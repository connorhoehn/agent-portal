// A live identity clone sees its persona's direct messages under its own id.
//
// Rows keyed by user id belong to the persona (lib/record-owner.ts), but a DM
// is different: its CHANNEL NAME carries both member ids
// (`social:dm:u-sana:u-vera`), and the portal checks that the name carries the
// session's own id before it will draw the conversation (embeddedSocial.ts, the
// DM pane's "mine"). A clone listed under the persona's channel names was
// rejected ("The Social response was invalid", "This conversation is not
// yours"). So a clone gets its OWN copies: for every DM its persona has, the
// same history under a channel named for the clone, authored by the clone where
// the persona wrote. The copy is made once per clone and world, from the chat
// store, so it follows `POST /api/__mock/reset`, request-scoped mock worlds and
// the Dynamo backend alike; nothing is shared with the persona or with any
// other clone, and a clone is never put in a DM of a persona it was not cloned
// from. Outside dev:mock no clone is live and this does nothing.

import { findClone } from '../mock/identity-clones.js';
import { socialChat, tenantDmMembers } from './social-chat.js';
import { dmLobbyName } from '@connorhoehn/realtime-modules/call';

const HISTORY_CAP = 500;
const pending = new Map<string, Promise<void>>();

/** `<tenant>:dm:<ids>` with the persona's id swapped for the clone's, in the library's canonical order. */
export function cloneDmChannel(channel: string, persona: string, cloneId: string): string | null {
  const ids = tenantDmMembers(channel);
  const at = channel.indexOf(':dm:');
  if (!ids || at < 0 || !ids.includes(persona)) return null;
  return dmLobbyName(ids.map(id => (id === persona ? cloneId : id)), { prefix: `${channel.slice(0, at)}:` });
}

async function mirror(sub: string, persona: string): Promise<void> {
  const chat = socialChat();
  await chat.ready;
  for (const row of await chat.conversations.listForUser(persona)) {
    const target = cloneDmChannel(row.channel, persona, sub);
    const members = target ? tenantDmMembers(target) : null;
    if (!target || !members) continue;
    if ((await chat.chatStore.listMessages(target, 1)).length) continue; // already copied (or the clone's own conversation)
    const history = await chat.chatStore.listMessages(row.channel, HISTORY_CAP);
    for (const m of history) {
      const copy = { ...m, id: `${m.id}~${sub}`, channel: target, ...(m.userId === persona ? { userId: sub } : {}) };
      await chat.chatStore.putMessage(copy);
      await chat.conversations.recordDmMessage(target, members, copy);
    }
    if (!history.length) await chat.conversations.recordJoin(target, sub);
  }
}

/** Idempotent; a no-op for anyone but a live clone. Calls for one clone run one at a time. */
export function mirrorCloneDms(sub: string | null | undefined): Promise<void> {
  if (!sub || !sub.includes('-clone-')) return Promise.resolve();
  const clone = findClone(sub);
  if (!clone) return Promise.resolve();
  const run = (pending.get(sub) ?? Promise.resolve()).catch(() => undefined).then(() => mirror(sub, clone.from));
  pending.set(sub, run);
  void run.finally(() => { if (pending.get(sub) === run) pending.delete(sub); }).catch(() => undefined);
  return run;
}

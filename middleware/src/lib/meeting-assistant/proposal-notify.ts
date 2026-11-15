// Telling people about a proposal outside the call (docs/meeting-consent-design.md, "The consent rule" 2, package 6).
//
// The rules kept here:
//   - Only a named person or the executor who has not answered, and who is not seated in the call, is told it needs them.
//   - The asker and the executor are told when a proposal ends (done, failed, expired) and when Nova could not run it (a hand-back);
//     an executor who is not in the call is told when everyone needed has consented and only their own click is left.
//   - A notification's title names the call ("A proposal from the Auth Migration call needs you") and links to the meeting page. It
//     carries no statement, reason or name of the proposal: the notification service cannot delete, and the inviter's delete must
//     leave nothing behind. The call's name is its initiative's name, never anything said in it.
//   - Each person is told once per proposal and event in this process: it needs them (when it is created for those not in the
//     call, and when the call ends or Nova leaves for those still owing an answer who are not seated then), it ended, each hand-back.
import { callChatRuntime } from '../call-chat.js';
import { notify } from '../social-notify.js';
import { getProject } from '../../providers/projects.js';
import { ANSWERABLE, onProposalChanged } from './proposals.js';
import { assistantStore } from './store-select.js';
import type { AssistantStore } from './store.js';
import type { Proposal } from './types.js';

/** "the Auth Migration call" for a call on an initiative, else "a call". */
export type CallLabel = string;
export const proposalNoticeTitle = (label: CallLabel): string => `A proposal from ${label} needs you`;
const ENDED_TITLES: Readonly<Record<'done' | 'failed' | 'expired', (label: CallLabel) => string>> = {
  done: (l) => `A proposal from ${l} was carried out`,
  failed: (l) => `A proposal from ${l} could not be carried out`,
  expired: (l) => `A proposal from ${l} expired without running`,
};
export const handBackTitle = (label: CallLabel): string => `Nova could not run a proposal from ${label}`;
export const readyTitle = (label: CallLabel): string => `A proposal from ${label} is ready for you to run`;
/** The portal's meeting page (minutes-service.ts `meetingPagePath`, kept here to avoid loading the minutes stack). */
const meetingPage = (callId: string): string => `/iq/meetings/${encodeURIComponent(callId)}`;

/** The call as a notification names it: its initiative's name, or "a call". Never throws. */
export async function callLabelOf(callId: string, store: AssistantStore = assistantStore()): Promise<CallLabel> {
  try {
    const initiativeId = (await store.get(callId))?.initiativeId;
    const name = initiativeId ? (await getProject(initiativeId))?.name?.trim() : null;
    return name ? `the ${name} call` : 'a call';
  } catch { return 'a call'; }
}

const told = new Set<string>();
/** Tests start clean. */
export function forgetProposalNotices(): void { told.clear(); }

/** The people this proposal still waits for: the executor and everyone named who has not answered. */
export function owedBy(p: Pick<Proposal, 'executor' | 'named' | 'responses'>): string[] {
  const answered = new Set(p.responses.map((r) => r.userId));
  return [...new Set([p.executor, ...p.named])].filter((u) => !answered.has(u));
}

async function seatedNow(callId: string): Promise<Set<string>> {
  try { return new Set((await callChatRuntime().seatedUsers(callId)).filter((u) => u.active).map((u) => u.userId)); } catch { return new Set(); }
}

/** Tell `who` once per `event` key; returns who was told. */
async function tellOnce(p: Proposal, who: readonly string[], event: string, type: string, title: string): Promise<string[]> {
  const fresh = [...new Set(who)].filter((u) => !told.has(`${p.callId}\0${p.id}\0${event}\0${u}`));
  if (!fresh.length) return [];
  for (const u of fresh) told.add(`${p.callId}\0${p.id}\0${event}\0${u}`);
  return notify(fresh, {
    type, title, action: { label: 'Open the meeting', href: meetingPage(p.callId) },
    payload: { tenant: p.tenant, kind: type, callId: p.callId },
  });
}

/** Tell the people `p` still needs who are not in `seated`, once each. Returns who was told. */
export async function notifyProposalNeeds(p: Proposal, seated: ReadonlySet<string>, label?: CallLabel): Promise<string[]> {
  if (!ANSWERABLE.includes(p.state)) return [];
  const who = owedBy(p).filter((u) => !seated.has(u));
  if (!who.length) return [];
  return tellOnce(p, who, 'needs', 'meeting-proposal-needs-you', proposalNoticeTitle(label ?? await callLabelOf(p.callId)));
}

/** A proposal that ended (done, failed, expired) tells its asker and its executor, once. */
export async function notifyProposalEnded(p: Proposal, label?: CallLabel): Promise<string[]> {
  if (p.state !== 'done' && p.state !== 'failed' && p.state !== 'expired') return [];
  const who = [...(p.askedBy ? [p.askedBy] : []), p.executor];
  return tellOnce(p, who, 'ended', 'meeting-proposal-ended', ENDED_TITLES[p.state](label ?? await callLabelOf(p.callId)));
}

/** True when this saved proposal is a hand-back: consented again with a note, no turn, not raised again. */
export const isHandBack = (p: Pick<Proposal, 'state' | 'run'>): boolean => p.state === 'consented' && !!p.run && p.run.turnId === null && !!p.run.note && !p.run.raisedAs;

/** Nova could not run it (the executor may not, or was not there): the executor is told, once per hand-back. */
export async function notifyHandBack(p: Proposal, label?: CallLabel): Promise<string[]> {
  if (!isHandBack(p)) return [];
  return tellOnce(p, [p.executor], `back-${p.run!.at}`, 'meeting-proposal-handed-back', handBackTitle(label ?? await callLabelOf(p.callId)));
}

/** Everyone needed consented but the executor's own click is still to come, and they are not in the call: they are told, once. */
export async function notifyReadyToRun(p: Proposal, seated: ReadonlySet<string>, label?: CallLabel): Promise<string[]> {
  if (p.state !== 'consented' || p.run || seated.has(p.executor)) return [];
  return tellOnce(p, [p.executor], 'ready', 'meeting-proposal-ready', readyTitle(label ?? await callLabelOf(p.callId)));
}

/** The call ended or Nova left: everyone still owed an answer who is not seated now is told. Never throws. */
export async function notifyOpenProposals(store: AssistantStore, callId: string): Promise<number> {
  try {
    const seated = await seatedNow(callId);
    const label = await callLabelOf(callId, store);
    let n = 0;
    for (const p of await store.listProposals(callId)) n += (await notifyProposalNeeds(p, seated, label)).length + (await notifyReadyToRun(p, seated, label)).length;
    return n;
  } catch (e) { console.warn('[meeting-assistant] proposal notices failed', (e as Error).message); return 0; }
}

let hooked: (() => void) | null = null;
/** A new proposal tells the people it needs who are not in the call; an ending or a hand-back tells its asker and executor. Subscribed once. */
export function hookProposalNotices(): void {
  hooked ??= onProposalChanged(async (p, how) => {
    if (how === 'created') { await notifyProposalNeeds(p, await seatedNow(p.callId)); return; }
    await notifyProposalEnded(p);
    await notifyHandBack(p);
    if (p.state === 'consented' && !p.run) await notifyReadyToRun(p, await seatedNow(p.callId));
  });
}

// The gateway's socket-side notification producers (docs/social-tenant-design.md
// §3.4 rows 4–6), as router plugins over the chat service's `message` frames,
// plus the chat options that give the page discussions reader cursors and
// their "new messages" items. Who may be told is never decided here: the
// gateway's `authorize` already refused a publish by a non-member, and each
// recipient's own read is asked through lib/gateway/authority.ts (`admitReader`
// behind lib/social-notify.ts) before an item is written.
//
//   - a DM message (chat publish on `<tenant>:dm:<a>:<b>…`) → the other
//     members who have no live subscription to that channel;
//   - a channel message (chat publish on `social:ch:<slug>`) → the channel's
//     active members who have no live subscription to it; `@<name>` in the
//     text → the mentioned members, as a `mention` (design §3.4 row 5);
//   - a mention on a tenant discussion → the mentioned readers;
//   - a message on a page discussion → each earlier reader's "new messages",
//     made by the chat service itself (realtime-modules 0.118 `unread`) on
//     every post path; see `pageCursorChatOptions` and lib/page-thread-unread.ts.

import type { AuthorityScope, RealtimeRouter } from '@connorhoehn/realtime-modules/server';
import { parseChatPluginMessage, type ChatServiceOpts } from '@connorhoehn/realtime-modules/chat';
import { conversationHref, notify, notifyTenantChannelMention, parseDmLobby, resolveMentions } from '../social-notify.js';
import { currentPageReaders, pageCursorMode, pageThreadUnread } from '../page-thread-unread.js';
import { socialChat, slugForChannel, type MirroredMembershipStore } from '../social-chat.js';
import { pageCursorFamily } from '../tenant-channels.js';

/** What the producers ask of the router: the authenticated user of a
 * connection and which users hold a live, readable subscription (0.119). */
export type LiveRouter = Pick<RealtimeRouter, 'getUserIdForClient' | 'liveUsersOn'>;

function snippet(text: unknown, max = 140): string {
  const flat = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Which of `users` are watching `channel` right now: a live, READABLE
 * subscription (the router's `liveUsersOn`, peer-aware on the cluster router,
 * re-asking the channel authority per connection). Chat subscribes the bare
 * name; a `chat:`-prefixed subscription counts too. `scope` is the send's
 * operation when it is still open (0.108 plugin scope), so the probes share
 * the send's membership proof; a closed scope is never passed on. Null when
 * the router cannot answer — callers then alert everyone (conservative).
 */
export async function liveSubscribersForUsers(router: LiveRouter, channel: string, users: readonly string[], scope?: AuthorityScope): Promise<Set<string> | null> {
  if (!router.liveUsersOn) return null;
  try {
    const opts = scope?.active ? { scope } : {};
    const live = new Set(await router.liveUsersOn(channel, [...users], opts));
    const rest = users.filter(user => !live.has(user));
    if (rest.length) for (const user of await router.liveUsersOn(`chat:${channel}`, rest, opts)) live.add(user);
    return live;
  } catch { return null; }
}

export type ChatPluginArgs = { clientId: string; channelId: string; message: unknown; userId?: string; scope?: AuthorityScope };
/** The send's authority scope while it is still open, else nothing (a fresh read). */
const liveScope = (args: ChatPluginArgs): AuthorityScope | undefined => args.scope?.active ? args.scope : undefined;

/**
 * The one reading of a notify plugin's input (the library's
 * `parseChatPluginMessage`): a chat `message` frame whose server-stamped
 * sender agrees with the authenticated sender (the plugin's `userId`, else the
 * publishing connection's). Null for anything else.
 */
function chatMessageFrame(args: ChatPluginArgs, getRouter: () => LiveRouter | null) {
  const router = getRouter();
  const parsed = parseChatPluginMessage(args, { resolveUserId: clientId => router?.getUserIdForClient?.(clientId) });
  return parsed ? { ...parsed, router } : null;
}

/**
 * Row 4: a chat message on a `<tenant>:dm:<a>:<b>…` channel notifies the other
 * members who are not looking at it. The sender is the PUBLISHING CONNECTION's
 * authenticated user (the plugin's `clientId` is the publisher); the message's
 * server-stamped sender (`message.userId`, and `metadata.userId` where a
 * library version stamps it there) must agree or the frame is ignored. The
 * gateway's `authorize` already refused a publish by a non-member.
 */
export function dmNotifyPlugin(getRouter: () => LiveRouter | null) {
  return {
    name: 'social-dm-notify',
    onMessage: async (args: ChatPluginArgs) => {
      const frame = chatMessageFrame(args, getRouter);
      if (!frame || !frame.router) return;
      const { channel, router, sender, message } = frame;
      const dm = parseDmLobby(channel);
      if (!dm || !dm.members.includes(sender)) return;
      const live = await liveSubscribersForUsers(router, channel, dm.members.filter(user => user !== sender), liveScope(args));
      const recipients = dm.members.filter((u) => u !== sender && !(live?.has(u) ?? false));
      if (!recipients.length) return;
      const name = frame.displayName ?? sender;
      void notify(recipients, {
        type: 'message',
        title: `${name} sent you a message`,
        body: snippet(message.message) || 'New message',
        channel,
        payload: { tenant: dm.tenant, kind: 'message', channel, actorId: sender, actorName: name },
        action: { label: 'Open the conversation', href: conversationHref(dm.tenant, channel) },
      });
    },
  };
}

/**
 * Row 5: a chat message on a `social:ch:<slug>` channel notifies the channel's
 * active members who are not looking at it (no live subscription), and
 * `@<display name>` in the text — resolved against the social roster — sends
 * the mentioned MEMBERS a `mention` instead (live or not: a mention asks for
 * attention). A mention of someone outside the channel notifies nobody: the
 * link would open a channel they cannot read. The sender is the plugin's
 * authenticated `userId` (0.99.0), falling back to the publishing connection's.
 */
export function channelNotifyPlugin(getRouter: () => LiveRouter | null, members: () => MirroredMembershipStore = () => socialChat().membershipStore) {
  return {
    name: 'social-channel-notify',
    onMessage: async (args: ChatPluginArgs) => {
      const frame = chatMessageFrame(args, getRouter);
      if (!frame) return;
      const { channel, router, sender } = frame;
      const slug = slugForChannel(channel);
      if (!slug) return;
      const store = members();
      const scope = liveScope(args);
      // With the send's scope the rows are the SAME durable read its
      // authorize checks resolved (no extra membership query); a write or peer
      // hint during the send makes listMembers read fresh instead. Without one
      // (an unscoped or already-closed operation) the mirror answers, as before.
      const active = async () => scope
        ? (await store.listMembers(channel, { scope })).filter(m => !m.removedAt).map(m => m.userId)
        : store.activeMembers(channel).map(m => m.userId);
      const before = await active();
      if (!before.includes(sender)) return;
      const audience = before.filter((u) => u !== sender);
      if (!audience.length) return;
      const live = router ? await liveSubscribersForUsers(router, channel, audience, scope) : null;
      // A removal that landed while the probes ran must not still be alerted:
      // ask the operation's proof again (shared while unchanged, fresh after a
      // change) and keep only members who are still active.
      const after = scope ? new Set(await active()) : null;
      const current = after ? audience.filter(u => after.has(u)) : audience;
      if (!current.length || (after && !after.has(sender))) return;
      await notifyChannelMessage({ channel, slug, sender, name: frame.displayName ?? sender, text: frame.text, audience: current, live });
    },
  };
}

/**
 * Mentions in orgiq initiative/work, pipelines run/definition and assessment
 * document/team chat. Only `mention` items: unread message alerts are separate.
 * The sender is the authenticated plugin user (or the publishing connection).
 */
export function tenantMentionNotifyPlugin(getRouter: () => LiveRouter | null) {
  return {
    name: 'tenant-mention-notify',
    onMessage: async (args: ChatPluginArgs) => {
      const frame = chatMessageFrame(args, getRouter);
      if (!frame) return;
      const { channel, sender, text, displayName } = frame;
      if (!/^(orgiq:(initiative|work)|pipelines:(run|def)|assessment:(doc|team)):/.test(channel)) return;
      // Awaited so the send's scope is retained while the readers are asked:
      // their membership reads share the send's proof (one read per channel).
      const scope = liveScope(args);
      await notifyTenantChannelMention({ channel, sender, ...(displayName ? { senderName: displayName } : {}), text, ...(scope ? { scope } : {}) });
    },
  };
}

/**
 * Reader cursors and unread on the page discussions (lib/page-thread-unread.ts):
 * those families run in `cursorMode: 'readers'` (a cursor per current reader,
 * no member list), and the chat service makes each earlier reader's "new
 * messages" item on every post — a socket send, `appendServerMessage`, or a
 * host's `noteMessagePosted` — skipping the sender, anyone watching the thread
 * (`live`, the router's readable-subscription probe) and anyone the page's
 * read gate refuses now (`currentReaders`, asked again per recipient). Reading
 * the thread clears the item (the service's own read-receipt path).
 */
/**
 * Does a send on `channel` keep page-thread unread items (realtime-modules
 * 0.120.1 `unread.channels`)? Only a page discussion with reader cursors
 * (`pageCursorFamily`). A DM or a Social channel answers false, so its send
 * does no unread work at all: no read-receipts read, no inbox read. The chat
 * service passes the send's own channel, which the gateway's chat uses bare;
 * a `chat:`-prefixed spelling is unwrapped before matching all the same.
 */
export function pageThreadKeepsUnread(channel: string): boolean {
  const bare = channel.startsWith('chat:') ? channel.slice('chat:'.length) : channel;
  return pageCursorFamily(bare) !== null;
}

export function pageCursorChatOptions(getRouter: () => LiveRouter | null): Pick<ChatServiceOpts, 'cursorMode' | 'currentReaders' | 'unread'> {
  return {
    cursorMode: pageCursorMode,
    currentReaders: (channel, userIds, scope) => currentPageReaders(channel, userIds, scope),
    unread: {
      ...pageThreadUnread(async (channel, userIds, scope) => {
        const router = getRouter();
        return router ? liveSubscribersForUsers(router, channel, userIds, scope) : null;
      }),
      channels: pageThreadKeepsUnread,
    },
  };
}

export async function notifyChannelMessage(ev: { channel: string; slug: string; sender: string; name: string; text: string; audience: string[]; live: Set<string> | null }): Promise<void> {
  try {
    const href = `/social/channels/${encodeURIComponent(ev.slug)}`;
    const payload = { tenant: 'social', kind: 'message', channel: ev.channel, actorId: ev.sender, actorName: ev.name };
    const action = { label: 'Open the channel', href };
    const body = snippet(ev.text) || 'New message';
    const mentioned = (await resolveMentions(ev.text, 'social')).filter((u) => ev.audience.includes(u));
    if (mentioned.length) {
      await notify(mentioned, { type: 'mention', title: `${ev.name} mentioned you in #${ev.slug}`, body, channel: ev.channel, payload: { ...payload, kind: 'mention' }, action });
    }
    const rest = ev.audience.filter((u) => !mentioned.includes(u) && !(ev.live?.has(u) ?? false));
    if (rest.length) {
      await notify(rest, { type: 'message', title: `${ev.name} in #${ev.slug}`, body, channel: ev.channel, payload, action });
    }
  } catch (err) {
    console.warn(`[realtime-gateway] channel notify failed: ${(err as Error).message}`);
  }
}

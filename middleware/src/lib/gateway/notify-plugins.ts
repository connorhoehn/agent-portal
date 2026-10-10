// The gateway's socket-side notification producers (docs/social-tenant-design.md
// §3.4 rows 4–6 and the page-thread unread items), as router plugins over the
// chat service's `message` frames. Who may be told is never decided here: the
// gateway's `authorize` already refused a publish by a non-member, and each
// recipient's own read is asked through lib/gateway/authority.ts (`admitReader`
// behind lib/page-thread-unread.ts and lib/social-notify.ts) before an item is
// written.
//
//   - a DM message (chat publish on `<tenant>:dm:<a>:<b>…`) → the other
//     members who have no live subscription to that channel;
//   - a channel message (chat publish on `social:ch:<slug>`) → the channel's
//     active members who have no live subscription to it; `@<name>` in the
//     text → the mentioned members, as a `mention` (design §3.4 row 5);
//   - a mention on a tenant discussion → the mentioned readers;
//   - a message on a page discussion → each earlier reader's "new messages".

import { baseChannel, type AuthorityScope } from '@connorhoehnslalom/realtime-modules/server';
import { conversationHref, notify, notifyTenantChannelMention, parseDmLobby, resolveMentions } from '../social-notify.js';
import { clearPageThreadItems, currentPageReaders, notifyPageThreadMessage, pageCursorMode } from '../page-thread-unread.js';
import { socialChat, slugForChannel, type MirroredMembershipStore } from '../social-chat.js';
import { pageCursorFamily } from '../tenant-channels.js';

/** Public subscription probes cover current local and peer readers. The private
 * inventory remains a compatibility fallback for older local routers. */
export interface DmRouter {
  getUserIdForClient?(clientId: string): string | undefined;
  getClientsByUserId?(userIds: string[]): Array<{ clientId: string; userId: string }> | Promise<Array<{ clientId: string; userId: string }>>;
  isClientSubscribed?(clientId: string, channel: string, opts?: { scope?: AuthorityScope }): boolean | Promise<boolean>;
  channelMembers?: Map<string, Set<string>>;
}

function snippet(text: unknown, max = 140): string {
  const flat = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Users with a live subscription to `channel` (chat subscribes it bare; `chat:`-prefixed covered too). */
export function liveSubscribers(router: DmRouter, channel: string): Set<string> | null {
  const members = router.channelMembers;
  if (!(members instanceof Map)) return null;
  const out = new Set<string>();
  for (const name of [channel, `chat:${channel}`]) {
    for (const clientId of members.get(name) ?? []) {
      const userId = router.getUserIdForClient?.(clientId);
      if (userId) out.add(userId);
    }
  }
  return out;
}

/** Public peer-aware probes verify the actual recipient's readable
 * subscription. An unavailable/legacy router retains conservative alerts.
 * `scope` is the send's operation when the caller has one: since 0.108 the
 * router hands every plugin hook the operation's scope (`info.scope`, retained
 * until the hook settles, at most PLUGIN_SCOPE_RETAIN_MAX_MS), so the probes
 * below share the send's membership proof — one durable read per channel
 * across the send's authorize checks and its plugins. A revocation observed
 * during the operation still denies every later probe (live-principal's
 * sticky shared fence); a closed scope is never passed on. */
export async function liveSubscribersForUsers(router: DmRouter, channel: string, users: string[], scope?: AuthorityScope): Promise<Set<string> | null> {
  if (!router.getClientsByUserId || !router.isClientSubscribed) return liveSubscribers(router, channel);
  try {
    const wanted = new Set(users), live = new Set<string>();
    const probe = (clientId: string, name: string) => scope?.active
      ? router.isClientSubscribed!(clientId, name, { scope }) : router.isClientSubscribed!(clientId, name);
    const clients = await router.getClientsByUserId([...wanted]);
    await Promise.all(clients.filter(client => wanted.has(client.userId)).map(async client => {
      if (await probe(client.clientId, channel) || await probe(client.clientId, `chat:${channel}`)) live.add(client.userId);
    }));
    return live;
  } catch { return null; }
}

export type ChatPluginArgs = { clientId: string; channelId: string; message: unknown; userId?: string; scope?: AuthorityScope };
/** The send's authority scope while it is still open, else nothing (a fresh read). */
const liveScope = (args: ChatPluginArgs): AuthorityScope | undefined => args.scope?.active ? args.scope : undefined;
type ChatFrameMessage = { id?: unknown; timestamp?: unknown; userId?: unknown; message?: unknown; metadata?: { userId?: unknown; displayName?: unknown } };

/**
 * The one reading of a notify plugin's input: a chat `message` frame whose
 * server-stamped sender agrees with the authenticated sender (the plugin's
 * `userId`, else the publishing connection's). Null for anything else.
 */
function chatMessageFrame(args: ChatPluginArgs, getRouter: () => DmRouter | null):
  { channel: string; router: DmRouter | null; sender: string; message: ChatFrameMessage; text: string; displayName: string | undefined } | null {
  const frame = args.message as { type?: unknown; action?: unknown; message?: ChatFrameMessage } | null;
  if (!frame || frame.type !== 'chat' || frame.action !== 'message' || !frame.message) return null;
  const router = getRouter();
  const sender = args.userId ?? router?.getUserIdForClient?.(args.clientId);
  const stamped = frame.message.userId ?? frame.message.metadata?.userId;
  if (!sender || (typeof stamped === 'string' && stamped !== sender)) return null;
  const name = frame.message.metadata?.displayName;
  return {
    channel: baseChannel(args.channelId), router, sender, message: frame.message,
    text: typeof frame.message.message === 'string' ? frame.message.message : '',
    displayName: typeof name === 'string' && name ? name : undefined,
  };
}

/**
 * Row 4: a chat message on a `<tenant>:dm:<a>:<b>…` channel notifies the other
 * members who are not looking at it. The sender is the PUBLISHING CONNECTION's
 * authenticated user (the plugin's `clientId` is the publisher); the message's
 * server-stamped sender (`message.userId`, and `metadata.userId` where a
 * library version stamps it there) must agree or the frame is ignored. The
 * gateway's `authorize` already refused a publish by a non-member.
 */
export function dmNotifyPlugin(getRouter: () => DmRouter | null) {
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
export function channelNotifyPlugin(getRouter: () => DmRouter | null, members: () => MirroredMembershipStore = () => socialChat().membershipStore) {
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
export function tenantMentionNotifyPlugin(getRouter: () => DmRouter | null) {
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
 * Unread on page discussions (lib/page-thread-unread.ts): a message on an
 * orgiq initiative/work, assessment team/document or pipelines run thread
 * gives each earlier reader who is not watching it, and still passes the
 * page's read gate now, one "new messages" item. The send's authority scope is
 * retained while the readers are asked, as for mentions.
 */
export function pageUnreadNotifyPlugin(getRouter: () => DmRouter | null) {
  return {
    name: 'page-unread-notify',
    onMessage: async (args: ChatPluginArgs) => {
      const frame = chatMessageFrame(args, getRouter);
      if (!frame || !pageCursorFamily(frame.channel)) return;
      const { channel, router, sender, text, displayName, message } = frame;
      const id = typeof message.id === 'string' ? message.id : '';
      const timestamp = typeof message.timestamp === 'string' ? message.timestamp : '';
      if (!id || !timestamp) return;
      const scope = liveScope(args);
      const cursors = await socialChat().readReceiptStore.listReceipts(channel).catch(() => []);
      const others = cursors.map(c => c.userId).filter(u => u !== sender);
      if (!others.length) return;
      const live = router ? await liveSubscribersForUsers(router, channel, others, scope) : null;
      await notifyPageThreadMessage({ channel, sender, ...(displayName ? { senderName: displayName } : {}), message: { id, timestamp }, text, live, ...(scope ? { scope } : {}) });
    },
  };
}

export type PageReadReceiptHook = (info: { channel: string; receipt: { userId: string; readAt: string } }) => void;
/** The chat options that turn on reader cursors for the page families, composed over the store's own read hook. */
export function pageCursorChatOptions(storeHook?: PageReadReceiptHook) {
  return {
    cursorMode: pageCursorMode,
    currentReaders: (channel: string, userIds: readonly string[]) => currentPageReaders(channel, userIds),
    onReadReceipt(info: { channel: string; receipt: { userId: string; readAt: string } }) {
      storeHook?.(info);
      if (pageCursorFamily(info.channel)) void clearPageThreadItems(info.receipt.userId, info.channel, info.receipt.readAt);
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

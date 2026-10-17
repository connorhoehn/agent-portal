// Read cursors and unread state for the page discussions (orgiq initiative and
// work-item threads, assessment team and document chats, pipelines run
// threads, access request threads): the families marked `cursors` in
// lib/tenant-channels.ts.
//
// Those channels are OPEN — the gateway admits each request by the page's read
// gate (lib/gateway/authority.ts admitChannel), never by a member list — so the
// chat service runs them in `cursorMode: 'readers'`, and no member list is
// invented anywhere:
//
//   - a cursor is stored per (user, channel) when someone the page's read gate
//     admits reads the thread; the gateway asks that gate on every `read` and
//     `receipts` frame and again after the store write, so a revoked reader's
//     write is refused and their receipt never fans out;
//   - the router re-checks every recipient of a `readReceipt` frame, so a "seen
//     by" never reaches someone who lost access, and `currentPageReaders`
//     drops a revoked reader's stored cursor from every listing;
//   - the unread badge is server-side. Since realtime-modules 0.118 the chat
//     service makes the "new messages" item itself (`pageThreadUnread` below
//     is its `unread` option): one item per cursor holder who is not the
//     sender, not watching the thread, and still passes the read gate NOW
//     (`currentlyReadsTenantChannel`, asked again per recipient), on every
//     post path; reading the thread clears it. The notifications service
//     asks the same gate before it delivers or replays any item about a
//     tenant discussion (lib/social-notify.ts admitTenantNotification).
//     `GET /api/discussions/unread` recomputes every count from the cursor
//     and the stored messages on each call, re-asking the gate.
//
// The item id carries the cursor it was produced against
// (`discussion-unread:<channel>:<readAt>`), so a thread produces one bell item
// per stretch of unread messages, and reading the thread marks it read. Items
// stored before 0.118 (no `chatUnread` marker) are still recognised by
// `payload.kind`.

import type { AuthorityScope } from '@connorhoehn/realtime-modules/server';
import type { ChatUnreadOpts } from '@connorhoehn/realtime-modules/chat';
import { pageCursorFamily, channelService } from './tenant-channels.js';
import { currentlyReadsTenantChannel, notificationInbox, tenantDiscussionLink } from './social-notify.js';
import { holdsChannelAuthority } from './live-principal.js';
import { socialChat } from './social-chat.js';
import { unreadFor } from '../mock/social-channels.js';
import type { Session } from './session.js';

export const DISCUSSION_UNREAD_KIND = 'discussion-unread';
/** How far back a count looks — the DM conversations list's window (routes/people.ts). */
export const UNREAD_WINDOW = 50;

/** The chat service's `cursorMode`: readers for a page discussion, the library default elsewhere. */
export function pageCursorMode(channel: string): 'readers' | 'members' {
  return pageCursorFamily(channel) ? 'readers' : 'members';
}

/** The chat service's `currentReaders`: which cursor holders pass the page's read gate NOW. */
export async function currentPageReaders(channel: string, userIds: readonly string[], scope?: AuthorityScope): Promise<string[]> {
  if (!pageCursorFamily(channel)) return [];
  const out: string[] = [];
  for (const userId of new Set(userIds)) if (await currentlyReadsTenantChannel(userId, channel, scope)) out.push(userId);
  return out;
}

export function unreadItemId(channel: string, readAt: string | null): string {
  return `${DISCUSSION_UNREAD_KIND}:${channel}:${readAt ?? 'never'}`;
}

/** An item about `channel` the unread model made: the library's marker, or a pre-0.118 item's kind. */
export const isUnreadItem = (n: { payload?: Record<string, unknown> }, channel?: string): boolean =>
  channel === undefined
    ? n.payload?.['kind'] === DISCUSSION_UNREAD_KIND || typeof n.payload?.['chatUnread'] === 'string'
    : n.payload?.['chatUnread'] === channel || (n.payload?.['kind'] === DISCUSSION_UNREAD_KIND && n.payload?.['channel'] === channel);

function snippet(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * The chat service's `unread` option (realtime-modules 0.118) for the page
 * families. `live` names who is watching a thread (they get no item). Any
 * other channel gets no item: DMs and Social channels have their own
 * producers (lib/gateway/notify-plugins.ts), so every holder there counts as
 * "watching" and `describe` refuses too.
 */
export function pageThreadUnread(live: (channel: string, userIds: readonly string[], scope?: AuthorityScope) => Promise<ReadonlySet<string> | null>): ChatUnreadOpts {
  return {
    itemId: unreadItemId,
    window: UNREAD_WINDOW,
    isItem: (n, channel) => isUnreadItem(n, channel),
    live: (channel, userIds, scope) => pageCursorFamily(channel) ? live(channel, userIds, scope) : new Set(userIds),
    describe: async ({ channel, message, senderName }) => {
      if (!pageCursorFamily(channel)) return null;
      const link = await tenantDiscussionLink(channel);
      if (!link) return null;
      const stamped = message.metadata?.['displayName'];
      const name = senderName || (typeof stamped === 'string' && stamped ? stamped : '') || message.userId || 'Someone';
      return {
        type: 'message',
        title: `New messages in ${link.place}`,
        body: `${name}: ${snippet(typeof message.message === 'string' ? message.message : '') || 'New message'}`,
        payload: { tenant: link.tenant, kind: DISCUSSION_UNREAD_KIND, channel, actorId: message.userId ?? null, actorName: name },
        action: { label: link.label, href: link.href },
      };
    },
  };
}

/** The rail door a family's threads count against (the tenant's own nav path). */
export function sectionFor(channel: string): string | null {
  const family = pageCursorFamily(channel);
  switch (family?.id) {
    case 'orgiq:initiative': case 'orgiq:work': return '/iq/projects';
    case 'assessment:team': return '/assessment/teams';
    case 'assessment:doc': return '/assessment/workspace';
    case 'pipelines:run': return '/pipelines/runs';
    default: return null;
  }
}

/** A short name for a thread: its page's id with the family's noun. */
export function threadTitle(channel: string): string {
  const family = pageCursorFamily(channel);
  const id = family ? channel.slice(family.id.length + 1) : channel;
  switch (family?.id) {
    case 'orgiq:initiative': return `Initiative ${id}`;
    case 'orgiq:work': return `Work item ${id}`;
    case 'assessment:team': return `Team ${id}`;
    case 'assessment:doc': return 'Document chat';
    case 'pipelines:run': return `Run ${id}`;
    default: return channel;
  }
}

export interface UnreadThread {
  channel: string; title: string; href: string; label: string; place: string; section: string;
  unreadCount: number; lastMessageAt: string | null; lastMessagePreview: string | null;
}

/**
 * The signed-in user's page discussions with new messages, in their ACTIVE
 * tenant. The candidates are the threads that produced an item for them (the
 * inbox is the per-user index); every one is re-decided now — the session's
 * own family read authority (active tenant + policy), the user's current read
 * gate (directory, resource row) — and its count recomputed from the stored
 * cursor and messages. Nothing is counted on the client.
 */
export async function unreadThreadsFor(session: Session, limit = 50): Promise<UnreadThread[]> {
  const inbox = notificationInbox();
  if (!inbox) return [];
  const items = await inbox.listForUser(session.sub);
  const channels = [...new Set(items.filter(n => isUnreadItem(n) && n.payload?.['tenant'] === session.tenant)
    .map(n => n.payload!['channel']).filter((c): c is string => typeof c === 'string'))].slice(-limit);
  const chat = socialChat(); await chat.ready;
  const out: UnreadThread[] = [];
  for (const channel of channels) {
    const family = pageCursorFamily(channel);
    const section = sectionFor(channel);
    if (!family || !section || family.tenant !== session.tenant || channelService(channel).service !== 'chat') continue;
    if (!await holdsChannelAuthority(session, family.read)) continue;
    if (!await currentlyReadsTenantChannel(session.sub, channel)) continue;
    const [recent, cursors] = await Promise.all([chat.recentMessages(channel, UNREAD_WINDOW), chat.readReceiptStore.listReceipts(channel)]);
    const readAt = cursors.find(c => c.userId === session.sub)?.readAt ?? null;
    const unreadCount = unreadFor(recent, channel, session.sub, readAt);
    if (unreadCount < 1) continue;
    const link = await tenantDiscussionLink(channel);
    if (!link) continue;
    const last = recent[recent.length - 1] ?? null;
    out.push({ channel, title: threadTitle(channel), href: link.href, label: link.label, place: link.place, section, unreadCount,
      lastMessageAt: last?.timestamp ?? null,
      lastMessagePreview: last ? snippet(last.deletedAt ? 'Message deleted' : last.message, 80) : null });
  }
  return out.sort((a, b) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? '') || a.channel.localeCompare(b.channel));
}

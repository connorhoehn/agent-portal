// Read cursors and unread state for the page discussions (orgiq initiative and
// work-item threads, assessment team and document chats, pipelines run
// threads): the families marked `cursors` in lib/tenant-channels.ts.
//
// Those channels are OPEN — the gateway admits each request by the page's read
// gate (live-principal.ts authorizeLiveGatewayChannel), never by a member list —
// so until realtime-modules 0.115 they kept no read cursor (`receipts` answered
// `enabled:false, reason:'open-channel'`) and the "new messages" divider had
// nothing to draw from. Now the chat service runs them in `cursorMode:
// 'readers'`, and no member list is invented anywhere:
//
//   - a cursor is stored per (user, channel) when someone the page's read gate
//     admits reads the thread; the gateway asks that gate on every `read` and
//     `receipts` frame and again after the store write, so a revoked reader's
//     write is refused and their receipt never fans out;
//   - the router re-checks every recipient of a `readReceipt` frame, so a "seen
//     by" never reaches someone who lost access, and `currentPageReaders`
//     drops a revoked reader's stored cursor from every listing;
//   - the unread badge is server-side: a message on the thread produces one
//     "new messages" item per cursor holder who is not watching the thread
//     and still passes the read gate NOW (`currentlyReadsTenantChannel`, the
//     notify plugin path's per-recipient check, sharing the send's authority
//     scope), and `GET /api/discussions/unread` recomputes every count from the
//     cursor and the stored messages on each call, re-asking the gate.
//
// The item id carries the cursor it was produced against
// (`discussion-unread:<channel>:<readAt>`), so a thread produces one bell item
// per stretch of unread messages, and reading the thread marks it read.

import type { AuthorityScope } from '@connorhoehnslalom/realtime-modules/server';
import type { ChatMessage } from '@connorhoehnslalom/realtime-modules/chat';
import { pageCursorFamily, channelService } from './tenant-channels.js';
import { currentlyReadsTenantChannel, notify, tenantDiscussionLink } from './social-notify.js';
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

/** The slice of the gateway's NotificationService the unread items use (realtime-modules 0.115). */
export interface DiscussionInbox {
  listForUser(userId: string): Promise<Array<{ id: string; timestamp?: string; read?: boolean; payload?: Record<string, unknown> }>>;
  markReadForUser(userId: string, ids: readonly string[]): Promise<void>;
}
let inbox: DiscussionInbox | null = null;
/** Wired by attachRealtimeGateway; `null` on dispose (and in tests that do not attach). */
export function setDiscussionInbox(next: DiscussionInbox | null): void { inbox = next; }

const isUnreadItem = (n: { payload?: Record<string, unknown> }, channel?: string): boolean =>
  n.payload?.['kind'] === DISCUSSION_UNREAD_KIND && (channel === undefined || n.payload?.['channel'] === channel);

function snippet(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export interface PageThreadMessage {
  channel: string;
  sender: string;
  senderName?: string;
  message: Pick<ChatMessage, 'id' | 'timestamp'> & Partial<ChatMessage>;
  text: string;
  /** Users watching the thread right now (their open panel reads it); null when unknown. */
  live: Set<string> | null;
  scope?: AuthorityScope;
}

/**
 * A message on a page discussion: every cursor holder (someone who has read
 * the thread before) who is not the sender, not watching it, and still passes
 * the page's read gate gets ONE "new messages" item for the stretch since
 * their cursor. Resolves to the users given an item; never throws.
 */
export async function notifyPageThreadMessage(ev: PageThreadMessage): Promise<string[]> {
  try {
    const family = pageCursorFamily(ev.channel);
    if (!family) return [];
    const link = await tenantDiscussionLink(ev.channel);
    if (!link) return [];
    const chat = socialChat(); await chat.ready;
    const cursors = await chat.readReceiptStore.listReceipts(ev.channel);
    const candidates = cursors.filter(c => c.userId !== ev.sender && !(ev.live?.has(c.userId) ?? false));
    if (!candidates.length) return [];
    const recent = await chat.recentMessages(ev.channel, UNREAD_WINDOW);
    const messages = recent.some(m => m.id === ev.message.id) ? recent
      : [...recent, { ...ev.message, channel: ev.channel, userId: ev.sender } as ChatMessage];
    const name = ev.senderName || ev.sender;
    const given: string[] = [];
    for (const cursor of candidates) {
      if (!await currentlyReadsTenantChannel(cursor.userId, ev.channel, ev.scope)) continue;
      if (unreadFor(messages, ev.channel, cursor.userId, cursor.readAt) < 1) continue;
      const id = unreadItemId(ev.channel, cursor.readAt);
      if (inbox && (await inbox.listForUser(cursor.userId)).some(n => n.id === id)) continue;
      const sent = await notify([cursor.userId], {
        id,
        type: 'message',
        title: `New messages in ${link.place}`,
        body: `${name}: ${snippet(ev.text) || 'New message'}`,
        timestamp: ev.message.timestamp,
        channel: ev.channel,
        payload: { tenant: link.tenant, kind: DISCUSSION_UNREAD_KIND, channel: ev.channel, actorId: ev.sender, actorName: name },
        action: { label: link.label, href: link.href },
      });
      given.push(...sent);
    }
    return given;
  } catch (err) {
    console.warn(`[page-thread-unread] notify failed: ${(err as Error).message}`);
    return [];
  }
}

/** The reader's cursor moved: their "new messages" items for this thread at or before it are read. */
export async function clearPageThreadItems(userId: string, channel: string, readAt: string): Promise<string[]> {
  try {
    if (!inbox || !pageCursorFamily(channel)) return [];
    const ids = (await inbox.listForUser(userId))
      .filter(n => !n.read && isUnreadItem(n, channel) && (n.timestamp ?? '') <= readAt)
      .map(n => n.id);
    if (ids.length) await inbox.markReadForUser(userId, ids);
    return ids;
  } catch (err) {
    console.warn(`[page-thread-unread] clear failed: ${(err as Error).message}`);
    return [];
  }
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

// A call's unread bubble (hooks/useCallChatUnread.ts), the pure part. A tab's unread count is the messages it shows
// that someone else wrote after my read position on that tab (middleware lib/call-chat-reads.ts: "read up to the
// message at time T", kept per person per call per tab). My own messages never count; a history replay of messages at
// or before my position never counts; before my position has loaded nothing counts (a reload does not flash the
// replayed history as new).

export type CallChatReadTab = 'chat' | 'milo';
export interface UnreadMessage { id?: string; userId?: string; timestamp?: string; deletedAt?: string | null; metadata?: Record<string, unknown> }
/** My position on a tab: the time of the newest message I have seen, null when I never opened it, undefined while loading. */
export type ReadPosition = string | null | undefined;

const time = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : Number.NaN);

/** How many of `messages` (those `counts` keeps) someone other than me wrote after `readAt`. */
export function unreadCount(messages: readonly UnreadMessage[], viewerId: string | null | undefined, readAt: ReadPosition,
  counts: (m: UnreadMessage) => boolean = () => true): number {
  if (readAt === undefined || !viewerId) return 0;
  const floor = readAt === null ? Number.NEGATIVE_INFINITY : time(readAt);
  let n = 0;
  for (const m of messages) {
    if (m.deletedAt || !m.userId || m.userId === viewerId || !counts(m)) continue;
    const at = time(m.timestamp);
    if (Number.isFinite(at) && at > floor) n += 1;
  }
  return n;
}

/** The newest time among `messages` (`counts` keeps): what opening the tab marks read. Null when there is none. */
export function newestTime(messages: readonly UnreadMessage[], counts: (m: UnreadMessage) => boolean = () => true): string | null {
  let best: string | null = null;
  for (const m of messages) {
    if (!m.timestamp || !counts(m) || !Number.isFinite(time(m.timestamp))) continue;
    if (best === null || time(m.timestamp) > time(best)) best = m.timestamp;
  }
  return best;
}

/** The later of two positions (a position only moves forward). */
export function laterPosition(a: ReadPosition, b: string | null | undefined): ReadPosition {
  if (!b) return a;
  if (!a) return b;
  return time(b) > time(a) ? b : a;
}

/** Should opening the tab write a new position? Only when what it shows is newer than what is stored. */
export const shouldMark = (readAt: ReadPosition, newest: string | null): newest is string =>
  !!newest && (readAt === null || readAt === undefined || time(newest) > time(readAt));

/** The bubble's text (the library tab badge) and the words a screen reader hears beside the tab's name. */
export const unreadBadgeText = (n: number): string => (n > 99 ? '99+' : String(n));
export const unreadWords = (n: number): string => `${n} unread`;

/** Milo's line in a call chat: the assistant's author id (middleware lib/meeting-assistant/chat-types.ts). */
export const isMiloLine = (m: UnreadMessage): boolean => m.userId === 'agent:meeting-assistant' || m.userId === 'agent:nova';

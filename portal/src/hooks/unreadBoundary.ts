// Pure half of useUnreadBoundary.ts (tested under node --test).

export interface BoundaryMessage { timestamp?: string; userId?: string }

/**
 * Timestamp of the first message the viewer has not read, or undefined when there is no line to
 * draw: nothing newer than the cursor, no known cursor, or every loaded message is unread (a line
 * above the whole transcript marks nothing).
 */
export function unreadBoundary(messages: readonly BoundaryMessage[], readAt: string | null | undefined, viewerId: string): string | undefined {
  if (!readAt) return undefined;
  const cursor = Date.parse(readAt);
  if (Number.isNaN(cursor)) return undefined;
  const index = messages.findIndex(m => m.timestamp !== undefined && Date.parse(m.timestamp) > cursor && m.userId !== viewerId);
  return index > 0 ? messages[index]?.timestamp : undefined;
}

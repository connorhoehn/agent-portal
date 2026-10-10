// The "new messages" divider for a gateway chat thread. The library's WrappedChatPanel draws the
// line at `unreadFrom` (the first message at or after it) and freezes it, but nothing hands the
// panel the viewer's OWN read cursor: useChatReadReceipts drops it on purpose. A second,
// never-reading instance of the same hook (no currentUserId, active false) sees every cursor,
// including ours, from the same `chat:receipts` frames the Social workspace already uses — no new
// BFF surface. The cursor is the timestamp of the newest message the viewer had seen, so the line
// goes above the first later message written by someone else. It is captured once per channel,
// before the main hook's automatic read can advance it, and never moves while the thread is open.

import { useEffect, useRef, useState } from 'react';
import { useChatReadReceipts } from '@connorhoehnslalom/realtime-modules/client';
import { unreadBoundary, type BoundaryMessage } from './unreadBoundary';

export function useUnreadBoundary(channel: string, viewerId: string, messages: readonly BoundaryMessage[]): string | undefined {
  const cursors = useChatReadReceipts(channel, {});
  const mine = viewerId ? cursors.receipts.find(r => r.userId === viewerId)?.readAt : undefined;
  const frozen = useRef<{ channel: string; readAt: string | null | undefined; settled: boolean }>({ channel, readAt: undefined, settled: false });
  const [boundary, setBoundary] = useState<{ channel: string; at: string | undefined }>({ channel, at: undefined });
  if (frozen.current.channel !== channel) frozen.current = { channel, readAt: undefined, settled: false };
  if (!cursors.loading && frozen.current.readAt === undefined) frozen.current.readAt = cursors.enabled ? (mine ?? null) : null;
  const readAt = frozen.current.readAt;
  const loaded = messages.length > 0;
  useEffect(() => {
    const state = frozen.current;
    if (state.channel !== channel || state.settled || readAt === undefined || !loaded) return;
    state.settled = true;
    setBoundary({ channel, at: unreadBoundary(messages, readAt, viewerId) });
  }, [channel, readAt, loaded, messages, viewerId]);
  return boundary.channel === channel ? boundary.at : undefined;
}

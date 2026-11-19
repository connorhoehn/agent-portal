// A call's unread bubbles, for every tenant's call surface (the interview room's Chat and Milo tabs, the candidate's
// Chat tab, Work's and Social's huddle chat behind the footer's Message and the hangout's Conversation tab).
// My read position per tab is the server's (GET/PUT <base>/:callId/chat/reads, middleware lib/call-chat-reads.ts), so a
// reload or a second device shows the same state. The count is live from the messages the caller already holds
// (lib/callChatUnreadModel.ts); a tab that is on screen in a visible window marks what it shows read, at once locally
// and, debounced, on the server.
import { useEffect, useMemo, useRef, useState } from 'react';
import { laterPosition, newestTime, shouldMark, unreadCount, type CallChatReadTab, type ReadPosition, type UnreadMessage } from '../lib/callChatUnreadModel';

export const STAFF_CALL_READS = '/api/calls';
export const GUEST_CALL_READS = '/api/interview-invite/calls';
const MARK_DEBOUNCE_MS = 600;
const INIT: RequestInit = { credentials: 'same-origin', cache: 'no-store' };

export interface CallChatUnreadTab {
  /** The tab's content is on screen now (the pane shown, the tab selected). */
  seen: boolean;
  /** Which messages this tab shows and counts (default: all). */
  counts?: (m: UnreadMessage) => boolean;
}
export interface UseCallChatUnreadOpts {
  callId: string | null;
  viewerId: string | null;
  messages: readonly UnreadMessage[];
  tabs: Partial<Record<CallChatReadTab, CallChatUnreadTab>>;
  /** The reads route's prefix: the staff one, or the guest's twin. */
  base?: string;
}

const readsUrl = (base: string, callId: string) => `${base}/${encodeURIComponent(callId)}/chat/reads`;
type Positions = Record<CallChatReadTab, ReadPosition>;
const LOADING: Positions = { chat: undefined, milo: undefined };

function useWindowVisible(): boolean {
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
  useEffect(() => {
    const on = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  return visible;
}

/** The unread count per tab (0 for a tab not asked for). */
export function useCallChatUnread({ callId, viewerId, messages, tabs, base = STAFF_CALL_READS }: UseCallChatUnreadOpts): Record<CallChatReadTab, number> {
  const [positions, setPositions] = useState<Positions>(LOADING);
  const visible = useWindowVisible();
  // My position for this call, once per call; a failed read counts from "never read" rather than hiding the bubble.
  useEffect(() => {
    setPositions(LOADING);
    if (!callId || !viewerId) return;
    let on = true;
    void fetch(readsUrl(base, callId), INIT).then(async (res) => {
      const body = res.ok ? await res.json() as { reads?: Partial<Record<CallChatReadTab, { readAt?: string } | null>> } : null;
      if (!on) return;
      setPositions((held) => ({ chat: laterPosition(body?.reads?.chat?.readAt ?? null, held.chat ?? null),
        milo: laterPosition(body?.reads?.milo?.readAt ?? null, held.milo ?? null) }));
    }).catch(() => { if (on) setPositions((held) => ({ chat: held.chat ?? null, milo: held.milo ?? null })); });
    return () => { on = false; };
  }, [base, callId, viewerId]);

  // A seen tab marks the newest message it shows: locally now, on the server after a short quiet.
  const pending = useRef<Partial<Record<CallChatReadTab, string>>>({});
  const timer = useRef<number | undefined>(undefined);
  const pendingUrl = useRef<string | null>(null);
  const flush = () => {
    const send = pending.current, url = pendingUrl.current; pending.current = {};
    if (!url) return;
    for (const [tab, readAt] of Object.entries(send)) {
      void fetch(url, { ...INIT, method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tab, readAt }), keepalive: true }).catch(() => undefined);
    }
  };
  const chatTab = tabs.chat, miloTab = tabs.milo;
  const newest = useMemo(() => ({
    chat: chatTab ? newestTime(messages, chatTab.counts) : null,
    milo: miloTab ? newestTime(messages, miloTab.counts) : null,
  }), [messages, chatTab, miloTab]);
  useEffect(() => {
    if (!callId || !viewerId || !visible) return;
    const marks: Partial<Record<CallChatReadTab, string>> = {};
    for (const tab of ['chat', 'milo'] as const) {
      const n = newest[tab];
      if (tabs[tab]?.seen && positions[tab] !== undefined && shouldMark(positions[tab], n)) marks[tab] = n;
    }
    if (!Object.keys(marks).length) return;
    setPositions((held) => ({ chat: laterPosition(held.chat, marks.chat), milo: laterPosition(held.milo, marks.milo) }));
    pending.current = { ...pending.current, ...marks };
    window.clearTimeout(timer.current);
    pendingUrl.current = readsUrl(base, callId);
    timer.current = window.setTimeout(flush, MARK_DEBOUNCE_MS);
  }, [base, callId, viewerId, visible, newest, positions, tabs.chat?.seen, tabs.milo?.seen]); // eslint-disable-line react-hooks/exhaustive-deps
  // Leaving the call or the page still writes what was marked.
  useEffect(() => () => { window.clearTimeout(timer.current); flush(); }, [base, callId]); // eslint-disable-line react-hooks/exhaustive-deps

  return useMemo(() => ({
    chat: chatTab ? unreadCount(messages, viewerId, positions.chat, chatTab.counts) : 0,
    milo: miloTab ? unreadCount(messages, viewerId, positions.milo, miloTab.counts) : 0,
  }), [messages, viewerId, positions, chatTab, miloTab]);
}

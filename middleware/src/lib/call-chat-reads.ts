// A call chat's read positions, per person and per pane tab: the "read up to here" a call's unread bubble counts from
// (portal hooks/useCallChatUnread.ts). One position per (call, person, tab):
//   - `chat`: the call chat itself. It is the library read receipt on `orgiq:huddle:<callId>` (the same cursor the
//     gateway's `read` frame moves and Social's conversations count their unread from, lib/social-chat.ts), so the
//     REST write and the gateway's agree and both only move forward.
//   - `milo`: Milo's lines, for a pane that shows them on their own tab (the interview room). Kept in the same store
//     under a name no socket can join (`orgiq:huddle:<callId>~reads~milo`), so it shares the chat's storage and retention.
// Authority is the call chat's own (`CallChatRuntime.assertMember`): only a current member of that call reads or moves
// their own position; another call's, another tenant's, a departed member's and a guest outside their interview's call
// are refused there. A position never moves backwards, and never past the server's clock.
import type { ChatReadReceiptStore } from '@connorhoehn/realtime-modules/chat';
import { ValidationError } from './async-handler.js';
import { callChatChannel } from './call-chat.js';
import type { Session } from './session.js';

export const CALL_CHAT_READ_TABS = ['chat', 'milo'] as const;
export type CallChatReadTab = typeof CALL_CHAT_READ_TABS[number];
export interface CallChatReadPosition { readAt: string; updatedAt: string }
export interface CallChatReads { callId: string; reads: Record<CallChatReadTab, CallChatReadPosition | null> }

export const isCallChatReadTab = (value: unknown): value is CallChatReadTab =>
  typeof value === 'string' && (CALL_CHAT_READ_TABS as readonly string[]).includes(value);
/** The store key for one tab's positions in a call. */
export const callChatReadChannel = (callId: string, tab: CallChatReadTab): string =>
  tab === 'chat' ? callChatChannel(callId) : `${callChatChannel(callId)}~reads~${tab}`;

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
/** A client clock a little ahead is clamped to now; a position well in the future is refused. */
const SKEW_MS = 5 * 60_000;

export interface CallChatReadsDeps {
  store: () => ChatReadReceiptStore;
  /** CallChatRuntime.assertMember: throws 403 unless the session is a current member of the call. */
  assertMember: (callId: string, session: Session) => Promise<void>;
  now?: () => Date;
}

export function callChatReads(deps: CallChatReadsDeps) {
  const now = () => (deps.now ?? (() => new Date()))();
  const mine = async (callId: string, tab: CallChatReadTab, userId: string): Promise<CallChatReadPosition | null> => {
    const rows = await deps.store().listReceipts(callChatReadChannel(callId, tab));
    const row = rows.find((r) => r.userId === userId);
    return row ? { readAt: row.readAt, updatedAt: row.updatedAt } : null;
  };
  const reads = async (callId: string, userId: string): Promise<CallChatReads> => {
    const [chat, milo] = await Promise.all(CALL_CHAT_READ_TABS.map((tab) => mine(callId, tab, userId)));
    return { callId, reads: { chat: chat ?? null, milo: milo ?? null } };
  };
  return {
    /** My positions in this call. */
    async get(callId: string, session: Session): Promise<CallChatReads> {
      await deps.assertMember(callId, session);
      return reads(callId, session.sub);
    },
    /** Move my position on `tab` up to `readAt` (the newest message I have seen). Behind the stored one: unchanged. */
    async mark(callId: string, session: Session, tab: unknown, readAt: unknown): Promise<CallChatReads> {
      if (!isCallChatReadTab(tab)) throw new ValidationError(`tab must be one of ${CALL_CHAT_READ_TABS.join(', ')}`);
      if (typeof readAt !== 'string' || !ISO.test(readAt) || Number.isNaN(Date.parse(readAt))) throw new ValidationError('readAt must be an ISO-8601 UTC time');
      const at = now();
      if (Date.parse(readAt) - at.getTime() > SKEW_MS) throw new ValidationError('readAt is in the future');
      await deps.assertMember(callId, session);
      const clamped = Date.parse(readAt) > at.getTime() ? at.toISOString() : readAt;
      await deps.store().advance({ channel: callChatReadChannel(callId, tab), userId: session.sub, readAt: clamped, updatedAt: at.toISOString(),
        ...(session.name ? { displayName: session.name } : {}) });
      return reads(callId, session.sub);
    },
  };
}
export type CallChatReadsService = ReturnType<typeof callChatReads>;

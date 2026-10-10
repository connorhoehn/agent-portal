// Gateway-connection helpers shared by every tenant's scoped discussion, next
// to ConversationThread which consumes them.

/** The offline notice for a conversation named by `noun` ("the discussion", "this conversation"). */
export function offlineReason(noun: string): string {
  return `The realtime gateway is not connected, so ${noun} is unavailable.`;
}

export const OFFLINE_REASON = offlineReason('the discussion');

/** Whether a gateway connection state allows sending; null = no gateway provider at all. */
export function isConnected(state: string | null | undefined): boolean {
  return state === 'connected';
}

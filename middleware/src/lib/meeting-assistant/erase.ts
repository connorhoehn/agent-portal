// Erasing a call's words (audit M2, M3): the stores' own rows, then Milo's messages in the call chat. One function, so the inviter's
// delete and the retention sweep leave the same things behind. Every step is safe to repeat.
import { eraseAssistantMessages } from './chat.js';
import type { AssistantStore } from './store.js';

/**
 * Delete the call's transcript and tombstone its minutes, blank the pending requests, tool arguments and result text, and replace Milo's
 * chat text. Returns the lines removed, or null when Milo is in the call again (it was invited back after the caller looked): then
 * nothing is erased, the chat included; the store's check is part of its erase step.
 */
export async function eraseCall(store: AssistantStore, callId: string, by: string, at: number): Promise<number | null> {
  const lines = await store.tombstoneMinutes(callId, by, at);
  if (lines === null) return null;
  await eraseAssistantMessages(callId);
  return lines;
}

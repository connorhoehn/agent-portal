// Erasing a call's words (audit M2, M3): the stores' own rows, then Nova's messages in the call chat. One function, so the inviter's
// delete and the retention sweep leave the same things behind. Every step is safe to repeat.
import { eraseAssistantMessages } from './chat.js';
import type { AssistantStore } from './store.js';

/** Delete the call's transcript and tombstone its minutes, blank the pending requests, tool arguments and result text, and replace Nova's chat text. Returns the lines removed. */
export async function eraseCall(store: AssistantStore, callId: string, by: string, at: number): Promise<number> {
  const lines = await store.tombstoneMinutes(callId, by, at);
  await eraseAssistantMessages(callId);
  return lines;
}

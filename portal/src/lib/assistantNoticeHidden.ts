// Whether this person closed the transcription notice with its own close mark (which hides it without acknowledging).
// The Milo mark reads it: while the notice is up it is the prompt; once hidden, the mark says Milo cannot hear them yet.
import { useSyncExternalStore } from 'react';

const hidden = new Set<string>();
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

/** The notice is closed per period of Milo in the call: after Milo is invited back everyone acknowledges again, so it shows again. */
export const noticeKey = (callId: string | null, period: number): string | null => (callId ? `${callId}#${period}` : null);

export function hideAssistantNotice(callId: string): void {
  if (hidden.has(callId)) return;
  hidden.add(callId);
  for (const fn of listeners) fn();
}

export function useAssistantNoticeHidden(callId: string | null): boolean {
  return useSyncExternalStore(subscribe, () => !!callId && hidden.has(callId), () => false);
}

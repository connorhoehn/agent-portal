// Whether this person closed the transcription notice with its own close mark (which hides it without acknowledging).
// The Nova mark reads it: while the notice is up it is the prompt; once hidden, the mark says Nova cannot hear them yet.
import { useSyncExternalStore } from 'react';

const hidden = new Set<string>();
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

export function hideNovaNotice(callId: string): void {
  if (hidden.has(callId)) return;
  hidden.add(callId);
  for (const fn of listeners) fn();
}

export function useNovaNoticeHidden(callId: string | null): boolean {
  return useSyncExternalStore(subscribe, () => !!callId && hidden.has(callId), () => false);
}

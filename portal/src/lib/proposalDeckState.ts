// What this browser remembers about the proposal prompt in the footer deck, per call: whether the person hid it (Esc), and which
// answered proposals they chose to keep as answered (so the withdraw card stops asking). Nothing here reaches the server; a reload
// shows the prompt again. The deck and the count on Nova's footer mark both read it, so the count reopens what Esc hid.
import { useSyncExternalStore } from 'react';

interface CallDeck { hidden: boolean; kept: ReadonlySet<string> }
const EMPTY: CallDeck = { hidden: false, kept: new Set() };
const decks = new Map<string, CallDeck>();
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
const set = (callId: string, patch: Partial<CallDeck>) => {
  decks.set(callId, { ...(decks.get(callId) ?? EMPTY), ...patch });
  for (const fn of listeners) fn();
};

export function setProposalDeckHidden(callId: string, hidden: boolean): void {
  if ((decks.get(callId) ?? EMPTY).hidden !== hidden) set(callId, { hidden });
}

export function keepProposalAnswer(callId: string, key: string): void {
  const kept = new Set((decks.get(callId) ?? EMPTY).kept);
  kept.add(key);
  set(callId, { kept });
}

export function useProposalDeck(callId: string | null): CallDeck {
  return useSyncExternalStore(subscribe, () => (callId ? decks.get(callId) ?? EMPTY : EMPTY), () => EMPTY);
}

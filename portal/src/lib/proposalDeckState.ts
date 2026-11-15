// What this browser remembers about the proposal prompt in the footer deck, per call: whether the person hid it (Esc), which
// proposals they set aside ("Not now", "Skip": kept in sessionStorage, so a reload does not ask again in this tab), and which
// proposals waiting on them it has already seen (a NEW one shows the deck again, even after Esc). Nothing here reaches the server.
// The deck, the count on Nova's footer mark and the card's "Answer" all read or set it.
import { useSyncExternalStore } from 'react';

interface CallDeck { hidden: boolean; kept: ReadonlySet<string>; seen: ReadonlySet<string> }
const EMPTY: CallDeck = { hidden: false, kept: new Set(), seen: new Set() };
const decks = new Map<string, CallDeck>();
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

const storageKey = (callId: string): string => `nova-proposal-kept:${callId}`;
/** Storage can be missing or refuse (a private window, blocked site data): the deck then forgets on reload, nothing more. */
function readKept(callId: string): Set<string> {
  try {
    const raw = globalThis.sessionStorage?.getItem(storageKey(callId));
    const list: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string').slice(-200) : []);
  } catch { return new Set(); }
}
function writeKept(callId: string, kept: ReadonlySet<string>): void {
  try { globalThis.sessionStorage?.setItem(storageKey(callId), JSON.stringify([...kept].slice(-200))); } catch { /* remembered for this page only */ }
}

const get = (callId: string): CallDeck => {
  let d = decks.get(callId);
  if (!d) { d = { ...EMPTY, kept: readKept(callId) }; decks.set(callId, d); }
  return d;
};
const set = (callId: string, patch: Partial<CallDeck>) => {
  decks.set(callId, { ...get(callId), ...patch });
  for (const fn of listeners) fn();
};

export function setProposalDeckHidden(callId: string, hidden: boolean): void {
  if (get(callId).hidden !== hidden) set(callId, { hidden });
}

export function keepProposalAnswer(callId: string, key: string): void {
  const kept = new Set(get(callId).kept);
  kept.add(key);
  writeKept(callId, kept);
  set(callId, { kept });
}

/**
 * The proposals now waiting on this person. One not seen before shows the deck again (it never takes focus: the prompt says
 * `focusOnArrive: false`).
 */
export function noteWaitingProposals(callId: string, ids: readonly string[]): void {
  const d = get(callId);
  const fresh = ids.filter((id) => !d.seen.has(id));
  if (!fresh.length) return;
  set(callId, { seen: new Set([...d.seen, ...fresh]), hidden: false });
}

/** Tests start clean (and stand for a reload: memory goes, the tab's storage stays). */
export function forgetProposalDecks(): void { decks.clear(); }

/** The call's deck state as the hook reads it. */
export const proposalDeckOf = (callId: string): CallDeck => get(callId);

export function useProposalDeck(callId: string | null): CallDeck {
  // The first read loads what this tab set aside; the same object is returned until something changes.
  return useSyncExternalStore(subscribe, () => (callId ? proposalDeckOf(callId) : EMPTY), () => EMPTY);
}

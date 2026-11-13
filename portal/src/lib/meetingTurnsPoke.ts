// A confirmed card should not wait for the next 2 s tick: the card's decision pokes the turn runner for that call.
const listeners = new Map<string, Set<() => void>>();

export function onTurnsPoke(callId: string, fn: () => void): () => void {
  const set = listeners.get(callId) ?? new Set<() => void>();
  set.add(fn); listeners.set(callId, set);
  return () => { set.delete(fn); };
}

export function pokeTurns(callId: string): void {
  for (const fn of listeners.get(callId) ?? []) fn();
}

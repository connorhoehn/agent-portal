// Pure scheduling helpers for useFetch's poll loop, split out so they can be
// unit tested with plain `node --test` — useFetch.ts itself pulls in React
// and can't be mounted without a DOM, but the arithmetic it leans on has no
// such dependency and is exactly the part worth pinning.

/**
 * How long to wait before the NEXT poll after `failures` consecutive
 * fetch failures, given the caller's base interval.
 *
 * Doubles per consecutive failure, capped at 5x the base interval — enough
 * to stop a dead endpoint from hammering the network every `pollIntervalMs`
 * forever, without backing off so far that a brief blip takes minutes to
 * notice recovering. Reset to `failures = 0` happens on the first success,
 * so a poll returns to its normal cadence immediately once the endpoint is
 * healthy again.
 */
export function nextPollDelay(failures: number, baseMs: number): number {
  if (!Number.isFinite(baseMs) || baseMs <= 0) return baseMs;
  if (!Number.isFinite(failures) || failures <= 0) return baseMs;
  const factor = Math.min(2 ** failures, 5);
  return baseMs * factor;
}

/** True while the tab is in the background and polling should pause. */
export function isDocumentHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

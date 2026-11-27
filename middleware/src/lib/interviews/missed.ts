// A missed round (gap audit 2026-11-20, "Thin scheduling"; ledger row C-17): a round still waiting to go live whose
// scheduled start is more than its own length in the past. Nobody started it and its window is over, so the lists say
// "Missed" instead of leaving it in Upcoming as if it were still to come.
//
// Computed in the read from the tenant's clock (clock.ts), never stored: no state, no column. A missed round keeps every
// action it had: it can still be cancelled or marked as not having taken place (cancel.ts), re-seated or given a new
// time, and a new time in the future makes it upcoming again.

import type { Interview, InterviewState } from './types.js';

/** The states before the call starts. */
const NOT_YET_LIVE: ReadonlySet<InterviewState> = new Set(['assigned', 'accepted', 'ready']);

/** Is `i` missed at `nowMs`? Exactly at the end of its window it is not yet; a moment later it is. */
export function isMissed(i: Pick<Interview, 'state' | 'scheduledAt' | 'minutes'>, nowMs: number): boolean {
  if (!NOT_YET_LIVE.has(i.state) || !i.scheduledAt) return false;
  const start = Date.parse(i.scheduledAt);
  return Number.isFinite(start) && nowMs - start > Math.max(i.minutes, 0) * 60_000;
}

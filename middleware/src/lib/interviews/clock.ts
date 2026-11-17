// The interviews tenant's clock: the one place its code reads the time.
//
// In every real run this is the wall clock. In the mock world a walk can move it ahead (routes/mock-control.ts,
// POST /api/__mock/interviews/clock) to reach states that depend on time without waiting for them: a link past
// its ceiling, an interview starting soon, media past its retention period, a deletion request that is late.
//
// What reads it: link and guest-session expiry, admission, "starting soon", the retention sweeps and the stamps
// the tenant's own writes carry (assigned, answered, ended, scored, decided, written, asked, erased).
// What does not: ids, the invite exchange's rate limit and timing floor, staff sessions, spend holds and the
// meeting assistant (a transcript line's time and Milo's listening limit stay on the wall clock), so a walk puts
// the clock back before it runs a live call.
//
// The offset can only be set through setInterviewsClockOffset, which refuses outside the mock plane.

let offsetMs = 0;

/** Epoch milliseconds, as the interviews code reads it. */
export function interviewsNowMs(): number {
  return Date.now() + offsetMs;
}

/** The same instant as a Date. */
export function interviewsNow(): Date {
  return new Date(interviewsNowMs());
}

/** How far ahead of (or behind) the wall clock the interviews clock runs; 0 everywhere but a mock walk. */
export function interviewsClockOffsetMs(): number {
  return offsetMs;
}

/** The longest a walk may move the clock either way: ten years covers the four-year retention period twice. */
export const MAX_CLOCK_OFFSET_MS = 10 * 366 * 86_400_000;

/**
 * Move the interviews clock. `mockPlane` must be true (the caller is the mock control router, behind its own
 * gate): anywhere else the clock is the wall clock and stays so. Returns whether the offset was taken.
 */
export function setInterviewsClockOffset(ms: number, mockPlane: boolean): boolean {
  if (!mockPlane || !Number.isFinite(ms) || Math.abs(ms) > MAX_CLOCK_OFFSET_MS) return false;
  offsetMs = Math.trunc(ms);
  return true;
}

/** Back to the wall clock (a mock reset, and after each test that moved it). */
export function resetInterviewsClock(): void {
  offsetMs = 0;
}

// The one clock every fixture reads. See contract.ts for the rules.
//
// Bug #3 in the contract header — "import-time timestamps" — is a property of
// WHEN a timestamp is computed, not of how it is formatted. A fixture that
// writes `new Date(Date.now() - 3 * HOUR).toISOString()` at module scope bakes
// the answer at import; the module then insists a run happened three hours
// before the process started, however long ago that was. Every helper here is
// a function, so a fixture that calls it inside its rows factory samples the
// clock at READ time.
//
// Everything below buckets in **UTC**, deliberately. Aurora truncates with
// `date_trunc('day', NOW())` in the session timezone, which is UTC (no TimeZone
// override in the cluster parameter group), so the real predicate behind every
// "today" number is a UTC one. A mock that bucketed in local time agreed with
// Aurora only on a UTC laptop — providers/bots.ts's `deriveBotStats` shipped
// exactly that bug, and the run stamped "3 hours ago" fell out of "today" for
// the first three local hours after midnight.

import type { FreezeClock, MockClock } from './contract.js';

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/**
 * Frozen instant in epoch ms, or `null` when the clock runs free. A stack, so
 * a freeze inside a freeze restores to the outer one rather than to wall time.
 */
const frozenStack: number[] = [];

function currentMs(): number {
  return frozenStack.length > 0 ? frozenStack[frozenStack.length - 1]! : Date.now();
}

/**
 * Epoch ms of UTC midnight for the day containing `at`. The single definition
 * of "the day started here" — clock.hoursAgo's clamp and derive.todayInUtc's
 * filter both call it, so the write side and the read side cannot disagree.
 */
export function utcDayStartMs(at: Date | number = currentMs()): number {
  const d = at instanceof Date ? at : new Date(at);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Ms elapsed since UTC midnight — i.e. how far back "today" actually extends. */
export function msSinceUtcMidnight(at: Date | number = currentMs()): number {
  const ms = at instanceof Date ? at.getTime() : at;
  return ms - utcDayStartMs(ms);
}

export const clock: MockClock = {
  now(): Date {
    return new Date(currentMs());
  },

  nowIso(): string {
    return new Date(currentMs()).toISOString();
  },

  /**
   * An instant `hours` before now.
   *
   * With `keepWithinToday`, the offset is clamped to the elapsed part of the
   * UTC day, so a row meant to read as "today" ("2 runs today", "last synced
   * this morning") can never land in yesterday just because the process booted
   * near UTC midnight. The age is narrative flavor; the day is the claim, and
   * the clamp keeps the claim true. Arithmetic is in integer ms, so the
   * clamped result is exactly UTC midnight in the worst case — still today,
   * with no epsilon fudge that could round the wrong way.
   */
  hoursAgo(hours: number, opts?: { keepWithinToday?: boolean }): string {
    const now = currentMs();
    // Never return the future: a negative age is a caller mistake, not a
    // request for tomorrow.
    let offsetMs = Math.max(0, hours * HOUR_MS);
    if (opts?.keepWithinToday) {
      offsetMs = Math.min(offsetMs, msSinceUtcMidnight(now));
    }
    return new Date(now - offsetMs).toISOString();
  },

  daysAgo(days: number): string {
    return new Date(currentMs() - Math.max(0, days) * DAY_MS).toISOString();
  },
};

/** Alias for import sites where a bare `clock` would read ambiguously. */
export const mockClock: MockClock = clock;

/**
 * Freeze the clock at `at`; the returned function restores the previous state.
 * Restore is idempotent and order-independent — calling an outer restore first
 * drops the inner freeze with it, so a test that forgets one in a failure path
 * cannot leak a frozen clock into the next test.
 */
export const freezeClock: FreezeClock = (at: Date | string) => {
  const ms = at instanceof Date ? at.getTime() : new Date(at).getTime();
  if (Number.isNaN(ms)) {
    throw new Error(`freezeClock: not a valid instant: ${String(at)}`);
  }
  const depth = frozenStack.length;
  frozenStack.push(ms);
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    frozenStack.length = Math.min(frozenStack.length, depth);
  };
};

/** True while a test holds the clock. Fixtures never need this; guards do. */
export function isClockFrozen(): boolean {
  return frozenStack.length > 0;
}

/** Escape hatch for `afterEach` — drops every outstanding freeze. */
export function unfreezeClock(): void {
  frozenStack.length = 0;
}

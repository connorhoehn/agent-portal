// The clock, and the midnight bug it exists to make impossible.
//
// The shipped version of this bug: a fixture stamped a run "3 hours ago" to
// mean "earlier today". Read at 00:05 UTC that lands at 21:05 the previous
// day, so the row drops out of every "today" bucket — and because the bucket
// was correct and the fixture was correct in isolation, the only symptom was
// a demo that read "0 runs today" for the first few hours after midnight.

import { clock, freezeClock, unfreezeClock, isClockFrozen, msSinceUtcMidnight, utcDayStartMs, HOUR_MS, DAY_MS } from '../clock.js';

const SUNDAY_0005 = '2026-09-06T00:05:00.000Z'; // getUTCDay() === 0
const WEDNESDAY_AFTERNOON = '2026-09-09T15:30:00.000Z'; // getUTCDay() === 3

function utcDate(iso: string): string {
  return iso.slice(0, 10);
}

afterEach(() => unfreezeClock());

describe('freezeClock', () => {
  it('pins now()/nowIso() to the frozen instant and restores wall time', () => {
    const before = Date.now();
    const restore = freezeClock(WEDNESDAY_AFTERNOON);
    expect(clock.nowIso()).toBe(WEDNESDAY_AFTERNOON);
    expect(clock.now().getTime()).toBe(Date.parse(WEDNESDAY_AFTERNOON));
    expect(isClockFrozen()).toBe(true);

    restore();
    expect(isClockFrozen()).toBe(false);
    expect(clock.now().getTime()).toBeGreaterThanOrEqual(before);
  });

  it('accepts a Date, nests, and ignores a double restore', () => {
    const outer = freezeClock(new Date(SUNDAY_0005));
    const inner = freezeClock(WEDNESDAY_AFTERNOON);
    expect(clock.nowIso()).toBe(WEDNESDAY_AFTERNOON);

    inner();
    inner(); // idempotent — must not pop the outer freeze
    expect(clock.nowIso()).toBe(SUNDAY_0005);

    outer();
    expect(isClockFrozen()).toBe(false);
  });

  it('rejects an instant it cannot parse rather than freezing at NaN', () => {
    expect(() => freezeClock('not a date')).toThrow(/valid instant/);
    expect(isClockFrozen()).toBe(false);
  });
});

describe('hoursAgo at Sunday 00:05 UTC — five minutes into the day', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = freezeClock(SUNDAY_0005);
  });
  afterEach(() => restore());

  it('is a Sunday, and only five minutes of the UTC day have elapsed', () => {
    expect(clock.now().getUTCDay()).toBe(0);
    expect(msSinceUtcMidnight()).toBe(5 * 60_000);
  });

  it('keepWithinToday clamps a 3-hour offset to UTC midnight — still today', () => {
    const ts = clock.hoursAgo(3, { keepWithinToday: true });
    expect(ts).toBe('2026-09-06T00:00:00.000Z');
    expect(utcDate(ts)).toBe('2026-09-06');
    expect(Date.parse(ts)).toBeGreaterThanOrEqual(utcDayStartMs());
  });

  it('without the flag the SAME offset falls into Saturday — the shipped bug', () => {
    const ts = clock.hoursAgo(3);
    expect(ts).toBe('2026-09-05T21:05:00.000Z');
    expect(utcDate(ts)).toBe('2026-09-05');
    expect(Date.parse(ts)).toBeLessThan(utcDayStartMs());
  });

  it('clamps a 14-hour offset too (the nightly-maintenance case)', () => {
    expect(clock.hoursAgo(14, { keepWithinToday: true })).toBe('2026-09-06T00:00:00.000Z');
  });

  it('never returns an instant later than now', () => {
    expect(Date.parse(clock.hoursAgo(0, { keepWithinToday: true }))).toBe(clock.now().getTime());
    expect(Date.parse(clock.hoursAgo(-5))).toBe(clock.now().getTime());
  });
});

describe('hoursAgo at Wednesday afternoon', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = freezeClock(WEDNESDAY_AFTERNOON);
  });
  afterEach(() => restore());

  it('does not clamp when the day has room — the offset is exact', () => {
    expect(clock.hoursAgo(3, { keepWithinToday: true })).toBe('2026-09-09T12:30:00.000Z');
    expect(clock.hoursAgo(3)).toBe('2026-09-09T12:30:00.000Z');
  });

  it('clamps only once the offset would cross midnight backwards', () => {
    expect(clock.hoursAgo(15, { keepWithinToday: true })).toBe('2026-09-09T00:30:00.000Z');
    expect(clock.hoursAgo(16, { keepWithinToday: true })).toBe('2026-09-09T00:00:00.000Z');
    expect(clock.hoursAgo(16)).toBe('2026-09-08T23:30:00.000Z');
  });
});

describe('hoursAgo never crosses UTC midnight backwards, at any hour of the day', () => {
  // The bug was time-of-day dependent, so the regression test has to be too:
  // one assertion at one instant would have passed all afternoon.
  const offsets = [0.5, 1, 3, 6, 14, 23, 47];

  it.each(offsets)('holds for a %s-hour offset across all 24 hours + boundaries', (hours) => {
    for (let minute = 0; minute < 24 * 60; minute += 7) {
      const at = new Date(Date.UTC(2026, 8, 6) + minute * 60_000);
      const restore = freezeClock(at);
      const ts = clock.hoursAgo(hours, { keepWithinToday: true });
      restore();
      expect(utcDate(ts)).toBe('2026-09-06');
      expect(Date.parse(ts)).toBeGreaterThanOrEqual(Date.UTC(2026, 8, 6));
      expect(Date.parse(ts)).toBeLessThanOrEqual(at.getTime());
    }
  });

  it('holds at the exact instant of midnight (offset clamps to zero)', () => {
    const restore = freezeClock(new Date(Date.UTC(2026, 8, 6)));
    expect(clock.hoursAgo(3, { keepWithinToday: true })).toBe('2026-09-06T00:00:00.000Z');
    restore();
  });
});

describe('daysAgo', () => {
  it('subtracts whole days from the frozen instant', () => {
    const restore = freezeClock(WEDNESDAY_AFTERNOON);
    expect(clock.daysAgo(2)).toBe('2026-09-07T15:30:00.000Z');
    expect(clock.daysAgo(0)).toBe(WEDNESDAY_AFTERNOON);
    expect(Date.parse(clock.daysAgo(30))).toBe(Date.parse(WEDNESDAY_AFTERNOON) - 30 * DAY_MS);
    restore();
  });

  it('never returns the future', () => {
    const restore = freezeClock(WEDNESDAY_AFTERNOON);
    expect(clock.daysAgo(-3)).toBe(WEDNESDAY_AFTERNOON);
    restore();
  });
});

describe('utcDayStartMs / msSinceUtcMidnight', () => {
  it('truncates in UTC regardless of the host timezone', () => {
    const at = new Date('2026-09-09T15:30:00.000Z');
    expect(new Date(utcDayStartMs(at)).toISOString()).toBe('2026-09-09T00:00:00.000Z');
    expect(msSinceUtcMidnight(at)).toBe(15.5 * HOUR_MS);
  });

  it('defaults to the (possibly frozen) current instant', () => {
    const restore = freezeClock(SUNDAY_0005);
    expect(new Date(utcDayStartMs()).toISOString()).toBe('2026-09-06T00:00:00.000Z');
    restore();
  });
});

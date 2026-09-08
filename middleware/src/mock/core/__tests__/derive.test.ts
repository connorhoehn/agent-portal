// The selectors — the reason no fixture ever has to type a count.
//
// Contract bug #1 is a stored number that used to be right: "5 bots" over an
// empty table, "6 pending" above 5 cards, a 25-error summary the list could
// not produce. Each of those is one `countBy` call away from being impossible.

import { clock, freezeClock, unfreezeClock } from '../clock.js';
import { countBy, groupBy, latestBy, sumBy, toRecord, todayInUtc } from '../derive.js';

interface Run {
  id: string;
  botId: string;
  status: 'ok' | 'failed' | 'skipped';
  costUsd: number | null;
  startedAt: string | null;
}

const RUNS: Run[] = [
  { id: 'r1', botId: 'b1', status: 'ok', costUsd: 0.1, startedAt: '2026-09-09T09:00:00.000Z' },
  { id: 'r2', botId: 'b1', status: 'failed', costUsd: 0.2, startedAt: '2026-09-09T11:00:00.000Z' },
  { id: 'r3', botId: 'b2', status: 'ok', costUsd: null, startedAt: '2026-09-08T23:59:59.999Z' },
  { id: 'r4', botId: 'b2', status: 'ok', costUsd: 0.05, startedAt: '2026-09-09T00:00:00.000Z' },
  { id: 'r5', botId: 'b3', status: 'skipped', costUsd: 0, startedAt: null },
];

afterEach(() => unfreezeClock());

describe('countBy', () => {
  it('counts by field name and by selector, identically', () => {
    expect(toRecord(countBy(RUNS, 'status'))).toEqual({ ok: 3, failed: 1, skipped: 1 });
    expect(toRecord(countBy(RUNS, (r) => r.status))).toEqual({ ok: 3, failed: 1, skipped: 1 });
  });

  it('returns an empty map for no rows — the "5 bots over an empty table" case', () => {
    const counts = countBy([] as Run[], 'status');
    expect(counts.size).toBe(0);
    expect(counts.get('ok')).toBeUndefined();
    expect(toRecord(counts)).toEqual({});
  });

  it('survives a key that would corrupt a plain object', () => {
    const rows = [{ k: '__proto__' }, { k: '__proto__' }, { k: 'constructor' }];
    const counts = countBy(rows, 'k');
    expect(counts.get('__proto__')).toBe(2);
    expect(counts.get('constructor')).toBe(1);
    // The Record form keeps them as real own keys — on a `{}`-based accumulator
    // the `__proto__` bucket is swallowed by the prototype setter instead.
    const record = toRecord(counts);
    expect(Object.keys(record).sort()).toEqual(['__proto__', 'constructor']);
    expect(record['__proto__']).toBe(2);
    expect(record['constructor']).toBe(1);
  });
});

describe('sumBy', () => {
  it('sums a numeric field, treating null/undefined as absent rather than NaN', () => {
    expect(sumBy(RUNS, 'costUsd')).toBeCloseTo(0.35, 10);
    expect(sumBy([{ v: null }, { v: undefined }], 'v')).toBe(0);
    expect(sumBy([] as Run[], 'costUsd')).toBe(0);
  });

  it('rounds to the requested precision, for money', () => {
    const cents = [{ v: 0.1 }, { v: 0.2 }];
    expect(sumBy(cents, 'v')).not.toBe(0.3); // float reality
    expect(sumBy(cents, 'v', { digits: 2 })).toBe(0.3);
    expect(sumBy(RUNS, (r) => r.costUsd, { digits: 2 })).toBe(0.35);
  });

  it('skips a NaN/Infinity row instead of poisoning the total', () => {
    expect(sumBy([{ v: 1 }, { v: Number.NaN }, { v: Number.POSITIVE_INFINITY }, { v: 2 }], 'v')).toBe(3);
  });
});

describe('groupBy', () => {
  it('groups rows in first-seen key order, keeping row order within a group', () => {
    const byBot = groupBy(RUNS, 'botId');
    expect([...byBot.keys()]).toEqual(['b1', 'b2', 'b3']);
    expect(byBot.get('b1')!.map((r) => r.id)).toEqual(['r1', 'r2']);
    expect(byBot.get('b2')!).toHaveLength(2);
    expect(byBot.get('missing')).toBeUndefined();
  });

  it('supports a computed key', () => {
    const byOutcome = groupBy(RUNS, (r) => (r.status === 'failed' ? 'bad' : 'good'));
    expect(byOutcome.get('bad')!.map((r) => r.id)).toEqual(['r2']);
    expect(byOutcome.get('good')).toHaveLength(4);
  });

  it('countBy and groupBy agree — one cannot report more than the other holds', () => {
    const grouped = groupBy(RUNS, 'botId');
    for (const [key, count] of countBy(RUNS, 'botId')) {
      expect(grouped.get(key)!).toHaveLength(count);
    }
  });
});

describe('latestBy', () => {
  it('returns the newest row', () => {
    expect(latestBy(RUNS, 'startedAt')!.id).toBe('r2');
  });

  it('returns undefined for no rows, and for rows with no usable timestamp', () => {
    expect(latestBy([] as Run[], 'startedAt')).toBeUndefined();
    expect(latestBy([{ startedAt: null }, { startedAt: 'nonsense' }], 'startedAt')).toBeUndefined();
  });

  it('never lets an unparseable timestamp win — "last run: 1970"', () => {
    const rows = [
      { id: 'bad', ts: 'not-a-date' },
      { id: 'good', ts: '2026-09-09T09:00:00.000Z' },
    ];
    expect(latestBy(rows, 'ts')!.id).toBe('good');
    expect(latestBy([...rows].reverse(), 'ts')!.id).toBe('good');
  });

  it('accepts Date and epoch-ms timestamps, and keeps the first of a tie', () => {
    const rows = [
      { id: 'a', ts: new Date('2026-09-09T09:00:00.000Z') },
      { id: 'b', ts: new Date('2026-09-09T09:00:00.000Z') },
    ];
    expect(latestBy(rows, 'ts')!.id).toBe('a');
    expect(latestBy([{ id: 'x', ts: 1 }, { id: 'y', ts: 2 }], 'ts')!.id).toBe('y');
  });
});

describe('todayInUtc — the one definition of "today"', () => {
  it('includes UTC midnight exactly and excludes the millisecond before it', () => {
    const restore = freezeClock('2026-09-09T15:30:00.000Z');
    const today = todayInUtc(RUNS, 'startedAt');
    // r4 is stamped 00:00:00.000Z today; r3 is 23:59:59.999Z yesterday. A
    // local-time bucket on any host east or west of UTC gets one of these
    // wrong — that is the drift from Aurora's date_trunc('day', NOW()).
    expect(today.map((r) => r.id)).toEqual(['r1', 'r2', 'r4']);
    restore();
  });

  it('drops rows with a missing or unparseable timestamp', () => {
    const restore = freezeClock('2026-09-09T15:30:00.000Z');
    expect(todayInUtc(RUNS, 'startedAt').some((r) => r.id === 'r5')).toBe(false);
    expect(todayInUtc([{ ts: 'nope' }], 'ts')).toEqual([]);
    restore();
  });

  it('pairs with hoursAgo({ keepWithinToday }) at 00:05 UTC — both halves of the midnight bug', () => {
    const restore = freezeClock('2026-09-06T00:05:00.000Z');
    const rows = [
      { id: 'clamped', ts: clock.hoursAgo(3, { keepWithinToday: true }) },
      { id: 'unclamped', ts: clock.hoursAgo(3) },
    ];
    // The row a fixture MEANT as "earlier today" is today; the naive one is not.
    expect(todayInUtc(rows, 'ts').map((r) => r.id)).toEqual(['clamped']);
    restore();
  });

  it('honours an explicit `now` and defaults to the frozen clock', () => {
    const restore = freezeClock('2026-09-08T12:00:00.000Z');
    expect(todayInUtc(RUNS, 'startedAt').map((r) => r.id)).toEqual(['r3']);
    expect(
      todayInUtc(RUNS, 'startedAt', { now: new Date('2026-09-09T15:30:00.000Z') }).map((r) => r.id),
    ).toEqual(['r1', 'r2', 'r4']);
    restore();
  });

  it('excludes tomorrow — the window is half-open, so a future row cannot inflate today', () => {
    const restore = freezeClock('2026-09-08T12:00:00.000Z');
    expect(todayInUtc(RUNS, 'startedAt').map((r) => r.id)).toEqual(['r3']);
    restore();
  });

  it('returns nothing when nothing is from today, rather than falling back to all rows', () => {
    const restore = freezeClock('2026-09-20T00:00:00.000Z');
    expect(todayInUtc(RUNS, 'startedAt')).toEqual([]);
    restore();
  });
});

describe('toRecord', () => {
  it('converts a Map aggregate for the wire, stringifying numeric keys', () => {
    expect(toRecord(new Map([['a', 1]]))).toEqual({ a: 1 });
    expect(toRecord(new Map([[2026, 4]]))).toEqual({ '2026': 4 });
    expect(JSON.stringify(toRecord(countBy(RUNS, 'botId')))).toBe('{"b1":2,"b2":2,"b3":1}');
  });
});

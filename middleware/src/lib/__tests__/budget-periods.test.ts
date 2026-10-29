// DE-38: the one budget window helper, pure. Every instant here is pinned
// through the mock clock (freezeClock), the way the providers read it.

import { clock, freezeClock } from '../../mock/core/index.js';
import {
  budgetedAllocation, carryOut, closesAtBoundary, currentPeriod, currentSprint, effectiveAllocation,
  inBounds, isBudgetPeriod, previousPeriod, sprintBounds, type SprintSpan,
} from '../budget-periods.js';

const iso = (d: Date) => d.toISOString();
let restore: () => void = () => undefined;
afterEach(() => restore());
const at = (instant: string): Date => { restore(); restore = freezeClock(instant); return clock.now(); };

describe('currentPeriod — monthly (the default)', () => {
  it('a missing policy is the calendar month, keyed YYYY-MM', () => {
    const w = currentPeriod(null, at('2026-10-29T15:00:00Z'));
    expect({ start: iso(w.start), end: iso(w.end), key: w.key, state: w.state, period: w.period }).toEqual({
      start: '2026-10-01T00:00:00.000Z', end: '2026-11-01T00:00:00.000Z', key: '2026-10', state: 'open', period: 'monthly',
    });
  });

  it('turns over at UTC midnight on the 1st, not a millisecond early', () => {
    expect(currentPeriod({ period: 'monthly' }, at('2026-10-31T23:59:59.999Z')).key).toBe('2026-10');
    expect(currentPeriod({ period: 'monthly' }, at('2026-11-01T00:00:00.000Z')).key).toBe('2026-11');
  });

  it('crosses the year', () => {
    const w = currentPeriod({ period: 'monthly' }, at('2026-12-31T12:00:00Z'));
    expect([w.key, iso(w.end)]).toEqual(['2026-12', '2027-01-01T00:00:00.000Z']);
    expect(previousPeriod({ period: 'monthly' }, at('2027-01-01T00:00:00Z'))!.key).toBe('2026-12');
  });
});

describe('currentPeriod — quarterly', () => {
  it('is the calendar quarter, keyed YYYY-Qn, and turns over on the quarter boundary', () => {
    const q4 = currentPeriod({ period: 'quarterly' }, at('2026-10-29T00:00:00Z'));
    expect([iso(q4.start), iso(q4.end), q4.key]).toEqual(['2026-10-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z', '2026-Q4']);
    expect(currentPeriod({ period: 'quarterly' }, at('2026-09-30T23:59:59.999Z')).key).toBe('2026-Q3');
    expect(currentPeriod({ period: 'quarterly' }, at('2027-01-01T00:00:00Z')).key).toBe('2027-Q1');
  });

  it('the previous quarter crosses the year backwards', () => {
    const p = previousPeriod({ period: 'quarterly' }, at('2027-02-10T00:00:00Z'))!;
    expect([p.key, iso(p.start), iso(p.end)]).toEqual(['2026-Q4', '2026-10-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z']);
  });
});

describe('currentPeriod — sprint', () => {
  const sprints: SprintSpan[] = [
    { id: 'spr-1', startsOn: '2026-10-01', endsOn: '2026-10-14', status: 'done' },
    { id: 'spr-2', startsOn: '2026-10-15', endsOn: '2026-10-28', status: 'active' },
    { id: 'spr-3', startsOn: '2026-11-02', endsOn: '2026-11-15', status: 'planned' },
  ];

  it('is the sprint containing now, [starts_on, ends_on + 1 day), keyed by its id', () => {
    const w = currentPeriod({ period: 'sprint' }, at('2026-10-20T09:00:00Z'), sprints);
    expect([w.key, iso(w.start), iso(w.end), w.state]).toEqual(['spr-2', '2026-10-15T00:00:00.000Z', '2026-10-29T00:00:00.000Z', 'open']);
  });

  it('includes the whole last day (ends_on is inclusive) and excludes the next midnight', () => {
    expect(currentPeriod({ period: 'sprint' }, at('2026-10-28T23:59:59.999Z'), sprints).key).toBe('spr-2');
    expect(currentPeriod({ period: 'sprint' }, at('2026-10-29T00:00:00.000Z'), sprints).state).toBe('between-sprints');
  });

  it('turns over on the first day of the next sprint, and the previous period is the sprint before', () => {
    const now = at('2026-10-15T00:00:00Z');
    expect(currentPeriod({ period: 'sprint' }, now, sprints).key).toBe('spr-2');
    expect(previousPeriod({ period: 'sprint' }, now, sprints)!.key).toBe('spr-1');
  });

  it('between sprints there is no current period: no key, the month as the spend window', () => {
    const now = at('2026-10-31T12:00:00Z');
    const w = currentPeriod({ period: 'sprint' }, now, sprints);
    expect([w.key, w.state, iso(w.start), iso(w.end)]).toEqual([null, 'between-sprints', '2026-10-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z']);
    expect(previousPeriod({ period: 'sprint' }, now, sprints)!.key).toBeNull();
  });

  it('the first sprint has no previous period', () => {
    expect(previousPeriod({ period: 'sprint' }, at('2026-10-05T00:00:00Z'), sprints)).toBeNull();
  });

  it('two sprints containing now: active wins, then the latest start, then the larger id', () => {
    const overlap: SprintSpan[] = [
      { id: 'spr-a', startsOn: '2026-10-01', endsOn: '2026-10-31', status: 'planned' },
      { id: 'spr-b', startsOn: '2026-10-10', endsOn: '2026-10-31', status: 'planned' },
      { id: 'spr-c', startsOn: '2026-10-05', endsOn: '2026-10-31', status: 'active' },
    ];
    const now = at('2026-10-20T00:00:00Z');
    expect(currentSprint(overlap, now)!.id).toBe('spr-c');
    expect(currentSprint(overlap.filter((s) => s.id !== 'spr-c'), now)!.id).toBe('spr-b');
    expect(currentSprint([{ id: 'x-1', startsOn: '2026-10-10', endsOn: '2026-10-31' }, { id: 'x-2', startsOn: '2026-10-10', endsOn: '2026-10-31' }], now)!.id).toBe('x-2');
  });

  it('uses the same bounds as an envelope burn (sprintBounds)', () => {
    const b = sprintBounds('2026-10-15', '2026-10-28');
    const w = currentPeriod({ period: 'sprint' }, at('2026-10-20T00:00:00Z'), sprints);
    expect([b.fromMs, b.toMs]).toEqual([w.start.getTime(), w.end.getTime()]);
    expect(inBounds(Date.parse('2026-10-28T23:00:00Z'), b)).toBe(true);
    expect(inBounds(Date.parse('2026-10-29T00:00:00Z'), b)).toBe(false);
    expect(inBounds(0, sprintBounds(null, null))).toBe(true);
  });
});

describe('currentPeriod — rolling', () => {
  it('a 7-day rolling window is [now - 7 days, now), with no key', () => {
    const now = at('2026-10-29T15:30:00Z');
    const w = currentPeriod({ period: 'rolling', rollingDays: 7 }, now);
    expect([iso(w.start), iso(w.end), w.key, w.state]).toEqual(['2026-10-22T15:30:00.000Z', '2026-10-29T15:30:00.000Z', null, 'open']);
    const p = previousPeriod({ period: 'rolling', rollingDays: 7 }, now)!;
    expect([iso(p.start), iso(p.end), p.key]).toEqual(['2026-10-15T15:30:00.000Z', '2026-10-22T15:30:00.000Z', null]);
  });

  it('slides with the clock', () => {
    const a = currentPeriod({ period: 'rolling', rollingDays: 7 }, at('2026-10-29T00:00:00Z'));
    const b = currentPeriod({ period: 'rolling', rollingDays: 7 }, at('2026-10-30T00:00:00Z'));
    expect(b.start.getTime() - a.start.getTime()).toBe(86_400_000);
  });

  it('never closes at a boundary, whatever the carry policy', () => {
    expect(closesAtBoundary({ period: 'rolling', carryOver: 'both' })).toBe(false);
    expect(closesAtBoundary({ period: 'monthly', carryOver: 'none' })).toBe(false);
    expect(closesAtBoundary({ period: 'sprint', carryOver: 'unspent' })).toBe(true);
  });
});

describe('carry-over', () => {
  const end = new Date('2026-11-01T00:00:00Z');
  const base = { allocatedUsd: 40, carryInUsd: 0, spentUsd: 15, periodEnd: end };

  it('none carries nothing (the default)', () => {
    expect(carryOut(base, { carryOver: 'none', capUsd: null, since: null })).toBe(0);
  });

  it('unspent with a $10 cap: $25 left over carries $10', () => {
    expect(carryOut(base, { carryOver: 'unspent', capUsd: 10, since: null })).toBe(10);
    expect(carryOut(base, { carryOver: 'unspent', capUsd: null, since: null })).toBe(25);
  });

  it('unspent ignores an overspend; overspend ignores a surplus', () => {
    expect(carryOut({ ...base, spentUsd: 50 }, { carryOver: 'unspent', capUsd: null, since: null })).toBe(0);
    expect(carryOut(base, { carryOver: 'overspend', capUsd: null, since: null })).toBe(0);
    expect(carryOut({ ...base, spentUsd: 44 }, { carryOver: 'overspend', capUsd: null, since: null })).toBe(-4);
  });

  it('both carries either sign, clamped to ±cap', () => {
    expect(carryOut({ ...base, spentUsd: 70 }, { carryOver: 'both', capUsd: 10, since: null })).toBe(-10);
    expect(carryOut(base, { carryOver: 'both', capUsd: 10, since: null })).toBe(10);
  });

  it('the carry in rides along: allocated + carry in - spent', () => {
    expect(carryOut({ ...base, carryInUsd: 5 }, { carryOver: 'unspent', capUsd: null, since: null })).toBe(30);
  });

  it('a period ending at or before the policy took effect carries nothing', () => {
    expect(carryOut(base, { carryOver: 'unspent', capUsd: null, since: end })).toBe(0);
    expect(carryOut(base, { carryOver: 'unspent', capUsd: null, since: new Date(end.getTime() - 1) })).toBe(25);
  });

  it('the effective allocation is allocation + carry in, never below zero', () => {
    expect(effectiveAllocation(40, 10)).toBe(50);
    expect(effectiveAllocation(10, -4)).toBe(6);
    expect(effectiveAllocation(10, -40)).toBe(0);
  });

  it('a row without DE-38 fields is judged on its stored allocation; between sprints on none', () => {
    expect(budgetedAllocation({ allocatedUsd: 10 })).toBe(10);
    expect(budgetedAllocation({ allocatedUsd: 10, effectiveAllocatedUsd: 16 })).toBe(16);
    expect(budgetedAllocation({ allocatedUsd: 10, effectiveAllocatedUsd: null })).toBeNull();
  });

  it('only the four periods are periods', () => {
    expect(['monthly', 'quarterly', 'sprint', 'rolling'].every(isBudgetPeriod)).toBe(true);
    expect(isBudgetPeriod('weekly')).toBe(false);
  });
});

// The spend report's pure arithmetic: windows, grouping, burn and projection,
// the open-work fit, run outcomes and the read-tier withhold.

import {
  aggregateEntries, daysLeftInPeriod, fitOpenItems, isBudgetSkip, itemForecast, projectGroup, reportWindow,
  summarizeForecast, summarizeRuns, withhold, type OpenItemInput, type ReportEntry,
} from '../spend-report-model.js';

const NOW = new Date('2026-10-29T12:00:00.000Z');

function entry(over: Partial<ReportEntry>): ReportEntry {
  return { initiativeId: 'p-a', actorId: 'u-a', model: 'm', source: 'box_task', trigger: null, costUsd: 1, occurredAt: '2026-10-28T00:00:00.000Z', ...over };
}

function item(over: Partial<OpenItemInput> & { id: string }): OpenItemInput {
  return { title: over.id, priority: 'medium', storyPoints: 3, createdAt: '2026-10-01T00:00:00.000Z', estimateModel: null, estimateForecast: null, estimatedCostUsd: null, ...over };
}

describe('reportWindow', () => {
  it('cuts month, 7d and 30d windows and reads from the earliest instant any figure needs', () => {
    const m = reportWindow('month', NOW);
    expect(m.since.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(m.monthEnd.toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(daysLeftInPeriod(m)).toBe(2.5);
    const w = reportWindow('30d', NOW);
    expect(w.readFrom.toISOString()).toBe('2026-09-29T12:00:00.000Z');
    // Early in a month the burn window reaches into the last one.
    const early = reportWindow('month', new Date('2026-11-02T00:00:00.000Z'));
    expect(early.readFrom.toISOString()).toBe('2026-10-26T00:00:00.000Z');
  });
});

describe('aggregateEntries', () => {
  it('sums known dollars, counts unknowns apart, and groups a non-bot entry by its source under trigger', () => {
    const w = reportWindow('month', NOW);
    const rows = aggregateEntries([
      entry({ costUsd: 2 }),
      entry({ costUsd: null }),
      entry({ trigger: 'cron', source: 'bot_run', costUsd: 0.5 }),
    ], 'trigger', w);
    expect(rows).toEqual(expect.arrayContaining([
      { key: 'box_task', knownUsd: 2, unknownCount: 1, entries: 2, monthToDateUsd: 2, last7dUsd: 2 },
      { key: 'cron', knownUsd: 0.5, unknownCount: 0, entries: 1, monthToDateUsd: 0.5, last7dUsd: 0.5 },
    ]));
  });

  it('keeps last month\'s burn out of month-to-date but in the 7-day rate, and drops the future', () => {
    const w = reportWindow('month', new Date('2026-11-02T00:00:00.000Z'));
    const [g] = aggregateEntries([
      entry({ costUsd: 7, occurredAt: '2026-10-30T00:00:00.000Z' }),
      entry({ costUsd: 99, occurredAt: '2026-11-05T00:00:00.000Z' }),
    ], 'initiative', w);
    expect(g).toMatchObject({ key: 'p-a', knownUsd: 0, entries: 0, monthToDateUsd: 0, last7dUsd: 7 });
    expect(projectGroup(g!, w)).toEqual({ burnPerDay7d: 1, projectedPeriodEndUsd: 29 });
  });

  it('labels an entry with no model under "unknown" and no initiative under null', () => {
    const w = reportWindow('month', NOW);
    expect(aggregateEntries([entry({ model: null })], 'model', w)[0]!.key).toBe('unknown');
    expect(aggregateEntries([entry({ initiativeId: null })], 'initiative', w)[0]!.key).toBeNull();
  });
});

describe('fitOpenItems', () => {
  it('prefers the authorized forecast, falls back to the stored estimate, and says which', () => {
    expect(itemForecast(item({ id: 'a', estimateForecast: { costUsdP25: '1', costUsdP75: 4 }, estimatedCostUsd: 9 }))).toEqual({ p25Usd: 1, p75Usd: 4, basis: 'forecast' });
    expect(itemForecast(item({ id: 'b', estimatedCostUsd: 9 }))).toEqual({ p25Usd: null, p75Usd: 9, basis: 'estimate' });
    expect(itemForecast(item({ id: 'c' }))).toEqual({ p25Usd: null, p75Usd: null, basis: null });
  });

  it('judges each item against the remainder minus every item ahead of it in priority, then age', () => {
    const fits = fitOpenItems([
      item({ id: 'low', priority: 'low', estimatedCostUsd: 1 }),
      item({ id: 'old-med', estimatedCostUsd: 6, createdAt: '2026-09-01T00:00:00.000Z' }),
      item({ id: 'crit', priority: 'critical', estimatedCostUsd: 3 }),
      item({ id: 'new-med', estimatedCostUsd: 2 }),
      item({ id: 'none' }),
    ], 10);
    expect(fits.map((f) => [f.id, f.aheadUsd, f.fitsRemaining])).toEqual([
      ['crit', 0, true],
      ['old-med', 3, true],
      ['new-med', 9, false],
      ['none', 11, null],
      ['low', 11, false],
    ]);
  });

  it('answers null for every item when there is no allocation to fit against', () => {
    expect(fitOpenItems([item({ id: 'a', estimatedCostUsd: 1 })], null)[0]!.fitsRemaining).toBeNull();
  });

  it('summarizes per model, never blended, and counts sized items with no estimate', () => {
    const s = summarizeForecast(fitOpenItems([
      item({ id: 'a', estimateModel: 'opus', estimateForecast: { costUsdP25: 1, costUsdP75: 5 } }),
      item({ id: 'b', estimateModel: 'haiku', estimateForecast: { costUsdP25: 0.1, costUsdP75: 0.3 } }),
      item({ id: 'c', storyPoints: 5 }),
      item({ id: 'd', storyPoints: null }),
    ], 100));
    expect(s).toMatchObject({ p25Usd: 1.1, p75Usd: 5.3, estimatedItems: 2, unestimatedSizedItems: 1, unsizedItems: 1, mixedModels: true });
    expect(s.models.map((m) => m.model)).toEqual(['opus', 'haiku']);
  });
});

describe('summarizeRuns', () => {
  it('counts by status and trigger, over-budget runs and budget skips', () => {
    const r = summarizeRuns([
      { trigger: 'cron', status: 'done', outcome: { overRunBudget: true } },
      { trigger: 'cron', status: 'skipped', outcome: { reason: 'cron firing skipped: initiative allocation exhausted' } },
      { trigger: 'cron', status: 'skipped', outcome: { reason: 'max runs per day reached (4)' } },
      { trigger: 'marketplace', status: 'failed', outcome: null },
    ]);
    expect(r).toMatchObject({ total: 4, byStatus: { done: 1, failed: 1, skipped: 2, running: 0 }, overRunBudget: 1, skippedForBudget: 1 });
    expect(r.byTrigger[0]).toEqual({ trigger: 'cron', total: 3, done: 1, failed: 0, skipped: 2, running: 0 });
    expect(isBudgetSkip({ trigger: 'cron', status: 'skipped', outcome: { gate: 'hard-cap' } })).toBe(true);
  });
});

describe('withhold', () => {
  it('removes the keys rather than zeroing them', () => {
    expect(withhold({ a: 1, b: 2, c: 0 }, ['a', 'c'])).toEqual({ b: 2 });
  });
});

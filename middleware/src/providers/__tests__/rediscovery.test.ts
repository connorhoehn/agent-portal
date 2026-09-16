// rediscoveryStats — providers/rediscovery.ts.
//
// What is pinned:
//   * `usdAvoidedSeries` has exactly `windowDays` entries, oldest first, one
//     per UTC calendar day ending today — the same convention
//     `getProjectActivitySeries` uses (`buildDayKeys`, reused here),
//   * a day with no USED outcome is a real 0, not a missing element,
//   * the series sums to the SAME `usdAvoided` figure the stats report — two
//     views of one ledger, never allowed to disagree,
//   * a DISMISSED outcome never contributes (it has no avoidedUsd to give),
//   * shrinking the window past a seeded short-circuit's day drops it from
//     both the total and the series together.
//
// Not frozen: the module's seeded OUTCOMES stamp with `daysAgo()`, a plain
// `Date.now()`-relative helper evaluated once at import — real wall time, not
// `mock/core/clock.ts`. `buildDayKeys`'s default `now` is `clock.now()`,
// which is real wall time too when nothing has frozen it, so the two agree
// without a freeze; freezing here would only pull them apart, since the seed
// itself has no clock to pin.

// Real config.js reads `.env.aws` off disk via `import.meta.url` at import,
// which neither the test runner nor an offline box should depend on. Every
// other provider test that pulls in a real (unmocked) dependency chain mocks
// this the same way — see agent-jobs-mock-clock.test.ts.
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));

import { rediscoveryStats } from '../rediscovery.js';

function seriesSum(series: number[]): number {
  return Math.round(series.reduce((n, v) => n + v, 0) * 100) / 100;
}

describe('rediscoveryStats.usdAvoidedSeries', () => {
  it('has exactly windowDays entries, every one a non-negative dollar figure', async () => {
    const stats = await rediscoveryStats(30);
    expect(stats.usdAvoidedSeries).toHaveLength(30);
    for (const v of stats.usdAvoidedSeries) expect(v).toBeGreaterThanOrEqual(0);
  });

  it('sums to the same total usdAvoided reports', async () => {
    const stats = await rediscoveryStats(30);
    expect(seriesSum(stats.usdAvoidedSeries)).toBe(stats.usdAvoided);
  });

  it('places the seeded short-circuits on their own days: $4.8 three days back, $6.2 nine days back', async () => {
    const windowDays = 10;
    const stats = await rediscoveryStats(windowDays);
    // buildDayKeys is oldest-first ending today, so "N days ago" sits at
    // index (windowDays - 1 - N).
    expect(stats.usdAvoidedSeries[windowDays - 1 - 3]).toBeCloseTo(4.8, 2);
    expect(stats.usdAvoidedSeries[windowDays - 1 - 9]).toBeCloseTo(6.2, 2);
    // Today itself, and the dismissed outcome's day (6 back — it dismissed,
    // it did not avoid anything), both read zero.
    expect(stats.usdAvoidedSeries[windowDays - 1]).toBe(0);
    expect(stats.usdAvoidedSeries[windowDays - 1 - 6]).toBe(0);
  });

  it('shrinking the window drops a short-circuit from the series AND the total together', async () => {
    const wide = await rediscoveryStats(10); // both 3-days-back and 9-days-back in range
    const narrow = await rediscoveryStats(4); // only 3-days-back in range

    expect(wide.usdAvoided).toBeCloseTo(11, 2); // 4.8 + 6.2
    expect(narrow.usdAvoided).toBeCloseTo(4.8, 2);

    expect(seriesSum(wide.usdAvoidedSeries)).toBe(wide.usdAvoided);
    expect(seriesSum(narrow.usdAvoidedSeries)).toBe(narrow.usdAvoided);
  });

  it('a 1-day window is just today — real zero, since nothing seeded lands there', async () => {
    const stats = await rediscoveryStats(1);
    expect(stats.usdAvoidedSeries).toEqual([0]);
  });
});

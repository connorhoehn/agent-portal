// Activity time-series provider tests (providers/activity.ts).
//
// Exercises the REAL provider (config.js and aurora.js are the only mocks) so
// these tests catch the things a route-level test with a stubbed provider
// cannot: that a gap day really is zero-filled, that an unknown initiative
// really returns null (→ the route's 404), and that the mock and Aurora
// branches answer with the same shape.

const auroraState = { mockAurora: true };
jest.mock('../../config.js', () => ({
  get config() {
    return { mock: { aurora: auroraState.mockAurora } };
  },
}));

const execMock = jest.fn();
jest.mock('../aurora.js', () => ({ exec: (...args: unknown[]) => execMock(...args) }));

import { getProjectActivitySeries, buildDayKeys } from '../activity.js';

beforeEach(() => {
  auroraState.mockAurora = true;
  execMock.mockReset();
});

describe('buildDayKeys', () => {
  it('returns `days` UTC calendar-day keys, oldest first, ending today', () => {
    const now = new Date('2026-09-15T23:00:00Z'); // late in the UTC day on purpose
    const keys = buildDayKeys(5, now);
    expect(keys).toEqual(['2026-09-11', '2026-09-12', '2026-09-13', '2026-09-14', '2026-09-15']);
  });
});

describe('getProjectActivitySeries — mock mode', () => {
  it('404-shapes an unknown initiative as null', async () => {
    const result = await getProjectActivitySeries('p-does-not-exist', 30);
    expect(result).toBeNull();
  });

  it('zero-fills an initiative with no runs and no completed work — not an empty series', async () => {
    // p-data-lake: planning-stage, no mock bot targets it and it carries no
    // seeded work items at all — a real, activity-free initiative, not a
    // missing one. (p-mobile-redesign used to be the example here, but its
    // wi-mob-* fixture now mirrors schema/seed_program.sql exactly —
    // program-owner.md defect #3 — which includes one item completed 8 days
    // ago, so it is no longer activity-free.)
    const result = await getProjectActivitySeries('p-data-lake', 30);
    expect(result).not.toBeNull();
    expect(result!.days).toBe(30);
    expect(result!.series.runs).toHaveLength(30);
    expect(result!.series.spendUsd).toHaveLength(30);
    expect(result!.series.completed).toHaveLength(30);
    expect(result!.series.runs.every((n) => n === 0)).toBe(true);
    expect(result!.series.spendUsd.every((n) => n === 0)).toBe(true);
    expect(result!.series.completed.every((n) => n === 0)).toBe(true);
    expect(result!.totals).toEqual({ runs: 0, spendUsd: 0, completed: 0 });
  });

  // auth-dep-watch's roster numbers (todayRunCount/todaySpendUsd, read via
  // bots.ts's MOCK_BOT_RUNS/deriveBotStats) are baked into providers/bots.ts
  // at module-load time from whatever Date.now() was at that instant — so
  // freezing the clock inside a test body isn't enough on its own; the
  // fixture module has to be re-imported AFTER the fake clock is installed,
  // or it still answers with real-wall-clock timestamps. This is exactly the
  // mechanism behind the reported flake: deriveBotStats used to bucket
  // "today" by LOCAL midnight while everything else here works in UTC
  // (buildDayKeys's own doc comment), so a suite run in the ~3 local hours
  // after midnight saw auth-dep-watch's "3 hours ago" run fall into
  // yesterday and lost its one seeded run for today. Fixed in bots.ts
  // (deriveBotStats now truncates in UTC, matching Aurora's own
  // `date_trunc('day', NOW())`); the two instants below pin it stays green
  // on both a Sunday and a mid-week day, including re-run at an hour that
  // would have tripped the old local-time bug.
  async function freshActivitySeries(now: string) {
    jest.useFakeTimers({ now: new Date(now) });
    jest.resetModules();
    try {
      const fresh = await import('../activity.js');
      // The bots fixture MUST come out of this same module registry, under
      // the same fake clock: MOCK_BOT_RUNS stamps every run relative to
      // Date.now() at module-load time, so a bots.js imported after the
      // `finally` below (real timers, fresh registry) carries entirely
      // different timestamps than the ones the series just bucketed.
      const botsFixture = await import('../bots.js');
      return {
        result: await fresh.getProjectActivitySeries('p-auth-migration', 30),
        dayKeys: fresh.buildDayKeys(30),
        bots: botsFixture.MOCK_BOTS,
        botRuns: botsFixture.MOCK_BOT_RUNS,
      };
    } finally {
      jest.useRealTimers();
      jest.resetModules();
    }
  }

  it.each([
    ['a Sunday, just after UTC midnight (the old local-time bug\'s danger zone)', '2026-09-06T01:30:00Z'],
    ['a Wednesday, mid-afternoon UTC', '2026-09-09T15:00:00Z'],
  ])('leaves a real gap day at zero instead of skipping it: auth-dep-watch fires every few days (%s)', async (_label, now) => {
    // auth-dep-watch is the ONLY bot targeting p-auth-migration, and the mock
    // series now replays its OWN run history (bots.ts's MOCK_BOT_RUNS) rather
    // than synthesizing one run per cron weekday — so the shape to pin is: a
    // bucket with a run carries that run's own cost, and every day between two
    // runs is a real 0 rather than a missing element. (The bot is parked, as
    // every seeded bot is; a parked bot's past runs still happened, so its
    // history must still show — Aurora does not filter on bots.enabled.)
    const { result, dayKeys, bots: MOCK_BOTS, botRuns: MOCK_BOT_RUNS } = await freshActivitySeries(now);
    expect(result).not.toBeNull();

    const bot = MOCK_BOTS.find((b) => b.orgProjectId === 'p-auth-migration')!;
    expect(bot.name).toBe('auth-dep-watch');
    expect(bot.enabled).toBe(false);

    const wantRuns = new Map<string, number>();
    const wantSpend = new Map<string, number>();
    for (const run of MOCK_BOT_RUNS[bot.id] ?? []) {
      const key = run.startedAt.slice(0, 10);
      wantRuns.set(key, (wantRuns.get(key) ?? 0) + 1);
      wantSpend.set(key, Math.round(((wantSpend.get(key) ?? 0) + (run.costUsd ?? 0)) * 100) / 100);
    }

    let sawGap = false;
    let sawRun = false;
    dayKeys.forEach((key, i) => {
      const runs = wantRuns.get(key) ?? 0;
      if (runs === 0) sawGap = true; else sawRun = true;
      expect(result!.series.runs[i]).toBe(runs);
      expect(result!.series.spendUsd[i]).toBeCloseTo(wantSpend.get(key) ?? 0, 2);
    });
    // Sanity: a 30-day window contains at least one of each, or the assertions
    // above never actually ran.
    expect(sawGap).toBe(true);
    expect(sawRun).toBe(true);

    // "Today" agrees with the bot's own live counters (todayRunCount: 1,
    // todaySpendUsd: 0.11) — the same numbers the Bots/Queue page renders,
    // now by construction rather than by a reconciliation pass.
    const lastIdx = dayKeys.length - 1;
    expect(result!.series.runs[lastIdx]).toBe(bot.todayRunCount);
    expect(result!.series.spendUsd[lastIdx]).toBeCloseTo(bot.todaySpendUsd, 2);
  });

  it('sums the arrays into totals', async () => {
    const result = await getProjectActivitySeries('p-observability', 14);
    expect(result).not.toBeNull();
    const sum = (arr: number[]) => Math.round(arr.reduce((a, b) => a + b, 0) * 100) / 100;
    expect(result!.totals.runs).toBe(sum(result!.series.runs));
    expect(result!.totals.spendUsd).toBe(sum(result!.series.spendUsd));
    expect(result!.totals.completed).toBe(sum(result!.series.completed));
  });
});

describe('getProjectActivitySeries — mock/Aurora shape parity', () => {
  it('answers with the same top-level shape whichever path serves it', async () => {
    const mockResult = await getProjectActivitySeries('p-observability', 10);
    expect(mockResult).not.toBeNull();

    auroraState.mockAurora = false;
    execMock.mockImplementation(async (sql: string) => {
      if (/FROM projects WHERE id/.test(sql)) return [{ '1': 1 }]; // projectExists → true
      if (/FROM bot_runs/.test(sql)) return []; // no rows in this window
      if (/wi\.project_id/.test(sql)) return []; // dbGetProjectWorkItems → no items
      return [];
    });
    const auroraResult = await getProjectActivitySeries('p-observability', 10);
    expect(auroraResult).not.toBeNull();

    expect(Object.keys(auroraResult!).sort()).toEqual(Object.keys(mockResult!).sort());
    expect(Object.keys(auroraResult!.series).sort()).toEqual(Object.keys(mockResult!.series).sort());
    expect(Object.keys(auroraResult!.totals).sort()).toEqual(Object.keys(mockResult!.totals).sort());
    expect(auroraResult!.series.runs).toHaveLength(10);
    expect(auroraResult!.series.spendUsd).toHaveLength(10);
    expect(auroraResult!.series.completed).toHaveLength(10);
    expect(auroraResult!.days).toBe(mockResult!.days);
    expect(auroraResult!.from).toBe(mockResult!.from);
    expect(auroraResult!.to).toBe(mockResult!.to);
  });
});

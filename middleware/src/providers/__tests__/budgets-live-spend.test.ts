// One bot_runs table, one answer — including for the runs THIS process wrote.
//
// The bug this suite exists for: the mock spend derivation read the seeded
// cron history and nothing else, while providers/activity.ts's graph resolved
// a second, different subset of the same attribution predicate that DID count
// marketplace dispatches. So a dispatch in `dev:mock` moved the initiative's
// activity graph and left the Initiatives rollup and the Budgets ledger
// exactly where they were, and the sprint envelope beside them was windowed on
// `(null, null)` — the initiative's whole life — rather than on its sprint.
// Three surfaces, three numbers, one table.
//
// Every case below either freezes the clock and asserts an EXACT figure, or
// asserts that two surfaces moved by the same amount. A derivation with no
// frozen-clock test is not proven: the fixture stamps its rows relative to
// `now`, so without a frozen instant the only assertions available are
// tautological ones ("the sum equals the sum").

jest.mock('../aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));

import { freezeClock } from '../../mock/core/index.js';

/**
 * Run `fn` against a FRESH module registry with the clock frozen at `iso`.
 *
 * The order is load-bearing. `MOCK_BOT_RUNS` stamps every seeded run at module
 * evaluation, so freezing the clock that the already-imported bots.js used has
 * no effect on rows it stamped before the freeze. `jest.resetModules()` first,
 * then freeze the clock *out of the new registry*, then import the providers —
 * that way the fixture, the period window and the sprint calendar all read the
 * same frozen instant.
 */
async function frozen<T>(
  iso: string,
  fn: (mods: {
    budgets: typeof import('../budgets.js');
    bots: typeof import('../bots.js');
    activity: typeof import('../activity.js');
    projects: typeof import('../projects.js');
  }) => Promise<T>,
): Promise<T> {
  jest.resetModules();
  const clock = await import('../../mock/core/clock.js');
  const restore = clock.freezeClock(iso);
  try {
    return await fn({
      budgets: await import('../budgets.js'),
      bots: await import('../bots.js'),
      activity: await import('../activity.js'),
      projects: await import('../projects.js'),
    });
  } finally {
    restore();
    jest.resetModules();
  }
}

// 12:00 UTC on the 20th: the calendar month starts on the 1st, so a seeded run
// dated N days back is inside the period exactly when N <= 19. That makes the
// expected sums below a hand-checkable slice of schema/seed_program.sql rather
// than a restatement of the provider's own arithmetic.
const AT = '2026-09-20T12:00:00Z';

describe('the mock period window, at a frozen instant', () => {
  // compliance-evidence-cron (p-soc2), one of the seven bots the roster used to
  // omit. Seed run history: days 1, 4, 7, 10, 13, 16, 19, 22 back, at
  // 0.1739 / 0.1409 / 0.1548 / 0.1017 / 0.1694 / 0.1726 / 0.0934 / 0.0707.
  // Frozen on the 20th, the day-22 run is August's money and drops out; the
  // other seven sum to 1.0067. Every dollar is cron, so the maintenance floor
  // is the whole of it — which is the point docs/program-operating-model.md
  // makes about an allocation: $25 against a $1.01 floor.
  it('sums p-soc2 to the seed\'s own figure, to the cent', async () => {
    await frozen(AT, async ({ budgets }) => {
      expect(budgets.mockInitiativeSpend('p-soc2')).toEqual({
        spentUsd: 1.0067,
        runCount: 7,
        maintenanceUsd: 1.0067,
      });
    });
  });

  // The same rows through the LEDGER, so the public read and the selector
  // cannot answer differently.
  it('reports that figure on the ledger row too', async () => {
    await frozen(AT, async ({ budgets }) => {
      const row = (await budgets.listBudgets()).find((b) => b.orgProjectId === 'p-soc2')!;
      expect(row.spentThisPeriodUsd).toBe(1.0067);
      expect(row.runCountThisPeriod).toBe(7);
      expect(row.allocatedUsd).toBe(25);
    });
  });

  // The seeded month is cron maintenance plus the marketplace dispatches people
  // made from the board, so the org's spend is the floor and the dispatches —
  // and both breakdown cards cover the same rows.
  it('makes the org total the sum of its own rows', async () => {
    await frozen(AT, async ({ budgets }) => {
      const s = await budgets.orgSummary();
      const cron = s.byTrigger.find((t) => t.trigger === 'cron');
      const marketplace = s.byTrigger.find((t) => t.trigger === 'marketplace');
      expect(cron?.spentUsd).toBe(s.totalMaintenanceUsd);
      expect(marketplace?.spentUsd ?? 0).toBeGreaterThan(0);
      expect(s.byTrigger).toHaveLength(2);
      const scaleTo = (n: number): number => Math.round(n * 10_000) / 10_000;
      expect(scaleTo(s.byTrigger.reduce((n, t) => n + t.spentUsd, 0))).toBe(s.totalSpentThisPeriodUsd);
      const scale = (n: number): number => Math.round(n * 10_000) / 10_000;
      expect(scale(s.byModel.reduce((n, m) => n + m.spentUsd, 0))).toBe(s.totalSpentThisPeriodUsd);
    });
  });

  // Twelve mirrored bots means the breakdown cards have something to break
  // down. With five, by-model and by-trigger each had exactly one row — a
  // breakdown that cannot demonstrate a breakdown.
  it('gives the ledger more than one initiative to compare', async () => {
    await frozen(AT, async ({ budgets }) => {
      const rows = await budgets.listBudgets();
      expect(rows.filter((r) => r.spentThisPeriodUsd > 0).length).toBeGreaterThanOrEqual(10);
    });
  });
});

describe('a live dispatch moves every money surface by the same amount', () => {
  // wi-auth-e2-b3 is an open bug on p-auth-migration. A marketplace dispatch
  // carries no bot at all (bot_id NULL), so it reaches the initiative only
  // through arm 1 of spendPredicateSql — the arm the ledger used to skip.
  const ITEM = 'wi-auth-e2-b3';
  const PROJECT = 'p-auth-migration';
  const COST = 0.25;

  async function readAll(mods: {
    budgets: typeof import('../budgets.js');
    activity: typeof import('../activity.js');
    projects: typeof import('../projects.js');
  }) {
    const ledger = (await mods.budgets.listBudgets()).find((b) => b.orgProjectId === PROJECT)!;
    const rollup = (await mods.projects.listProjects({ limit: 50 })).find((p) => p.id === PROJECT)!;
    const series = (await mods.activity.getProjectActivitySeries(PROJECT, 30))!;
    const grants = await mods.budgets.listGrants(PROJECT);
    return {
      ledgerSpend: ledger.spentThisPeriodUsd,
      ledgerRuns: ledger.runCountThisPeriod,
      // The maintenance floor is the CRON subset — a hand-driven dispatch is
      // not maintenance and must not move it.
      ledgerMaintenance: ledger.maintenanceUsd,
      initiativesSpend: rollup.agentSpendUsd,
      activitySpend: series.totals.spendUsd,
      activityRuns: series.totals.runs,
      envelopeWindowSpend: grants.find((g) => g.id === 'bg-auth-3')!.initiativeSpendInWindowUsd,
    };
  }

  it('moves the ledger, the Initiatives rollup, the activity graph and the sprint envelope together', async () => {
    await frozen(AT, async (mods) => {
      const before = await readAll(mods);

      // Initiatives and Budgets must agree BEFORE anything is dispatched —
      // that invariant is what the synchronous derivation was protecting, and
      // it has to survive folding live runs in, not be traded for them.
      expect(before.initiativesSpend).toBe(before.ledgerSpend);

      const run = await mods.bots.createBotRun({
        botId: null, trigger: 'marketplace', workItemId: ITEM, dispatchedBy: 'u-nora',
      });
      expect(run).not.toBeNull();
      // A run in flight has posted no cost and has spent nothing yet —
      // `cost_usd IS NOT NULL` is the predicate's own first clause.
      expect((await readAll(mods)).ledgerSpend).toBe(before.ledgerSpend);

      await mods.bots.finalizeBotRun(run!.id, { status: 'done', costUsd: COST });
      const after = await readAll(mods);

      const scale = (n: number): number => Math.round(n * 10_000) / 10_000;
      expect(after.ledgerSpend).toBe(scale(before.ledgerSpend + COST));
      expect(after.initiativesSpend).toBe(after.ledgerSpend);
      expect(after.activitySpend).toBe(scale(before.activitySpend + COST));
      expect(after.envelopeWindowSpend).toBe(scale(before.envelopeWindowSpend + COST));

      expect(after.ledgerRuns).toBe(before.ledgerRuns + 1);
      expect(after.activityRuns).toBe(before.activityRuns + 1);
      // Not maintenance: a marketplace dispatch is someone spending an
      // envelope, not the recurring cost of keeping the repo alive.
      expect(after.ledgerMaintenance).toBe(before.ledgerMaintenance);

      mods.bots.__resetMockRuns();
    });
  });

  // The org total is unattributed — `SUM(cost_usd) FROM bot_runs` with no
  // predicate — so it must move for a dispatch even against an initiative the
  // ledger has no allocation row for. It also gains a second by-trigger row,
  // which is the shape a real cluster shows.
  it('moves the org total and splits it by trigger', async () => {
    await frozen(AT, async ({ budgets, bots }) => {
      const before = await budgets.orgSummary();
      const run = await bots.createBotRun({
        botId: null, trigger: 'marketplace', workItemId: ITEM, dispatchedBy: 'u-nora',
      });
      await bots.finalizeBotRun(run!.id, { status: 'done', costUsd: COST });
      const after = await budgets.orgSummary();

      expect(after.totalSpentThisPeriodUsd)
        .toBe(Math.round((before.totalSpentThisPeriodUsd + COST) * 10_000) / 10_000);
      // Cron is the floor and stays put; the dispatch is the delta.
      expect(after.totalMaintenanceUsd).toBe(before.totalMaintenanceUsd);
      expect(after.byTrigger.map((t) => t.trigger).sort()).toEqual(['cron', 'marketplace']);
      // No bot behind a marketplace run, and the mock records no per-run model,
      // so it groups as 'unknown' — the real query's own last COALESCE arm. An
      // unattributable dollar is a thing to show, not to hide.
      expect(after.byModel.map((m) => m.model)).toContain('unknown');

      bots.__resetMockRuns();
    });
  });
});

describe('grant windows come from the sprint calendar', () => {
  // Frozen on 2026-09-20, spr-auth-s2 (9 days ago → 5 days ahead) is 2026-09-11
  // to 2026-09-25. Before the fix every seed grant carried (null, null), which is
  // unbounded on both sides, so this figure was the initiative's lifetime spend.
  it('bounds an envelope on its own sprint, not on all of time', async () => {
    await frozen(AT, async ({ budgets }) => {
      const g = (await budgets.listGrants('p-auth-migration')).find((x) => x.id === 'bg-auth-3')!;
      expect(g.startsOn).toBe('2026-09-11');
      expect(g.endsOn).toBe('2026-09-25');

      const lifetime = budgets.mockInitiativeWindowSpendUsd('p-auth-migration', null, null);
      const windowed = budgets.mockInitiativeWindowSpendUsd('p-auth-migration', g.startsOn, g.endsOn);
      expect(g.initiativeSpendInWindowUsd).toBe(windowed);
      // auth-dep-watch's seeded history reaches 28 days back, so a 9-day
      // window is a strict slice of it. If these were ever equal the window
      // would not be doing anything.
      expect(windowed).toBeLessThan(lifetime);
    });
  });

  // The sprint page and the grants page read one calendar and one sum. They
  // used to read two: sprints.ts windowed correctly while the grants beside it
  // did not, so an SME's envelope reported one number on /iq/sprints and a
  // larger one on the grant itself.
  it('reports the same window spend on the sprint as on its grants', async () => {
    await frozen(AT, async ({ budgets }) => {
      const sprints = await import('../sprints.js');
      const rows = await sprints.listSprints({ sprintId: 'spr-auth-s2' });
      const s = rows.find((r) => r.id === 'spr-auth-s2')!;
      const grants = (await budgets.listGrants('p-auth-migration'))
        .filter((g) => g.sprintId === 'spr-auth-s2');
      expect(grants).toHaveLength(2);
      expect(s.startsOn).toBe(grants[0]!.startsOn);
      expect(s.endsOn).toBe(grants[0]!.endsOn);
      for (const g of grants) {
        expect(g.initiativeSpendInWindowUsd).toBe(s.initiativeSpendInWindowUsd);
      }
    });
  });
});

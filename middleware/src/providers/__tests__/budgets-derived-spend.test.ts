// The ledger's money is SUMMED, never stored — docs/mock-floor.md rule 1.
//
// `MOCK_BUDGETS` used to carry `spent`, `runs` and `maintenance` typed beside
// the rows they claimed to count, and every one of them had drifted:
// p-observability claimed $4.12 over nine runs summing $1.91, p-cost-opt
// claimed 12 runs over a bot with two, and p-soc2 / p-feature-store /
// p-mobile-redesign claimed money against bots the mock roster has never had a
// row for. `MOCK_GRANTS.initiativeSpendInWindowUsd` was the same shape, with
// bg-auth-2 and bg-auth-3 each claiming the SAME $1.70 of one initiative's
// spend. Nothing could catch it, because the number and the rows were never
// compared. These cases are that comparison.

jest.mock('../aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));

import {
  listBudgets, listGrants, orgSummary,
  mockInitiativeSpend, mockInitiativeWindowSpendUsd, MOCK_BUDGETS,
} from '../budgets.js';
import { MOCK_BOTS, MOCK_BOT_RUNS, type BotRun } from '../bots.js';
import { freezeClock } from '../../mock/core/index.js';

/** The rows the ledger claims to count, resolved here independently of the
 *  provider — arm 2 of spendPredicateSql. Arm 1 (through a work item) can only
 *  match a run this process dispatched, and this suite dispatches none; the
 *  live-dispatch invariant is pinned in budgets-live-spend.test.ts. */
function runsFor(orgProjectId: string): BotRun[] {
  return MOCK_BOTS
    .filter((b) => b.orgProjectId === orgProjectId)
    .flatMap((b) => MOCK_BOT_RUNS[b.id] ?? []);
}

/** `cost_usd` is NUMERIC(10,4), so four decimals is the scale Postgres would
 *  return and the scale the mock rounds to. Rounding to cents here would have
 *  the ledger's own rows stop adding up to its org total. */
function scale(n: number): number { return Math.round(n * 10_000) / 10_000; }

function monthStartMs(): number {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
}

describe('the mock ledger sums its own bot_runs', () => {
  it('every row\'s spend, run count and maintenance floor equal the rows behind it', async () => {
    const rows = await listBudgets();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const period = runsFor(row.orgProjectId)
        .filter((r) => r.costUsd != null && Date.parse(r.startedAt) >= monthStartMs());
      expect(row.spentThisPeriodUsd).toBe(scale(period.reduce((n, r) => n + (r.costUsd ?? 0), 0)));
      expect(row.runCountThisPeriod).toBe(period.length);
      expect(row.maintenanceUsd).toBe(
        scale(period.filter((r) => r.trigger === 'cron').reduce((n, r) => n + (r.costUsd ?? 0), 0)),
      );
    }
  });

  // The floor is a SUBSET of spend, never a second bucket added to it.
  it('keeps the maintenance floor inside this period\'s spend', async () => {
    for (const row of await listBudgets()) {
      expect(row.maintenanceUsd).toBeLessThanOrEqual(row.spentThisPeriodUsd);
    }
  });

  // An initiative with no bot in the mock roster derives $0 — the honest answer
  // to "sum the rows" when there are none. It used to claim hand-typed money.
  //
  // The examples used to be p-soc2 / p-feature-store / p-mobile-redesign, which
  // were $0 for a worse reason: the roster mirrored 5 of the seed's 12 bots, so
  // three initiatives holding a real monthly allocation had no rows to sum. All
  // twelve are mirrored now, so those three derive the seed's own money and the
  // genuinely activity-free initiatives are the ones the seed gives no bot:
  // p-data-lake and p-zero-trust, both still in planning.
  it('reports $0, not invented money, for an initiative with no runs', async () => {
    for (const id of ['p-data-lake', 'p-zero-trust']) {
      expect(runsFor(id)).toHaveLength(0);
      expect(mockInitiativeSpend(id)).toEqual({ spentUsd: 0, runCount: 0, maintenanceUsd: 0 });
    }
  });

  // The other half of that fix: the three that used to be empty are not any
  // more, and their money is the seed's, not an invention.
  it('derives the seed\'s own money for every initiative the seed gives a bot', () => {
    for (const id of ['p-soc2', 'p-feature-store', 'p-mobile-redesign',
                      'p-realtime-analytics', 'p-design-v3', 'p-rag-search',
                      'p-design-system-api']) {
      expect(runsFor(id).length).toBeGreaterThan(0);
    }
    // Twelve bots, mirroring schema/seed_program.sql exactly.
    expect(MOCK_BOTS).toHaveLength(12);
    expect(Object.keys(MOCK_BOT_RUNS)).toHaveLength(12);
    // Every bot in the roster has a run history, and every history has a bot:
    // an id on one side and not the other is a link into a page that 404s.
    expect(new Set(Object.keys(MOCK_BOT_RUNS))).toEqual(new Set(MOCK_BOTS.map((b) => b.id)));
  });

  // `…ThisPeriod` means the calendar month, matching PERIOD_START_SQL. The
  // stored totals were month-independent, which is a shape Aurora cannot
  // produce: on the 7th, most of a 30-day seeded history is last month's money.
  it('windows on the calendar month, through the mock clock', () => {
    const runs = runsFor('p-observability');
    expect(runs.length).toBeGreaterThan(3);
    const wholeHistory = runs.reduce((n, r) => n + (r.costUsd ?? 0), 0);
    expect(mockInitiativeSpend('p-observability').spentUsd).toBeLessThanOrEqual(wholeHistory);

    // Roll the clock into next month with the rows where they are: every run is
    // then LAST month's money and this period is empty. A stored total cannot
    // do that, which is exactly why the old one disagreed with Aurora.
    const now = new Date();
    const restore = freezeClock(
      new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 2, 12, 0, 0)).toISOString(),
    );
    try {
      expect(mockInitiativeSpend('p-observability'))
        .toEqual({ spentUsd: 0, runCount: 0, maintenanceUsd: 0 });
    } finally {
      restore();
    }
  });

  it('leaves the allocation alone — it is a stored column, not an aggregate', async () => {
    const rows = await listBudgets();
    for (const m of MOCK_BUDGETS) {
      expect(rows.find((r) => r.orgProjectId === m.id)?.allocatedUsd).toBe(m.allocated);
    }
  });
});

describe('the org summary is cuts of one row set', () => {
  it('makes both breakdown cards add up to the total', async () => {
    const s = await orgSummary();
    expect(scale(s.byModel.reduce((n, m) => n + m.spentUsd, 0))).toBe(s.totalSpentThisPeriodUsd);
    expect(scale(s.byTrigger.reduce((n, t) => n + t.spentUsd, 0))).toBe(s.totalSpentThisPeriodUsd);
    // No negative remainder row — the old by-trigger 'manual' row absorbed
    // whatever was left after two hand-typed constants.
    for (const t of s.byTrigger) expect(t.spentUsd).toBeGreaterThanOrEqual(0);
    for (const m of s.byModel) expect(m.spentUsd).toBeGreaterThanOrEqual(0);
  });

  it('agrees with the per-initiative ledger on the maintenance floor', async () => {
    const s = await orgSummary();
    const perRow = (await listBudgets()).reduce((n, b) => n + b.maintenanceUsd, 0);
    expect(scale(perRow)).toBe(s.totalMaintenanceUsd);
  });
});

describe('a sprint envelope\'s window spend is summed, not stored', () => {
  it('equals the initiative\'s runs inside the grant\'s own window', async () => {
    const grants = await listGrants();
    expect(grants.length).toBeGreaterThan(0);
    for (const g of grants) {
      expect(g.initiativeSpendInWindowUsd)
        .toBe(mockInitiativeWindowSpendUsd(g.orgProjectId, g.startsOn, g.endsOn));
    }
  });

  // Two grantees on one sprint is legal (budget_grants has no such constraint)
  // and both saw $1.70 of p-auth-migration spend written on their row. Derived,
  // they still report the same figure — but it is now ONE initiative's spend
  // read twice, not two independent numbers that could disagree.
  it('gives the two grantees on one sprint the same figure, from one sum', async () => {
    const grants = await listGrants('p-auth-migration');
    const onS2 = grants.filter((g) => g.sprintId === 'spr-auth-s2');
    expect(onS2.length).toBe(2);
    expect(onS2[0]!.initiativeSpendInWindowUsd).toBe(onS2[1]!.initiativeSpendInWindowUsd);
    // Both read the SPRINT's window, and both take their bounds from the same
    // sprint. This used to assert equality with the unbounded (null, null) sum
    // instead, and it passed — because every seed grant carried
    // `startsOn: null, endsOn: null`, so "spend in this envelope's window" was
    // the initiative's LIFETIME spend. That is the assertion that had to change.
    expect(onS2[0]!.startsOn).toBe(onS2[1]!.startsOn);
    expect(onS2[0]!.endsOn).toBe(onS2[1]!.endsOn);
    expect(onS2[0]!.initiativeSpendInWindowUsd).toBe(
      mockInitiativeWindowSpendUsd('p-auth-migration', onS2[0]!.startsOn, onS2[0]!.endsOn),
    );
  });

  // The regression that matters: a null bound is UNBOUNDED, in the SQL and in
  // the mock alike, so a grant with no window reports lifetime spend. Every
  // seed grant now takes its window from the sprint that funds it.
  it('gives every seed grant a real window, bounded by its sprint', async () => {
    const grants = await listGrants();
    expect(grants.length).toBeGreaterThan(0);
    for (const g of grants) {
      expect(g.startsOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(g.endsOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Date.parse(g.startsOn!)).toBeLessThan(Date.parse(g.endsOn!));
      // Windowed spend can never exceed the lifetime sum it is a slice of.
      expect(g.initiativeSpendInWindowUsd)
        .toBeLessThanOrEqual(mockInitiativeWindowSpendUsd(g.orgProjectId, null, null));
    }
  });

  // The bound convention listGrants' subquery uses: starts_on inclusive,
  // ends_on exclusive at +1 day (a sprint ends ON that day), null unbounded.
  it('excludes a window that ends before the runs it would have counted', () => {
    const all = mockInitiativeWindowSpendUsd('p-observability', null, null);
    expect(all).toBeGreaterThan(0);
    expect(mockInitiativeWindowSpendUsd('p-observability', '2000-01-01', '2000-01-02')).toBe(0);
    expect(mockInitiativeWindowSpendUsd('p-observability', '2099-01-01', null)).toBe(0);
  });
});

// Budgets provider tests. The DB layer is stubbed — what matters is that the
// SQL we emit encodes the invariants: the monthly period window, the same
// three-way attribution predicate the Projects rollup uses, the UNION that
// surfaces unallocated-but-spending initiatives, and schema tolerance.

jest.mock('../aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../config.js', () => ({ config: { mock: { aurora: false } } }));

import { exec } from '../aurora.js';
import {
  PERIOD_START_SQL, spendPredicateSql,
  listBudgets, getBudget, upsertAllocation, deleteAllocation, initiativeExists, orgSummary,
  listGrants,
} from '../budgets.js';

const execMock = exec as unknown as jest.Mock;

beforeEach(() => execMock.mockReset());

const ROW = {
  org_project_id: 'p-observability', org_project_name: 'Observability Platform',
  allocated_usd: 250, period: 'monthly', updated_by: 'pm@example.com',
  updated_at: '2026-08-01T00:00:00Z', spent_this_period_usd: 42.5,
  run_count_this_period: 7, last_agent_activity_at: '2026-08-20T12:00:00Z',
  maintenance_usd: 12.25,
};

// ─── Pure SQL builders ───────────────────────────────────────────────────────

describe('period window', () => {
  it('windows on the calendar month — the only period v1 supports', () => {
    expect(PERIOD_START_SQL).toBe(`date_trunc('month', NOW())`);
  });

  // The Initiatives rollup (providers/projects.ts) imports this constant rather
  // than declaring its own — see __tests__/projects-spend-window.test.ts, which
  // asserts the emitted rollup SQL carries exactly this window.
});

describe('spendPredicateSql', () => {
  // The predicate is copied from listProjects (providers/projects.ts) — all
  // three attribution paths must be present or spend silently vanishes from
  // the ledger while still appearing on the Projects rollup.
  const sql = spendPredicateSql('p.id');

  it('only counts runs that actually carry a cost', () => {
    expect(sql).toMatch(/br\.cost_usd IS NOT NULL/);
  });

  it('attributes via the work item', () => {
    expect(sql).toMatch(/br\.work_item_id IN \(SELECT w2\.id FROM work_items w2 WHERE w2\.project_id = p\.id\)/);
  });

  it('attributes via a bot targeting the initiative directly', () => {
    expect(sql).toMatch(/b\.org_project_id = p\.id/);
  });

  it('attributes via a bot targeting a codebase that delivers the initiative', () => {
    expect(sql).toMatch(/ap\.org_project_id = p\.id/);
  });

  it('substitutes the caller-supplied project reference', () => {
    expect(spendPredicateSql(':pid')).toMatch(/w2\.project_id = :pid/);
  });
});

// ─── List / get ──────────────────────────────────────────────────────────────

describe('listBudgets', () => {
  it('unions allocation ids with spending ids so blind spots surface', async () => {
    execMock.mockResolvedValue([ROW]);
    await listBudgets();
    const sql = execMock.mock.calls[0][0] as string;
    expect(sql).toMatch(/SELECT org_project_id FROM initiative_budgets\s+UNION\s+SELECT org_project_id FROM period_spend/);
    // Spend is windowed to the current period, attributed the rollup's way.
    expect(sql).toContain(PERIOD_START_SQL);
    expect(sql).toContain(spendPredicateSql('p.id'));
  });

  it('maps a joined row, including nullable allocation fields', async () => {
    execMock.mockResolvedValue([ROW, {
      ...ROW, org_project_id: 'proj-rogue', org_project_name: 'Rogue Spender',
      allocated_usd: null, period: null, updated_by: null, updated_at: null,
    }]);
    const rows = await listBudgets();
    expect(rows[0]).toEqual({
      orgProjectId: 'p-observability', orgProjectName: 'Observability Platform',
      allocatedUsd: 250, period: 'monthly', updatedBy: 'pm@example.com',
      updatedByName: null,
      updatedAt: '2026-08-01T00:00:00Z', spentThisPeriodUsd: 42.5,
      runCountThisPeriod: 7, lastAgentActivityAt: '2026-08-20T12:00:00Z',
      maintenanceUsd: 12.25,
    });
    // The unallocated-but-spending row keeps null allocation — the signal.
    expect(rows[1]!.allocatedUsd).toBeNull();
    expect(rows[1]!.spentThisPeriodUsd).toBe(42.5);
  });

  // The maintenance floor is the cron-triggered SUBSET of spend, never an
  // addition to it — a UI that added the two would double-count every
  // scheduled run.
  it('reads the maintenance floor as a cron-filtered subset of spend', async () => {
    execMock.mockResolvedValue([ROW]);
    const rows = await listBudgets();
    expect(rows[0]!.maintenanceUsd).toBe(12.25);
    expect(rows[0]!.maintenanceUsd).toBeLessThanOrEqual(rows[0]!.spentThisPeriodUsd);
    const sql = String(execMock.mock.calls[0]?.[0] ?? '');
    expect(sql).toContain(`FILTER (WHERE br.trigger = 'cron')`);
  });

  it('reports no floor when an initiative has no scheduled runs', async () => {
    const { maintenance_usd: _omitted, ...noCron } = ROW;
    execMock.mockResolvedValue([noCron]);
    expect((await listBudgets())[0]!.maintenanceUsd).toBe(0);
  });

  it('degrades to empty when the schema predates the budgets tables', async () => {
    execMock.mockRejectedValue(new Error('relation "initiative_budgets" does not exist'));
    expect(await listBudgets()).toEqual([]);
  });

  it('stays loud on real errors', async () => {
    execMock.mockRejectedValue(new Error('connection refused'));
    await expect(listBudgets()).rejects.toThrow('connection refused');
  });
});

describe('getBudget', () => {
  it('scopes the same list shape to one initiative', async () => {
    execMock.mockResolvedValue([ROW]);
    const budget = await getBudget('p-observability');
    const sql = execMock.mock.calls[0][0] as string;
    expect(sql).toMatch(/WHERE ids\.org_project_id = :pid/);
    expect(budget?.orgProjectId).toBe('p-observability');
  });

  it('returns null when nothing matches', async () => {
    execMock.mockResolvedValue([]);
    expect(await getBudget('proj-none')).toBeNull();
  });
});

// ─── Writes ──────────────────────────────────────────────────────────────────

describe('upsertAllocation', () => {
  it('upserts idempotently and re-reads through the list shape', async () => {
    execMock.mockResolvedValueOnce([]).mockResolvedValueOnce([ROW]);
    const budget = await upsertAllocation('p-observability', 250, 'pm@example.com');
    const insertSql = execMock.mock.calls[0][0] as string;
    expect(insertSql).toMatch(/INSERT INTO initiative_budgets/);
    expect(insertSql).toMatch(/ON CONFLICT \(org_project_id\) DO UPDATE/);
    expect(insertSql).toMatch(/updated_at = NOW\(\)/);
    // Second statement is the re-read: the insert alone cannot compute the
    // joined name or this-period spend.
    expect(execMock.mock.calls[1][0]).toMatch(/period_spend/);
    expect(budget?.allocatedUsd).toBe(250);
  });
});

describe('deleteAllocation', () => {
  it('reports whether a row was actually deleted', async () => {
    execMock.mockResolvedValueOnce([{ org_project_id: 'p-observability' }]).mockResolvedValueOnce([]);
    expect(await deleteAllocation('p-observability')).toBe(true);
    expect(await deleteAllocation('proj-none')).toBe(false);
    expect(execMock.mock.calls[0][0]).toMatch(/DELETE FROM initiative_budgets WHERE org_project_id = :pid/);
  });
});

describe('initiativeExists', () => {
  it('checks the projects table', async () => {
    execMock.mockResolvedValue([{ id: 'p-observability' }]);
    expect(await initiativeExists('p-observability')).toBe(true);
    expect(execMock.mock.calls[0][0]).toMatch(/FROM projects WHERE id = :pid/);
  });
});

// ─── Org summary ─────────────────────────────────────────────────────────────

describe('orgSummary', () => {
  it('returns the zeroed shape when nothing exists yet', async () => {
    execMock.mockResolvedValue([]);
    expect(await orgSummary()).toEqual({
      totalAllocatedUsd: 0, totalSpentThisPeriodUsd: 0, totalMaintenanceUsd: 0,
      byModel: [], byTrigger: [],
    });
  });

  it('windows every spend read to the current period', async () => {
    execMock.mockResolvedValue([]);
    await orgSummary();
    for (const call of execMock.mock.calls) {
      expect(call[0] as string).toContain(PERIOD_START_SQL);
    }
  });

  it('cuts by-model and by-trigger over the same rows', async () => {
    execMock
      .mockResolvedValueOnce([{ total_allocated: 500, total_spent: 120 }])
      .mockResolvedValueOnce([{ model: 'us.amazon.nova-pro-v1:0', spent_usd: 80, run_count: 5 }])
      .mockResolvedValueOnce([
        { trigger: 'cron', spent_usd: 90, run_count: 6 },
        { trigger: 'marketplace', spent_usd: 30, run_count: 2 },
      ]);
    const summary = await orgSummary();
    const byModelSql = execMock.mock.calls[1][0] as string;
    const byTriggerSql = execMock.mock.calls[2][0] as string;
    expect(byTriggerSql).toMatch(/GROUP BY br\.trigger/);

    // The card was permanently empty because this join was INNER on
    // bot_runs.run_id and every seeded run is job-backed (run_id null). Nothing
    // here may narrow the row set relative to by-trigger.
    expect(byModelSql).not.toMatch(/(?<!LEFT )JOIN agent_project_runs/);
    expect(byModelSql).toMatch(/LEFT JOIN agent_project_runs apr ON apr\.id = br\.run_id/);
    expect(byModelSql).not.toMatch(/apr\.model IS NOT NULL/);

    // The two breakdowns must cover identical rows, or the cards add up to
    // different money for one period.
    const rowFilter = (sql: string) =>
      sql.slice(sql.indexOf('WHERE'), sql.indexOf('GROUP BY')).trim();
    expect(rowFilter(byModelSql)).toBe(rowFilter(byTriggerSql));

    expect(summary.totalAllocatedUsd).toBe(500);
    expect(summary.totalSpentThisPeriodUsd).toBe(120);
    expect(summary.byModel).toEqual([{ model: 'us.amazon.nova-pro-v1:0', spentUsd: 80, runCount: 5 }]);
    expect(summary.byTrigger).toHaveLength(2);
    expect(summary.byTrigger[0]).toEqual({ trigger: 'cron', spentUsd: 90, runCount: 6 });
  });

  // bots.model is NOT NULL (agent_bots_schema.sql) and bot-runner.ts writes the
  // bot's model into the enqueued job payload, so the model IS recoverable for
  // a job-backed run — the "agent_jobs carries no reliable model" comment that
  // justified excluding them is stale.
  it('resolves the model from the run, the job payload, or the bot', async () => {
    execMock.mockResolvedValue([]);
    await orgSummary();
    const byModelSql = execMock.mock.calls[1][0] as string;
    expect(byModelSql).toMatch(
      /COALESCE\(apr\.model, aj\.payload->>'model', b\.model, 'unknown'\)/,
    );
    expect(byModelSql).toMatch(/LEFT JOIN agent_jobs aj ON aj\.id = br\.job_id/);
    expect(byModelSql).toMatch(/LEFT JOIN bots b ON b\.id = br\.bot_id/);
  });

  it('buckets unresolvable spend as unknown rather than dropping it', async () => {
    execMock
      .mockResolvedValueOnce([{ total_allocated: 0, total_spent: 10 }])
      .mockResolvedValueOnce([
        { model: 'us.amazon.nova-lite-v1:0', spent_usd: 7, run_count: 3 },
        { model: 'unknown', spent_usd: 3, run_count: 1 },
      ])
      .mockResolvedValueOnce([{ trigger: 'cron', spent_usd: 10, run_count: 4 }]);
    const summary = await orgSummary();
    const byModelTotal = summary.byModel.reduce((n, m) => n + m.spentUsd, 0);
    expect(byModelTotal).toBe(summary.totalSpentThisPeriodUsd);
    expect(summary.byModel.map((m) => m.model)).toContain('unknown');
  });

  it('degrades to the zeroed shape when the bots schema is missing', async () => {
    execMock.mockRejectedValue(new Error('relation "bot_runs" does not exist'));
    expect(await orgSummary()).toEqual({
      totalAllocatedUsd: 0, totalSpentThisPeriodUsd: 0, totalMaintenanceUsd: 0,
      byModel: [], byTrigger: [],
    });
  });
});

describe('listGrants', () => {
  const GRANT = {
    id: 'bg-obs-3', org_project_id: 'p-observability',
    org_project_name: 'Observability Platform',
    grantee_person_id: 'p-008', grantee_name: 'Layla Hassan',
    sprint_id: 'spr-obs-s3', sprint_name: 'Sprint 98 — Span metrics + decom',
    starts_on: '2026-08-10', ends_on: '2026-08-24', sprint_status: 'active',
    allocated_usd: 30, granted_by: 'u-release', window_spend_usd: 2.74,
  };

  it('maps an envelope with its holder, sprint window and in-window spend', async () => {
    execMock.mockResolvedValue([GRANT]);
    const [g] = await listGrants();
    expect(g).toEqual({
      id: 'bg-obs-3', orgProjectId: 'p-observability',
      orgProjectName: 'Observability Platform',
      granteePersonId: 'p-008', granteeName: 'Layla Hassan',
      sprintId: 'spr-obs-s3', sprintName: 'Sprint 98 — Span metrics + decom',
      startsOn: '2026-08-10', endsOn: '2026-08-24', sprintStatus: 'active',
      allocatedUsd: 30, grantedBy: 'u-release', note: null, initiativeSpendInWindowUsd: 2.74,
    });
  });

  // The window figure is the initiative's, bounded by the sprint dates — it is
  // NOT the grantee's personal burn, because bot_runs never record whose
  // envelope paid. The SQL must therefore window on the sprint and attribute
  // by initiative, using the same predicate the rest of the ledger uses.
  it('windows spend on the sprint and attributes it by initiative', async () => {
    execMock.mockResolvedValue([GRANT]);
    await listGrants();
    const sql = String(execMock.mock.calls[0]?.[0] ?? '');
    expect(sql).toContain('br.started_at >= sp.starts_on');
    expect(sql).toContain('br.started_at < sp.ends_on + 1');
    expect(sql).toContain(spendPredicateSql('g.org_project_id').trim().slice(0, 40));
    expect(sql).not.toContain('grantee_person_id = ');
  });

  it('scopes to one initiative when asked', async () => {
    execMock.mockResolvedValue([]);
    await listGrants('p-auth-migration');
    expect(String(execMock.mock.calls[0]?.[0])).toContain('WHERE g.org_project_id = :pid');
    expect(execMock.mock.calls[0]?.[1]).toEqual([
      { name: 'pid', value: { stringValue: 'p-auth-migration' } },
    ]);
  });

  it('degrades to empty when the program schema is missing', async () => {
    execMock.mockRejectedValue(new Error('relation "budget_grants" does not exist'));
    expect(await listGrants()).toEqual([]);
  });
});

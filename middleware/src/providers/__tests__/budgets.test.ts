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
} from '../budgets.js';

const execMock = exec as unknown as jest.Mock;

beforeEach(() => execMock.mockReset());

const ROW = {
  org_project_id: 'proj-k8s', org_project_name: 'Kubernetes Cluster Upgrade',
  allocated_usd: 250, period: 'monthly', updated_by: 'pm@example.com',
  updated_at: '2026-08-01T00:00:00Z', spent_this_period_usd: 42.5,
  run_count_this_period: 7, last_agent_activity_at: '2026-08-20T12:00:00Z',
};

// ─── Pure SQL builders ───────────────────────────────────────────────────────

describe('period window', () => {
  it('windows on the calendar month — the only period v1 supports', () => {
    expect(PERIOD_START_SQL).toBe(`date_trunc('month', NOW())`);
  });
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
      orgProjectId: 'proj-k8s', orgProjectName: 'Kubernetes Cluster Upgrade',
      allocatedUsd: 250, period: 'monthly', updatedBy: 'pm@example.com',
      updatedAt: '2026-08-01T00:00:00Z', spentThisPeriodUsd: 42.5,
      runCountThisPeriod: 7, lastAgentActivityAt: '2026-08-20T12:00:00Z',
    });
    // The unallocated-but-spending row keeps null allocation — the signal.
    expect(rows[1]!.allocatedUsd).toBeNull();
    expect(rows[1]!.spentThisPeriodUsd).toBe(42.5);
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
    const budget = await getBudget('proj-k8s');
    const sql = execMock.mock.calls[0][0] as string;
    expect(sql).toMatch(/WHERE ids\.org_project_id = :pid/);
    expect(budget?.orgProjectId).toBe('proj-k8s');
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
    const budget = await upsertAllocation('proj-k8s', 250, 'pm@example.com');
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
    execMock.mockResolvedValueOnce([{ org_project_id: 'proj-k8s' }]).mockResolvedValueOnce([]);
    expect(await deleteAllocation('proj-k8s')).toBe(true);
    expect(await deleteAllocation('proj-none')).toBe(false);
    expect(execMock.mock.calls[0][0]).toMatch(/DELETE FROM initiative_budgets WHERE org_project_id = :pid/);
  });
});

describe('initiativeExists', () => {
  it('checks the projects table', async () => {
    execMock.mockResolvedValue([{ id: 'proj-k8s' }]);
    expect(await initiativeExists('proj-k8s')).toBe(true);
    expect(execMock.mock.calls[0][0]).toMatch(/FROM projects WHERE id = :pid/);
  });
});

// ─── Org summary ─────────────────────────────────────────────────────────────

describe('orgSummary', () => {
  it('returns the zeroed shape when nothing exists yet', async () => {
    execMock.mockResolvedValue([]);
    expect(await orgSummary()).toEqual({
      totalAllocatedUsd: 0, totalSpentThisPeriodUsd: 0, byModel: [], byTrigger: [],
    });
  });

  it('windows every spend read to the current period', async () => {
    execMock.mockResolvedValue([]);
    await orgSummary();
    for (const call of execMock.mock.calls) {
      expect(call[0] as string).toContain(PERIOD_START_SQL);
    }
  });

  it('scopes by-model to run-backed spend via agent_project_runs', async () => {
    execMock
      .mockResolvedValueOnce([{ total_allocated: 500, total_spent: 120 }])
      .mockResolvedValueOnce([{ model: 'us.amazon.nova-pro-v1:0', spent_usd: 80, run_count: 5 }])
      .mockResolvedValueOnce([
        { trigger: 'cron', spent_usd: 90, run_count: 6 },
        { trigger: 'marketplace', spent_usd: 30, run_count: 2 },
      ]);
    const summary = await orgSummary();
    // Jobs carry no reliable model — by-model must join through the run.
    const byModelSql = execMock.mock.calls[1][0] as string;
    expect(byModelSql).toMatch(/JOIN agent_project_runs apr ON apr\.id = br\.run_id/);
    expect(byModelSql).toMatch(/GROUP BY apr\.model/);
    const byTriggerSql = execMock.mock.calls[2][0] as string;
    expect(byTriggerSql).toMatch(/GROUP BY br\.trigger/);

    expect(summary.totalAllocatedUsd).toBe(500);
    expect(summary.totalSpentThisPeriodUsd).toBe(120);
    expect(summary.byModel).toEqual([{ model: 'us.amazon.nova-pro-v1:0', spentUsd: 80, runCount: 5 }]);
    expect(summary.byTrigger).toHaveLength(2);
    expect(summary.byTrigger[0]).toEqual({ trigger: 'cron', spentUsd: 90, runCount: 6 });
  });

  it('degrades to the zeroed shape when the bots schema is missing', async () => {
    execMock.mockRejectedValue(new Error('relation "bot_runs" does not exist'));
    expect(await orgSummary()).toEqual({
      totalAllocatedUsd: 0, totalSpentThisPeriodUsd: 0, byModel: [], byTrigger: [],
    });
  });
});

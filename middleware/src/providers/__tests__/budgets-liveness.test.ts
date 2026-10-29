// The Budgets ledger's two time semantics, which are NOT the same and must
// not be merged again.
//
//   spend   — month-to-date (PERIOD_START_SQL). It is judged against
//             initiative_budgets.allocated_usd, which is monthly, so a lifetime
//             total could never be read against anything.
//   liveness— lifetime. "When did an agent last touch this initiative" is not a
//             money question.
//
// lastAgentActivityAt used to be MAX(started_at) taken from inside the
// month-windowed period_spend CTE, so an initiative dormant since last month
// read "26d ago" on Budgets and "never" on Initiatives — the Initiatives
// rollup (providers/projects.ts) had already been left deliberately unwindowed.
// Two pages, one fact, two answers. These tests pin the split.

jest.mock('../aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../config.js', () => ({ config: { mock: { aurora: false } } }));

import { exec } from '../aurora.js';
import { PERIOD_START_SQL, spendPredicateSql, listBudgets, getBudget } from '../budgets.js';

const execMock = exec as unknown as jest.Mock;

beforeEach(() => {
  execMock.mockReset();
  execMock.mockResolvedValue([]);
});

async function ledgerSql(): Promise<string> {
  await listBudgets();
  return String(execMock.mock.calls[0]?.[0] ?? '');
}

/** The `(SELECT MAX(br.started_at) ... ) AS last_agent_activity_at` expression. */
function livenessExpr(sql: string): string {
  const end = sql.indexOf('AS last_agent_activity_at');
  expect(end).toBeGreaterThan(-1);
  const start = sql.lastIndexOf('(SELECT MAX(br.started_at)', end);
  expect(start).toBeGreaterThan(-1);
  return sql.slice(start, end);
}

describe('lastAgentActivityAt', () => {
  it('is lifetime — the period window appears nowhere inside it', async () => {
    const expr = livenessExpr(await ledgerSql());
    expect(expr).not.toContain(PERIOD_START_SQL);
    expect(expr).not.toMatch(/started_at\s*>=/);
  });

  it('is no longer taken from the month-windowed spend CTE', async () => {
    const sql = await ledgerSql();
    // The CTE still exists and is still windowed — it just no longer carries
    // the liveness column out with the money.
    expect(sql).toContain('period_spend AS (');
    expect(sql).not.toMatch(/MAX\(br\.started_at\) AS last_agent_activity_at/);
    expect(sql).not.toContain('ps.last_agent_activity_at');
  });

  it('uses the same three-way attribution the spend columns use', async () => {
    const expr = livenessExpr(await ledgerSql());
    expect(expr).toContain(spendPredicateSql('ids.org_project_id'));
  });
});

describe('spend columns', () => {
  it('stay month-to-date while liveness went lifetime', async () => {
    const sql = await ledgerSql();
    const cte = sql.slice(sql.indexOf('period_spend AS ('), sql.indexOf('ids AS ('));
    // DE-38: each initiative's own window, from the budget_windows CTE —
    // whose default (monthly, or no allocation row) is PERIOD_START_SQL.
    expect(cte).toContain('br.started_at >= bw.period_start');
    expect(sql.slice(sql.indexOf('budget_windows AS ('), sql.indexOf('period_spend AS ('))).toContain(`ELSE ${PERIOD_START_SQL} END AS period_start`);
    expect(cte).toContain('SUM(br.cost_usd)');
    expect(cte).toContain('maintenance_usd');
    // …and the window is bounded only at the start: a "period" that also
    // capped the end would drop today's runs.
    expect(cte).not.toMatch(/started_at\s*<[^=]/);
  });

  it('scopes to one initiative without disturbing either window', async () => {
    execMock.mockResolvedValue([]);
    await getBudget('p-observability');
    const sql = String(execMock.mock.calls[0]?.[0] ?? '');
    expect(sql).toContain('WHERE ids.org_project_id = :pid');
    expect(livenessExpr(sql)).not.toContain(PERIOD_START_SQL);
    expect(sql).toContain('br.started_at >= bw.period_start');
    expect(sql).toContain('WHERE p.id = :pid');
  });
});

// The Initiatives rollup's agent-spend window.
//
// This existed as a defect for as long as both surfaces existed: listProjects
// summed bot_runs.cost_usd with NO time predicate (lifetime) while the Budgets
// ledger windowed on the calendar month, and neither page named its window. The
// same initiative therefore reported two different "agent spend" figures —
// p-llm-platform $4.1025 on Initiatives, $3.7530 on Budgets — and clicking
// between them looked like the number had moved.
//
// Lifetime spend also answers nothing this product asks: the only ceiling in
// the system is initiative_budgets.allocated_usd, which is monthly, so a
// monotonically growing total can never be judged against anything. One window,
// declared once in providers/budgets.ts and imported here.
//
// The tests below assert the SQL the rollup actually emits, not the source text.

const send = jest.fn();

jest.mock('@aws-sdk/client-rds-data', () => ({
  RDSDataClient: jest.fn().mockImplementation(() => ({ send })),
  ExecuteStatementCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

jest.mock('../../config.js', () => ({
  config: {
    region: 'us-east-1',
    mock: { aurora: false },
    aurora: { clusterArn: 'arn:cluster', secretArn: 'arn:secret', database: 'orgiq' },
  },
}));

import { listProjects } from '../projects.js';
import { PERIOD_START_SQL } from '../budgets.js';

beforeEach(() => {
  send.mockReset();
  send.mockResolvedValue({ columnMetadata: [], records: [] });
});

/** The SQL of the rollup query (the first statement listProjects issues). */
async function rollupSql(): Promise<string> {
  await listProjects({ limit: 50 });
  return String(send.mock.calls[0]?.[0]?.input?.sql ?? '');
}

describe('listProjects agent spend', () => {
  it('windows spend on the budget period, not on all time', async () => {
    const sql = await rollupSql();
    const spendSelect = sql.slice(
      sql.indexOf('AS agent_spend_usd') - 900,
      sql.indexOf('AS agent_spend_usd'),
    );
    expect(spendSelect).toContain(`br.started_at >= ${PERIOD_START_SQL}`);
  });

  it('uses the ledger window verbatim rather than declaring its own', async () => {
    const sql = await rollupSql();
    // Every month-truncation in this query must be the imported constant.
    const truncations = sql.match(/date_trunc\('month', NOW\(\)\)/g) ?? [];
    expect(truncations.length).toBeGreaterThan(0);
    expect(PERIOD_START_SQL).toBe(`date_trunc('month', NOW())`);
  });

  it('keeps the three-way attribution the ledger copies', async () => {
    const sql = await rollupSql();
    expect(sql).toMatch(/br\.work_item_id IN \(SELECT w2\.id FROM work_items w2 WHERE w2\.project_id = p\.id\)/);
    expect(sql).toMatch(/b\.org_project_id = p\.id/);
    expect(sql).toMatch(/ap\.org_project_id = p\.id/);
  });

  // Liveness is a different question from money. Windowing MAX(started_at) too
  // would report an initiative that last ran in June as never having run.
  it('leaves last agent activity unwindowed', async () => {
    const sql = await rollupSql();
    const lastActivity = sql.slice(
      sql.indexOf('AS last_agent_activity_at') - 500,
      sql.indexOf('AS last_agent_activity_at'),
    );
    const subselect = lastActivity.slice(lastActivity.lastIndexOf('(SELECT MAX(br.started_at)'));
    expect(subselect).not.toContain('date_trunc');
    expect(subselect).toContain('br.cost_usd IS NOT NULL');
  });
});

// GET /api/graph/projects/:id — the two rollups the initiative Overview's stat
// strip reads ("2 agents running", "$1.73 spent of $95 allocated").
//
// Both already existed on the LIST (ProjectSummary.activeAgentRuns /
// allocatedUsd) and not on the detail, so the Overview could only render them
// by refetching the whole initiatives list — the same refetch the detail's
// spend field was added to end. What is pinned:
//   * mock mode, through the real router: `allocatedUsd` is the ledger's
//     allocation, `activeAgentRuns` is counted from running bot_runs rows, an
//     initiative with neither reads `null` allocation / `0` runs (never a
//     missing key), and an unknown id is still a 404,
//   * the Aurora path: the running-runs count rides the spend statement with
//     the list's own predicate ('running' + 24h), the allocation is its OWN
//     guarded query, and a cluster without initiative_budgets costs the
//     allocation only — never the spend figure or the page.

const send = jest.fn();

jest.mock('@aws-sdk/client-rds-data', () => ({
  RDSDataClient: jest.fn().mockImplementation(() => ({ send })),
  ExecuteStatementCommand: jest.fn().mockImplementation((input) => ({ input })),
}));
// The router's governance gate is built at import; these reads carry none.
jest.mock('../../lib/authz.js', () => ({
  requireAction: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  resolveSession: () => null,
}));

// The budgets read tier (lib/budget-read-tier.ts) decides whether the dollar
// fields ship; these suites read as a tier holder unless a case says otherwise.
const mockCanReadBudgets = jest.fn(async () => true);
jest.mock('../../lib/budget-read-tier.js', () => ({
  ...jest.requireActual('../../lib/budget-read-tier.js'),
  canReadBudgets: () => mockCanReadBudgets(),
}));

import express from 'express';
import request from '../../test-support/http.js';

async function buildApp() {
  const { projectsRouter } = await import('../projects.js');
  const { errorHandler } = await import('../../lib/async-handler.js');
  const app = express();
  app.use(express.json());
  app.use('/api/graph/projects', projectsRouter);
  app.use(errorHandler);
  return app;
}

describe('detail rollups — mock mode (dev:mock), through the router', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.doMock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));
  });

  it('carries the ledger allocation and the counted running runs for Observability', async () => {
    const app = await buildApp();
    const { MOCK_BUDGETS } = await import('../../providers/budgets.js');
    const { botRuns } = await import('../../mock/bots.js');
    const res = await request(app).get('/api/graph/projects/p-observability');
    expect(res.status).toBe(200);
    expect(res.body.allocatedUsd).toBe(MOCK_BUDGETS.find((b) => b.id === 'p-observability')!.allocated);
    expect(res.body.activeAgentRuns).toBe(botRuns.rows().filter((r) => r.status === 'running').length);
    expect(res.body.activeAgentRuns).toBe(2);
  });

  it('reads an initiative with no allocation and nothing running as null / 0, not absent', async () => {
    const app = await buildApp();
    // p-inference-platform is held at a null allocation on purpose (mock/budgets.ts).
    const res = await request(app).get('/api/graph/projects/p-inference-platform');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('allocatedUsd', null);
    expect(res.body).toHaveProperty('activeAgentRuns', 0);
  });

  it('agrees with the list row for the same id', async () => {
    const app = await buildApp();
    const list = await request(app).get('/api/graph/projects?limit=200');
    const detail = await request(app).get('/api/graph/projects/p-observability');
    const row = (list.body as Array<{ id: string; allocatedUsd: number | null; activeAgentRuns: number | null }>)
      .find((p) => p.id === 'p-observability');
    expect(detail.body.allocatedUsd).toBe(row?.allocatedUsd);
    expect(detail.body.activeAgentRuns).toBe(row?.activeAgentRuns);
  });

  it('still 404s an unknown id', async () => {
    const app = await buildApp();
    const res = await request(app).get('/api/graph/projects/p-nope');
    expect(res.status).toBe(404);
  });
});

describe('detail rollups — Aurora path', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.doMock('../../config.js', () => ({
      config: {
        region: 'us-east-1',
        mock: { aurora: false },
        aurora: { clusterArn: 'arn:cluster', secretArn: 'arn:secret', database: 'orgiq' },
      },
    }));
    send.mockReset();
  });

  function queueHead() {
    send.mockResolvedValueOnce({
      columnMetadata: [{ name: 'id' }, { name: 'name' }, { name: 'status' }, { name: 'created_at' }],
      records: [[
        { stringValue: 'p-observability' }, { stringValue: 'Observability Platform' },
        { stringValue: 'in_progress' }, { stringValue: '2026-05-24T12:00:00Z' },
      ]],
    });
    send.mockResolvedValueOnce({ columnMetadata: [], records: [] }); // contributors
    send.mockResolvedValueOnce({ columnMetadata: [], records: [] }); // owner
    send.mockResolvedValueOnce({ columnMetadata: [], records: [] }); // summary/sponsor
  }

  function sqlOf(call: number): string {
    return String(send.mock.calls[call]?.[0]?.input?.sql ?? '');
  }

  it('counts running runs with the list\'s predicate and reads the allocation separately', async () => {
    queueHead();
    send.mockResolvedValueOnce({
      columnMetadata: [{ name: 'agent_spend_usd' }, { name: 'repo_full_name' }, { name: 'active_agent_runs' }],
      records: [[{ doubleValue: 1.73 }, { stringValue: 'connorhoehn/orgiq-observability' }, { longValue: 2 }]],
    });
    send.mockResolvedValueOnce({ columnMetadata: [{ name: 'allocated_usd' }], records: [[{ doubleValue: 95 }]] });

    const app = await buildApp();
    const res = await request(app).get('/api/graph/projects/p-observability');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ agentSpendUsd: 1.73, activeAgentRuns: 2, allocatedUsd: 95 });

    const spendSql = sqlOf(4);
    expect(spendSql).toMatch(/br\.status = 'running' AND br\.started_at > NOW\(\) - INTERVAL '24 hours'/);
    expect(spendSql).toMatch(/AS active_agent_runs/);
    expect(sqlOf(5)).toMatch(/FROM initiative_budgets ib\s+WHERE ib\.org_project_id = :id/);
  });

  it('costs only the allocation when initiative_budgets is missing', async () => {
    queueHead();
    send.mockResolvedValueOnce({
      columnMetadata: [{ name: 'agent_spend_usd' }, { name: 'repo_full_name' }, { name: 'active_agent_runs' }],
      records: [[{ doubleValue: 1.73 }, { isNull: true }, { longValue: 0 }]],
    });
    send.mockRejectedValueOnce(new Error('relation "initiative_budgets" does not exist'));

    const app = await buildApp();
    const res = await request(app).get('/api/graph/projects/p-observability');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ agentSpendUsd: 1.73, activeAgentRuns: 0, allocatedUsd: null });
  });

  it('reads both rollups as null when bot_runs predates the schema', async () => {
    queueHead();
    send.mockRejectedValueOnce(new Error('relation "bot_runs" does not exist'));
    send.mockResolvedValueOnce({ columnMetadata: [{ name: 'allocated_usd' }], records: [] });

    const app = await buildApp();
    const res = await request(app).get('/api/graph/projects/p-observability');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ agentSpendUsd: null, activeAgentRuns: null, allocatedUsd: null });
  });

  it('404s an id the projects table does not carry', async () => {
    send.mockResolvedValueOnce({ columnMetadata: [{ name: 'id' }], records: [] });
    const app = await buildApp();
    const res = await request(app).get('/api/graph/projects/p-nope');
    expect(res.status).toBe(404);
  });
});

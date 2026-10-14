// GET /api/graph/projects/:id — agent spend + repo link on the detail read.
//
// ProjectDetailPage.tsx used to refetch the WHOLE /api/graph/projects list
// just to pick agentSpendUsd/repoFullName out of the one row matching the
// current id — on every visit, polled every 60s. getProject() now carries
// both fields itself (same rollup listProjects computes, scoped to one id),
// so the page can read them off the single-project fetch it already makes.
//
// These tests assert the SQL shape (real Aurora path) and the mock-mode
// parity (dev:mock path) getProject actually returns, not the source text.

const send = jest.fn();

jest.mock('@aws-sdk/client-rds-data', () => ({
  RDSDataClient: jest.fn().mockImplementation(() => ({ send })),
  ExecuteStatementCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

describe('getProject agentSpendUsd/repoFullName — real Aurora path', () => {
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

  /** Queues the 5 sequential exec() calls getProject makes on the Aurora
      path: project row, contributors, owner (guarded), summary/sponsor
      (guarded), agent-spend/repo (guarded). */
  function queueResponses(opts: { agentSpendUsd?: number | null; repoFullName?: string | null }) {
    send.mockResolvedValueOnce({
      columnMetadata: [{ name: 'id' }, { name: 'name' }, { name: 'status' }, { name: 'created_at' }],
      records: [[
        { stringValue: 'p-observability' },
        { stringValue: 'Observability Platform' },
        { stringValue: 'in_progress' },
        { stringValue: '2026-05-24T12:00:00Z' },
      ]],
    });
    send.mockResolvedValueOnce({ columnMetadata: [], records: [] }); // contributors
    send.mockResolvedValueOnce({ columnMetadata: [], records: [] }); // owner (none set)
    send.mockResolvedValueOnce({ columnMetadata: [], records: [] }); // summary/sponsor (none set)
    send.mockResolvedValueOnce({
      columnMetadata: [{ name: 'agent_spend_usd' }, { name: 'repo_full_name' }],
      records: [[
        opts.agentSpendUsd === undefined ? { isNull: true } : { doubleValue: opts.agentSpendUsd },
        opts.repoFullName === undefined ? { isNull: true } : { stringValue: opts.repoFullName },
      ]],
    });
  }

  it('scopes the spend/repo subqueries to this project id', async () => {
    const { getProject } = await import('../projects.js');
    queueResponses({ agentSpendUsd: 12.5, repoFullName: 'connorhoehnslalom/orgiq-observability' });
    await getProject('p-observability');
    const sql = String(send.mock.calls[4]?.[0]?.input?.sql ?? '');
    expect(sql).toMatch(/agent_spend_usd/);
    expect(sql).toMatch(/ap\.repo_full_name FROM agent_projects ap\s+WHERE ap\.org_project_id = :id/);
  });

  it('maps agent_spend_usd and repo_full_name onto the detail response', async () => {
    const { getProject } = await import('../projects.js');
    queueResponses({ agentSpendUsd: 12.5, repoFullName: 'connorhoehnslalom/orgiq-observability' });
    const project = await getProject('p-observability');
    expect(project?.agentSpendUsd).toBe(12.5);
    expect(project?.repoFullName).toBe('connorhoehnslalom/orgiq-observability');
  });

  it('reports nulls, not a crash, when nothing is linked yet', async () => {
    const { getProject } = await import('../projects.js');
    queueResponses({});
    const project = await getProject('p-observability');
    expect(project?.agentSpendUsd).toBeNull();
    expect(project?.repoFullName).toBeNull();
  });

  it('degrades to nulls, not a 500, when bot_runs/agent_projects predate the schema', async () => {
    const { getProject } = await import('../projects.js');
    send.mockResolvedValueOnce({
      columnMetadata: [{ name: 'id' }, { name: 'name' }, { name: 'status' }, { name: 'created_at' }],
      records: [[
        { stringValue: 'p-observability' },
        { stringValue: 'Observability Platform' },
        { stringValue: 'in_progress' },
        { stringValue: '2026-05-24T12:00:00Z' },
      ]],
    });
    send.mockResolvedValueOnce({ columnMetadata: [], records: [] });
    send.mockResolvedValueOnce({ columnMetadata: [], records: [] });
    send.mockResolvedValueOnce({ columnMetadata: [], records: [] });
    send.mockRejectedValueOnce(new Error('relation "bot_runs" does not exist'));

    const project = await getProject('p-observability');
    expect(project?.agentSpendUsd).toBeNull();
    expect(project?.repoFullName).toBeNull();
    // The rest of the detail still resolves — one missing table doesn't take
    // the whole page down.
    expect(project?.id).toBe('p-observability');
  });
});

describe('getProject agentSpendUsd/repoFullName — mock mode parity', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.doMock('../../config.js', () => ({
      config: { region: 'us-east-1', mock: { aurora: true } },
    }));
  });

  it('agrees with listProjects for the same initiative id', async () => {
    const { getProject, listProjects } = await import('../projects.js');
    const detail = await getProject('p-observability');
    const [summary] = await listProjects({ limit: 200 });
    const fromList = (await listProjects({ limit: 200 })).find((p) => p.id === 'p-observability');
    expect(detail?.agentSpendUsd).toBe(fromList?.agentSpendUsd);
    expect(detail?.repoFullName).toBe(fromList?.repoFullName);
    expect(summary).toBeDefined();
  });

  it('carries a repoFullName for every mock initiative', async () => {
    const { getProject } = await import('../projects.js');
    const ids = [
      'p-observability', 'p-auth-migration', 'p-llm-platform', 'p-cost-opt',
      'p-realtime-analytics', 'p-data-lake', 'p-feature-store', 'p-mobile-redesign',
      'p-design-v3', 'p-rag-search', 'p-soc2', 'p-design-system-api',
      'p-inference-platform', 'p-zero-trust',
    ];
    for (const id of ids) {
      const project = await getProject(id);
      expect(project?.repoFullName).toEqual(expect.stringMatching(/^connorhoehnslalom\//));
      expect(project?.agentSpendUsd).toEqual(expect.any(Number));
    }
  });
});

// Module marker: keeps the file-level `send` mock out of the global script scope.
export {};

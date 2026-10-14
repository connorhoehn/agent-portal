// TPM/release-manager visibility: the Initiatives rollup used to have no
// field naming the repository an initiative's code lives in, and the one
// endpoint that did (/api/agent-projects) is gated on ManageDevbox, which
// org-leader (the release manager) does not hold — see docs/program-
// operating-model.md's role table. GET /api/graph/projects carries no
// capability gate beyond requireTenant('orgiq'), so surfacing repoFullName
// here is the read path a TPM actually has.
//
// These tests assert the SQL shape (real Aurora path) and the mock-mode
// parity (dev:mock path), not the source text.

const send = jest.fn();

jest.mock('@aws-sdk/client-rds-data', () => ({
  RDSDataClient: jest.fn().mockImplementation(() => ({ send })),
  ExecuteStatementCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

describe('listProjects repoFullName — real Aurora path', () => {
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
    send.mockResolvedValue({ columnMetadata: [], records: [] });
  });

  it('sources repo_full_name from agent_projects joined on org_project_id', async () => {
    const { listProjects } = await import('../projects.js');
    await listProjects({ limit: 50 });
    const sql = String(send.mock.calls[0]?.[0]?.input?.sql ?? '');
    expect(sql).toMatch(
      /SELECT ap\.repo_full_name FROM agent_projects ap\s+WHERE ap\.org_project_id = p\.id/,
    );
    expect(sql).toContain('AS repo_full_name');
  });

  it('maps the repo_full_name column onto ProjectSummary.repoFullName', async () => {
    const { listProjects } = await import('../projects.js');
    send.mockResolvedValueOnce({
      columnMetadata: [{ name: 'id' }, { name: 'name' }, { name: 'repo_full_name' }],
      records: [[
        { stringValue: 'p-observability' },
        { stringValue: 'Observability Platform' },
        { stringValue: 'connorhoehnslalom/orgiq-observability' },
      ]],
    });
    const [project] = await listProjects({ limit: 1 });
    expect(project?.repoFullName).toBe('connorhoehnslalom/orgiq-observability');
  });

  it('reports null, not a crash, when no repo is linked yet', async () => {
    const { listProjects } = await import('../projects.js');
    send.mockResolvedValueOnce({
      columnMetadata: [{ name: 'id' }, { name: 'name' }, { name: 'repo_full_name' }],
      records: [[
        { stringValue: 'p-data-lake' },
        { stringValue: 'Data Lake Migration' },
        { isNull: true },
      ]],
    });
    const [project] = await listProjects({ limit: 1 });
    expect(project?.repoFullName).toBeNull();
  });
});

describe('listProjects repoFullName — mock mode parity', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.doMock('../../config.js', () => ({
      config: { region: 'us-east-1', mock: { aurora: true } },
    }));
  });

  it('reports the same repoFullName dev:mock shows for a known initiative', async () => {
    const { listProjects } = await import('../projects.js');
    const projects = await listProjects({ limit: 200 });
    const observability = projects.find((p) => p.id === 'p-observability');
    expect(observability?.repoFullName).toBe('connorhoehnslalom/orgiq-observability');
  });

  it('every mock initiative carries a repoFullName', async () => {
    const { listProjects } = await import('../projects.js');
    const projects = await listProjects({ limit: 200 });
    expect(projects.length).toBeGreaterThan(0);
    for (const p of projects) {
      expect(p.repoFullName).toEqual(expect.stringMatching(/^connorhoehnslalom\//));
    }
  });
});

// Module marker: keeps the file-level `send` mock out of the global script scope.
export {};

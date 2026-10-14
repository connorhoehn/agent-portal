// GET /api/graph/projects/:id — summary + sponsor.
//
// The project overview card had no prose summary and no executive sponsor
// (the VP-like authorizer who signed off on the initiative existing —
// distinct from the owner who runs it day to day and the SMEs who attach to
// it). Both are new columns (projects.summary, projects.sponsor_person_id)
// added alongside owner_id, so they get the SAME guarded-query treatment:
// a pre-migration cluster degrades to nulls, not a 500.
//
// These tests assert the SQL shape (real Aurora path) and the mock-mode
// parity (dev:mock path) getProject actually returns, not the source text.

const send = jest.fn();

jest.mock('@aws-sdk/client-rds-data', () => ({
  RDSDataClient: jest.fn().mockImplementation(() => ({ send })),
  ExecuteStatementCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

describe('getProject summary/sponsor — real Aurora path', () => {
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

  /** Queues the 4 sequential exec() calls getProject makes on the Aurora
      path: project row, contributors, owner (guarded), sponsor (guarded). */
  function queueResponses(opts: {
    sponsorPersonId?: string | null;
    sponsorName?: string | null;
    sponsorTitle?: string | null;
    summary?: string | null;
  }) {
    // 1. project row
    send.mockResolvedValueOnce({
      columnMetadata: [{ name: 'id' }, { name: 'name' }, { name: 'status' }, { name: 'created_at' }],
      records: [[
        { stringValue: 'p-observability' },
        { stringValue: 'Observability Platform' },
        { stringValue: 'in_progress' },
        { stringValue: '2026-05-24T12:00:00Z' },
      ]],
    });
    // 2. contributors
    send.mockResolvedValueOnce({ columnMetadata: [], records: [] });
    // 3. owner (guarded)
    send.mockResolvedValueOnce({
      columnMetadata: [{ name: 'owner_id' }, { name: 'owner_name' }],
      records: [[{ stringValue: 'p-004' }, { stringValue: 'Nora DaSilva' }]],
    });
    // 4. sponsor + summary (guarded)
    send.mockResolvedValueOnce({
      columnMetadata: [
        { name: 'summary' }, { name: 'sponsor_person_id' },
        { name: 'sponsor_name' }, { name: 'sponsor_title' },
      ],
      records: [[
        opts.summary === undefined ? { isNull: true } : opts.summary === null ? { isNull: true } : { stringValue: opts.summary },
        opts.sponsorPersonId === undefined ? { isNull: true } : opts.sponsorPersonId === null ? { isNull: true } : { stringValue: opts.sponsorPersonId },
        opts.sponsorName === undefined ? { isNull: true } : opts.sponsorName === null ? { isNull: true } : { stringValue: opts.sponsorName },
        opts.sponsorTitle === undefined ? { isNull: true } : opts.sponsorTitle === null ? { isNull: true } : { stringValue: opts.sponsorTitle },
      ]],
    });
  }

  it('queries sponsor_person_id joined against people for name + title', async () => {
    const { getProject } = await import('../projects.js');
    queueResponses({
      summary: 'Unified telemetry across every service.',
      sponsorPersonId: 'p-002', sponsorName: 'Vera Green', sponsorTitle: 'Principal Engineer',
    });
    await getProject('p-observability');
    const sql = String(send.mock.calls[3]?.[0]?.input?.sql ?? '');
    expect(sql).toMatch(/sponsor_person_id/);
    expect(sql).toMatch(/LEFT JOIN people pe ON pe\.id = p\.sponsor_person_id/);
  });

  it('resolves sponsor id to name + title', async () => {
    const { getProject } = await import('../projects.js');
    queueResponses({
      summary: 'Unified telemetry across every service.',
      sponsorPersonId: 'p-002', sponsorName: 'Vera Green', sponsorTitle: 'Principal Engineer',
    });
    const project = await getProject('p-observability');
    expect(project?.sponsorId).toBe('p-002');
    expect(project?.sponsorName).toBe('Vera Green');
    expect(project?.sponsorTitle).toBe('Principal Engineer');
  });

  it('passes summary through untouched', async () => {
    const { getProject } = await import('../projects.js');
    queueResponses({
      summary: 'Unified telemetry across every service.',
      sponsorPersonId: 'p-002', sponsorName: 'Vera Green', sponsorTitle: 'Principal Engineer',
    });
    const project = await getProject('p-observability');
    expect(project?.summary).toBe('Unified telemetry across every service.');
  });

  it('returns nulls, not a throw, when no sponsor is set', async () => {
    const { getProject } = await import('../projects.js');
    queueResponses({ summary: null, sponsorPersonId: null, sponsorName: null, sponsorTitle: null });
    const project = await getProject('p-observability');
    expect(project?.sponsorId).toBeNull();
    expect(project?.sponsorName).toBeNull();
    expect(project?.sponsorTitle).toBeNull();
    expect(project?.summary).toBeNull();
  });

  it('degrades to nulls, not a 500, when the columns predate the migration', async () => {
    const { getProject } = await import('../projects.js');
    // project row + contributors + owner succeed; the summary/sponsor query
    // throws — the exact shape of a pre-migration cluster missing the column.
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
    send.mockResolvedValueOnce({
      columnMetadata: [{ name: 'owner_id' }, { name: 'owner_name' }],
      records: [[{ stringValue: 'p-004' }, { stringValue: 'Nora DaSilva' }]],
    });
    send.mockRejectedValueOnce(new Error('column "sponsor_person_id" does not exist'));

    const project = await getProject('p-observability');
    expect(project?.summary).toBeNull();
    expect(project?.sponsorId).toBeNull();
    expect(project?.sponsorName).toBeNull();
    expect(project?.sponsorTitle).toBeNull();
    // The rest of the detail still resolves — one missing column doesn't
    // take the whole page down.
    expect(project?.ownerId).toBe('p-004');
  });
});

describe('getProject summary/sponsor — mock mode parity', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.doMock('../../config.js', () => ({
      config: { region: 'us-east-1', mock: { aurora: true } },
    }));
  });

  it('resolves a real sponsor for a known initiative, distinct from the owner', async () => {
    const { getProject } = await import('../projects.js');
    const project = await getProject('p-observability');
    expect(project?.ownerId).toBe('p-004');
    expect(project?.sponsorId).toBe('p-002');
    expect(project?.sponsorName).toBe('Vera Green');
    expect(project?.sponsorTitle).toBe('Principal Engineer');
    expect(project?.sponsorId).not.toBe(project?.ownerId);
  });

  it('returns non-empty summary prose for every mock initiative', async () => {
    const { getProject } = await import('../projects.js');
    const ids = [
      'p-observability', 'p-auth-migration', 'p-llm-platform', 'p-cost-opt',
      'p-realtime-analytics', 'p-data-lake', 'p-feature-store', 'p-mobile-redesign',
      'p-design-v3', 'p-rag-search', 'p-soc2', 'p-design-system-api',
      'p-inference-platform', 'p-zero-trust',
    ];
    for (const id of ids) {
      const project = await getProject(id);
      expect(project?.summary).toEqual(expect.any(String));
      expect(project?.summary?.length).toBeGreaterThan(0);
      expect(project?.sponsorId).toEqual(expect.any(String));
      expect(project?.sponsorName).toEqual(expect.any(String));
      expect(project?.sponsorTitle).toEqual(expect.any(String));
    }
  });

  it('returns null, not a throw, for an unknown project id', async () => {
    const { getProject } = await import('../projects.js');
    expect(await getProject('p-nope')).toBeNull();
  });
});

// Module marker: keeps the file-level `send` mock out of the global script scope.
export {};

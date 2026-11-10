// Quality — /api/observability/quality (routes/quality.ts).
//
// What is pinned:
//   * the snake_case → camelCase mapping the chart reads (`invocation_id` →
//     `invocationId`, `judge_score` → `judgeScore`, …) and its NULL handling.
//     `judgeScore: null` must survive as null: coercing an unjudged row to 0
//     would draw a flat line at the bottom of the quality chart and read as
//     "every answer was terrible",
//   * that synthetic `test:%` traffic is excluded from the series — the
//     harness writes those rows and they are not org traffic,
//   * the `since` grammar (bare `60m`, an ISO instant, and a garbage value
//     that falls back to the 24h default) and the parameter each binds,
//   * the read degrades to `{points: []}` when the observability schema is
//     missing rather than 500ing the page,
//   * the write's auth floor (LabelFeedback — the one endpoint that consumes
//     that grant), its label allow-list, its UUID check, and its 404.

const gateCalls: string[] = [];

jest.mock('../../lib/authz.js', () => ({
  requireAction: (action: string) => {
    gateCalls.push(action);
    return (_req: unknown, _res: unknown, next: () => void) => next();
  },
}));
jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn() }));
// The router now has an offline branch gated on `config.mock.aurora`, so it
// imports config.ts — which reaches `import.meta` and is unloadable under the
// CJS test build (the same trap drift-routes.test.ts documents). Mocked with
// `aurora: false` on purpose: every case in this file is about the LIVE SQL
// path, and the offline branch is pinned separately in
// observability-mock-branch.test.ts.
jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', mock: { aurora: false } },
}));

import express from 'express';
import request from '../../test-support/http.js';
import { qualityRouter } from '../quality.js';
import { errorHandler } from '../../lib/async-handler.js';
import { exec } from '../../providers/aurora.js';

const execMock = exec as unknown as jest.Mock;

type Param = { name: string; value: Record<string, unknown> };
const paramsOf = (call: number): Param[] => (execMock.mock.calls[call]![1] ?? []) as Param[];
const sqlOf = (call: number): string => String(execMock.mock.calls[call]![0]);

function buildApp() {
  const app = express();
  app.use(express.json());
  // The snippet routes read their scope from the session (lib/trace-scope.ts); these
  // cases are about the data plane, so they run as the cross-tenant admin.
  app.use((req, _res, next) => { (req as unknown as { session: unknown }).session = { sub: 'u-admin', role: 'admin', tenant: 'orgiq', grants: {}, iat: 0 }; next(); });
  app.use('/api/observability/quality', qualityRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => { execMock.mockReset(); });

describe('auth floor', () => {
  it('gates only the feedback write, on LabelFeedback', () => {
    expect(gateCalls).toEqual(['LabelFeedback']);
  });
});

describe('GET /scores', () => {
  it('maps the trace row onto the wire names the chart reads', async () => {
    execMock.mockResolvedValue([{
      invocation_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      agent_id: 'orgiq-supervisor', ts: '2026-08-20T09:00:00Z',
      judge_score: '0.82', schema_valid: true, human_label: 'good',
      judge_rationale: 'Grounded, cites its sources.',
      input_tokens: 540, output_tokens: 200,
      est_cost_usd: '0.001072', judge_cost_usd: '0.000509', total_cost_usd: '0.001581',
      prompt_version: 'e29795dd3691', model_id: 'amazon.nova-pro-v1:0',
    }]);
    const res = await request(buildApp()).get('/api/observability/quality/scores');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['points']);
    expect(res.body.points[0]).toEqual({
      invocationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      agentId: 'orgiq-supervisor', ts: '2026-08-20T09:00:00Z',
      judgeScore: 0.82, schemaValid: true, humanLabel: 'good',
      // The Quality page renders RATIONALE and COST columns and this route
      // returned neither, so both were empty on every row of every deployment.
      // Every column below exists on the table; the SELECT simply omitted them.
      judgeRationale: 'Grounded, cites its sources.',
      inputTokens: 540, outputTokens: 200,
      estCostUsd: 0.001072, judgeCostUsd: 0.000509, totalCostUsd: 0.001581,
      promptVersion: 'e29795dd3691', modelId: 'amazon.nova-pro-v1:0',
    });
    // The Data API returns numerics as strings; cost must land as a number.
    expect(typeof res.body.points[0].totalCostUsd).toBe('number');
    // The numeric came back as a string from the Data API and must land as a
    // number, not "0.82".
    expect(typeof res.body.points[0].judgeScore).toBe('number');
  });

  it('keeps an UNJUDGED row null rather than scoring it zero', async () => {
    execMock.mockResolvedValue([{
      invocation_id: 'x', agent_id: 'a', ts: 't',
      judge_score: null, schema_valid: null, human_label: null,
    }]);
    const res = await request(buildApp()).get('/api/observability/quality/scores');
    expect(res.body.points[0].judgeScore).toBeNull();
    expect(res.body.points[0].schemaValid).toBeNull();
    expect(res.body.points[0].humanLabel).toBeNull();
    // A row written before the cost migration, or by a trace POST that carried
    // no usage, has no cost. Null, never zero: "$0.0000" is a claim that the
    // call was free.
    expect(res.body.points[0].judgeRationale).toBeNull();
    expect(res.body.points[0].totalCostUsd).toBeNull();
    expect(res.body.points[0].inputTokens).toBeNull();
  });

  it('excludes synthetic test:% traffic from the series', async () => {
    execMock.mockResolvedValue([]);
    await request(buildApp()).get('/api/observability/quality/scores');
    expect(sqlOf(0)).toMatch(/template_id NOT LIKE 'test:%'/);
  });

  it('understands the three `since` forms and binds the right parameter', async () => {
    execMock.mockResolvedValue([]);
    const app = buildApp();
    await request(app).get('/api/observability/quality/scores');
    await request(app).get('/api/observability/quality/scores?since=60m');
    await request(app).get('/api/observability/quality/scores?since=2026-08-01T00:00:00Z');
    await request(app).get('/api/observability/quality/scores?since=not-a-time');

    expect(sqlOf(0)).toMatch(/INTERVAL '24 hours'/);
    expect(paramsOf(0)).toEqual([]);

    expect(sqlOf(1)).toMatch(/INTERVAL '1 minute' \* :mins/);
    expect(paramsOf(1)[0]).toEqual({ name: 'mins', value: { longValue: 60 } });

    expect(sqlOf(2)).toMatch(/:since_iso::timestamptz/);
    expect(paramsOf(2)[0]!.value['stringValue']).toBe('2026-08-01T00:00:00.000Z');

    // Unparseable: silently back to the default window, never an injected clause.
    expect(sqlOf(3)).toMatch(/INTERVAL '24 hours'/);
    expect(paramsOf(3)).toEqual([]);
  });

  it('binds an agent filter as a parameter, never inlined', async () => {
    execMock.mockResolvedValue([]);
    await request(buildApp()).get('/api/observability/quality/scores?agentId=orgiq-search');
    expect(sqlOf(0)).toMatch(/agent_id = :agent/);
    expect(sqlOf(0)).not.toMatch(/orgiq-search/);
    expect(paramsOf(0)).toContainEqual({ name: 'agent', value: { stringValue: 'orgiq-search' } });
  });

  it('marks a missing schema, and leaves an unjudged window unmarked', async () => {
    execMock.mockResolvedValue([]);
    const quiet = await request(buildApp()).get('/api/observability/quality/scores');
    expect(quiet.status).toBe(200);
    expect(quiet.body).toEqual({ points: [] });

    execMock.mockRejectedValue(new Error('relation "observability.invocation_traces" does not exist'));
    const res = await request(buildApp()).get('/api/observability/quality/scores');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      points: [], degraded: true,
      error: 'relation "observability.invocation_traces" does not exist',
    });
  });
});

describe('POST /feedback', () => {
  const UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  it('requires an invocationId that is actually a UUID', async () => {
    const missing = await request(buildApp()).post('/api/observability/quality/feedback')
      .send({ label: 'good' });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatch(/invocationId is required/);

    const notUuid = await request(buildApp()).post('/api/observability/quality/feedback')
      .send({ invocationId: 'nope', label: 'good' });
    expect(notUuid.status).toBe(400);
    expect(notUuid.body.error).toMatch(/UUID/);
    expect(execMock).not.toHaveBeenCalled();
  });

  it('accepts only good / bad / fixed, and names the allowed set when it refuses', async () => {
    const res = await request(buildApp()).post('/api/observability/quality/feedback')
      .send({ invocationId: UUID, label: 'excellent' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/good/);
    expect(res.body.error).toMatch(/bad/);
    expect(res.body.error).toMatch(/fixed/);

    execMock.mockResolvedValue([{ invocation_id: UUID }]);
    for (const label of ['good', 'bad', 'fixed']) {
      const ok = await request(buildApp()).post('/api/observability/quality/feedback')
        .send({ invocationId: UUID, label });
      expect(ok.status).toBe(200);
    }
  });

  it('echoes what it wrote and binds a missing note as SQL NULL, not ""', async () => {
    execMock.mockResolvedValue([{ invocation_id: UUID }]);
    const res = await request(buildApp()).post('/api/observability/quality/feedback')
      .send({ invocationId: UUID, label: 'bad' });
    expect(res.body).toEqual({ ok: true, invocationId: UUID, label: 'bad', note: '' });
    expect(paramsOf(0)).toContainEqual({ name: 'note', value: { isNull: true } });
  });

  it('truncates an oversized note to 2000 chars rather than rejecting it', async () => {
    execMock.mockResolvedValue([{ invocation_id: UUID }]);
    await request(buildApp()).post('/api/observability/quality/feedback')
      .send({ invocationId: UUID, label: 'good', note: 'z'.repeat(5000) });
    const note = paramsOf(0).find((p) => p.name === 'note')!;
    expect(String(note.value['stringValue'])).toHaveLength(2000);
  });

  it('404s when the UPDATE matched no trace', async () => {
    execMock.mockResolvedValue([]);
    const res = await request(buildApp()).post('/api/observability/quality/feedback')
      .send({ invocationId: UUID, label: 'good' });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/invocation not found/);
  });
});

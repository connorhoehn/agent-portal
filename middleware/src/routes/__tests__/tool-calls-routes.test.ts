// Tool calls — /api/observability/tools (routes/tool-calls.ts). Per-tool
// latency, the bucketed series, and the error tail on the triage page.
//
// What is pinned:
//   * the three wire shapes, and that a Data-API numeric string lands as a
//     NUMBER — `count: "7"` would sort lexicographically in the table,
//   * the deliberate ASYMMETRY this router documents: /latency and
//     /timeseries exclude `test:%` template traffic, /errors does NOT (the
//     harness's own failures are what a researcher came to see). A blanket
//     filter added to /errors is the regression this catches,
//   * that a p99 with no samples stays null while an error rate with no
//     samples reads 0 — "no data" and "no errors" are different answers,
//   * the clamps, including bucketMin's 5-minute FLOOR (a 1-minute bucket
//     would fan the group-by out over the whole window),
//   * every read degrading to an empty payload, with the echoed window/bucket
//     preserved so the chart axis still knows what it asked for.

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
import { toolCallsRouter } from '../tool-calls.js';
import { errorHandler } from '../../lib/async-handler.js';
import { exec } from '../../providers/aurora.js';

const execMock = exec as unknown as jest.Mock;

type Param = { name: string; value: Record<string, unknown> };
const paramsOf = (call: number): Param[] => (execMock.mock.calls[call]![1] ?? []) as Param[];
const sqlOf = (call: number): string => String(execMock.mock.calls[call]![0]);
const longOf = (call: number, name: string): unknown =>
  paramsOf(call).find((p) => p.name === name)?.value['longValue'];

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/observability/tools', toolCallsRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => { execMock.mockReset(); });

describe('GET /latency', () => {
  it('maps the rollup, coercing Data-API numeric strings to numbers', async () => {
    execMock.mockResolvedValue([{
      tool_name: 'kb_query', cnt: '7', p50: '120.5', p99: '900',
      error_rate: '0.142857', total_cost_usd: '0.0031', with_cost: '5',
    }]);
    const res = await request(buildApp()).get('/api/observability/tools/latency');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['byTool']);
    expect(res.body.byTool[0]).toEqual({
      toolName: 'kb_query', count: 7, p50DurationMs: 120.5, p99DurationMs: 900,
      errorRate: 0.142857, totalCostUsd: 0.0031, withCost: 5,
    });
    expect(typeof res.body.byTool[0].count).toBe('number');
  });

  it('distinguishes "no latency samples" (null) from "no errors" (0)', async () => {
    execMock.mockResolvedValue([{
      tool_name: 'kb_query', cnt: '1', p50: null, p99: null,
      error_rate: null, total_cost_usd: null, with_cost: '0',
    }]);
    const res = await request(buildApp()).get('/api/observability/tools/latency');
    expect(res.body.byTool[0].p50DurationMs).toBeNull();
    expect(res.body.byTool[0].p99DurationMs).toBeNull();
    expect(res.body.byTool[0].errorRate).toBe(0);
    expect(res.body.byTool[0].totalCostUsd).toBe(0);
  });

  it('excludes test:% template traffic and binds the agent filter', async () => {
    execMock.mockResolvedValue([]);
    await request(buildApp()).get('/api/observability/tools/latency?agentId=orgiq-search');
    expect(sqlOf(0)).toMatch(/it\.template_id NOT LIKE 'test:%'/);
    expect(sqlOf(0)).toMatch(/it\.agent_id = :agent_id/);
    expect(sqlOf(0)).not.toMatch(/orgiq-search/);
    expect(paramsOf(0)).toContainEqual({ name: 'agent_id', value: { stringValue: 'orgiq-search' } });
  });

  it('omits the agent clause entirely for a blank agentId', async () => {
    execMock.mockResolvedValue([]);
    await request(buildApp()).get('/api/observability/tools/latency?agentId=%20%20');
    expect(sqlOf(0)).not.toMatch(/agent_id = :agent_id/);
  });

  it('defaults the window to 24h, caps it at 14 days, ignores junk', async () => {
    execMock.mockResolvedValue([]);
    const app = buildApp();
    const base = '/api/observability/tools/latency';
    await request(app).get(base);
    await request(app).get('/api/observability/tools/latency?windowHours=100000');
    await request(app).get('/api/observability/tools/latency?windowHours=abc');
    await request(app).get('/api/observability/tools/latency?windowHours=-3');
    expect([0, 1, 2, 3].map((i) => longOf(i, 'hours'))).toEqual([24, 336, 24, 24]);
  });

  it('marks a DB error; a window with no tool calls stays unmarked', async () => {
    execMock.mockResolvedValue([]);
    const quiet = await request(buildApp()).get('/api/observability/tools/latency');
    expect(quiet.body).toEqual({ byTool: [] });

    execMock.mockRejectedValue(new Error('relation "observability.tool_calls" does not exist'));
    const res = await request(buildApp()).get('/api/observability/tools/latency');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      byTool: [], degraded: true,
      error: 'relation "observability.tool_calls" does not exist',
    });
  });
});

describe('GET /timeseries', () => {
  it('returns points beside the bucket + window the axis needs to label itself', async () => {
    execMock.mockResolvedValue([{
      bucket_start: '2026-08-20 09:00:00+00', tool_name: 'kb_query',
      cnt: '3', p99: '900', error_rate: '0', total_cost_usd: '0.01',
    }]);
    const res = await request(buildApp())
      .get('/api/observability/tools/timeseries?windowHours=6&bucketMin=30');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['bucketMin', 'points', 'windowHours']);
    expect(res.body.bucketMin).toBe(30);
    expect(res.body.windowHours).toBe(6);
    expect(res.body.points[0]).toEqual({
      bucketStart: '2026-08-20 09:00:00+00', toolName: 'kb_query',
      count: 3, p99DurationMs: 900, errorRate: 0, totalCostUsd: 0.01,
    });
  });

  it('floors bucketMin at 5 minutes and caps it at 6 hours', async () => {
    execMock.mockResolvedValue([]);
    const app = buildApp();
    const base = '/api/observability/tools/timeseries';
    await request(app).get(base);
    await request(app).get('/api/observability/tools/timeseries?bucketMin=1');
    await request(app).get('/api/observability/tools/timeseries?bucketMin=5');
    await request(app).get('/api/observability/tools/timeseries?bucketMin=99999');
    await request(app).get('/api/observability/tools/timeseries?bucketMin=abc');
    expect([0, 1, 2, 3, 4].map((i) => longOf(i, 'bucket'))).toEqual([60, 60, 5, 360, 60]);
  });

  it('excludes test:% traffic from the series too', async () => {
    execMock.mockResolvedValue([]);
    await request(buildApp()).get('/api/observability/tools/timeseries');
    expect(sqlOf(0)).toMatch(/it\.template_id NOT LIKE 'test:%'/);
  });

  it('marks a failed series while still echoing bucket + window', async () => {
    execMock.mockResolvedValue([]);
    const quiet = await request(buildApp())
      .get('/api/observability/tools/timeseries?windowHours=6&bucketMin=30');
    expect(quiet.body).toEqual({ points: [], bucketMin: 30, windowHours: 6 });

    execMock.mockRejectedValue(new Error('boom'));
    const res = await request(buildApp())
      .get('/api/observability/tools/timeseries?windowHours=6&bucketMin=30');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      points: [], bucketMin: 30, windowHours: 6, degraded: true, error: 'boom',
    });
  });
});

describe('GET /errors', () => {
  it('maps the error tail and keeps a missing message null', async () => {
    execMock.mockResolvedValue([{
      tool_call_id: 'tc-1', invocation_id: 'inv-1', agent_id: 'orgiq-search',
      tool_name: 'kb_query', error_message: 'AccessDenied', ts: '2026-08-20T09:00:00Z',
    }, {
      tool_call_id: 'tc-2', invocation_id: 'inv-2', agent_id: '',
      tool_name: 'graph_read', error_message: null, ts: '2026-08-20T08:00:00Z',
    }]);
    const res = await request(buildApp()).get('/api/observability/tools/errors');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['errors']);
    expect(res.body.errors[0]).toEqual({
      toolCallId: 'tc-1', invocationId: 'inv-1', agentId: 'orgiq-search',
      toolName: 'kb_query', errorMessage: 'AccessDenied', ts: '2026-08-20T09:00:00Z',
    });
    expect(res.body.errors[1].errorMessage).toBeNull();
  });

  it('deliberately does NOT filter test:% — the harness\'s own failures belong here', async () => {
    execMock.mockResolvedValue([]);
    await request(buildApp()).get('/api/observability/tools/errors');
    expect(sqlOf(0)).not.toMatch(/test:%/);
    expect(sqlOf(0)).toMatch(/tc\.errored = true/);
  });

  it('clamps the limit into 1..500 and falls back to 50 on junk', async () => {
    execMock.mockResolvedValue([]);
    const app = buildApp();
    const base = '/api/observability/tools/errors';
    await request(app).get(base);
    await request(app).get('/api/observability/tools/errors?limit=9999');
    await request(app).get('/api/observability/tools/errors?limit=abc');
    await request(app).get('/api/observability/tools/errors?limit=0');
    expect([0, 1, 2, 3].map((i) => longOf(i, 'lim'))).toEqual([50, 500, 50, 50]);
  });

  it('NEVER answers a bare empty error list on a DB error', async () => {
    // The most misleading empty in the tree. "No tool errors" is precisely
    // what someone opens this route to confirm, so a failed read that answers
    // `{errors: []}` does not merely lose information — it asserts the
    // reassuring thing.
    execMock.mockResolvedValue([]);
    const clean = await request(buildApp()).get('/api/observability/tools/errors');
    expect(clean.body).toEqual({ errors: [] });

    execMock.mockRejectedValue(new Error('boom'));
    const res = await request(buildApp()).get('/api/observability/tools/errors');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ errors: [], degraded: true, error: 'boom' });
  });
});

// Traffic shape — /api/observability/traffic (routes/traffic.ts).
//
// The load-bearing assertion here is on /per-agent-summary: `errorRate` counts
// only REAL failures — a guardrail intervention (action present and not
// 'NONE') or non-conforming output (schema_valid = false) — while a weak
// answer is reported separately as `lowQualityRate` (judge < 0.3). Folding a
// low judge score into the error rate made a healthy fleet giving mediocre
// answers alarm as erroring; that regression is what this file catches, at
// both the SQL and the arithmetic level.
//
// Also pinned:
//   * the four wire shapes and their echoed window/bucket/days,
//   * `rps` derived from the window the caller ASKED for, so the number means
//     something when the window changes,
//   * every rate guarded against a zero denominator (0, never NaN),
//   * that `top-users` skips rows with no user_id — an unattributed row is
//     not a user, and one would otherwise dominate the "biggest offender" list,
//   * `test:%` excluded everywhere, and every read degrading to an empty
//     payload rather than 500ing the page.

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
import { trafficRouter } from '../traffic.js';
import { errorHandler } from '../../lib/async-handler.js';
import { exec } from '../../providers/aurora.js';

const execMock = exec as unknown as jest.Mock;

type Param = { name: string; value: Record<string, unknown> };
const paramsOf = (call: number): Param[] => (execMock.mock.calls[call]![1] ?? []) as Param[];
const sqlOf = (call: number): string => String(execMock.mock.calls[call]![0]);
const longOf = (call: number, name: string): unknown =>
  paramsOf(call).find((p) => p.name === name)?.value['longValue'];

const READS = [
  '/api/observability/traffic/rps',
  '/api/observability/traffic/heatmap',
  '/api/observability/traffic/top-users',
  '/api/observability/traffic/per-agent-summary',
];

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/observability/traffic', trafficRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => { execMock.mockReset(); });

describe('the whole router', () => {
  it('excludes synthetic test:% traffic from every read', async () => {
    execMock.mockResolvedValue([]);
    const app = buildApp();
    for (const path of READS) {
      execMock.mockClear();
      await request(app).get(path);
      expect(sqlOf(0)).toMatch(/template_id NOT LIKE 'test:%'/);
    }
  });

  it('degrades to an empty payload on a DB error, keeping the echoed window', async () => {
    execMock.mockRejectedValue(new Error('relation "observability.invocation_traces" does not exist'));
    const app = buildApp();
    for (const path of READS) {
      const res = await request(app).get(path);
      expect(res.status).toBe(200);
      const rows = (res.body.points ?? res.body.cells ?? res.body.users ?? res.body.byAgent) as unknown[];
      expect(rows).toEqual([]);
    }
  });

  it('says WHICH of the two empties it is — degraded on failure, silent on quiet', async () => {
    // All four reads answer the same empty collection whether the fleet was
    // idle or the table is gone. The marker is the only thing that separates
    // them, so it is asserted on every one of the four rather than a sample.
    const app = buildApp();

    execMock.mockResolvedValue([]);
    for (const path of READS) {
      const quiet = await request(app).get(path);
      expect({ path, degraded: quiet.body.degraded, error: quiet.body.error })
        .toEqual({ path, degraded: undefined, error: undefined });
    }

    execMock.mockRejectedValue(new Error('relation "observability.invocation_traces" does not exist'));
    for (const path of READS) {
      const res = await request(app).get(path);
      expect({ path, ...res.body as Record<string, unknown> }).toMatchObject({
        path,
        degraded: true,
        error: 'relation "observability.invocation_traces" does not exist',
      });
    }
  });
});

describe('GET /rps', () => {
  it('maps the bucketed counts, including the two distinct-cardinality columns', async () => {
    execMock.mockResolvedValue([{
      bucket_start: '2026-08-20 09:00:00+00', agent_id: 'orgiq-supervisor',
      invocations: '30', unique_users: '4', unique_sessions: '9',
    }]);
    const res = await request(buildApp())
      .get('/api/observability/traffic/rps?windowHours=6&bucketMin=15');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['bucketMin', 'points', 'windowHours']);
    expect(res.body.points[0]).toEqual({
      bucketStart: '2026-08-20 09:00:00+00', agentId: 'orgiq-supervisor',
      invocations: 30, uniqueUsers: 4, uniqueSessions: 9,
    });
    // Distinct users can never exceed the invocations they are drawn from.
    expect(res.body.points[0].uniqueUsers).toBeLessThanOrEqual(res.body.points[0].invocations);
  });

  it('defaults to 24h / 5min, caps at 30 days / 6h, floors the bucket at 1min', async () => {
    execMock.mockResolvedValue([]);
    const app = buildApp();
    await request(app).get('/api/observability/traffic/rps');
    await request(app).get('/api/observability/traffic/rps?windowHours=99999&bucketMin=99999');
    await request(app).get('/api/observability/traffic/rps?windowHours=abc&bucketMin=0');
    expect([0, 1, 2].map((i) => longOf(i, 'hours'))).toEqual([24, 24 * 30, 24]);
    expect([0, 1, 2].map((i) => longOf(i, 'bucket'))).toEqual([5, 360, 5]);
  });
});

describe('GET /heatmap', () => {
  it('returns sparse (dow, hour) cells beside the day count', async () => {
    execMock.mockResolvedValue([
      { dow: '1', hod: '9', cnt: '40' },
      { dow: '1', hod: '10', cnt: '12' },
    ]);
    const res = await request(buildApp()).get('/api/observability/traffic/heatmap?days=14');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['cells', 'days']);
    expect(res.body.days).toBe(14);
    expect(res.body.cells[0]).toEqual({ dayOfWeek: 1, hourOfDay: 9, count: 40 });
    // Zero cells are deliberately NOT emitted; the client fills the 7x24 grid.
    expect(res.body.cells).toHaveLength(2);
  });

  it('defaults to 7 days and caps at 30', async () => {
    execMock.mockResolvedValue([]);
    const app = buildApp();
    await request(app).get('/api/observability/traffic/heatmap');
    await request(app).get('/api/observability/traffic/heatmap?days=9999');
    await request(app).get('/api/observability/traffic/heatmap?days=abc');
    expect([0, 1, 2].map((i) => longOf(i, 'days'))).toEqual([7, 30, 7]);
  });
});

describe('GET /top-users', () => {
  it('maps the per-user rollup with cost and breadth on the same row', async () => {
    execMock.mockResolvedValue([{
      user_id: 'u-1', invocations: '80', unique_agents: '3',
      total_cost_usd: '1.25', last_seen_at: '2026-08-20T09:00:00Z',
    }]);
    const res = await request(buildApp()).get('/api/observability/traffic/top-users');
    expect(Object.keys(res.body).sort()).toEqual(['users', 'windowHours']);
    expect(res.body.users[0]).toEqual({
      userId: 'u-1', invocations: 80, uniqueAgents: 3,
      totalCostUsd: 1.25, lastSeenAt: '2026-08-20T09:00:00Z',
    });
  });

  it('skips unattributed rows — an empty user_id is not a top user', async () => {
    execMock.mockResolvedValue([]);
    await request(buildApp()).get('/api/observability/traffic/top-users');
    expect(sqlOf(0)).toMatch(/user_id IS NOT NULL/);
    expect(sqlOf(0)).toMatch(/length\(trim\(user_id\)\) > 0/);
  });

  it('clamps the limit into 1..200 with a default of 10', async () => {
    execMock.mockResolvedValue([]);
    const app = buildApp();
    await request(app).get('/api/observability/traffic/top-users');
    await request(app).get('/api/observability/traffic/top-users?limit=9999');
    await request(app).get('/api/observability/traffic/top-users?limit=abc');
    expect([0, 1, 2].map((i) => longOf(i, 'lim'))).toEqual([10, 200, 10]);
  });
});

describe('GET /per-agent-summary', () => {
  it('counts ONLY guardrail interventions and schema failures as errors', async () => {
    execMock.mockResolvedValue([]);
    await request(buildApp()).get('/api/observability/traffic/per-agent-summary');
    const sql = sqlOf(0);
    expect(sql).toMatch(/guardrail_action IS NOT NULL AND guardrail_action <> 'NONE'/);
    expect(sql).toMatch(/schema_valid = false/);
    // The error filter must not mention the judge at all — that is the whole
    // point of splitting lowQualityRate out.
    const errorFilter = sql.slice(sql.indexOf('AS error_count') - 400, sql.indexOf('AS error_count'));
    expect(errorFilter).not.toMatch(/judge_score/);
    expect(sql).toMatch(/judge_score IS NOT NULL AND judge_score < 0\.3/);
  });

  it('reports a weak-but-successful agent as 0% errors and non-zero low quality', async () => {
    execMock.mockResolvedValue([{
      agent_id: 'orgiq-advisor', invocations: '100', p50: '900', p99: '4000',
      error_count: '0', low_quality_count: '25', total_cost_usd: '2',
    }]);
    const res = await request(buildApp())
      .get('/api/observability/traffic/per-agent-summary?windowHours=1');
    expect(res.body.byAgent[0].errorRate).toBe(0);
    expect(res.body.byAgent[0].lowQualityRate).toBe(0.25);
    // rps is derived from the window the caller asked for: 100 / 3600s.
    expect(res.body.byAgent[0].rps).toBeCloseTo(100 / 3600, 10);
    expect(res.body.byAgent[0].p50DurationMs).toBe(900);
    expect(res.body.byAgent[0].p99DurationMs).toBe(4000);
  });

  it('rescales rps when the window changes', async () => {
    execMock.mockResolvedValue([{
      agent_id: 'a', invocations: '100', p50: null, p99: null,
      error_count: '0', low_quality_count: '0', total_cost_usd: '0',
    }]);
    const app = buildApp();
    const oneHour = await request(app).get('/api/observability/traffic/per-agent-summary?windowHours=1');
    const tenHours = await request(app).get('/api/observability/traffic/per-agent-summary?windowHours=10');
    expect(oneHour.body.byAgent[0].rps).toBeCloseTo(tenHours.body.byAgent[0].rps * 10, 10);
  });

  it('answers 0 — not NaN — for both rates when an agent has no invocations', async () => {
    execMock.mockResolvedValue([{
      agent_id: 'orgiq-idle', invocations: '0', p50: null, p99: null,
      error_count: '0', low_quality_count: '0', total_cost_usd: null,
    }]);
    const res = await request(buildApp()).get('/api/observability/traffic/per-agent-summary');
    const row = res.body.byAgent[0];
    expect(row.errorRate).toBe(0);
    expect(row.lowQualityRate).toBe(0);
    expect(row.rps).toBe(0);
    expect(row.totalCostUsd).toBe(0);
    expect(row.p50DurationMs).toBeNull();
  });

  it('labels an unattributed group "unknown" rather than dropping the spend', async () => {
    execMock.mockResolvedValue([{
      agent_id: null, invocations: '2', p50: null, p99: null,
      error_count: '1', low_quality_count: '0', total_cost_usd: '0.1',
    }]);
    const res = await request(buildApp()).get('/api/observability/traffic/per-agent-summary');
    expect(res.body.byAgent[0].agentId).toBe('unknown');
    expect(res.body.byAgent[0].errorRate).toBe(0.5);
  });
});

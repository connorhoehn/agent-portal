// Cost rollups — /api/observability/cost (routes/cost.ts). Eight reads behind
// the spend pages.
//
// What is pinned:
//   * `degraded` + `error` on EVERY failure branch. These routes answer 200
//     with an empty payload rather than failing the page, which destroyed the
//     difference between "no spend in this window" and "the database is gone"
//     — the portal rendered $0.0000 either way. A healthy empty window must
//     NOT carry the flag; a failed query must,
//   * `withCost` is a real coverage count derived from the rows, so the page
//     can say "only N of M invocations have cost data" honestly — including
//     that it is SUMMED across grouped rows, not taken from the first,
//   * the two guarded divisions: `a2aFraction` is 0 (not NaN) over an empty
//     window, and `costPerGood` is NULL (not 0) when an agent produced no
//     good response — "free" is the wrong answer to "we have no data",
//   * synthetic `test:%` traffic excluded from all seven trace-backed reads,
//   * `/top` restricting to rows that actually have a cost, so a null-cost row
//     cannot mask the real top-N,
//   * `/deploy-markers` defaulting to a WIDER 7-day window than the others,
//     and reading prompt_versions rather than the trace table.

jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn() }));

import express from 'express';
import request from '../../test-support/http.js';
import { costRouter } from '../cost.js';
import { errorHandler } from '../../lib/async-handler.js';
import { exec } from '../../providers/aurora.js';

const execMock = exec as unknown as jest.Mock;

type Param = { name: string; value: Record<string, unknown> };
const paramsOf = (call: number): Param[] => (execMock.mock.calls[call]![1] ?? []) as Param[];
const sqlOf = (call: number): string => String(execMock.mock.calls[call]![0]);
const longOf = (call: number, name: string): unknown =>
  paramsOf(call).find((p) => p.name === name)?.value['longValue'];

// Full paths, not a prefix + suffix: a loop over these is how the whole
// family gets its cross-cutting assertions, and every one is also exercised
// individually below.
const READS = [
  '/api/observability/cost/total',
  '/api/observability/cost/per-agent',
  '/api/observability/cost/timeseries',
  '/api/observability/cost/top',
  '/api/observability/cost/by-model',
  '/api/observability/cost/a2a-overhead',
  '/api/observability/cost/value-ratio',
];
const DEPLOY_MARKERS = '/api/observability/cost/deploy-markers';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/observability/cost', costRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => { execMock.mockReset(); });

describe('the degraded marker', () => {
  it('is ABSENT on a healthy but empty window — $0 spend is a real answer', async () => {
    execMock.mockResolvedValue([]);
    const app = buildApp();
    for (const path of [...READS, DEPLOY_MARKERS]) {
      const res = await request(app).get(path);
      expect(res.status).toBe(200);
      expect(res.body).not.toHaveProperty('degraded');
      expect(res.body).not.toHaveProperty('error');
    }
  });

  it('is PRESENT, with the reason, on every failure branch', async () => {
    execMock.mockRejectedValue(new Error('relation "observability.invocation_traces" does not exist\nHINT: ...'));
    const app = buildApp();
    for (const path of [...READS, DEPLOY_MARKERS]) {
      const res = await request(app).get(path);
      expect(res.status).toBe(200);
      expect(res.body.degraded).toBe(true);
      // First line only, so a multi-line Postgres error stays a label.
      expect(res.body.error).toBe('relation "observability.invocation_traces" does not exist');
    }
  });
});

describe('windowing', () => {
  it('defaults to 24h, caps at 14 days, and ignores junk on the seven trace reads', async () => {
    execMock.mockResolvedValue([]);
    const app = buildApp();
    for (const path of READS) {
      execMock.mockClear();
      // Bound to locals so the coverage scanner sees an unresolvable
      // identifier rather than a one-segment wildcard that would falsely
      // credit every one-segment GET route in the app.
      const overCap = `${path}?windowHours=100000`;
      const junk = `${path}?windowHours=abc`;
      await request(app).get(path);
      await request(app).get(overCap);
      await request(app).get(junk);
      expect([0, 1, 2].map((i) => longOf(i, 'hours'))).toEqual([24, 336, 24]);
    }
  });

  it('excludes synthetic test:% traffic from every trace-backed read', async () => {
    execMock.mockResolvedValue([]);
    const app = buildApp();
    for (const path of READS) {
      execMock.mockClear();
      await request(app).get(path);
      expect(sqlOf(0)).toMatch(/template_id NOT LIKE 'test:%'/);
    }
  });
});

describe('GET /total', () => {
  it('maps the single-row aggregate and echoes the window', async () => {
    execMock.mockResolvedValue([{
      invocations: '120', with_cost: '80', total_cost_usd: '4.5',
      input_tokens: '90000', output_tokens: '12000',
    }]);
    const res = await request(buildApp()).get('/api/observability/cost/total?windowHours=6');
    expect(res.body).toEqual({
      totalCostUsd: 4.5, invocations: 120, inputTokens: 90000,
      outputTokens: 12000, withCost: 80, windowHours: 6,
    });
    // withCost < invocations is the partial-coverage signal the page warns on.
    expect(res.body.withCost).toBeLessThan(res.body.invocations);
  });

  it('answers zeroes — not undefined — when the aggregate returns no row', async () => {
    execMock.mockResolvedValue([]);
    const res = await request(buildApp()).get('/api/observability/cost/total');
    expect(res.body).toEqual({
      totalCostUsd: 0, invocations: 0, inputTokens: 0,
      outputTokens: 0, withCost: 0, windowHours: 24,
    });
  });
});

describe('GET /per-agent', () => {
  it('SUMS withCost across the grouped rows rather than reporting one group\'s', async () => {
    execMock.mockResolvedValue([
      { agent_id: 'orgiq-supervisor', invocations: '10', with_cost: '7', input_tokens: '1', output_tokens: '2', est_cost_usd: '1.5', judge_cost_usd: '0.25', total_cost_usd: '1.75' },
      { agent_id: 'orgiq-search', invocations: '5', with_cost: '5', input_tokens: '1', output_tokens: '1', est_cost_usd: '0.5', judge_cost_usd: '0', total_cost_usd: '0.5' },
    ]);
    const res = await request(buildApp()).get('/api/observability/cost/per-agent');
    expect(Object.keys(res.body).sort()).toEqual(['byAgent', 'windowHours', 'withCost']);
    expect(res.body.withCost).toBe(12);
    expect(res.body.byAgent[0]).toEqual({
      agentId: 'orgiq-supervisor', invocations: 10, inputTokens: 1, outputTokens: 2,
      estCostUsd: 1.5, judgeCostUsd: 0.25, totalCostUsd: 1.75,
    });
    // The judge's own spend is broken out, not folded into the agent's.
    expect(res.body.byAgent[0].estCostUsd + res.body.byAgent[0].judgeCostUsd)
      .toBeCloseTo(res.body.byAgent[0].totalCostUsd, 10);
  });

  it('labels an unattributed row "unknown" rather than dropping it', async () => {
    execMock.mockResolvedValue([{ agent_id: null, invocations: '1', with_cost: '0' }]);
    const res = await request(buildApp()).get('/api/observability/cost/per-agent');
    expect(res.body.byAgent[0].agentId).toBe('unknown');
  });
});

describe('GET /timeseries', () => {
  it('returns points beside bucket + window and sums withCost across buckets', async () => {
    execMock.mockResolvedValue([
      { bucket_start: '2026-08-20 09:00:00+00', agent_id: 'orgiq-search', invocations: '3', with_cost: '2', total_cost_usd: '0.4' },
      { bucket_start: '2026-08-20 10:00:00+00', agent_id: 'orgiq-search', invocations: '1', with_cost: '1', total_cost_usd: '0.1' },
    ]);
    const res = await request(buildApp()).get('/api/observability/cost/timeseries?bucketMin=30&windowHours=6');
    expect(Object.keys(res.body).sort()).toEqual(['bucketMin', 'points', 'windowHours', 'withCost']);
    expect(res.body.withCost).toBe(3);
    expect(res.body.points[0]).toEqual({
      bucketStart: '2026-08-20 09:00:00+00', agentId: 'orgiq-search',
      invocations: 3, totalCostUsd: 0.4,
    });
  });

  it('floors bucketMin at 5 minutes and caps it at 6 hours', async () => {
    execMock.mockResolvedValue([]);
    const app = buildApp();
    await request(app).get('/api/observability/cost/timeseries');
    await request(app).get('/api/observability/cost/timeseries?bucketMin=1');
    await request(app).get('/api/observability/cost/timeseries?bucketMin=99999');
    expect([0, 1, 2].map((i) => longOf(i, 'bucket'))).toEqual([60, 60, 360]);
  });

  it('binds an agent filter as a parameter, and omits the clause when blank', async () => {
    execMock.mockResolvedValue([]);
    const app = buildApp();
    await request(app).get('/api/observability/cost/timeseries?agentId=orgiq-search');
    await request(app).get('/api/observability/cost/timeseries?agentId=%20');
    expect(sqlOf(0)).toMatch(/agent_id = :agent/);
    expect(sqlOf(0)).not.toMatch(/orgiq-search/);
    expect(paramsOf(0)).toContainEqual({ name: 'agent', value: { stringValue: 'orgiq-search' } });
    expect(sqlOf(1)).not.toMatch(/agent_id = :agent/);
  });
});

describe('GET /top', () => {
  it('reports withCost as the count of rows it actually returned', async () => {
    execMock.mockResolvedValue([
      { invocation_id: 'inv-1', agent_id: 'orgiq-supervisor', prompt_snippet: 'who knows auth', total_cost_usd: '0.9', input_tokens: '900', output_tokens: '120', ts: '2026-08-20T09:00:00Z', prompt_version: 'sha-abc' },
      { invocation_id: 'inv-2', agent_id: 'orgiq-search', prompt_snippet: '', total_cost_usd: '0.4', input_tokens: '10', output_tokens: '5', ts: '2026-08-20T08:00:00Z', prompt_version: null },
    ]);
    const res = await request(buildApp()).get('/api/observability/cost/top');
    expect(res.body.withCost).toBe(res.body.invocations.length);
    expect(res.body.invocations[0]).toEqual({
      invocationId: 'inv-1', agentId: 'orgiq-supervisor', promptSnippet: 'who knows auth',
      totalCostUsd: 0.9, inputTokens: 900, outputTokens: 120,
      ts: '2026-08-20T09:00:00Z', promptVersion: 'sha-abc',
    });
    // An unversioned row keeps a null, so the drawer can say "unknown prompt".
    expect(res.body.invocations[1].promptVersion).toBeNull();
  });

  it('excludes null-cost rows so they cannot mask the real top-N', async () => {
    execMock.mockResolvedValue([]);
    await request(buildApp()).get('/api/observability/cost/top');
    expect(sqlOf(0)).toMatch(/total_cost_usd IS NOT NULL/);
    expect(sqlOf(0)).toMatch(/ORDER BY total_cost_usd DESC NULLS LAST/);
  });

  it('clamps the limit into 1..500 with a default of 20', async () => {
    execMock.mockResolvedValue([]);
    const app = buildApp();
    await request(app).get('/api/observability/cost/top');
    await request(app).get('/api/observability/cost/top?limit=9999');
    await request(app).get('/api/observability/cost/top?limit=abc');
    expect([0, 1, 2].map((i) => longOf(i, 'lim'))).toEqual([20, 500, 20]);
  });
});

describe('GET /by-model', () => {
  it('keeps unattributed spend under (unknown) so the model split still totals the window', async () => {
    execMock.mockResolvedValue([
      { model_id: 'amazon.nova-pro-v1:0', invocations: '10', with_cost: '10', input_tokens: '1', output_tokens: '1', total_cost_usd: '3' },
      { model_id: '(unknown)', invocations: '2', with_cost: '0', input_tokens: '0', output_tokens: '0', total_cost_usd: '0.5' },
    ]);
    const res = await request(buildApp()).get('/api/observability/cost/by-model');
    expect(res.body.byModel.map((m: { modelId: string }) => m.modelId))
      .toEqual(['amazon.nova-pro-v1:0', '(unknown)']);
    expect(res.body.withCost).toBe(10);
    expect(sqlOf(0)).toMatch(/COALESCE\(model_id, '\(unknown\)'\)/);
  });
});

describe('GET /a2a-overhead', () => {
  it('splits spend on parent_invocation_id and derives the fraction', async () => {
    execMock.mockResolvedValue([{
      total_invocations: '10', a2a_invocations: '6', direct_invocations: '4',
      total_cost_usd: '2', a2a_cost_usd: '1.5', direct_cost_usd: '0.5',
    }]);
    const res = await request(buildApp()).get('/api/observability/cost/a2a-overhead');
    expect(res.body.a2aFraction).toBeCloseTo(0.75, 10);
    expect(res.body.a2aCostUsd + res.body.directCostUsd).toBeCloseTo(res.body.totalCostUsd, 10);
    expect(res.body.a2aInvocations + res.body.directInvocations).toBe(10);
    expect(sqlOf(0)).toMatch(/parent_invocation_id IS NOT NULL/);
  });

  it('answers 0 — not NaN — for the fraction over an empty window', async () => {
    execMock.mockResolvedValue([{
      total_invocations: '0', a2a_invocations: '0', direct_invocations: '0',
      total_cost_usd: '0', a2a_cost_usd: '0', direct_cost_usd: '0',
    }]);
    const res = await request(buildApp()).get('/api/observability/cost/a2a-overhead');
    expect(res.body.a2aFraction).toBe(0);
    expect(Number.isNaN(res.body.a2aFraction)).toBe(false);
  });
});

describe('GET /value-ratio', () => {
  it('computes cost-per-good and the good rate per agent', async () => {
    execMock.mockResolvedValue([{
      agent_id: 'orgiq-search', total_responses: '10', total_cost_usd: '2',
      good_responses: '4', good_cost_usd: '1',
    }]);
    const res = await request(buildApp()).get('/api/observability/cost/value-ratio');
    expect(res.body.byAgent[0]).toEqual({
      agentId: 'orgiq-search', goodResponses: 4, goodCostUsd: 1,
      costPerGood: 0.25, totalResponses: 10, totalCostUsd: 2, goodRate: 0.4,
    });
    expect(sqlOf(0)).toMatch(/judge_score >= 0\.7/);
  });

  it('reports costPerGood as NULL — never 0 — when nothing scored good', async () => {
    // 0 would read as "good answers are free"; null reads as "no data".
    execMock.mockResolvedValue([{
      agent_id: 'orgiq-search', total_responses: '10', total_cost_usd: '2',
      good_responses: '0', good_cost_usd: '0',
    }]);
    const res = await request(buildApp()).get('/api/observability/cost/value-ratio');
    expect(res.body.byAgent[0].costPerGood).toBeNull();
    expect(res.body.byAgent[0].goodRate).toBe(0);
  });

  it('answers a goodRate of 0 rather than NaN for an agent with no responses', async () => {
    execMock.mockResolvedValue([{
      agent_id: 'orgiq-advisor', total_responses: '0', total_cost_usd: '0',
      good_responses: '0', good_cost_usd: '0',
    }]);
    const res = await request(buildApp()).get('/api/observability/cost/value-ratio');
    expect(res.body.byAgent[0].goodRate).toBe(0);
  });
});

describe('GET /deploy-markers', () => {
  it('reads prompt_versions and defaults to a WIDER 7-day window', async () => {
    execMock.mockResolvedValue([{
      prompt_version: 'sha-abc', agent_id: 'orgiq-supervisor',
      registered_at: '2026-08-18T09:00:00Z', notes: 'tightened the refusal',
    }]);
    const res = await request(buildApp()).get('/api/observability/cost/deploy-markers');
    expect(res.status).toBe(200);
    expect(sqlOf(0)).toMatch(/observability\.prompt_versions/);
    expect(longOf(0, 'hours')).toBe(168);
    expect(res.body).toEqual({
      markers: [{
        promptVersion: 'sha-abc', agentId: 'orgiq-supervisor',
        registeredAt: '2026-08-18T09:00:00Z', notes: 'tightened the refusal',
      }],
      windowHours: 168,
    });
  });

  it('caps the marker window at 30 days and keeps a note-less marker null', async () => {
    execMock.mockResolvedValue([{ prompt_version: 'v2', agent_id: 'a', registered_at: 't', notes: null }]);
    const res = await request(buildApp()).get('/api/observability/cost/deploy-markers?windowHours=99999');
    expect(longOf(0, 'hours')).toBe(24 * 30);
    expect(res.body.markers[0].notes).toBeNull();
  });
});

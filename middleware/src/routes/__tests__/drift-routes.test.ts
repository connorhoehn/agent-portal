// Drift — /api/observability/drift (routes/drift.ts). The semantic-drift
// data plane: per-agent rollup, outlier tail, time series, per-template
// breakdown, and the nearest known-good neighbours of one outlier.
//
// What is pinned:
//   * the five wire shapes — note /summary answers a BARE ARRAY while the
//     other four answer wrapped objects. That asymmetry is real and the
//     portal codes to it; wrapping /summary "for consistency" would blank the
//     rollup table,
//   * the two defaults that make an EMPTY signal safe to render: absent
//     conformance reads 1 (no schema-checked rows is not 0% conformance) and
//     absent drift reads 0 — while an absent judge percentile stays NULL,
//     because "nobody judged this" is not "scored zero",
//   * every window/limit clamp, including /summary's 1-hour default (tighter
//     than /timeseries' 24h) and the 7-day vs 14-day ceilings,
//   * the centroid definition the whole feature rests on: it is built from
//     KNOWN-GOOD rows only (`judge_score IS NULL OR >= 0.6`). A centroid that
//     included the drifted rows would drift with them and report nothing,
//   * `test:%` exclusion on the four aggregate reads,
//   * every read degrading to an empty payload rather than 500ing the page.

jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn() }));
// drift.ts pulls EMBEDDING_DIMENSIONS from lib/embedding.js, which reaches
// config.ts and its `import.meta` — unloadable under the CJS test build.
jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', mock: { aurora: false } },
}));

import express from 'express';
import request from '../../test-support/http.js';
import { driftRouter } from '../drift.js';
import { errorHandler } from '../../lib/async-handler.js';
import { exec } from '../../providers/aurora.js';

const execMock = exec as unknown as jest.Mock;

type Param = { name: string; value: Record<string, unknown> };
const paramsOf = (call: number): Param[] => (execMock.mock.calls[call]![1] ?? []) as Param[];
const sqlOf = (call: number): string => String(execMock.mock.calls[call]![0]);
const longOf = (call: number, name: string): unknown =>
  paramsOf(call).find((p) => p.name === name)?.value['longValue'];

const AGGREGATES = [
  '/api/observability/drift/summary',
  '/api/observability/drift/outliers',
  '/api/observability/drift/timeseries',
  '/api/observability/drift/templates',
];

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/observability/drift', driftRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => { execMock.mockReset(); });

describe('the centroid is anchored on known-good rows', () => {
  it('excludes low-judged rows from every centroid, and test:% from the window', async () => {
    execMock.mockResolvedValue([]);
    const app = buildApp();
    for (const path of AGGREGATES) {
      execMock.mockClear();
      await request(app).get(path);
      // A centroid that absorbed the drifted rows would move with them and
      // report no drift at all — this is the feature's load-bearing clause.
      expect(sqlOf(0)).toMatch(/judge_score IS NULL OR judge_score >= 0\.6/);
      expect(sqlOf(0)).toMatch(/template_id NOT LIKE 'test:%'/);
    }
  });
});

describe('GET /summary', () => {
  it('answers a BARE ARRAY of per-agent rollups', async () => {
    execMock.mockResolvedValue([{
      agent_id: 'orgiq-supervisor', cnt: '42', conformance: '0.95',
      p50: '0.81', p05: '0.34', drift_p95: '0.22',
    }]);
    const res = await request(buildApp()).get('/api/observability/drift/summary');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0]).toEqual({
      agentId: 'orgiq-supervisor', count: 42, schemaConformance: 0.95,
      judgeP50: 0.81, judgeP05: 0.34, embeddingDriftP95: 0.22,
    });
  });

  it('defaults absent conformance to 1 and absent drift to 0, but keeps judge NULL', async () => {
    // No schema-checked rows is not "0% conformant", and no embeddings is not
    // "maximally drifted" — but no judged rows really is "unknown".
    execMock.mockResolvedValue([{
      agent_id: 'orgiq-advisor', cnt: '3', conformance: null,
      p50: null, p05: null, drift_p95: null,
    }]);
    const res = await request(buildApp()).get('/api/observability/drift/summary');
    expect(res.body[0].schemaConformance).toBe(1);
    expect(res.body[0].embeddingDriftP95).toBe(0);
    expect(res.body[0].judgeP50).toBeNull();
    expect(res.body[0].judgeP05).toBeNull();
  });

  it('defaults the window to 1 hour and caps it at 7 days', async () => {
    execMock.mockResolvedValue([]);
    const app = buildApp();
    await request(app).get('/api/observability/drift/summary');
    await request(app).get('/api/observability/drift/summary?windowHours=99999');
    await request(app).get('/api/observability/drift/summary?windowHours=abc');
    expect([0, 1, 2].map((i) => longOf(i, 'hours'))).toEqual([1, 24 * 7, 1]);
  });

  it('answers a bare EMPTY ARRAY for a quiet window and an OBJECT for a failure', async () => {
    // The asymmetry is deliberate and it is the whole fix. A quiet window is
    // still the bare array the portal maps over, byte for byte. A failure
    // cannot be marked inside an array, so it answers the object form — which
    // every consumer already tolerates, because all three guard with
    // `Array.isArray(x) ? x : []` and render the same empty rollup.
    execMock.mockResolvedValue([]);
    const quiet = await request(buildApp()).get('/api/observability/drift/summary');
    expect(quiet.status).toBe(200);
    expect(quiet.body).toEqual([]);

    execMock.mockRejectedValue(new Error('type "vector" does not exist'));
    const res = await request(buildApp()).get('/api/observability/drift/summary');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(false);
    expect(res.body).toEqual({
      agents: [], degraded: true, error: 'type "vector" does not exist',
    });
  });
});

describe('GET /outliers', () => {
  it('maps the outlier row, keeping unjudged fields null', async () => {
    execMock.mockResolvedValue([{
      invocation_id: 'inv-1', agent_id: 'orgiq-search', agent_name: 'Search',
      template_id: 'kb-lookup', prompt_snippet: 'who owns auth',
      response_snippet: 'nobody', judge_score: '0.2',
      judge_rationale: 'ungrounded', schema_valid: false,
      dist: '0.61', ts: '2026-08-20T09:00:00Z',
    }, {
      invocation_id: 'inv-2', agent_id: 'orgiq-search', agent_name: 'Search',
      template_id: null, prompt_snippet: '', response_snippet: '',
      judge_score: null, judge_rationale: null, schema_valid: null,
      dist: null, ts: 't',
    }]);
    const res = await request(buildApp()).get('/api/observability/drift/outliers');
    expect(Object.keys(res.body)).toEqual(['outliers']);
    expect(res.body.outliers[0]).toEqual({
      invocationId: 'inv-1', agentId: 'orgiq-search', agentName: 'Search',
      templateId: 'kb-lookup', promptSnippet: 'who owns auth',
      responseSnippet: 'nobody', judgeScore: 0.2, judgeRationale: 'ungrounded',
      schemaValid: false, distance: 0.61, ts: '2026-08-20T09:00:00Z',
    });
    expect(res.body.outliers[1].templateId).toBeNull();
    expect(res.body.outliers[1].judgeScore).toBeNull();
    expect(res.body.outliers[1].distance).toBe(0);
  });

  it('ranks by distance descending — the point of an outlier list', async () => {
    execMock.mockResolvedValue([]);
    await request(buildApp()).get('/api/observability/drift/outliers');
    expect(sqlOf(0)).toMatch(/ORDER BY dist DESC/);
  });

  it('binds an agent filter and drops the clause when blank', async () => {
    execMock.mockResolvedValue([]);
    const app = buildApp();
    await request(app).get('/api/observability/drift/outliers?agentId=orgiq-search');
    await request(app).get('/api/observability/drift/outliers?agentId=%20');
    expect(sqlOf(0)).toMatch(/AND w\.agent_id = :agent/);
    expect(sqlOf(0)).not.toMatch(/orgiq-search/);
    expect(sqlOf(1)).not.toMatch(/w\.agent_id = :agent/);
  });

  it('clamps the limit into 1..500 with a default of 50', async () => {
    execMock.mockResolvedValue([]);
    const app = buildApp();
    await request(app).get('/api/observability/drift/outliers');
    await request(app).get('/api/observability/drift/outliers?limit=9999');
    await request(app).get('/api/observability/drift/outliers?limit=abc');
    expect([0, 1, 2].map((i) => longOf(i, 'lim'))).toEqual([50, 500, 50]);
  });

  it('marks a failed outlier read, and leaves a genuinely quiet tail unmarked', async () => {
    execMock.mockResolvedValue([]);
    const quiet = await request(buildApp()).get('/api/observability/drift/outliers');
    expect(quiet.body).toEqual({ outliers: [] });

    execMock.mockRejectedValue(new Error('boom'));
    const res = await request(buildApp()).get('/api/observability/drift/outliers');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ outliers: [], degraded: true, error: 'boom' });
  });
});

describe('GET /timeseries', () => {
  it('returns points beside the bucket + window the axis labels itself with', async () => {
    execMock.mockResolvedValue([{
      bucket_start: '2026-08-20 09:00:00+00', agent_id: 'orgiq-search',
      cnt: '9', drift_p95: '0.31', p50: '0.7',
    }]);
    const res = await request(buildApp())
      .get('/api/observability/drift/timeseries?windowHours=6&bucketMin=30');
    expect(Object.keys(res.body).sort()).toEqual(['bucketMin', 'points', 'windowHours']);
    expect(res.body.points[0]).toEqual({
      bucketStart: '2026-08-20 09:00:00+00', agentId: 'orgiq-search',
      count: 9, driftP95: 0.31, judgeP50: 0.7,
    });
  });

  it('defaults to 24h / 60min, caps at 14 days / 6h, floors the bucket at 5min', async () => {
    execMock.mockResolvedValue([]);
    const app = buildApp();
    await request(app).get('/api/observability/drift/timeseries');
    await request(app).get('/api/observability/drift/timeseries?windowHours=99999&bucketMin=99999');
    await request(app).get('/api/observability/drift/timeseries?windowHours=abc&bucketMin=1');
    expect([0, 1, 2].map((i) => longOf(i, 'hours'))).toEqual([24, 24 * 14, 24]);
    expect([0, 1, 2].map((i) => longOf(i, 'bucket'))).toEqual([60, 360, 60]);
  });

  it('marks a failed series while still echoing bucket + window', async () => {
    execMock.mockResolvedValue([]);
    const quiet = await request(buildApp())
      .get('/api/observability/drift/timeseries?windowHours=6&bucketMin=30');
    expect(quiet.body).toEqual({ points: [], bucketMin: 30, windowHours: 6 });

    execMock.mockRejectedValue(new Error('boom'));
    const res = await request(buildApp())
      .get('/api/observability/drift/timeseries?windowHours=6&bucketMin=30');
    expect(res.body).toEqual({
      points: [], bucketMin: 30, windowHours: 6, degraded: true, error: 'boom',
    });
  });
});

describe('GET /templates', () => {
  it('labels an untemplated group "(none)" instead of dropping it', async () => {
    execMock.mockResolvedValue([{
      agent_id: 'orgiq-search', template_id: '(none)', cnt: '5',
      p50: null, p05: null, conformance: null, drift_p95: '0.4',
    }]);
    const res = await request(buildApp()).get('/api/observability/drift/templates');
    expect(Object.keys(res.body)).toEqual(['templates']);
    expect(res.body.templates[0]).toEqual({
      agentId: 'orgiq-search', templateId: '(none)', count: 5,
      judgeP50: null, judgeP05: null, schemaConformance: 1, driftP95: 0.4,
    });
  });

  it('applies a minimum sample count of 3, floored at 1', async () => {
    // A p95 over one row is noise, not drift.
    execMock.mockResolvedValue([]);
    const app = buildApp();
    await request(app).get('/api/observability/drift/templates');
    await request(app).get('/api/observability/drift/templates?minCount=0');
    await request(app).get('/api/observability/drift/templates?minCount=10');
    expect([0, 1, 2].map((i) => longOf(i, 'mincnt'))).toEqual([3, 3, 10]);
    expect(sqlOf(0)).toMatch(/HAVING COUNT\(\*\) >= :mincnt/);
  });

  it('marks a failed breakdown; an unbusy window stays a plain empty one', async () => {
    execMock.mockResolvedValue([]);
    const quiet = await request(buildApp()).get('/api/observability/drift/templates');
    expect(quiet.body).toEqual({ templates: [] });

    execMock.mockRejectedValue(new Error('boom'));
    const res = await request(buildApp()).get('/api/observability/drift/templates');
    expect(res.body).toEqual({ templates: [], degraded: true, error: 'boom' });
  });
});

describe('GET /neighbors/:invocationId', () => {
  it('returns the nearest KNOWN-GOOD neighbours, excluding the probe itself', async () => {
    execMock.mockResolvedValue([{
      invocation_id: 'inv-9', ts: '2026-08-19T09:00:00Z',
      response_snippet: 'the grounded answer', judge_score: '0.91', dist: '0.08',
    }]);
    const res = await request(buildApp())
      .get('/api/observability/drift/neighbors/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(Object.keys(res.body)).toEqual(['neighbors']);
    expect(res.body.neighbors[0]).toEqual({
      invocationId: 'inv-9', ts: '2026-08-19T09:00:00Z',
      responseSnippet: 'the grounded answer', judgeScore: 0.91, distance: 0.08,
    });
    // "Known-good" is a higher bar here (0.7) than the centroid's 0.6, and the
    // probe row must not be its own nearest neighbour.
    expect(sqlOf(0)).toMatch(/t\.judge_score IS NULL OR t\.judge_score >= 0\.7/);
    expect(sqlOf(0)).toMatch(/t\.invocation_id::text <> :id/);
    expect(sqlOf(0)).toMatch(/ORDER BY t\.output_embedding <=> p\.output_embedding ASC/);
  });

  it('clamps the neighbour count into 1..20 with a default of 3', async () => {
    execMock.mockResolvedValue([]);
    const app = buildApp();
    const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    await request(app).get(`/api/observability/drift/neighbors/${id}`);
    await request(app).get(`/api/observability/drift/neighbors/${id}?limit=999`);
    await request(app).get(`/api/observability/drift/neighbors/${id}?limit=abc`);
    await request(app).get(`/api/observability/drift/neighbors/${id}?limit=0`);
    expect([0, 1, 2, 3].map((i) => longOf(i, 'lim'))).toEqual([3, 20, 3, 3]);
  });

  it('marks a failed neighbour lookup — "no neighbours" is a real answer too', async () => {
    // An outlier with no near neighbours is genuinely interesting; a malformed
    // id that never reached the index is not the same finding.
    execMock.mockResolvedValue([]);
    const quiet = await request(buildApp())
      .get('/api/observability/drift/neighbors/11111111-2222-3333-4444-555555555555');
    expect(quiet.body).toEqual({ neighbors: [] });

    execMock.mockRejectedValue(new Error('invalid input syntax for type uuid'));
    const res = await request(buildApp()).get('/api/observability/drift/neighbors/not-a-uuid');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      neighbors: [], degraded: true, error: 'invalid input syntax for type uuid',
    });
  });
});

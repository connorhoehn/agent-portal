// Cost rollups — /api/observability/cost (routes/cost.ts) — with no Aurora.
//
// WHY THIS FILE EXISTS. cost.ts was refactored into eight named
// fetchCostX/emptyCostX functions plus GET /summary, but every one of them
// went straight to `exec()` with no mock branch — so under `dev:mock` every
// read threw, was caught, and answered `degraded`. `/admin/observability/cost`
// was a page of UnavailableNotices offline. The sibling suite,
// cost-routes.test.ts, pins the LIVE SQL path (`config.mock.aurora === false`).
// This is the other half: the same eight reads, `aurora: true`, answering from
// the SAME fixtures drift/traffic/quality already read
// (`mock/observability.ts`'s `traceRows()`) — cost is just another cut of
// `observability.invocation_traces`, seven of eight reads are.
// `deploy-markers` is the one that reads `observability.prompt_versions`
// instead, via the SAME registry `routes/prompt-versions.ts` reads.
//
// Three states per read, exactly as observability-mock-branch.test.ts:
//   * seeded   — real rows, real rollups, no `degraded`
//   * empty    — an honest zero (`agentTelemetryProfiles`'s `empty` scenario
//                empties the trace corpus; `promptVersions`' empties the
//                registry), still no `degraded`
//   * error    — `agentTelemetryProfiles`'s `error` scenario throws inside
//                `traceRows()`, reached over HTTP exactly like a real query
//                blowing up

jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', mock: { aurora: true } },
}));

import express from 'express';
import request from '../../test-support/http.js';
import { costRouter } from '../cost.js';
import { errorHandler } from '../../lib/async-handler.js';
import { fixtureRegistry, freezeClock, unfreezeClock, type ScenarioName } from '../../mock/core/index.js';

const AT = '2026-09-08T15:20:00.000Z';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/observability/cost', costRouter);
  app.use(errorHandler);
  return app;
}

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
const ALL = [...READS, DEPLOY_MARKERS];

let restoreClock: () => void;
beforeEach(() => {
  restoreClock = freezeClock(AT);
  fixtureRegistry.resetAll('default');
});
afterEach(() => {
  restoreClock();
  unfreezeClock();
  fixtureRegistry.resetAll('default');
});

/** Run `fn` with every fixture in `scenario`, then put `default` back. */
async function inScenario(scenario: ScenarioName, fn: () => Promise<void>): Promise<void> {
  fixtureRegistry.resetAll(scenario);
  try {
    await fn();
  } finally {
    fixtureRegistry.resetAll('default');
  }
}

describe('the mock branch answers offline, seeded', () => {
  it('serves non-degraded rows on all eight reads', async () => {
    const app = buildApp();
    for (const path of ALL) {
      const res = await request(app).get(`${path}?windowHours=48`).expect(200);
      expect(res.body.degraded).toBeUndefined();
      expect(res.body.error).toBeUndefined();
    }
  });

  it('/total has real spend and coverage over the seeded day', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/observability/cost/total?windowHours=48').expect(200);
    expect(res.body.invocations).toBeGreaterThan(0);
    expect(res.body.totalCostUsd).toBeGreaterThan(0);
    expect(res.body.withCost).toBeGreaterThan(0);
    expect(res.body.withCost).toBeLessThanOrEqual(res.body.invocations);
  });
});

describe('the mock branch answers an honest empty — no marker', () => {
  it('every section reads zero when the trace corpus and the prompt registry are both empty', async () => {
    const app = buildApp();
    await inScenario('empty', async () => {
      for (const path of ALL) {
        const res = await request(app).get(`${path}?windowHours=48`).expect(200);
        expect(res.body.degraded).toBeUndefined();
      }
      const total = (await request(app).get('/api/observability/cost/total').expect(200)).body;
      expect(total).toEqual({
        totalCostUsd: 0, invocations: 0, inputTokens: 0, outputTokens: 0, withCost: 0, windowHours: 24,
      });
      const perAgent = (await request(app).get('/api/observability/cost/per-agent').expect(200)).body;
      expect(perAgent.byAgent).toEqual([]);
      const markers = (await request(app).get(DEPLOY_MARKERS).expect(200)).body;
      expect(markers.markers).toEqual([]);
    });
  });
});

describe('the mock branch degrades honestly on the error world', () => {
  it('marks every trace-backed read degraded, with a reason, when the trace table is unreadable', async () => {
    const app = buildApp();
    await inScenario('error', async () => {
      for (const path of READS) {
        const res = await request(app).get(path).expect(200);
        expect(res.body.degraded).toBe(true);
        expect(typeof res.body.error).toBe('string');
        expect(res.body.error.length).toBeGreaterThan(0);
      }
      // deploy-markers reads the prompt registry, not the trace table, so it
      // is unaffected by the trace fixture's error world.
      const markers = await request(app).get(DEPLOY_MARKERS).expect(200);
      expect(markers.body.degraded).toBeUndefined();
    });
  });

  it('/summary lands every trace-backed section in `degraded`, deployMarkers untouched', async () => {
    const app = buildApp();
    await inScenario('error', async () => {
      const res = await request(app).get('/api/observability/cost/summary').expect(200);
      expect(res.status).toBe(200);
      expect(res.body.degraded.sort()).toEqual(
        ['total', 'perAgent', 'timeseries', 'top', 'byModel', 'a2aOverhead', 'valueRatio'].sort(),
      );
      expect(res.body.sections.deployMarkers.degraded).toBeUndefined();
    });
  });
});

describe('internal consistency — the sections describe one fleet', () => {
  it('per-agent totals sum to the /total figure', async () => {
    const app = buildApp();
    const total = (await request(app).get('/api/observability/cost/total?windowHours=48').expect(200)).body;
    const perAgent = (await request(app).get('/api/observability/cost/per-agent?windowHours=48').expect(200)).body;
    const summed = perAgent.byAgent.reduce((a: number, r: { totalCostUsd: number }) => a + r.totalCostUsd, 0);
    expect(summed).toBeCloseTo(total.totalCostUsd, 6);
    const invSummed = perAgent.byAgent.reduce((a: number, r: { invocations: number }) => a + r.invocations, 0);
    expect(invSummed).toBe(total.invocations);
    expect(perAgent.withCost).toBe(total.withCost);
  });

  it('by-model totals sum to the /total figure', async () => {
    const app = buildApp();
    const total = (await request(app).get('/api/observability/cost/total?windowHours=48').expect(200)).body;
    const byModel = (await request(app).get('/api/observability/cost/by-model?windowHours=48').expect(200)).body;
    const summed = byModel.byModel.reduce((a: number, r: { totalCostUsd: number }) => a + r.totalCostUsd, 0);
    expect(summed).toBeCloseTo(total.totalCostUsd, 6);
    const invSummed = byModel.byModel.reduce((a: number, r: { invocations: number }) => a + r.invocations, 0);
    expect(invSummed).toBe(total.invocations);
  });

  it('timeseries buckets sum to the /total figure within rounding', async () => {
    const app = buildApp();
    const total = (await request(app).get('/api/observability/cost/total?windowHours=48').expect(200)).body;
    const series = (await request(app)
      .get('/api/observability/cost/timeseries?windowHours=48&bucketMin=60').expect(200)).body;
    expect(series.points.length).toBeGreaterThan(0);
    const summed = series.points.reduce((a: number, r: { totalCostUsd: number }) => a + r.totalCostUsd, 0);
    expect(summed).toBeCloseTo(total.totalCostUsd, 6);
    const invSummed = series.points.reduce((a: number, r: { invocations: number }) => a + r.invocations, 0);
    expect(invSummed).toBe(total.invocations);
  });

  it('a2a + direct cost/invocations reconstruct the /total figure', async () => {
    const app = buildApp();
    const total = (await request(app).get('/api/observability/cost/total?windowHours=48').expect(200)).body;
    const overhead = (await request(app)
      .get('/api/observability/cost/a2a-overhead?windowHours=48').expect(200)).body;
    expect(overhead.a2aCostUsd + overhead.directCostUsd).toBeCloseTo(total.totalCostUsd, 6);
    expect(overhead.a2aInvocations + overhead.directInvocations).toBe(total.invocations);
    // Some A2A overhead exists in the seeded corpus (linkA2aParents attaches
    // a quarter of the specialist rows to a supervisor call) — if this were
    // 0 the split would be untested.
    expect(overhead.a2aInvocations).toBeGreaterThan(0);
    expect(overhead.a2aFraction).toBeGreaterThan(0);
    expect(overhead.a2aFraction).toBeLessThanOrEqual(1);
  });

  it('/top is a subset of the rows /per-agent counted, ordered by cost descending', async () => {
    const app = buildApp();
    const top = (await request(app)
      .get('/api/observability/cost/top?windowHours=48&limit=500').expect(200)).body;
    const perAgent = (await request(app).get('/api/observability/cost/per-agent?windowHours=48').expect(200)).body;
    expect(top.invocations.length).toBeGreaterThan(0);
    expect(top.invocations.length).toBeLessThanOrEqual(
      perAgent.byAgent.reduce((a: number, r: { invocations: number }) => a + r.invocations, 0),
    );
    // Every top row actually has a cost, and the list is sorted descending.
    for (const row of top.invocations) expect(row.totalCostUsd).toBeGreaterThan(0);
    for (let i = 1; i < top.invocations.length; i++) {
      expect(top.invocations[i - 1].totalCostUsd).toBeGreaterThanOrEqual(top.invocations[i].totalCostUsd);
    }
    // Every top invocation belongs to an agent /per-agent also reports.
    const agentIds = new Set(perAgent.byAgent.map((r: { agentId: string }) => r.agentId));
    for (const row of top.invocations) expect(agentIds.has(row.agentId)).toBe(true);
  });

  it('value-ratio good-response counts never exceed the agent’s total responses', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/observability/cost/value-ratio?windowHours=48').expect(200);
    expect(res.body.byAgent.length).toBeGreaterThan(0);
    for (const row of res.body.byAgent) {
      expect(row.goodResponses).toBeLessThanOrEqual(row.totalResponses);
      expect(row.goodCostUsd).toBeLessThanOrEqual(row.totalCostUsd + 1e-9);
      if (row.goodResponses > 0) {
        expect(row.costPerGood).toBeCloseTo(row.goodCostUsd / row.goodResponses, 9);
      } else {
        expect(row.costPerGood).toBeNull();
      }
    }
  });

  it('deploy-markers reads the prompt registry, not the trace table, over its own wider window', async () => {
    const app = buildApp();
    const res = await request(app).get(DEPLOY_MARKERS).expect(200);
    expect(res.body.windowHours).toBe(168);
    expect(res.body.markers.length).toBeGreaterThan(0);
    // Ascending by registeredAt, matching `ORDER BY registered_at ASC`.
    for (let i = 1; i < res.body.markers.length; i++) {
      expect(Date.parse(res.body.markers[i].registeredAt))
        .toBeGreaterThanOrEqual(Date.parse(res.body.markers[i - 1].registeredAt));
    }
    for (const m of res.body.markers) {
      expect(typeof m.promptVersion).toBe('string');
      expect(m.promptVersion.length).toBeGreaterThan(0);
    }
  });

  it('/summary composes the SAME numbers the standalone reads answer', async () => {
    const app = buildApp();
    const summary = (await request(app)
      .get('/api/observability/cost/summary?windowHours=48').expect(200)).body;
    const total = (await request(app).get('/api/observability/cost/total?windowHours=48').expect(200)).body;
    expect(summary.sections.total).toEqual(total);
    expect(summary.degraded).toEqual([]);
  });
});

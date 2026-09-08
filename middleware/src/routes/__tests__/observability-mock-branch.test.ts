// The observability surface, over HTTP, with no Aurora.
//
// WHY THIS FILE EXISTS. Twenty reads across eight routers went straight to
// `providers/aurora.ts` `exec()` and nothing else. `exec()` had no mock branch,
// so offline every one of them threw, was caught, and answered an empty
// collection — a broken query and a fleet nobody had called rendered
// identically, which is why the gap survived so long. The sibling suites
// (traffic-routes, drift-routes, tool-calls-routes, …) all pin the LIVE SQL
// path with `config.mock.aurora === false`. This one is the other half: the
// same routes with the flag on, answering from the fixtures.
//
// Three states per read, and the whole point is that they are distinguishable:
//   * seeded   — real rows, real rollups
//   * empty    — an honest zero, NO `degraded` marker
//   * degraded — `degraded: true` plus the reason, reached by asking the
//                fixture for its `error` world rather than by unplugging
//                anything
//
// The clock is frozen so window membership and every percentile are exact.

jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', mock: { aurora: true, agentcore: true, guardrails: true, cloudwatch: true } },
}));
jest.mock('../../lib/authz.js', () => ({
  requireAction: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireSession: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import express from 'express';
import request from '../../test-support/http.js';
import { errorHandler } from '../../lib/async-handler.js';
import { trafficRouter } from '../traffic.js';
import { driftRouter } from '../drift.js';
import { toolCallsRouter } from '../tool-calls.js';
import { qualityRouter } from '../quality.js';
import { calibrationRouter } from '../calibration.js';
import { guardrailsDetailRouter } from '../guardrails-detail.js';
import { invocationsRouter } from '../invocations.js';
import { memoryRouter } from '../memory.js';
import {
  fixtureRegistry,
  freezeClock,
  unfreezeClock,
  type ScenarioName,
} from '../../mock/core/index.js';

const AT = '2026-09-08T15:20:00.000Z';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/traffic', trafficRouter);
  app.use('/drift', driftRouter);
  app.use('/tools', toolCallsRouter);
  app.use('/quality', qualityRouter);
  app.use('/calibration', calibrationRouter);
  app.use('/guardrails-detail', guardrailsDetailRouter);
  app.use('/invocations', invocationsRouter);
  app.use('/memory', memoryRouter);
  app.use(errorHandler);
  return app;
}

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

/**
 * Every GET on this surface, with the collection each one answers under and a
 * window wide enough that the seeded day is actually in it.
 *
 * `/drift/outliers` is deliberately absent from the "has rows" list and named
 * in its own case below — see there.
 */
const READS: Array<{ path: string; key: string }> = [
  { path: '/traffic/rps?windowHours=24&bucketMin=60', key: 'points' },
  { path: '/traffic/heatmap?days=7', key: 'cells' },
  { path: '/traffic/top-users?windowHours=24', key: 'users' },
  { path: '/traffic/per-agent-summary?windowHours=24', key: 'byAgent' },
  { path: '/drift/summary?windowHours=24', key: '' },          // bare array on success
  { path: '/drift/timeseries?windowHours=24&bucketMin=60', key: 'points' },
  { path: '/drift/templates?windowHours=24', key: 'templates' },
  { path: '/tools/latency?windowHours=24', key: 'byTool' },
  { path: '/tools/timeseries?windowHours=24&bucketMin=60', key: 'points' },
  { path: '/tools/errors?limit=50', key: 'errors' },
  { path: '/quality/scores', key: 'points' },
  { path: '/calibration/cases', key: 'cases' },
  { path: '/calibration/runs', key: 'runs' },
  { path: '/guardrails-detail/by-rule?windowHours=24', key: 'byRule' },
  { path: '/guardrails-detail/interventions?limit=50', key: 'interventions' },
  { path: '/invocations/search?limit=50', key: 'invocations' },
  { path: '/memory/events?limit=50', key: 'events' },
  { path: '/memory/stats?windowHours=24', key: 'byAgent' },
];

function collection(body: unknown, key: string): unknown[] {
  if (Array.isArray(body)) return body;
  const value = (body as Record<string, unknown>)[key || 'agents'];
  return Array.isArray(value) ? value : [];
}

/** Run `fn` with every fixture in `scenario`, then put `default` back. */
async function inScenario(scenario: ScenarioName, fn: () => Promise<void>): Promise<void> {
  fixtureRegistry.resetAll(scenario);
  try {
    await fn();
  } finally {
    fixtureRegistry.resetAll('default');
  }
}

describe('the observability surface answers offline', () => {
  it('serves rows on every read, and marks none of them degraded', async () => {
    const app = buildApp();
    for (const read of READS) {
      const res = await request(app).get(read.path).expect(200);
      expect({ path: read.path, rows: collection(res.body, read.key).length })
        .toEqual({ path: read.path, rows: expect.any(Number) });
      expect(collection(res.body, read.key).length).toBeGreaterThan(0);
      // The marker is for a caught failure. A read that answered from the
      // fixtures must not carry it, or "degraded" stops meaning anything.
      expect(res.body.degraded).toBeUndefined();
      expect(res.body.error).toBeUndefined();
    }
  });

  it('answers an honest empty — with no marker — when nothing is seeded', async () => {
    const app = buildApp();
    await inScenario('empty', async () => {
      for (const read of READS) {
        const res = await request(app).get(read.path).expect(200);
        expect({ path: read.path, rows: collection(res.body, read.key).length })
          .toEqual({ path: read.path, rows: 0 });
        expect(res.body.degraded).toBeUndefined();
      }
    });
  });

  it('marks a failed read degraded, with the reason, in the error world', async () => {
    const app = buildApp();
    await inScenario('error', async () => {
      for (const read of READS) {
        const res = await request(app).get(read.path).expect(200);
        expect({ path: read.path, degraded: res.body.degraded })
          .toEqual({ path: read.path, degraded: true });
        expect(typeof res.body.error).toBe('string');
        expect(res.body.error.length).toBeGreaterThan(0);
        expect(collection(res.body, read.key)).toEqual([]);
      }
    });
  });
});

describe('the numbers on the wire describe one fleet', () => {
  it('the per-agent summary and the search list report the same day', async () => {
    const app = buildApp();
    const summary = (await request(app)
      .get('/traffic/per-agent-summary?windowHours=24').expect(200)).body.byAgent as Array<{
        agentId: string; invocations: number; errorRate: number; lowQualityRate: number;
      }>;
    const list = (await request(app)
      .get('/invocations/search?limit=500').expect(200)).body.invocations as Array<{
        agentId: string; judgeScore: number | null; schemaValid: boolean | null;
      }>;

    const total = summary.reduce((a, r) => a + r.invocations, 0);
    expect(total).toBe(list.length);

    for (const row of summary) {
      const mine = list.filter((r) => r.agentId === row.agentId);
      expect(mine).toHaveLength(row.invocations);
      // errorRate counts non-conforming output; the guardrail half is checked
      // against the interventions feed in the next case. A weak answer must
      // NOT be in it.
      const nonConforming = mine.filter((r) => r.schemaValid === false).length;
      const weak = mine.filter((r) => r.judgeScore !== null && r.judgeScore < 0.3).length;
      expect(Math.round(row.lowQualityRate * row.invocations)).toBe(weak);
      expect(Math.round(row.errorRate * row.invocations)).toBeGreaterThanOrEqual(nonConforming);
    }
  });

  it('the guardrail breakdown counts interventions the feed can list', async () => {
    const app = buildApp();
    const byRule = (await request(app)
      .get('/guardrails-detail/by-rule?windowHours=24').expect(200)).body.byRule as Array<{
        ruleName: string; count: number; severityCounts: Record<string, number>;
      }>;
    const feed = (await request(app)
      .get('/guardrails-detail/interventions?limit=500').expect(200)).body.interventions as Array<{
        ruleName: string; severity: string;
      }>;

    expect(byRule.reduce((a, r) => a + r.count, 0)).toBe(feed.length);
    for (const rule of byRule) {
      const mine = feed.filter((i) => i.ruleName === rule.ruleName);
      expect(mine).toHaveLength(rule.count);
      const bySeverity = rule.severityCounts;
      expect(bySeverity.LOW + bySeverity.MEDIUM + bySeverity.HIGH).toBe(mine.length);
    }
  });

  it('a calibration run’s MAE is the mean of the errors its own detail lists', async () => {
    const app = buildApp();
    const runs = (await request(app).get('/calibration/runs').expect(200)).body.runs as Array<{
      calibrationRunId: string; meanAbsError: number | null; maxAbsError: number | null; totalCases: number;
    }>;
    expect(runs.length).toBeGreaterThan(0);

    for (const run of runs) {
      const detail = (await request(app)
        .get(`/calibration/runs/${run.calibrationRunId}`).expect(200)).body as {
          results: Array<{ absError: number | null }>;
        };
      expect(detail.results).toHaveLength(run.totalCases);
      const errors = detail.results
        .map((r) => r.absError)
        .filter((e): e is number => e !== null);
      const mean = errors.reduce((a, b) => a + b, 0) / errors.length;
      expect(run.meanAbsError!).toBeCloseTo(mean, 3);
      expect(run.maxAbsError!).toBeCloseTo(Math.max(...errors), 10);
    }
  });

  it('the newest calibration run has drifted past the 0.15 line its note claims', async () => {
    const app = buildApp();
    const runs = (await request(app).get('/calibration/runs').expect(200)).body.runs as Array<{
      label: string; meanAbsError: number; notes: string | null;
    }>;
    // Newest first — and the story the four seeded runs tell is a judge growing
    // generous over three months. A corpus where the MAE never crosses the line
    // cannot show what this page is for.
    expect(runs[0]!.label).toBe('monthly@current');
    expect(runs[0]!.meanAbsError).toBeGreaterThan(0.15);
    expect(runs[runs.length - 1]!.meanAbsError).toBeLessThan(0.05);
  });

  it('a detail page shows the tool calls the fleet-wide tool rollup counted', async () => {
    const app = buildApp();
    const errors = (await request(app).get('/tools/errors?limit=500').expect(200))
      .body.errors as Array<{ invocationId: string; toolName: string; errorMessage: string | null }>;
    expect(errors.length).toBeGreaterThan(0);

    const first = errors[0]!;
    const detail = (await request(app)
      .get(`/invocations/${encodeURIComponent(first.invocationId)}`).expect(200)).body as {
        toolCalls: Array<{ toolName: string; errored: boolean; errorMessage: string | null }>;
      };
    const errored = detail.toolCalls.filter((t) => t.errored);
    expect(errored).toHaveLength(1);
    expect(errored[0]!.toolName).toBe(first.toolName);
    expect(errored[0]!.errorMessage).toBe(first.errorMessage);
  });
});

describe('the reads that stay honest about what they cannot do', () => {
  it('drift/outliers is empty because its 1-hour window holds only failed runs', async () => {
    const app = buildApp();
    const res = await request(app).get('/drift/outliers?limit=20').expect(200);
    // NOT degraded — nothing failed. The query is `ts > now() - 1 hour AND
    // output_embedding IS NOT NULL`, and the fleet fixture bands every recent
    // row as an error (mock/invocations.ts: all errors newer than all clean
    // rows, so `/recent-invocations` can show them). A run that threw produced
    // no output, so `embedText('')` returns null and there is no embedding to
    // rank — offline and in production alike. Widen the window and the rows
    // appear, which is what the next assertion shows.
    expect(res.body.degraded).toBeUndefined();
    expect(res.body.outliers).toEqual([]);

    const recent = (await request(app)
      .get('/invocations/search?limit=500').expect(200)).body.invocations as Array<{
        ts: string; schemaValid: boolean | null;
      }>;
    // `ts` is the Postgres text form (`2026-09-08 15:19:55+00`) — the shape the
    // RDS Data API actually returns for a `::text` cast, and one Date.parse
    // reads directly. (Turning the space into a `T` is what breaks it: `+00`
    // without minutes is not valid ISO-8601, so the strict path rejects it.)
    const lastHour = recent.filter((r) => Date.parse(r.ts) > Date.parse(AT) - 3_600_000);
    expect(lastHour.length).toBeGreaterThan(0);
    expect(lastHour.every((r) => r.schemaValid === false)).toBe(true);
  });

  it('drift/summary over 24h does have the rows the 1-hour window lacks', async () => {
    const app = buildApp();
    const rows = (await request(app).get('/drift/summary?windowHours=24').expect(200))
      .body as Array<{ agentId: string; embeddingDriftP95: number; judgeP50: number | null }>;
    expect(rows.length).toBe(6);
    expect(rows.every((r) => r.embeddingDriftP95 > 0)).toBe(true);
    expect(rows.every((r) => r.judgeP50 !== null)).toBe(true);
    // The degraded agent is the worst on both axes, which is the whole reason
    // the page is worth opening.
    const worst = rows.slice().sort((a, b) => b.embeddingDriftP95 - a.embeddingDriftP95)[0]!;
    expect(worst.agentId).toBe('orgiq-ingestion');
  });

  it('search says so when it cannot honour the mode filter, instead of ignoring it', async () => {
    const app = buildApp();
    const plain = await request(app).get('/invocations/search?limit=5').expect(200);
    expect(plain.body.degraded).toBeUndefined();

    const withMode = await request(app).get('/invocations/search?limit=5&mode=sim').expect(200);
    expect(withMode.body.degraded).toBe(true);
    expect(withMode.body.error).toMatch(/test_runs/);
  });

  it('a calibration run is refused with its real reason, not a fabricated MAE', async () => {
    const app = buildApp();
    const res = await request(app).post('/calibration/runs').send({}).expect(503);
    expect(res.body.error).toMatch(/Nova-Pro judge/);
    expect(res.body.detail).toMatch(/active case/);
  });

  it('and refuses for the OTHER reason when the set is empty', async () => {
    const app = buildApp();
    await inScenario('empty', async () => {
      const res = await request(app).post('/calibration/runs').send({}).expect(400);
      expect(res.body.error).toMatch(/no active calibration cases/);
    });
  });
});

describe('writes land on a registered fixture, so reset undoes them', () => {
  it('a human label is readable back and dropped by a reset', async () => {
    const app = buildApp();
    await request(app)
      .post('/quality/feedback')
      .send({ invocationId: 'mock-inv-9', label: 'fixed', note: 'reran it' })
      .expect(200);

    const after = (await request(app).get('/invocations/mock-inv-9').expect(200)).body;
    expect(after.invocation.humanLabel).toBe('fixed');
    expect(after.invocation.humanNote).toBe('reran it');

    fixtureRegistry.resetAll('default');
    const reset = (await request(app).get('/invocations/mock-inv-9').expect(200)).body;
    expect(reset.invocation.humanLabel).toBeNull();
  });

  it('labelling an id the corpus does not serve is a 404, as the real RETURNING miss is', async () => {
    const app = buildApp();
    await request(app)
      .post('/quality/feedback')
      .send({ invocationId: 'mock-inv-nope', label: 'good' })
      .expect(404);
  });

  it('a manual memory event joins the feed and leaves on a reset', async () => {
    const app = buildApp();
    const created = await request(app)
      .post('/memory/events')
      .send({ agentId: 'orgiq-search', kind: 'summarize', sessionId: 'sess-manual', durationMs: 42 })
      .expect(201);
    expect(typeof created.body.memoryEventId).toBe('string');

    const feed = (await request(app)
      .get('/memory/events?agentId=orgiq-search&kind=summarize&limit=50').expect(200)).body.events;
    expect(feed).toHaveLength(1);
    expect(feed[0].sessionId).toBe('sess-manual');

    fixtureRegistry.resetAll('default');
    const after = (await request(app)
      .get('/memory/events?agentId=orgiq-search&kind=summarize&limit=50').expect(200)).body.events;
    expect(after).toHaveLength(0);
  });

  it('a calibration case can be added, patched and soft-deleted against the fixture', async () => {
    const app = buildApp();
    const before = (await request(app).get('/calibration/cases').expect(200)).body.cases.length;

    const created = await request(app)
      .post('/calibration/cases')
      .send({ agentId: 'orgiq-search', prompt: 'p', response: 'r', humanScore: 0.6 })
      .expect(201);
    const id = created.body.calibrationId as string;
    expect((await request(app).get('/calibration/cases').expect(200)).body.cases.length)
      .toBe(before + 1);

    await request(app).patch(`/calibration/cases/${id}`).send({ humanScore: 0.7 }).expect(200);
    const one = (await request(app).get(`/calibration/cases/${id}`).expect(200)).body.case;
    expect(one.humanScore).toBeCloseTo(0.7, 3);

    // DELETE is a soft delete: the row leaves the active list but is still
    // reachable with ?includeInactive=1, which is what the real UPDATE does.
    await request(app).delete(`/calibration/cases/${id}`).expect(200);
    expect((await request(app).get('/calibration/cases').expect(200)).body.cases.length)
      .toBe(before);
    expect((await request(app).get('/calibration/cases?includeInactive=1').expect(200)).body.cases
      .some((c: { calibrationId: string }) => c.calibrationId === id)).toBe(true);

    fixtureRegistry.resetAll('default');
    expect((await request(app).get('/calibration/cases?includeInactive=1').expect(200)).body.cases
      .some((c: { calibrationId: string }) => c.calibrationId === id)).toBe(false);
  });
});

// GET /api/observability/invocations/:invocationId — mock branch (dev:mock),
// org-leader.md defect #22.
//
// Health's "Read the failures on …" link opens
// /admin/observability/invocations?status=error, which lists rows from the
// dev:mock tail (mock/invocations.ts, ids like `mock-inv-33`) served by
// GET /api/observability/recent-invocations. Every row there links to
// GET /api/observability/invocations/:id for the drill-down. Before that fix
// this route only ever queried Aurora and 404'd anything that wasn't a UUID
// — i.e. every mock id — so the persona sent to "read the failures" could
// open the list but never a single row. This pins: every id the tail actually
// serves resolves 200 with the real path's detail shape, and an unknown id
// still 404s with the same error body as before.
//
// WHAT CHANGED, AND WHY THIS FILE MOVED WITH IT. The original fix answered
// from a SECOND hand-written projection that nulled every DB-only field —
// judge score, tokens, cost, model — because at the time nothing offline had
// those values, and inventing them here would have been a fabrication. That is
// no longer true: mock/observability.ts seeds the whole `invocation_traces`
// corpus from this same tail, so `GET /search` now shows this row scoring 0.83
// and costing $0.0002. A detail page still answering "—" for both would be the
// count-vs-list defect one click apart.
//
// So the assertions below moved from "these fields are null" to the stronger
// claim: the detail page shows EXACTLY what the list that linked to it showed.
// The route no longer holds a projection of its own — both paths run the same
// `rows.map(...)` over `exec()`-shaped rows — and this file is what keeps that
// true.

jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', mock: { aurora: true, agentcore: true, guardrails: false, cloudwatch: true } },
}));

import express from 'express';
import request from '../../test-support/http.js';
import { invocationsRouter } from '../invocations.js';
import { errorHandler } from '../../lib/async-handler.js';
import { getRecentInvocations } from '../../lib/invocations.js';
import { mockInvocationSearch } from '../../mock/observability-queries.js';
import { fixtureRegistry, freezeClock, unfreezeClock } from '../../mock/core/index.js';

// The corpus dates itself relative to `now` on every read, so the list and the
// detail page were being built a second apart and their `ts` disagreed by a
// second. Freezing is the fix, not rounding: the two surfaces have to be
// describing the same instant, and a test that tolerated a second of slack
// would tolerate a real divergence too.
let restoreClock: () => void;
beforeEach(() => {
  restoreClock = freezeClock('2026-09-08T15:20:00.000Z');
  fixtureRegistry.resetAll('default');
});
afterEach(() => {
  restoreClock();
  unfreezeClock();
  fixtureRegistry.resetAll('default');
});

function buildApp() {
  const app = express();
  app.use(express.json());
  // A fleet-wide role: this file is about the detail shape, not trace scope
  // (invocations-scope.test.ts owns who may read which trace).
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = { sub: 'u-operator', role: 'org-leader', tenant: 'orgiq', grants: {}, iat: 0 };
    next();
  });
  app.use('/api/observability/invocations', invocationsRouter);
  app.use(errorHandler);
  return app;
}

describe('GET /api/observability/invocations/:invocationId — mock branch', () => {
  it('resolves every id the mock tail actually serves, with the real detail shape', async () => {
    const app = buildApp();
    const tail = getRecentInvocations(500);
    expect(tail.length).toBeGreaterThan(0);

    // The same rows the Invocations LIST renders, keyed by id — this is the
    // page the reader clicked through from, and the detail must agree with it.
    const listed = new Map(
      mockInvocationSearch({
        q: '', agentId: '', minScore: null, maxScore: null,
        since: null, until: null, promptVersion: '', userId: '', limit: 500,
      }).map((r) => [r['invocation_id'] as string, r]),
    );

    // Sampling all of them would be slow across 300+ rows — cover an error
    // row, a guardrail-intervened row, and a plain success row explicitly,
    // plus a handful more for breadth.
    const errorRow = tail.find((r) => r.error)!;
    const blockedRow = tail.find((r) => r.guardrailIntervened)!;
    const okRow = tail.find((r) => !r.error && !r.guardrailIntervened)!;
    expect(errorRow).toBeDefined();
    expect(blockedRow).toBeDefined();
    expect(okRow).toBeDefined();

    for (const row of [errorRow, blockedRow, okRow, ...tail.slice(0, 5)]) {
      const res = await request(app)
        .get(`/api/observability/invocations/${encodeURIComponent(row.id)}`)
        .expect(200);
      const detail = res.body.invocation;
      expect(detail.invocationId).toBe(row.id);
      expect(detail.agentId).toBe(row.agentId);
      expect(detail.promptSnippet).toBe(row.promptSnippet);
      expect(detail.responseSnippet).toBe(row.responseSnippet);

      // The load-bearing half: every field the list also carries reads the
      // same on both surfaces. A future change that gives one of them a value
      // the other cannot produce fails here.
      const fromList = listed.get(row.id)!;
      expect(fromList).toBeDefined();
      expect(detail.judgeScore).toBe(fromList['judge_score']);
      expect(detail.totalCostUsd).toBe(fromList['total_cost_usd']);
      expect(detail.modelId).toBe(fromList['model_id']);
      expect(detail.promptVersion).toBe(fromList['prompt_version']);
      expect(detail.templateId).toBe(fromList['template_id']);
      expect(detail.schemaValid).toBe(fromList['schema_valid']);
      expect(detail.ts).toBe(fromList['ts']);

      expect(Array.isArray(res.body.toolCalls)).toBe(true);
      expect(Array.isArray(res.body.children)).toBe(true);

      if (row.error) {
        // invocation_traces has no error-message column of its own, so an
        // agent-level failure still surfaces as an errored tool_calls entry —
        // carrying the invocation's own message, not a fabricated one.
        expect(detail.schemaValid).toBe(false);
        const errored = res.body.toolCalls.filter((t: { errored: boolean }) => t.errored);
        expect(errored).toHaveLength(1);
        expect(errored[0].errorMessage).toBe(row.error);
      } else {
        expect(res.body.toolCalls.every((t: { errored: boolean }) => !t.errored)).toBe(true);
      }

      if (row.guardrailIntervened) {
        expect(detail.guardrailAction).toBe('BLOCKED');
      } else {
        expect(detail.guardrailAction).toBeNull();
      }
    }
  });

  it('still 404s an unknown id with the same error body as before', async () => {
    const app = buildApp();
    const res = await request(app)
      .get('/api/observability/invocations/mock-inv-does-not-exist')
      .expect(404);
    expect(res.body).toEqual({ error: 'invocation not found' });
  });

  it('still 404s a well-formed but unknown UUID (real-path 404 unchanged)', async () => {
    const app = buildApp();
    // No Aurora is actually reachable in this unit test (exec() will throw),
    // but a UUID must never fall into the mock branch — it should hit the
    // real lookup path and surface *some* 4xx/5xx, never a mock 200.
    const res = await request(app)
      .get('/api/observability/invocations/00000000-0000-0000-0000-000000000000');
    expect(res.status).not.toBe(200);
  });
});

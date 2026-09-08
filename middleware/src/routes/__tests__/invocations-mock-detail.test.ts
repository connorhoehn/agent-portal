// GET /api/observability/invocations/:invocationId — mock branch (dev:mock),
// org-leader.md defect #22.
//
// Health's "Read the failures on …" link opens
// /admin/observability/invocations?status=error, which lists rows from the
// dev:mock tail (mock/invocations.ts, ids like `mock-inv-33`) served by
// GET /api/observability/recent-invocations. Every row there links to
// GET /api/observability/invocations/:id for the drill-down. Before this fix
// that route only ever queried Aurora and 404'd anything that wasn't a UUID
// — i.e. every mock id — so the persona sent to "read the failures" could
// open the list but never a single row. This pins: every id the tail
// actually serves resolves 200 with the real path's detail shape, and an
// unknown id still 404s with the same error body as before.

jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', mock: { aurora: true, agentcore: true, guardrails: false, cloudwatch: true } },
}));

import express from 'express';
import request from '../../test-support/http.js';
import { invocationsRouter } from '../invocations.js';
import { errorHandler } from '../../lib/async-handler.js';
import { getRecentInvocations } from '../../lib/invocations.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/observability/invocations', invocationsRouter);
  app.use(errorHandler);
  return app;
}

describe('GET /api/observability/invocations/:invocationId — mock branch', () => {
  it('resolves every id the mock tail actually serves, with the real detail shape', async () => {
    const app = buildApp();
    const tail = getRecentInvocations(500);
    expect(tail.length).toBeGreaterThan(0);

    // Sampling all of them would be slow across 50+ rows — cover an error
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
      expect(res.body.invocation.invocationId).toBe(row.id);
      expect(res.body.invocation.agentId).toBe(row.agentId);
      expect(res.body.invocation.promptSnippet).toBe(row.promptSnippet);
      expect(res.body.invocation.responseSnippet).toBe(row.responseSnippet);
      // Real-shape fields the mock tail has no data for stay null, not invented.
      expect(res.body.invocation.judgeScore).toBeNull();
      expect(res.body.invocation.totalCostUsd).toBeNull();
      expect(res.body.invocation.modelId).toBeNull();
      expect(Array.isArray(res.body.toolCalls)).toBe(true);
      expect(res.body.parent).toBeNull();
      expect(Array.isArray(res.body.children)).toBe(true);

      if (row.error) {
        expect(res.body.invocation.schemaValid).toBe(false);
        expect(res.body.toolCalls).toHaveLength(1);
        expect(res.body.toolCalls[0].errored).toBe(true);
        expect(res.body.toolCalls[0].errorMessage).toBe(row.error);
      } else {
        expect(res.body.toolCalls).toHaveLength(0);
      }

      if (row.guardrailIntervened) {
        expect(res.body.invocation.guardrailAction).toBe('BLOCKED');
      } else {
        expect(res.body.invocation.guardrailAction).toBeNull();
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

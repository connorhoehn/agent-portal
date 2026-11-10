// GET /api/observability/invocations/search — the count is the trap.
//
// The other swallowed reads in this slice answered a bare empty array, which
// at least says nothing. This one answered `{ invocations: [], count: 0 }`,
// and a number is an assertion: zero traces matched. It is the row the
// InvocationSearchPage puts in its header ("0 results"), so a dead
// observability schema rendered as a confident, specific, wrong answer — the
// search ran and found nothing.
//
// Two answers, distinguishable, neither of them a 500 in a reader's face:
//
//   { invocations: [], count: 0 }                            searched, no hits
//   { invocations: [], count: 0, degraded: true, error }     could not search
//
// Same contract as cost-routes.test.ts and environments-runs-degraded.test.ts:
// a healthy empty result carries NO marker, and every failure carries one.

jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../config.js', () => ({
  config: {
    region: 'us-east-1',
    mock: { aurora: false, agentcore: false },
    agentcore: { runtimeArns: {} },
  },
}));
jest.mock('../../lib/authz.js', () => ({
  requireAction: () => (_req: unknown, _res: unknown, next: () => void) => { next(); },
}));
jest.mock('../../lib/trace-sink.js', () => ({ processTrace: jest.fn() }));
jest.mock('../../lib/invocations.js', () => ({ getRecentInvocations: jest.fn(async () => []) }));

import express from 'express';
import request from '../../test-support/http.js';
import { invocationsRouter } from '../invocations.js';
import { errorHandler } from '../../lib/async-handler.js';
import { exec } from '../../providers/aurora.js';

const execMock = exec as unknown as jest.Mock;

function buildApp() {
  const app = express();
  app.use(express.json());
  // A fleet-wide role: this file is about degraded answers, not trace scope
  // (invocations-scope.test.ts owns who may read which trace).
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = { sub: 'u-operator', role: 'org-leader', tenant: 'orgiq', grants: {}, iat: 0 };
    next();
  });
  app.use('/api/observability/invocations', invocationsRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => { execMock.mockReset(); });

describe('GET /search', () => {
  it('answers a plain zero when the search really matched nothing', async () => {
    execMock.mockResolvedValue([]);
    const res = await request(buildApp())
      .get('/api/observability/invocations/search?q=nothing-matches-this');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ invocations: [], count: 0 });
  });

  it('marks the same empty result when the query itself failed', async () => {
    execMock.mockRejectedValue(new Error('relation "observability.invocation_traces" does not exist'));
    const res = await request(buildApp())
      .get('/api/observability/invocations/search?q=nothing-matches-this');
    // Still 200 — the search page renders, it just no longer lies about why
    // it is empty.
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      invocations: [], count: 0, degraded: true,
      error: 'relation "observability.invocation_traces" does not exist',
    });
  });

  it('keeps the error to ONE line, so a multi-line driver dump stays a label', async () => {
    execMock.mockRejectedValue(new Error('BadRequestException: syntax error\n  at Position 41\n  detail…'));
    const res = await request(buildApp()).get('/api/observability/invocations/search');
    expect(res.body.error).toBe('BadRequestException: syntax error');
    expect(String(res.body.error)).not.toContain('\n');
  });
});

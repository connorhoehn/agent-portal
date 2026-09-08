// Eval sets — /api/library/evals (routes/prompt-evals.ts).
//
// What is pinned:
//   * the AUTH FLOOR the router's header argues for at length: running an
//     eval set is an AUTHORING act, so it is gated on ManageBots, NOT
//     ManageCanary. Gating it on the canary capability left an SME able to
//     author a library asset and structurally unable to make it shippable.
//     This test fails the moment that action string changes.
//   * the reads are ungated (the drawer's pass-rate context),
//   * the `{cases}` / `{runs}` envelopes, and the bare run object from the
//     two run-shaped routes,
//   * `runs/:runId` resolving as a literal ahead of `/:assetId/...`,
//   * the 400 (missing version) and 404 (unknown run) branches, and that the
//     runner is attributed from the session.

const gateCalls: string[] = [];
let sessionValue: { sub: string; name?: string } | null = { sub: 'u-1', name: 'Nora Vance' };

jest.mock('../../lib/authz.js', () => ({
  requireAction: (action: string) => {
    gateCalls.push(action);
    return (_req: unknown, _res: unknown, next: () => void) => next();
  },
  resolveSession: () => sessionValue,
}));

jest.mock('../../providers/prompt-evals.js', () => ({
  listEvalSets: jest.fn(),
  listRuns: jest.fn(),
  getEvalRun: jest.fn(),
  runEvals: jest.fn(),
}));

import express from 'express';
import request from '../../test-support/http.js';
import { promptEvalsRouter } from '../prompt-evals.js';
import { errorHandler } from '../../lib/async-handler.js';
import { listEvalSets, listRuns, getEvalRun, runEvals } from '../../providers/prompt-evals.js';

const casesMock = listEvalSets as unknown as jest.Mock;
const runsMock = listRuns as unknown as jest.Mock;
const runMock = getEvalRun as unknown as jest.Mock;
const executeMock = runEvals as unknown as jest.Mock;

const CASE = {
  id: 'ec-1', assetId: 'asset-1', name: 'refuses PII',
  input: 'what is his SSN', assertions: [{ kind: 'not_contains', value: '###' }],
};
const RUN = {
  id: 'er-1', assetId: 'asset-1', version: '3', ranBy: 'Nora Vance',
  ranAt: '2026-08-20T09:00:00Z', passRate: 0.9, results: [],
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/library/evals', promptEvalsRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  casesMock.mockReset(); runsMock.mockReset(); runMock.mockReset(); executeMock.mockReset();
  sessionValue = { sub: 'u-1', name: 'Nora Vance' };
});

describe('auth floor', () => {
  it('gates running an eval set on ManageBots — authoring, not rollout', () => {
    // If this ever reads ManageCanary again, an SME can author an asset they
    // can never make shippable. That regression is what this line catches.
    expect(gateCalls).toEqual(['ManageBots']);
  });
});

describe('GET /api/library/evals/:assetId/cases', () => {
  it('wraps the eval cases and scopes them to the asset in the path', async () => {
    casesMock.mockResolvedValue([CASE]);
    const res = await request(buildApp()).get('/api/library/evals/asset-1/cases');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['cases']);
    expect(casesMock).toHaveBeenCalledWith('asset-1');
    expect(res.body.cases[0].assertions[0].kind).toBe('not_contains');
  });

  it('returns an empty list for an asset with no eval set', async () => {
    casesMock.mockResolvedValue([]);
    const res = await request(buildApp()).get('/api/library/evals/asset-9/cases');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ cases: [] });
  });
});

describe('GET /api/library/evals/:assetId/runs', () => {
  it('wraps the run history with the pass rate the release gate reads', async () => {
    runsMock.mockResolvedValue([RUN]);
    const res = await request(buildApp()).get('/api/library/evals/asset-1/runs');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['runs']);
    expect(runsMock).toHaveBeenCalledWith('asset-1');
    expect(res.body.runs[0].passRate).toBe(0.9);
    expect(res.body.runs[0].version).toBe('3');
  });
});

describe('POST /api/library/evals/:assetId/run', () => {
  it('400s without a version — a run has to name what it evaluated', async () => {
    for (const body of [{}, { version: '' }, { version: '   ' }]) {
      const res = await request(buildApp()).post('/api/library/evals/asset-1/run').send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/version/);
    }
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('runs the suite attributed to the session, trimming the version', async () => {
    executeMock.mockResolvedValue(RUN);
    const res = await request(buildApp())
      .post('/api/library/evals/asset-1/run').send({ version: ' 3 ', ranBy: 'forged' });
    expect(res.status).toBe(200);
    expect(executeMock).toHaveBeenCalledWith('asset-1', '3', 'Nora Vance');
    expect(res.body.id).toBe('er-1');
  });

  it('falls back to the session sub when the session has no name', async () => {
    sessionValue = { sub: 'u-7' };
    executeMock.mockResolvedValue(RUN);
    await request(buildApp()).post('/api/library/evals/asset-1/run').send({ version: '3' });
    expect(executeMock.mock.calls[0]![2]).toBe('u-7');
  });
});

describe('GET /api/library/evals/runs/:runId', () => {
  it('reads one run without being swallowed by the /:assetId routes', async () => {
    runMock.mockResolvedValue(RUN);
    const res = await request(buildApp()).get('/api/library/evals/runs/er-1');
    expect(res.status).toBe(200);
    // `/runs/er-1` is two segments, the same arity as `/:assetId/runs`; only
    // the literal second segment keeps them apart.
    expect(runsMock).not.toHaveBeenCalled();
    expect(runMock).toHaveBeenCalledWith('er-1');
    expect(res.body.passRate).toBe(0.9);
  });

  it('404s an unknown run id', async () => {
    runMock.mockResolvedValue(null);
    const res = await request(buildApp()).get('/api/library/evals/runs/er-x');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/eval run not found/);
  });
});

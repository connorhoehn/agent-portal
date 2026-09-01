// Harness routes (routes/harness.ts) under MOCK_AURORA — regression cover for
// the fix in this sweep: every read in this router called providers/aurora.ts's
// `exec` directly (no mock branch of its own), so HarnessHomePage's three
// cards (cases, runs, coverage) all 500'd offline. Pins: the mock branch
// returns 2xx with fixture-shaped data instead of ever reaching `exec`, and
// the real path is untouched (still calls exec) when mock is off.

const mockFlag = { value: true };

jest.mock('../../config.js', () => ({
  config: {
    get mock() { return { aurora: mockFlag.value, agentcore: true, guardrails: true, cloudwatch: true }; },
    region: 'us-east-1',
  },
}));

jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../lib/trace-sink.js', () => ({ processTrace: jest.fn() }));
jest.mock('../../lib/judge.js', () => ({ judgeResponse: jest.fn() }));
jest.mock('../../lib/harness-runner.js', () => ({ executeRun: jest.fn(), loadCasesForRun: jest.fn() }));
jest.mock('../../lib/authz.js', () => ({
  requireAction: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireTenant: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import express from 'express';
import request from 'supertest';
import { harnessRouter } from '../harness.js';
import { errorHandler } from '../../lib/async-handler.js';
import { exec } from '../../providers/aurora.js';

const execMock = exec as unknown as jest.Mock;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/observability/harness', harnessRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  mockFlag.value = true;
  execMock.mockReset();
});

describe('GET /api/observability/harness/cases (mock)', () => {
  it('serves the fixture without touching the Data API', async () => {
    const res = await request(buildApp()).get('/api/observability/harness/cases');
    expect(res.status).toBe(200);
    expect(execMock).not.toHaveBeenCalled();
    expect(res.body.cases.length).toBeGreaterThan(0);
    expect(res.body.cases.every((c: { active: boolean }) => c.active)).toBe(true);
  });
});

describe('GET /api/observability/harness/runs (mock)', () => {
  it('returns fixture runs sorted by startedAt desc, honoring limit', async () => {
    const res = await request(buildApp()).get('/api/observability/harness/runs?limit=1');
    expect(res.status).toBe(200);
    expect(execMock).not.toHaveBeenCalled();
    expect(res.body.runs).toHaveLength(1);
    expect(res.body.runs[0]).toHaveProperty('runId');
    expect(res.body.runs[0]).toHaveProperty('mode');
  });
});

describe('GET /api/observability/harness/runs/:id (mock)', () => {
  it('returns the fixture run joined with its results', async () => {
    const list = await request(buildApp()).get('/api/observability/harness/runs?limit=14');
    const runId = list.body.runs[0].runId;
    const res = await request(buildApp()).get(`/api/observability/harness/runs/${runId}`);
    expect(res.status).toBe(200);
    expect(res.body.run.runId).toBe(runId);
    expect(Array.isArray(res.body.results)).toBe(true);
    expect(res.body.results.length).toBeGreaterThan(0);
    // Joined fields present, matching what the real path joins from test_cases.
    expect(res.body.results[0]).toHaveProperty('agentId');
    expect(res.body.results[0]).toHaveProperty('prompt');
  });

  it('404s for an unknown run id instead of 500ing', async () => {
    const res = await request(buildApp()).get('/api/observability/harness/runs/does-not-exist');
    expect(res.status).toBe(404);
  });
});

describe('GET /api/observability/harness/coverage (mock)', () => {
  it('rolls up active case counts per agent without touching the Data API', async () => {
    const res = await request(buildApp()).get('/api/observability/harness/coverage');
    expect(res.status).toBe(200);
    expect(execMock).not.toHaveBeenCalled();
    expect(res.body.byAgent.length).toBeGreaterThan(0);
    expect(res.body.byAgent[0]).toHaveProperty('agentId');
    expect(res.body.byAgent[0]).toHaveProperty('count');
  });
});

describe('GET /api/observability/harness/runs/:a/compare/:b (mock)', () => {
  it('compares the two fixture runs and buckets deltas', async () => {
    const list = await request(buildApp()).get('/api/observability/harness/runs?limit=14');
    const [runB, runA] = list.body.runs; // desc order: newest first
    const res = await request(buildApp()).get(
      `/api/observability/harness/runs/${runA.runId}/compare/${runB.runId}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.runA.runId).toBe(runA.runId);
    expect(res.body.runB.runId).toBe(runB.runId);
    expect(res.body.summary).toHaveProperty('passRateDelta');
    expect(
      res.body.regressions.length + res.body.fixes.length + res.body.neutral.length,
    ).toBeGreaterThan(0);
  });
});

describe('POST /api/observability/harness/cases (mock)', () => {
  it('creates a case in the in-memory store, readable back via GET /cases/:id', async () => {
    const app = buildApp();
    const create = await request(app).post('/api/observability/harness/cases').send({
      agentId: 'orgiq-search', prompt: 'A brand-new regression prompt',
    });
    expect(create.status).toBe(201);
    expect(execMock).not.toHaveBeenCalled();
    const testId = create.body.testId as string;
    const got = await request(app).get(`/api/observability/harness/cases/${testId}`);
    expect(got.status).toBe(200);
    expect(got.body.case.prompt).toBe('A brand-new regression prompt');
  });
});

describe('harness routes (real path, mock off)', () => {
  it('GET /runs still calls exec when config.mock.aurora is false', async () => {
    mockFlag.value = false;
    execMock.mockResolvedValue([]);
    const res = await request(buildApp()).get('/api/observability/harness/runs?limit=5');
    expect(res.status).toBe(200);
    expect(execMock).toHaveBeenCalled();
    expect(String(execMock.mock.calls[0]![0])).toMatch(/FROM observability.test_runs/);
  });
});

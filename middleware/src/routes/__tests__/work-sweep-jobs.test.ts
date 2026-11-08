// POST /api/work/sweeps/run { background: true } and GET /api/work/sweeps/jobs/:id (G19):
// the same sweeps as the button, answered at once with a job its owner reads back.

jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', aurora: {}, mock: { aurora: true } } }));
jest.mock('../../lib/authz.js', () => ({
  resolveSession: (req: { session?: unknown }) => req.session ?? null,
  isAllowed: jest.fn(async () => true),
  requireAction: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireSession: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  readForRolesElseAction: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import express, { type Request, type Response, type NextFunction } from 'express';
import request from '../../test-support/http.js';
import { workRouter } from '../work.js';
import { errorHandler } from '../../lib/async-handler.js';
import { sweepRuns } from '../../mock/sweep-runs.js';
import { resetSweepJobs } from '../../lib/sweep-jobs.js';

function app(session: Record<string, unknown> | null) {
  const a = express();
  a.use(express.json());
  a.use((req: Request, _res: Response, next: NextFunction) => {
    if (session) (req as unknown as { session: unknown }).session = session;
    next();
  });
  a.use('/api/work', workRouter);
  a.use(errorHandler);
  return a;
}

const owner = { sub: 'u-mia', role: 'program-owner', tenant: 'orgiq' };
const other = { sub: 'u-nora', role: 'sme', tenant: 'orgiq' };
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

beforeEach(() => { sweepRuns.reset(); resetSweepJobs(); process.env['SWEEP_JOB_MOCK_STEP_MS'] = '0'; });
afterAll(() => { sweepRuns.reset(); delete process.env['SWEEP_JOB_MOCK_STEP_MS']; });

describe('background sweeps', () => {
  it('answers 202 with a queued job before the sweeps run; the owner reads it to done; each sweep still writes its run row', async () => {
    const res = await request(app(owner)).post('/api/work/sweeps/run').send({ background: true });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ kind: 'sweep', sweep: null, state: 'queued', href: '/iq/work/findings' });
    await settle();
    const read = await request(app(owner)).get(`/api/work/sweeps/jobs/${res.body.jobId}`);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ jobId: res.body.jobId, state: 'done' });
    expect(read.body.detail).toMatch(/findings?/);
    expect(sweepRuns.rows().map((r) => r.sweep).sort()).toEqual(['bus_factor', 'orphan_decisions', 'stale_docs']);
  });

  it('one named sweep, and an unknown one is refused before anything starts', async () => {
    const one = await request(app(owner)).post('/api/work/sweeps/run').send({ sweep: 'stale_docs', background: true });
    expect(one.status).toBe(202);
    expect(one.body.title).toBe('The stale docs sweep');
    const bad = await request(app(owner)).post('/api/work/sweeps/run').send({ sweep: 'vibes', background: true });
    expect(bad.status).toBe(400);
    await settle();
    expect(sweepRuns.rows().map((r) => r.sweep)).toEqual(['stale_docs']);
  });

  it('another user reads 404, and without the flag the route still waits for the results', async () => {
    const res = await request(app(owner)).post('/api/work/sweeps/run').send({ background: true });
    expect((await request(app(other)).get(`/api/work/sweeps/jobs/${res.body.jobId}`)).status).toBe(404);
    expect((await request(app(owner)).get('/api/work/sweeps/jobs/sweepjob-nope')).status).toBe(404);
    const sync = await request(app(owner)).post('/api/work/sweeps/run').send({});
    expect(sync.status).toBe(200);
    expect(Object.keys(sync.body).sort()).toEqual(['released', 'results']);
    await settle();
  });
});

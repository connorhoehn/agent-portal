// POST /api/work/sweeps/run { background: true } and GET /api/work/sweeps/jobs/:id (G19):
// the same sweeps as the button, answered at once with a job its owner reads back.

jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', aurora: {}, mock: { aurora: true } } }));
// requireAction asks the same isAllowed the tests steer, so the background gate is a real decision here.
jest.mock('../../lib/authz.js', () => {
  const isAllowed = jest.fn(async (_s: unknown, _action: string) => true);
  return {
    resolveSession: (req: { session?: unknown }) => req.session ?? null,
    isAllowed,
    requireAction: (action: string) => async (req: { session?: unknown }, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) =>
      ((await isAllowed(req.session, action)) ? next() : res.status(403).json({ error: 'Forbidden', action })),
    requireSession: () => (_req: unknown, _res: unknown, next: () => void) => next(),
    readForRolesElseAction: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  };
});

import express, { type Request, type Response, type NextFunction } from 'express';
import request from '../../test-support/http.js';
import { workRouter } from '../work.js';
import { errorHandler } from '../../lib/async-handler.js';
import { sweepRuns } from '../../mock/sweep-runs.js';
import { resetSweepJobs } from '../../lib/sweep-jobs.js';
import { resetRateLimits } from '../../lib/rate-limit.js';
import { isAllowed } from '../../lib/authz.js';
import { SWEEP_JOBS_PER_HOUR } from '../work.js';

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

beforeEach(() => {
  sweepRuns.reset(); resetSweepJobs(); resetRateLimits(); (isAllowed as jest.Mock).mockClear();
  process.env['SWEEP_JOB_MOCK_STEP_MS'] = '0';
});
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

describe('GET /api/work/sweeps/jobs', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('lists the caller\'s own jobs newest first and nobody else\'s; limit is capped and defaults to 20', async () => {
    const a = await request(app(owner)).post('/api/work/sweeps/run').send({ sweep: 'stale_docs', background: true });
    await settle();
    await sleep(5);
    const b = await request(app(owner)).post('/api/work/sweeps/run').send({ background: true });
    await settle();
    await request(app(other)).post('/api/work/sweeps/run').send({ background: true });
    await settle();
    const res = await request(app(owner)).get('/api/work/sweeps/jobs');
    expect(res.status).toBe(200);
    expect(res.body.jobs.map((j: { jobId: string }) => j.jobId)).toEqual([b.body.jobId, a.body.jobId]);
    expect(res.body.jobs[0]).not.toHaveProperty('owner');
    expect((await request(app(owner)).get('/api/work/sweeps/jobs?limit=1')).body.jobs).toHaveLength(1);
    expect((await request(app(owner)).get('/api/work/sweeps/jobs?limit=9999')).status).toBe(200);
    // Another tenant's session with the same sub sees none.
    const elsewhere = await request(app({ ...owner, tenant: 'pipelines' })).get('/api/work/sweeps/jobs');
    expect(elsewhere.body.jobs).toEqual([]);
  });

  it('401 without a session', async () => {
    expect((await request(app(null)).get('/api/work/sweeps/jobs')).status).toBe(401);
  });
});

describe('background sweeps are paced (sweep 1, M2)', () => {
  const run = (who: Record<string, unknown>, body: Record<string, unknown> = { background: true }) =>
    request(app(who)).post('/api/work/sweeps/run').send(body);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('needs DispatchAgentRun, the action the Findings page\'s button and the voice card name; the button\'s own run is unchanged', async () => {
    (isAllowed as jest.Mock).mockImplementation(async (_s: unknown, action: string) => action !== 'DispatchAgentRun');
    try {
      const res = await run(owner);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ action: 'DispatchAgentRun' });
      expect(sweepRuns.rows()).toHaveLength(0);
      expect((await run(owner, {})).status).toBe(200);
    } finally { (isAllowed as jest.Mock).mockImplementation(async () => true); }
  });

  it('one job in flight per user: a second is a 409 naming the first, another user is unaffected, and the next goes once it ends', async () => {
    process.env['SWEEP_JOB_MOCK_STEP_MS'] = '40';
    const first = await run(owner);
    expect(first.status).toBe(202);
    const second = await run(owner, { sweep: 'stale_docs', background: true });
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ code: 'sweep-job-running', jobId: first.body.jobId, job: { jobId: first.body.jobId } });
    expect((await run(other)).status).toBe(202);
    await sleep(200);
    await settle();
    expect((await request(app(owner)).get(`/api/work/sweeps/jobs/${first.body.jobId}`)).body.state).toBe('done');
    expect((await run(owner)).status).toBe(202);
    await sleep(200);
  });

  it(`at most ${SWEEP_JOBS_PER_HOUR} an hour per user: the next is a 429; another user and the button's run still go`, async () => {
    for (let i = 0; i < SWEEP_JOBS_PER_HOUR; i++) {
      expect((await run(owner)).status).toBe(202);
      await settle();
    }
    const over = await run(owner);
    expect(over.status).toBe(429);
    expect(Number(over.headers['retry-after'])).toBeGreaterThan(3000);
    expect((await run(other)).status).toBe(202);
    expect((await run(owner, {})).status).toBe(200);
    await settle();
  });
});

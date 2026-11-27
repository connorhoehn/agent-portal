// The run page's Retry uses POST /api/work/jobs/:id/requeue, so that route's gate is Retry's gate
// (docs/next-steps.md section 9, 28 November item 8): a steward with DispatchAgentRun, an org-leader
// or an admin; the requester always; every one through the first dispatch's spend verdict.
process.env['INSECURE_DEV_MODE'] = 'true';
jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', aurora: {}, cognito: { portalOrigin: '' }, auth: { policyStoreId: undefined, sessionSigningSecretArn: '', cognito: null }, mock: { aurora: true } },
}));
jest.mock('aws-jwt-verify', () => ({ CognitoJwtVerifier: { create: () => ({ verify: async () => ({}) }) } }));
jest.mock('../../lib/role-registry.js', () => ({
  roleRegistry: () => [
    { id: 'admin', tenant: null, label: '', summary: '', capabilities: ['*'] },
    { id: 'operator', tenant: 'orgiq', label: '', summary: '', capabilities: ['ManageDevbox'] },
    { id: 'dispatcher', tenant: 'orgiq', label: '', summary: '', capabilities: ['DispatchAgentRun'] },
    { id: 'org-leader', tenant: 'orgiq', label: '', summary: '', capabilities: ['DispatchAgentRun'] },
    { id: 'member', tenant: 'orgiq', label: '', summary: '', capabilities: ['ViewWorkItems'] },
  ],
}));
jest.mock('../../providers/agent-jobs.js', () => ({
  ...jest.requireActual('../../providers/agent-jobs.js'),
  requeueJob: jest.fn(),
  getJob: jest.fn(),
}));
import express from 'express';
import request from '../../test-support/http.js';
import { workRouter } from '../work.js';
import { errorHandler } from '../../lib/async-handler.js';
import { requeueJob, getJob } from '../../providers/agent-jobs.js';
import type { Session } from '../../lib/session.js';

let app: express.Express;
beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(requeueJob).mockResolvedValue({ id: 'job-new' } as Awaited<ReturnType<typeof requeueJob>>);
  app = express(); app.use(express.json());
  app.use((req, _res, next) => {
    const role = String(req.headers['x-role']);
    req.session = { sub: 'u1', tenant: 'orgiq', role, epoch: 0, iat: 1, grants: { orgiq: [role] } } as Session;
    next();
  });
  app.use('/api/work', workRouter); app.use(errorHandler);
});

const verdict = { kind: 'allow' as 'allow' | 'deny' };
const onInitiative = { value: true };
jest.mock('../../lib/bot-runner.js', () => ({
  ...jest.requireActual('../../lib/bot-runner.js'),
  grantScopedDispatchVerdict: jest.fn(async () => (verdict.kind === 'deny' ? { kind: 'deny', reason: 'over budget' } : { kind: 'allow' })),
}));
jest.mock('../../lib/initiative-scope.js', () => ({
  ...jest.requireActual('../../lib/initiative-scope.js'),
  requireInitiativeScope: jest.fn(async (req: { session?: { role?: string } }, res: { status(n: number): { json(b: unknown): void } }) => {
    const role = req.session?.role ?? '';
    if (!['org-leader', 'hr-admin', 'admin'].includes(role) && !onInitiative.value) { res.status(403).json({ code: 'NOT_ON_INITIATIVE' }); return false; }
    if (verdict.kind === 'deny') { res.status(403).json({ error: 'over budget' }); return false; }
    return true;
  }),
}));

function job(createdBy: string, initiativeId: string | null = 'p-1') {
  jest.mocked(getJob).mockResolvedValue({ id: 'job-old', status: 'failed', createdBy, payload: initiativeId ? { initiativeId } : {} } as unknown as Awaited<ReturnType<typeof getJob>>);
}

beforeEach(() => { verdict.kind = 'allow'; onInitiative.value = true; });

it('404s a job that does not exist', async () => {
  jest.mocked(getJob).mockResolvedValue(null as unknown as Awaited<ReturnType<typeof getJob>>);
  expect((await request(app).post('/api/work/jobs/job-old/requeue').set('x-role', 'operator')).status).toBe(404);
});

// docs/next-steps.md section 9, 28 November item 8.
it('a steward holding DispatchAgentRun retries a run on their initiative; off it they are refused', async () => {
  job('u-other');
  expect((await request(app).post('/api/work/jobs/job-old/requeue').set('x-role', 'dispatcher')).status).toBe(201);
  onInitiative.value = false;
  expect((await request(app).post('/api/work/jobs/job-old/requeue').set('x-role', 'dispatcher')).status).toBe(403);
});

it('an org-leader and an admin retry on any initiative', async () => {
  job('u-other'); onInitiative.value = false;
  expect((await request(app).post('/api/work/jobs/job-old/requeue').set('x-role', 'org-leader')).status).toBe(201);
  expect((await request(app).post('/api/work/jobs/job-old/requeue').set('x-role', 'admin')).status).toBe(201);
});

it('someone else\'s run is refused to a role without DispatchAgentRun, even on the initiative', async () => {
  job('u-other');
  const res = await request(app).post('/api/work/jobs/job-old/requeue').set('x-role', 'member');
  expect(res.status).toBe(403);
  expect(res.body).toMatchObject({ action: 'DispatchAgentRun' });
  expect(requeueJob).not.toHaveBeenCalled();
});

it('the requester always retries their own, a requeue of it included, without the steward check', async () => {
  onInitiative.value = false;
  job('u1');
  expect((await request(app).post('/api/work/jobs/job-old/requeue').set('x-role', 'member')).status).toBe(201);
  job('u1 (requeue of job-0)');
  expect((await request(app).post('/api/work/jobs/job-old/requeue').set('x-role', 'member')).status).toBe(201);
  job('u10');
  expect((await request(app).post('/api/work/jobs/job-old/requeue').set('x-role', 'member')).status).toBe(403);
});

it('every retry meets the first dispatch\'s spend verdict: no bypass for the requester or a leader', async () => {
  verdict.kind = 'deny';
  job('u1');
  expect((await request(app).post('/api/work/jobs/job-old/requeue').set('x-role', 'member')).status).toBe(403);
  job('u-other');
  expect((await request(app).post('/api/work/jobs/job-old/requeue').set('x-role', 'org-leader')).status).toBe(403);
  expect(requeueJob).not.toHaveBeenCalled();
});

it('a job with no initiative keeps its ManageDevbox holders and adds org-leader', async () => {
  job('u-other', null);
  expect((await request(app).post('/api/work/jobs/job-old/requeue').set('x-role', 'operator')).status).toBe(201);
  expect((await request(app).post('/api/work/jobs/job-old/requeue').set('x-role', 'org-leader')).status).toBe(201);
  expect((await request(app).post('/api/work/jobs/job-old/requeue').set('x-role', 'dispatcher')).status).toBe(403);
});

// The run page's Retry uses POST /api/work/jobs/:id/requeue, so that route's gate is Retry's gate:
// a session without ManageDevbox is refused and nothing is requeued; one with it gets the clone.
process.env['INSECURE_DEV_MODE'] = 'true';
jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', aurora: {}, cognito: { portalOrigin: '' }, auth: { policyStoreId: undefined, sessionSigningSecretArn: '', cognito: null }, mock: { aurora: true } },
}));
jest.mock('aws-jwt-verify', () => ({ CognitoJwtVerifier: { create: () => ({ verify: async () => ({}) }) } }));
// Two roles: one holds ManageDevbox, one does not.
jest.mock('../../lib/role-registry.js', () => ({
  roleRegistry: () => [
    { id: 'operator', tenant: 'orgiq', label: '', summary: '', capabilities: ['ManageDevbox'] },
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
import { requeueJob } from '../../providers/agent-jobs.js';
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

it('refuses a person without ManageDevbox and requeues nothing', async () => {
  const res = await request(app).post('/api/work/jobs/job-old/requeue').set('x-role', 'member');
  expect(res.status).toBe(403);
  expect(requeueJob).not.toHaveBeenCalled();
});

it('returns the new attempt for a person who holds it', async () => {
  const res = await request(app).post('/api/work/jobs/job-old/requeue').set('x-role', 'operator');
  expect(res.status).toBe(201);
  expect(res.body.id).toBe('job-new');
});

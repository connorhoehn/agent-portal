// /api/distillation gates, against the REAL authz module in open mode (no
// POLICY_STORE_ID → the Cedar seed matrix via role-registry), mounted exactly
// as index.ts mounts it: requireTenant('orgiq') + requireSession('ViewDistillation')
// on the router, requireAction('ManageBots') on each write.
//
// Pinned: a member reads every new route; a member's writes 403 before
// anything moves; an org-leader (ManageBots) writes; no session at all is a
// 401, and an assessment-tenant session is refused at the tenant floor.
// role-registry is mocked to the seeds' own answer for ManageBots (member.cedar
// does not grant it; org-leader.cedar does) because the real module reads the
// seed files through import.meta, which the CJS jest build cannot compile.

jest.mock('../../config.js', () => ({
  config: {
    region: 'us-east-1', auth: { policyStoreId: undefined }, cognito: null,
    mock: { aurora: true }, messageQueue: { mock: true },
  },
}));
jest.mock('../../lib/role-registry.js', () => ({
  roleRegistry: () => [
    { id: 'member', tenant: 'orgiq', label: 'Member', summary: '', capabilities: ['Search'] },
    { id: 'org-leader', tenant: 'orgiq', label: 'Org leader', summary: '', capabilities: ['Search', 'ManageBots'] },
    { id: 'assessor', tenant: 'assessment', label: 'Assessor', summary: '', capabilities: ['ViewAssessment'] },
  ],
}));
jest.mock('@aws-sdk/client-verifiedpermissions', () => ({
  VerifiedPermissionsClient: class { send() { return Promise.resolve({}); } },
  IsAuthorizedCommand: class {},
}));
jest.mock('@aws-sdk/client-bedrock-agent', () => ({
  BedrockAgentClient: class { send() { return Promise.resolve({}); } },
  ListPromptsCommand: class {},
}));
jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn() }));

import express from 'express';
import request from '../../test-support/http.js';
import { distillationRouter } from '../distillation.js';
import { requireTenant, requireSession } from '../../lib/authz.js';
import { errorHandler } from '../../lib/async-handler.js';
import { __setCompactRunMs, __resetDistillationMock } from '../../providers/distillation.js';
import { clusters } from '../../mock/distillation.js';
import type { Session } from '../../lib/session.js';

const prevEnv = { ...process.env };
beforeAll(() => __setCompactRunMs(0));
beforeEach(() => __resetDistillationMock());
afterAll(() => { process.env = prevEnv; __resetDistillationMock(); });

function appAs(session: Partial<Session> | null) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (session) req.session = { sub: 'u-test', iat: 0, grants: {}, ...session } as Session;
    next();
  });
  app.use('/api/distillation', requireTenant('orgiq'), requireSession('ViewDistillation'), distillationRouter);
  app.use(errorHandler);
  return app;
}

const member = { role: 'member' as const, tenant: 'orgiq' as const, sub: 'u-theo' };
const leader = { role: 'org-leader' as const, tenant: 'orgiq' as const, sub: 'u-vera', name: 'Vera Green' };

const READS = [
  '/api/distillation/levels',
  '/api/distillation/facets?level=L1',
  '/api/distillation/items?level=L2&limit=5',
  '/api/distillation/items/art-001/sources',
  '/api/distillation/sessions/sess-obs-03',
  '/api/distillation/review?verdict=pending',
  '/api/distillation/compactions',
  '/api/distillation/compactions/comp-101',
  '/api/distillation/procedures/art-010/runs',
  '/api/distillation/replication',
];

describe('member — reads everything, writes nothing', () => {
  it.each(READS)('GET %s → 200', async (path) => {
    expect((await request(appAs(member)).get(path)).status).toBe(200);
  });

  it('POST /api/distillation/compact → 403, and no pass is queued or run', async () => {
    const before = clusters.rows().length;
    const res = await request(appAs(member)).post('/api/distillation/compact').send({ level: 'L1' });
    expect(res.status).toBe(403);
    expect(clusters.rows().length).toBe(before);
  });

  it('POST /api/distillation/review/:id and /review → 403', async () => {
    expect((await request(appAs(member)).post('/api/distillation/review/rev-003').send({ verdict: 'agree' })).status).toBe(403);
    expect((await request(appAs(member)).post('/api/distillation/review').send({ target_kind: 'cluster', target_id: 'cl-001' })).status).toBe(403);
  });

  it('POST /api/distillation/procedures/:id/apply and /artifacts/:id/publish → 403', async () => {
    expect((await request(appAs(member)).post('/api/distillation/procedures/art-011/apply').send({ outcome: 'succeeded' })).status).toBe(403);
    expect((await request(appAs(member)).post('/api/distillation/artifacts/art-006/publish')).status).toBe(403);
  });
});

describe('org-leader — ManageBots writes', () => {
  it('POST /api/distillation/compact → 201 with the pass attributed to the session', async () => {
    const res = await request(appAs(leader)).post('/api/distillation/compact').send({ level: 'L1' });
    expect(res.status).toBe(201);
    expect(res.body.requested_by).toBe('Vera Green');
    expect(res.body.status).toBe('succeeded');
  });
});

describe('the floor under every route', () => {
  it('an assessment-tenant session is refused at the tenant gate', async () => {
    const res = await request(appAs({ role: 'assessor', tenant: 'assessment', sub: 'u-asha' })).get('/api/distillation/levels');
    expect(res.status).toBe(403);
    expect(res.body.requiredTenant).toBe('orgiq');
  });

  it('no session (and no demo fallback) is a 401', async () => {
    process.env['NODE_ENV'] = 'production';
    delete process.env['AUTH_DEMO_MODE'];
    try {
      expect((await request(appAs(null)).get('/api/distillation/replication')).status).toBe(401);
    } finally {
      process.env['NODE_ENV'] = prevEnv['NODE_ENV'];
    }
  });
});

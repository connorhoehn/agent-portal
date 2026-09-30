// The pipelines tenant's API gate (docs/pipelines-tenant-goal.md §Routes,
// docs/social-tenant-design.md §6): a session parked in orgiq, assessment or
// social is refused at requireTenant('pipelines') BEFORE any handler runs —
// 403 naming the tenant it would have needed. Every pipelines role reads the
// summary; the cross-tenant admin passes from any tenant.

jest.mock('../../config.js', () => ({
  config: { auth: { policyStoreId: undefined, cognito: null }, mock: { aurora: true } },
}));
jest.mock('../../lib/role-registry.js', () => ({
  roleRegistry: () => [
    { id: 'admin', tenant: null, label: 'Admin', summary: '', capabilities: ['*'] },
    { id: 'author', tenant: 'pipelines', label: 'Author', summary: '', capabilities: ['ViewPipelines', 'AuthorDefinition', 'RunPipeline'] },
    { id: 'operator', tenant: 'pipelines', label: 'Operator', summary: '', capabilities: ['ViewPipelines', 'RunPipeline', 'ApproveStep', 'CancelRun'] },
    { id: 'pipeline-admin', tenant: 'pipelines', label: 'Pipeline Admin', summary: '', capabilities: ['ViewPipelines', 'RunPipeline', 'ApproveStep', 'CancelRun', 'ManagePipelineConfig', 'ManageUsers'] },
  ],
}));
jest.mock('@aws-sdk/client-verifiedpermissions', () => ({
  VerifiedPermissionsClient: class { send() { return Promise.resolve({}); } },
  IsAuthorizedCommand: class {},
}));

import express from 'express';
import request from '../../test-support/http.js';
import { pipelinesRouter } from '../pipelines.js';
import { requireTenant } from '../../lib/authz.js';
import { errorHandler } from '../../lib/async-handler.js';
import { type Role, type Session, type Tenant } from '../../lib/session.js';
import { pipelinesSurfaces } from '../../mock/pipelines.js';

function appAs(session: Partial<Session>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { sub: 'u-test', iat: 0, grants: {}, ...session } as Session;
    next();
  });
  // The same mount index.ts uses.
  app.use('/api/pipelines', requireTenant('pipelines'), pipelinesRouter);
  app.use(errorHandler);
  return app;
}

const OUTSIDE: Array<{ role: Role; tenant: Tenant; sub: string }> = [
  { role: 'member', tenant: 'orgiq', sub: 'u-theo' },
  { role: 'sme', tenant: 'orgiq', sub: 'u-nora' },
  { role: 'program-owner', tenant: 'orgiq', sub: 'u-mia' },
  { role: 'org-leader', tenant: 'orgiq', sub: 'u-vera' },
  { role: 'hr-admin', tenant: 'orgiq', sub: 'u-hr' },
  { role: 'assessor', tenant: 'assessment', sub: 'u-asha' },
  { role: 'lead-assessor', tenant: 'assessment', sub: 'u-jonas' },
  { role: 'program-lead', tenant: 'assessment', sub: 'u-farah' },
  { role: 'participant', tenant: 'social', sub: 'u-sana' },
  { role: 'moderator', tenant: 'social', sub: 'u-lena' },
  { role: 'community-admin', tenant: 'social', sub: 'u-mira' },
];

describe('requireTenant(pipelines) — outside roles', () => {
  for (const s of OUTSIDE) {
    it(`${s.tenant}/${s.role} gets 403 on /api/pipelines/summary`, async () => {
      const res = await request(appAs(s)).get('/api/pipelines/summary');
      expect(res.status).toBe(403);
      expect(res.body.requiredTenant).toBe('pipelines');
    });
  }
});

describe('GET /api/pipelines/summary', () => {
  afterEach(() => pipelinesSurfaces.reset());

  for (const role of ['author', 'operator', 'pipeline-admin'] as Role[]) {
    it(`pipelines/${role} reads the summary`, async () => {
      const res = await request(appAs({ role, tenant: 'pipelines', sub: 'u-kofi' })).get('/api/pipelines/summary');
      expect(res.status).toBe(200);
      expect(res.body.tenant).toBe('pipelines');
    });
  }

  it('admin passes the gate from any tenant', async () => {
    const res = await request(appAs({ role: 'admin', tenant: 'assessment', sub: 'u-operator' })).get('/api/pipelines/summary');
    expect(res.status).toBe(200);
  });

  it('counts members from grants and surfaces from the registered catalog', async () => {
    const res = await request(appAs({ role: 'operator', tenant: 'pipelines', sub: 'u-kofi' })).get('/api/pipelines/summary');
    const rows = pipelinesSurfaces.rows();
    expect(res.body.surfaces).toEqual({ total: rows.length, live: rows.filter((r) => r.live).length, pending: rows.filter((r) => !r.live).length });
    // One seeded user per role, plus the cross-tenant operator.
    expect(res.body.members.byRole).toEqual({ author: 1, operator: 1, 'pipeline-admin': 1, admin: 1 });
    expect(res.body.members.total).toBe(4);
  });

  it('the empty scenario reads zero surfaces', async () => {
    expect(pipelinesSurfaces.rows('empty')).toEqual([]);
  });
});

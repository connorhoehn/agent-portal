// "An SME shouldn't see the assessment pages." The API half of that sentence,
// pinned: a session whose tenant is orgiq is refused at requireTenant('assessment')
// BEFORE any assessment handler runs — 403, with the tenant it would have
// needed. Admin is the one cross-tenant role.

// lib/authz pulls config.ts (import.meta) and the AVP SDK; every route test
// mocks those the same way — see authz-open-mode.test.ts.
jest.mock('../../config.js', () => ({
  config: { auth: { policyStoreId: undefined, cognito: null }, mock: { aurora: true } },
}));
jest.mock('../../lib/role-registry.js', () => ({
  roleRegistry: () => [
    { id: 'admin', tenant: null, label: 'Admin', summary: '', capabilities: ['*'] },
    { id: 'assessor', tenant: 'assessment', label: 'Assessor', summary: '', capabilities: ['ViewAssessment', 'ScoreAssessment', 'RunAssessmentAgent'] },
  ],
}));
jest.mock('@aws-sdk/client-verifiedpermissions', () => ({
  VerifiedPermissionsClient: class { send() { return Promise.resolve({}); } },
  IsAuthorizedCommand: class {},
}));

import express from 'express';
import request from '../../test-support/http.js';
import { assessmentRouter } from '../assessment.js';
import { requireTenant } from '../../lib/authz.js';
import { errorHandler } from '../../lib/async-handler.js';
import { type Role, type Session, type Tenant } from '../../lib/session.js';

function appAs(session: Partial<Session>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { sub: 'u-test', iat: 0, grants: {}, ...session } as Session;
    next();
  });
  app.use('/api/assessment', requireTenant('assessment'), assessmentRouter);
  app.use(errorHandler);
  return app;
}

const OUTSIDE: Array<{ role: Role; tenant: Tenant; sub: string }> = [
  { role: 'sme', tenant: 'orgiq', sub: 'u-nora' },
  { role: 'member', tenant: 'orgiq', sub: 'u-theo' },
  { role: 'program-owner', tenant: 'orgiq', sub: 'u-mia' },
  { role: 'org-leader', tenant: 'orgiq', sub: 'u-vera' },
  { role: 'hr-admin', tenant: 'orgiq', sub: 'u-hr' },
];

describe('requireTenant(assessment) — outside roles', () => {
  for (const s of OUTSIDE) {
    it(`${s.tenant}/${s.role} gets 403 on every assessment read and write`, async () => {
      const app = appAs(s);
      for (const path of ['/api/assessment/teams', '/api/assessment/teams/TEAM-001', '/api/assessment/knowledge/tree', '/api/assessment/runs', '/api/assessment/rollup', '/api/assessment/dimension-index']) {
        const res = await request(app).get(path);
        expect({ path, status: res.status }).toEqual({ path, status: 403 });
        expect(res.body.requiredTenant).toBe('assessment');
      }
      const write = await request(app).post('/api/assessment/runs').send({ command: 'validate-outputs', args: {}, team_id: 'TEAM-006' });
      expect(write.status).toBe(403);
    });
  }

  it('an assessment session passes the gate, and admin passes it from any tenant', async () => {
    expect((await request(appAs({ role: 'assessor', tenant: 'assessment', sub: 'u-asha' })).get('/api/assessment/teams')).status).toBe(200);
    expect((await request(appAs({ role: 'admin', tenant: 'orgiq', sub: 'u-operator' })).get('/api/assessment/teams')).status).toBe(200);
  });
});

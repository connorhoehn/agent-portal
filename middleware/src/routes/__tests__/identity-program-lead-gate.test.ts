// Review finding 2: a router-wide requireAction('ViewIdentityAdmin') locked
// program-lead (ManageUsers, tenant-scoped) out of the user-admin routes
// built for it. Real open-mode authz here (no policy store, seed matrix from
// the mocked registry) — the grants-scope test mocks the gate away, which is
// exactly how this went unnoticed.

jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', auth: { policyStoreId: undefined, cognito: null }, mock: { aurora: true }, aurora: { clusterArn: '', secretArn: '', database: 'orgiq' } },
}));
jest.mock('../../lib/role-registry.js', () => ({
  roleRegistry: () => [
    { id: 'admin', tenant: null, label: 'Admin', summary: '', capabilities: ['*'] },
    { id: 'hr-admin', tenant: 'orgiq', label: 'HR', summary: '', capabilities: ['ViewIdentityAdmin', 'ManageUsers', 'EditPolicy', 'EditSchema'] },
    { id: 'sme', tenant: 'orgiq', label: 'SME', summary: '', capabilities: ['ViewGraph'] },
    { id: 'program-lead', tenant: 'assessment', label: 'PL', summary: '', capabilities: ['ViewAssessment', 'ManageUsers'] },
  ],
}));
jest.mock('@aws-sdk/client-verifiedpermissions', () => ({
  VerifiedPermissionsClient: class { send() { return Promise.resolve({}); } },
  IsAuthorizedCommand: class {}, ListPoliciesCommand: class {}, GetPolicyCommand: class {},
  CreatePolicyCommand: class {}, UpdatePolicyCommand: class {}, DeletePolicyCommand: class {},
  GetSchemaCommand: class {}, PutSchemaCommand: class {},
}));
jest.mock('../../providers/identity.js', () => ({
  listTenants: jest.fn(async () => [{ id: 'orgiq' }, { id: 'assessment' }]),
  listUsers: jest.fn(async () => [
    { id: 'u-asha', displayName: 'Asha', email: null, personId: null, epoch: 0, grants: { assessment: ['assessor'] } },
    { id: 'u-nora', displayName: 'Nora', email: null, personId: null, epoch: 0, grants: { orgiq: ['sme'] } },
    { id: 'u-operator', displayName: 'Op', email: null, personId: null, epoch: 0, grants: { orgiq: ['admin'], assessment: ['admin'] } },
  ]),
  getUser: jest.fn(async () => null), createUser: jest.fn(), setGrants: jest.fn(), setPerson: jest.fn(), createTenant: jest.fn(),
}));
jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn() }));

import express from 'express';
import request from '../../test-support/http.js';
import { identityRouter } from '../identity.js';
import { errorHandler } from '../../lib/async-handler.js';
import type { Session } from '../../lib/session.js';

function appAs(session: Partial<Session>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { sub: 'u-test', iat: 0, grants: {}, ...session } as Session; next(); });
  app.use('/api/identity', identityRouter);
  app.use(errorHandler);
  return app;
}

describe('identity router gates by capability, not by one router-wide action', () => {
  it('program-lead (ManageUsers) reaches the user routes, scoped to its tenant', async () => {
    const app = appAs({ role: 'program-lead', tenant: 'assessment', sub: 'u-farah' });
    const users = await request(app).get('/api/identity/users');
    expect(users.status).toBe(200);
    expect(users.body.map((u: { id: string }) => u.id).sort()).toEqual(['u-asha', 'u-operator']);
    // Only the assessment grants are shown, never the org's.
    expect(users.body.find((u: { id: string }) => u.id === 'u-operator').grants).toEqual({ assessment: ['admin'] });
    const tenants = await request(app).get('/api/identity/tenants');
    expect(tenants.body).toEqual([{ id: 'assessment' }]);
    expect((await request(app).get('/api/identity/roles')).status).toBe(200);
  });

  it('program-lead is still refused the policy and schema surface', async () => {
    const app = appAs({ role: 'program-lead', tenant: 'assessment', sub: 'u-farah' });
    expect((await request(app).get('/api/identity/policies')).status).toBe(403);
    expect((await request(app).get('/api/identity/schema')).status).toBe(403);
  });

  it('an sme is refused everywhere; hr-admin sees the whole roster', async () => {
    expect((await request(appAs({ role: 'sme', tenant: 'orgiq', sub: 'u-nora' })).get('/api/identity/users')).status).toBe(403);
    const hr = await request(appAs({ role: 'hr-admin', tenant: 'orgiq', sub: 'u-hr' })).get('/api/identity/users');
    expect(hr.status).toBe(200);
    expect(hr.body).toHaveLength(3);
  });
});

// PUT /api/identity/users/:id/grants (routes/identity.ts) — code-review
// finding: ManageUsers is granted to program-lead scoped "within the
// assessment tenant" (seeds/roles/assessment/program-lead.cedar), but the
// route accepted grants for ANY tenant key in the body and setGrants()
// rewrites user_tenant_roles wholesale — so a program-lead session (or any
// non-admin ManageUsers holder) could grant itself orgiq hr-admin or orgiq
// admin, and in the process wipe out the target user's grants in
// every tenant not named in the body. Pinned here: a non-admin caller's
// body may name only their own session tenant (else 403 naming the
// offending tenant), and a successful scoped write merges onto — never
// replaces — the user's grants in other tenants.
//
// config.ts and role-registry.ts both read import.meta at module scope, so
// both are mocked — same pattern as identity.test.ts — purely so the CJS
// test build can load routes/identity.ts.

jest.mock('../../config.js', () => ({
  config: {
    region: 'us-east-1',
    auth: { policyStoreId: 'ps-test' },
    aurora: {
      clusterArn: 'arn:aws:rds:us-east-1:1:cluster:test',
      secretArn: 'arn:aws:secretsmanager:us-east-1:1:secret:test',
      database: 'orgiq',
    },
  },
}));

// requireAction is the Cedar gate (ManageUsers) — the bug this test targets
// is a body-scoping bug that AVP cannot see, so the mock always allows and
// the route's own tenant check is what's under test.
jest.mock('../../lib/authz.js', () => ({
  requireAction: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireAnyAction: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  clearAuthzCache: jest.fn(),
}));

jest.mock('../../lib/role-registry.js', () => ({
  roleRegistry: jest.fn(() => [
    { id: 'admin', tenant: null },
    { id: 'hr-admin', tenant: 'orgiq' },
    { id: 'member', tenant: 'orgiq' },
    { id: 'admin', tenant: 'assessment' }, // tenant-scoped alias some registries expose
    { id: 'program-lead', tenant: 'assessment' },
    { id: 'lead-assessor', tenant: 'assessment' },
  ]),
}));

jest.mock('@aws-sdk/client-verifiedpermissions', () => ({
  VerifiedPermissionsClient: class { send() { return Promise.resolve({}); } },
  ListPoliciesCommand: class {},
  GetPolicyCommand: class {},
  CreatePolicyCommand: class {},
  UpdatePolicyCommand: class {},
  DeletePolicyCommand: class {},
  GetSchemaCommand: class {},
  PutSchemaCommand: class {},
  IsAuthorizedCommand: class {},
}));

jest.mock('../../providers/identity.js', () => ({
  listTenants: jest.fn(async () => []),
  listUsers: jest.fn(async () => []),
  getUser: jest.fn(),
  createTenant: jest.fn(),
  createUser: jest.fn(),
  setGrants: jest.fn(),
}));

jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn() }));

import express, { type Request, type Response, type NextFunction } from 'express';
import request from '../../test-support/http.js';
import { identityRouter } from '../identity.js';
import { errorHandler } from '../../lib/async-handler.js';
import { getUser, setGrants } from '../../providers/identity.js';

const getUserMock = getUser as unknown as jest.Mock;
const setGrantsMock = setGrants as unknown as jest.Mock;

const FARAH = {
  id: 'u-farah', displayName: 'Farah Osei', email: 'farah.osei@assessment.example',
  personId: null, grants: { assessment: ['program-lead', 'lead-assessor'] },
};

// Another program-lead editing Farah: nobody edits their own grants
// (lib/grant-rule.ts; identity-grant-rule.test.ts pins that refusal).
const programLead = { sub: 'u-jonas', role: 'program-lead', tenant: 'assessment' };
const admin = { sub: 'u-operator', role: 'admin', tenant: 'assessment' };

function buildApp(session: Record<string, unknown> | null) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (session) (req as unknown as { session: unknown }).session = session;
    next();
  });
  app.use('/api/identity', identityRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  getUserMock.mockReset();
  setGrantsMock.mockReset();
});

describe('PUT /api/identity/users/:id/grants — tenant scoping', () => {
  it('403s a non-admin body that names another tenant', async () => {
    getUserMock.mockResolvedValueOnce(FARAH);
    const res = await request(buildApp(programLead))
      .put('/api/identity/users/u-farah/grants')
      .send({ grants: { orgiq: ['hr-admin'] } });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/orgiq/);
    expect(setGrantsMock).not.toHaveBeenCalled();
  });

  it('403s even when the offending tenant is mixed in with the caller\'s own', async () => {
    getUserMock.mockResolvedValueOnce(FARAH);
    const res = await request(buildApp(programLead))
      .put('/api/identity/users/u-farah/grants')
      .send({ grants: { assessment: ['lead-assessor'], orgiq: ['admin'] } });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/orgiq/);
    expect(setGrantsMock).not.toHaveBeenCalled();
  });

  it('200s a body scoped to the caller\'s own tenant, merging onto (not replacing) other tenants', async () => {
    getUserMock
      .mockResolvedValueOnce(FARAH) // pre-write lookup to merge against
      .mockResolvedValueOnce({ ...FARAH, grants: { assessment: ['lead-assessor'] } }); // post-write re-fetch
    const res = await request(buildApp(programLead))
      .put('/api/identity/users/u-farah/grants')
      .send({ grants: { assessment: ['lead-assessor'] } });
    expect(res.status).toBe(200);
    expect(setGrantsMock).toHaveBeenCalledWith('u-farah', { assessment: ['lead-assessor'] }, {});
  });

  it('merges a scoped write onto a target user\'s grants in other tenants rather than wiping them', async () => {
    const multiTenantUser = { ...FARAH, grants: { assessment: ['program-lead'], orgiq: ['member'] } };
    getUserMock
      .mockResolvedValueOnce(multiTenantUser)
      .mockResolvedValueOnce({ ...multiTenantUser, grants: { assessment: ['lead-assessor'], orgiq: ['member'] } });
    const res = await request(buildApp(programLead))
      .put('/api/identity/users/u-farah/grants')
      .send({ grants: { assessment: ['lead-assessor'] } });
    expect(res.status).toBe(200);
    // the orgiq row the caller never named must survive the write untouched
    expect(setGrantsMock).toHaveBeenCalledWith('u-farah', { assessment: ['lead-assessor'], orgiq: ['member'] }, {});
  });

  it('lets admin write any tenant key with no scoping restriction', async () => {
    getUserMock.mockResolvedValueOnce(FARAH).mockResolvedValueOnce({ ...FARAH, grants: { orgiq: ['hr-admin'] } });
    const res = await request(buildApp(admin))
      .put('/api/identity/users/u-farah/grants')
      .send({ grants: { orgiq: ['hr-admin'] } });
    expect(res.status).toBe(200);
    expect(setGrantsMock).toHaveBeenCalledWith('u-farah', { orgiq: ['hr-admin'] }, {});
  });
});

describe('PUT /api/identity/users/:id/grants — the editor\'s base (2026-10-14)', () => {
  it('passes the loaded matrix through as the diff base, so a role granted since is not erased', async () => {
    getUserMock.mockResolvedValueOnce(FARAH).mockResolvedValueOnce(FARAH);
    const res = await request(buildApp(admin))
      .put('/api/identity/users/u-farah/grants')
      .send({ grants: { assessment: ['lead-assessor'] }, base: { assessment: ['program-lead', 'lead-assessor'] } });
    expect(res.status).toBe(200);
    expect(setGrantsMock).toHaveBeenCalledWith('u-farah', { assessment: ['lead-assessor'] }, { base: { assessment: ['program-lead', 'lead-assessor'] } });
  });

  it('scopes a non-admin base like its grants: another tenant in base is a 403, its own is merged over current', async () => {
    const multiTenantUser = { ...FARAH, grants: { assessment: ['program-lead'], orgiq: ['member'] } };
    getUserMock.mockResolvedValue(multiTenantUser);
    const refused = await request(buildApp(programLead))
      .put('/api/identity/users/u-farah/grants')
      .send({ grants: { assessment: ['lead-assessor'] }, base: { orgiq: ['member'] } });
    expect(refused.status).toBe(403);
    expect(setGrantsMock).not.toHaveBeenCalled();
    const ok = await request(buildApp(programLead))
      .put('/api/identity/users/u-farah/grants')
      .send({ grants: { assessment: ['lead-assessor'] }, base: { assessment: ['program-lead'] } });
    expect(ok.status).toBe(200);
    expect(setGrantsMock).toHaveBeenCalledWith('u-farah',
      { assessment: ['lead-assessor'], orgiq: ['member'] },
      { base: { assessment: ['program-lead'], orgiq: ['member'] } });
    getUserMock.mockReset();
  });

  it('400s a malformed base', async () => {
    getUserMock.mockResolvedValueOnce(FARAH);
    const res = await request(buildApp(admin))
      .put('/api/identity/users/u-farah/grants')
      .send({ grants: { orgiq: ['hr-admin'] }, base: ['orgiq'] });
    expect(res.status).toBe(400);
    expect(setGrantsMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/identity/users — tenant scoping on initial grants', () => {
  it('403s a non-admin creator granting another tenant at creation time', async () => {
    const res = await request(buildApp(programLead))
      .post('/api/identity/users')
      .send({ id: 'u-new', displayName: 'New User', grants: { orgiq: ['member'] } });
    expect(res.status).toBe(403);
    expect(setGrantsMock).not.toHaveBeenCalled();
  });
});

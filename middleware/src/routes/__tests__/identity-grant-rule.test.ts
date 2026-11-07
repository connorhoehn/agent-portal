// One grant rule (docs/next-steps.md section 8, package 5; section 7 "Fix
// first" item 3). A tenant-scoped ManageUsers holder (program-lead in
// assessment) could put `admin` in a grants body, because the role check
// accepted the cross-tenant `*/admin` for any tenant key and the scope check
// only rejected other tenants. They could also edit their own grants, and
// POST /users was an upsert that overwrote an existing user's name, email and
// grants. Pinned here: `admin` is assignable only by an admin session, nobody
// edits their own grants, and POST for an existing id is a 409.

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

jest.mock('../../lib/authz.js', () => ({
  requireAction: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireAnyAction: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  clearAuthzCache: jest.fn(),
}));

jest.mock('../../lib/role-registry.js', () => ({
  roleRegistry: jest.fn(() => [
    { id: 'admin', tenant: null },
    { id: 'program-lead', tenant: 'assessment' },
    { id: 'lead-assessor', tenant: 'assessment' },
    { id: 'assessor', tenant: 'assessment' },
  ]),
}));

jest.mock('@aws-sdk/client-verifiedpermissions', () => ({
  VerifiedPermissionsClient: class { send() { return Promise.resolve({}); } },
  GetPolicyCommand: class {}, CreatePolicyCommand: class {}, UpdatePolicyCommand: class {},
  DeletePolicyCommand: class {}, GetSchemaCommand: class {}, PutSchemaCommand: class {},
  IsAuthorizedCommand: class {},
}));

jest.mock('../../providers/identity.js', () => ({
  listTenants: jest.fn(async () => []),
  listUsers: jest.fn(async () => []),
  getUser: jest.fn(),
  createTenant: jest.fn(),
  createUser: jest.fn(async () => true),
  setGrants: jest.fn(),
}));

jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn() }));

import express, { type Request, type Response, type NextFunction } from 'express';
import request from '../../test-support/http.js';
import { identityRouter } from '../identity.js';
import { errorHandler } from '../../lib/async-handler.js';
import { createUser, getUser, setGrants } from '../../providers/identity.js';

const getUserMock = getUser as unknown as jest.Mock;
const setGrantsMock = setGrants as unknown as jest.Mock;
const createUserMock = createUser as unknown as jest.Mock;

const FARAH = { id: 'u-farah', displayName: 'Farah Osei', email: 'farah@assessment.example', personId: null,
  grants: { assessment: ['program-lead'] } };
const ASHA = { id: 'u-asha', displayName: 'Asha Nair', email: 'asha@assessment.example', personId: null,
  grants: { assessment: ['assessor'] } };

const programLead = { sub: 'u-farah', role: 'program-lead', tenant: 'assessment' };
const admin = { sub: 'u-operator', role: 'admin', tenant: 'assessment' };

function buildApp(session: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { session: unknown }).session = session;
    next();
  });
  app.use('/api/identity', identityRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  getUserMock.mockReset();
  setGrantsMock.mockReset();
  createUserMock.mockReset();
  createUserMock.mockResolvedValue(true);
});

describe('PUT /api/identity/users/:id/grants — one grant rule', () => {
  it('403s a program-lead adding admin in their own tenant', async () => {
    getUserMock.mockResolvedValue(ASHA);
    const res = await request(buildApp(programLead))
      .put('/api/identity/users/u-asha/grants')
      .send({ grants: { assessment: ['assessor', 'admin'] } });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/admin/);
    expect(setGrantsMock).not.toHaveBeenCalled();
  });

  it('403s a program-lead editing their own grants', async () => {
    getUserMock.mockResolvedValue(FARAH);
    const res = await request(buildApp(programLead))
      .put('/api/identity/users/u-farah/grants')
      .send({ grants: { assessment: ['program-lead', 'lead-assessor'] } });
    expect(res.status).toBe(403);
    expect(setGrantsMock).not.toHaveBeenCalled();
  });

  it('403s an admin editing their own grants too', async () => {
    getUserMock.mockResolvedValue({ ...ASHA, id: 'u-operator', grants: { assessment: ['admin'] } });
    const res = await request(buildApp(admin))
      .put('/api/identity/users/u-operator/grants')
      .send({ grants: { assessment: [] } });
    expect(res.status).toBe(403);
    expect(setGrantsMock).not.toHaveBeenCalled();
  });

  it('lets an admin grant admin to someone else', async () => {
    getUserMock.mockResolvedValue(ASHA);
    const res = await request(buildApp(admin))
      .put('/api/identity/users/u-asha/grants')
      .send({ grants: { assessment: ['assessor', 'admin'] } });
    expect(res.status).toBe(200);
    expect(setGrantsMock).toHaveBeenCalled();
  });

  it('still lets a program-lead change a non-admin role on someone else', async () => {
    getUserMock.mockResolvedValue(ASHA);
    const res = await request(buildApp(programLead))
      .put('/api/identity/users/u-asha/grants')
      .send({ grants: { assessment: ['lead-assessor'] } });
    expect(res.status).toBe(200);
    expect(setGrantsMock).toHaveBeenCalledWith('u-asha', { assessment: ['lead-assessor'] }, {});
  });

  it('403s a program-lead removing admin from someone who holds it', async () => {
    getUserMock.mockResolvedValue({ ...ASHA, grants: { assessment: ['assessor', 'admin'] } });
    const res = await request(buildApp(programLead))
      .put('/api/identity/users/u-asha/grants')
      .send({ grants: { assessment: ['assessor'] } });
    expect(res.status).toBe(403);
    expect(setGrantsMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/identity/users — create, never upsert', () => {
  it('409s for an id that already exists and writes nothing', async () => {
    getUserMock.mockResolvedValue(ASHA);
    const res = await request(buildApp(admin))
      .post('/api/identity/users')
      .send({ id: 'u-asha', displayName: 'Someone Else', email: 'attacker@evil.example' });
    expect(res.status).toBe(409);
    expect(createUserMock).not.toHaveBeenCalled();
    expect(setGrantsMock).not.toHaveBeenCalled();
  });

  it('409s when the insert itself finds the row (a create that raced)', async () => {
    getUserMock.mockResolvedValueOnce(null);
    createUserMock.mockResolvedValueOnce(false);
    const res = await request(buildApp(admin))
      .post('/api/identity/users')
      .send({ id: 'u-new', displayName: 'New Person', grants: { assessment: ['assessor'] } });
    expect(res.status).toBe(409);
    expect(setGrantsMock).not.toHaveBeenCalled();
  });

  it('403s a program-lead creating a user with admin', async () => {
    getUserMock.mockResolvedValue(null);
    const res = await request(buildApp(programLead))
      .post('/api/identity/users')
      .send({ id: 'u-new', displayName: 'New Person', grants: { assessment: ['admin'] } });
    expect(res.status).toBe(403);
    expect(createUserMock).not.toHaveBeenCalled();
  });

  it('201s a new id with an allowed grant', async () => {
    getUserMock.mockResolvedValueOnce(null).mockResolvedValueOnce({ ...ASHA, id: 'u-new' });
    const res = await request(buildApp(programLead))
      .post('/api/identity/users')
      .send({ id: 'u-new', displayName: 'New Person', grants: { assessment: ['assessor'] } });
    expect(res.status).toBe(201);
    expect(createUserMock).toHaveBeenCalled();
    expect(setGrantsMock).toHaveBeenCalledWith('u-new', { assessment: ['assessor'] });
  });
});

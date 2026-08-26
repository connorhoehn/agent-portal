// PUT /api/identity/users/:id/person (routes/identity.ts) — audit finding m6:
// the create form (POST /users) only ever sets person_id at creation, so an
// operator whose account was provisioned without one — or who needs to
// relink it — had no route to reach. This route fills that gap. Pinned here:
// link succeeds, clearing with personId: null succeeds and skips the
// existence check, an unknown user or unknown person 404s, a malformed body
// 400s before any write, and the route is gated on ManageUsers.
//
// config.ts and role-registry.ts both read import.meta at module scope (and
// role-registry.ts stats the seeds directory on load), so both are mocked
// here — same pattern as auth-session.test.ts / session-capabilities.test.ts
// — purely so the CJS test build can load routes/identity.ts.

const manageAllow = { value: true };

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
  requireAction: (action: string) =>
    (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) => {
      if (!manageAllow.value) { res.status(403).json({ error: 'Forbidden', action }); return; }
      next();
    },
  clearAuthzCache: jest.fn(),
}));

jest.mock('../../lib/role-registry.js', () => ({ roleRegistry: jest.fn(() => []) }));

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
import request from 'supertest';
import { identityRouter } from '../identity.js';
import { errorHandler } from '../../lib/async-handler.js';
import { getUser } from '../../providers/identity.js';
import { exec } from '../../providers/aurora.js';

const getUserMock = getUser as unknown as jest.Mock;
const execMock = exec as unknown as jest.Mock;

const USER = {
  id: 'u-theo', displayName: 'Theo Chang', email: 'theo.chang@orgiq.example',
  personId: null, grants: { orgiq: ['member'] },
};
const LINKED = { ...USER, personId: 'p-001' };

const hrAdmin = { sub: 'u-hr', role: 'hr-admin', tenant: 'orgiq' };

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
  manageAllow.value = true;
  getUserMock.mockReset();
  execMock.mockReset();
});

describe('PUT /api/identity/users/:id/person', () => {
  it('links a person to an already-provisioned user', async () => {
    getUserMock.mockResolvedValueOnce(USER).mockResolvedValueOnce(LINKED);
    execMock
      .mockResolvedValueOnce([{ id: 'p-001' }]) // people existence check
      .mockResolvedValueOnce([]); // the UPDATE
    const res = await request(buildApp(hrAdmin))
      .put('/api/identity/users/u-theo/person').send({ personId: 'p-001' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(LINKED);
    expect(execMock).toHaveBeenNthCalledWith(
      1,
      expect.stringMatching(/SELECT id FROM people/),
      [{ name: 'id', value: { stringValue: 'p-001' } }],
    );
    expect(execMock).toHaveBeenNthCalledWith(
      2,
      expect.stringMatching(/UPDATE app_users SET person_id = :person WHERE id = :id/),
      [
        { name: 'id', value: { stringValue: 'u-theo' } },
        { name: 'person', value: { stringValue: 'p-001' } },
      ],
    );
  });

  it('clears a link with personId: null, skipping the existence check', async () => {
    getUserMock.mockResolvedValueOnce(LINKED).mockResolvedValueOnce(USER);
    execMock.mockResolvedValueOnce([]); // the UPDATE only
    const res = await request(buildApp(hrAdmin))
      .put('/api/identity/users/u-theo/person').send({ personId: null });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(USER);
    expect(execMock).toHaveBeenCalledTimes(1);
    expect(execMock).toHaveBeenCalledWith(
      expect.stringMatching(/UPDATE app_users SET person_id = NULL WHERE id = :id/),
      [{ name: 'id', value: { stringValue: 'u-theo' } }],
    );
  });

  it('404s an unknown user before touching Aurora', async () => {
    getUserMock.mockResolvedValueOnce(null);
    const res = await request(buildApp(hrAdmin))
      .put('/api/identity/users/u-ghost/person').send({ personId: 'p-001' });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/u-ghost/);
    expect(execMock).not.toHaveBeenCalled();
  });

  it('404s an unknown personId and does not write', async () => {
    getUserMock.mockResolvedValueOnce(USER);
    execMock.mockResolvedValueOnce([]); // people lookup: no match
    const res = await request(buildApp(hrAdmin))
      .put('/api/identity/users/u-theo/person').send({ personId: 'p-ghost' });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/p-ghost/);
    expect(execMock).toHaveBeenCalledTimes(1); // the existence check only, no UPDATE
  });

  it('400s a missing personId key', async () => {
    const res = await request(buildApp(hrAdmin))
      .put('/api/identity/users/u-theo/person').send({});
    expect(res.status).toBe(400);
    expect(getUserMock).not.toHaveBeenCalled();
  });

  it('400s a non-string, non-null personId', async () => {
    const res = await request(buildApp(hrAdmin))
      .put('/api/identity/users/u-theo/person').send({ personId: 42 });
    expect(res.status).toBe(400);
    expect(getUserMock).not.toHaveBeenCalled();
  });

  it('400s a blank personId', async () => {
    const res = await request(buildApp(hrAdmin))
      .put('/api/identity/users/u-theo/person').send({ personId: '   ' });
    expect(res.status).toBe(400);
    expect(getUserMock).not.toHaveBeenCalled();
  });

  it('is gated on ManageUsers', async () => {
    manageAllow.value = false;
    const res = await request(buildApp({ sub: 'u-nora', role: 'sme', tenant: 'orgiq' }))
      .put('/api/identity/users/u-theo/person').send({ personId: 'p-001' });
    expect(res.status).toBe(403);
    expect(getUserMock).not.toHaveBeenCalled();
    expect(execMock).not.toHaveBeenCalled();
  });
});

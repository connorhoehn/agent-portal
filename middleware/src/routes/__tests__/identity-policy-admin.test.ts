// Identity admin — the Cedar policy CRUD, the policy simulator, the schema
// write and tenant creation (routes/identity.ts). The six routes the
// person-link, grants-scope and program-lead suites do not reach.
//
// What is pinned:
//   * the AUTHZ CACHE INVALIDATION that makes an edit real. Every mutation
//     here changes what AVP will decide, and `middleware/src/lib/authz.ts`
//     caches decisions keyed `tenant|role|action` — a create/update/delete
//     that forgot `clearAuthzCache()` would leave the fleet enforcing the
//     policy the operator just replaced, with nothing on screen to say so.
//     Every one of the four writes is checked for it,
//   * the two-layer gate: policies and schema are hr-admin's alone
//     (ViewIdentityAdmin) AND carry EditPolicy / EditSchema on top, while the
//     tenant/user routes take either capability so a tenant-scoped
//     program-lead is not locked out of the routes built for it,
//   * the 503 when POLICY_STORE_ID is unset — this whole surface is
//     unavailable rather than silently empty, which is what open-mode authz
//     looks like from the outside,
//   * that an AVP rejection is relayed as a 400 with the detail (a Cedar
//     syntax error is the operator's mistake, not a server fault),
//   * the tenant id shape, enforced before anything is created.

const readAllow = { value: true };
const adminAllow = { value: true };
const storeId = { value: 'ps-test' as string };
const gateActions: string[] = [];

jest.mock('../../config.js', () => ({
  config: {
    region: 'us-east-1',
    get auth() { return { policyStoreId: storeId.value }; },
    aurora: { clusterArn: 'arn:cluster', secretArn: 'arn:secret', database: 'orgiq' },
  },
}));

jest.mock('../../lib/authz.js', () => ({
  requireAction: (action: string) => {
    gateActions.push(action);
    return (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) => {
      if (!adminAllow.value) { res.status(403).json({ error: 'Forbidden', action }); return; }
      next();
    };
  },
  requireAnyAction: (actions: string[]) =>
    (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) => {
      if (!readAllow.value) { res.status(403).json({ error: 'Forbidden', action: actions.join('|') }); return; }
      next();
    },
  clearAuthzCache: jest.fn(),
}));
jest.mock('../../lib/audit.js', () => ({ logAuthz: jest.fn() }));
jest.mock('../../lib/role-registry.js', () => ({ roleRegistry: jest.fn(() => []) }));
jest.mock('../../providers/identity.js', () => ({
  listTenants: jest.fn(), listUsers: jest.fn(), getUser: jest.fn(),
  createTenant: jest.fn(), createUser: jest.fn(), setGrants: jest.fn(),
}));
jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn() }));

const avpSend = jest.fn();
jest.mock('@aws-sdk/client-verifiedpermissions', () => {
  class Cmd { constructor(public readonly input: unknown) {} }
  return {
    VerifiedPermissionsClient: class { send(cmd: unknown) { return avpSend(cmd); } },
    ListPoliciesCommand: class extends Cmd {},
    GetPolicyCommand: class extends Cmd {},
    CreatePolicyCommand: class extends Cmd {},
    UpdatePolicyCommand: class extends Cmd {},
    DeletePolicyCommand: class extends Cmd {},
    GetSchemaCommand: class extends Cmd {},
    PutSchemaCommand: class extends Cmd {},
    IsAuthorizedCommand: class extends Cmd {},
  };
});

import express, { type Request, type Response, type NextFunction } from 'express';
import request from '../../test-support/http.js';
import { identityRouter } from '../identity.js';
import { errorHandler } from '../../lib/async-handler.js';
import { clearAuthzCache } from '../../lib/authz.js';
import { createTenant } from '../../providers/identity.js';
import { logAuthz } from '../../lib/audit.js';

const m = <T,>(fn: T): jest.Mock => fn as unknown as jest.Mock;

const SESSION = { sub: 'u-hr', role: 'hr-admin', tenant: 'orgiq' };

function buildApp(session: Record<string, unknown> = SESSION) {
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
  jest.clearAllMocks();
  readAllow.value = true;
  adminAllow.value = true;
  storeId.value = 'ps-test';
});

describe('the gate matrix', () => {
  it('carries EditPolicy on the three policy writes and EditSchema on the schema write', () => {
    // Constructed at module load; the reads take requireAnyAction instead, so
    // they never appear here.
    expect(gateActions.filter((a) => a === 'EditPolicy')).toHaveLength(3);
    expect(gateActions.filter((a) => a === 'EditSchema')).toHaveLength(1);
    // Policies + schema are additionally hr-admin-only.
    expect(gateActions).toContain('ViewIdentityAdmin');
    // Tenant + user admin is ManageUsers, which program-lead holds scoped.
    expect(gateActions).toContain('ManageUsers');
  });
});

describe('POST /tenants', () => {
  it('enforces the id shape before creating anything', async () => {
    const app = buildApp();
    for (const id of [undefined, '', 'A', 'Has-Caps', '1starts-with-digit', 'x', 'a'.repeat(40), 'has space']) {
      const res = await request(app).post('/api/identity/tenants').send({ id });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/lowercase kebab-case/);
    }
    expect(createTenant).not.toHaveBeenCalled();
  });

  it('creates with 201, defaulting the display name to the id', async () => {
    m(createTenant).mockResolvedValue({ id: 'newco', displayName: 'newco' });
    const res = await request(buildApp()).post('/api/identity/tenants').send({ id: 'newco' });
    expect(res.status).toBe(201);
    expect(createTenant).toHaveBeenCalledWith('newco', 'newco');

    await request(buildApp()).post('/api/identity/tenants')
      .send({ id: 'newco', displayName: 'New Co' });
    expect(m(createTenant).mock.calls[1]).toEqual(['newco', 'New Co']);
  });

  it('403s a caller without ManageUsers', async () => {
    adminAllow.value = false;
    const res = await request(buildApp()).post('/api/identity/tenants').send({ id: 'newco' });
    expect(res.status).toBe(403);
    expect(createTenant).not.toHaveBeenCalled();
  });
});

describe('POST /policies/test — the simulator', () => {
  it('400s without a role and an action', async () => {
    const app = buildApp();
    for (const body of [{}, { role: 'sme' }, { action: 'ViewWork' }]) {
      const res = await request(app).post('/api/identity/policies/test').send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/role and action are required/);
    }
    expect(avpSend).not.toHaveBeenCalled();
  });

  it('asks AVP with the role as BOTH principal and its role attribute, defaulting the tenant', async () => {
    avpSend.mockResolvedValue({
      decision: 'ALLOW',
      determiningPolicies: [{ policyId: 'pol-1' }],
      errors: [],
    });
    const res = await request(buildApp()).post('/api/identity/policies/test')
      .send({ role: 'sme', action: 'DispatchAgentRun' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      decision: 'ALLOW', determiningPolicies: [{ policyId: 'pol-1' }], errors: [],
    });
    const input = (avpSend.mock.calls[0]![0] as { input: Record<string, unknown> }).input;
    expect(input['principal']).toEqual({ entityType: 'OrgIQ::User', entityId: 'sme' });
    expect(input['action']).toEqual({ actionType: 'OrgIQ::Action', actionId: 'DispatchAgentRun' });
    // Cedar policies condition on principal.tenant, so the simulation is
    // meaningless without one — it defaults to orgiq rather than omitting it.
    const entity = (input['entities'] as { entityList: Array<{ attributes: Record<string, unknown> }> })
      .entityList[0]!;
    expect(entity.attributes).toEqual({ role: { string: 'sme' }, tenant: { string: 'orgiq' } });
  });

  it('honours an explicit tenant so a cross-tenant policy can be simulated', async () => {
    avpSend.mockResolvedValue({ decision: 'DENY' });
    const res = await request(buildApp()).post('/api/identity/policies/test')
      .send({ role: 'assessor', action: 'ViewWork', tenant: 'assessment', resourceId: 'app' });
    expect(res.body.decision).toBe('DENY');
    // Missing arrays come back empty rather than undefined, so the page can map.
    expect(res.body.determiningPolicies).toEqual([]);
    expect(res.body.errors).toEqual([]);
    const input = (avpSend.mock.calls[0]![0] as { input: { entities: { entityList: Array<{ attributes: Record<string, unknown> }> } } }).input;
    expect(input.entities.entityList[0]!.attributes['tenant']).toEqual({ string: 'assessment' });
  });

  it('503s when no policy store is configured — unavailable, not silently empty', async () => {
    storeId.value = '';
    const res = await request(buildApp()).post('/api/identity/policies/test')
      .send({ role: 'sme', action: 'ViewWork' });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/POLICY_STORE_ID not configured/);
    expect(avpSend).not.toHaveBeenCalled();
  });

  it('relays an AVP error as a 400 — a bad simulation is the caller\'s input', async () => {
    avpSend.mockRejectedValue(new Error('ValidationException: unknown action'));
    const res = await request(buildApp()).post('/api/identity/policies/test')
      .send({ role: 'sme', action: 'NoSuchAction' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unknown action/);
  });
});

describe('POST /policies', () => {
  it('requires the Cedar source', async () => {
    const res = await request(buildApp()).post('/api/identity/policies').send({ description: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/statement \(Cedar source\) is required/);
    expect(avpSend).not.toHaveBeenCalled();
  });

  it('creates and CLEARS THE AUTHZ CACHE, or the fleet keeps enforcing the old policy', async () => {
    avpSend.mockResolvedValue({ policyId: 'pol-9' });
    const res = await request(buildApp()).post('/api/identity/policies')
      .send({ statement: 'permit(principal, action, resource);', description: 'wide open' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ policyId: 'pol-9' });
    expect(clearAuthzCache).toHaveBeenCalled();
    const input = (avpSend.mock.calls[0]![0] as { input: { definition: { static: Record<string, string> } } }).input;
    expect(input.definition.static).toEqual({
      description: 'wide open', statement: 'permit(principal, action, resource);',
    });
    // The edit is audited under its own action name, with the real identity.
    expect(m(logAuthz).mock.calls[0]![0]).toMatchObject({
      decision: 'ALLOW', action: 'EditPolicy.Create', sub: 'u-hr', role: 'hr-admin',
    });
  });

  it('relays a Cedar syntax rejection as a 400 with the detail, and clears nothing', async () => {
    avpSend.mockRejectedValue(new Error('Syntax error at line 1'));
    const res = await request(buildApp()).post('/api/identity/policies')
      .send({ statement: 'permit(' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('AVP rejected policy');
    expect(res.body.detail).toMatch(/Syntax error/);
    expect(clearAuthzCache).not.toHaveBeenCalled();
  });

  it('503s with no policy store, before reaching AVP', async () => {
    storeId.value = '';
    const res = await request(buildApp()).post('/api/identity/policies').send({ statement: 'permit();' });
    expect(res.status).toBe(503);
    expect(avpSend).not.toHaveBeenCalled();
  });
});

describe('PUT /policies/:id', () => {
  it('requires a statement and 503s with no store', async () => {
    const noStatement = await request(buildApp()).put('/api/identity/policies/pol-1').send({});
    expect(noStatement.status).toBe(400);

    storeId.value = '';
    const noStore = await request(buildApp()).put('/api/identity/policies/pol-1')
      .send({ statement: 'permit();' });
    expect(noStore.status).toBe(503);
    expect(avpSend).not.toHaveBeenCalled();
  });

  it('updates the NAMED policy and clears the cache', async () => {
    avpSend.mockResolvedValue({});
    const res = await request(buildApp()).put('/api/identity/policies/pol-1')
      .send({ statement: 'forbid(principal, action, resource);' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ policyId: 'pol-1' });
    const input = (avpSend.mock.calls[0]![0] as { input: Record<string, unknown> }).input;
    expect(input['policyId']).toBe('pol-1');
    expect(clearAuthzCache).toHaveBeenCalled();
    expect(m(logAuthz).mock.calls[0]![0]).toMatchObject({ action: 'EditPolicy.Update' });
  });

  it('relays an AVP rejection as a 400 and leaves the cache alone', async () => {
    avpSend.mockRejectedValue(new Error('Policy is not static'));
    const res = await request(buildApp()).put('/api/identity/policies/pol-1')
      .send({ statement: 'permit();' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('AVP rejected policy');
    expect(clearAuthzCache).not.toHaveBeenCalled();
  });
});

describe('DELETE /policies/:id', () => {
  it('deletes the named policy, clears the cache, and audits it', async () => {
    avpSend.mockResolvedValue({});
    const res = await request(buildApp()).delete('/api/identity/policies/pol-1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ policyId: 'pol-1', deleted: true });
    expect((avpSend.mock.calls[0]![0] as { input: { policyId: string } }).input.policyId).toBe('pol-1');
    expect(clearAuthzCache).toHaveBeenCalled();
    expect(m(logAuthz).mock.calls[0]![0]).toMatchObject({ action: 'EditPolicy.Delete' });
  });

  it('503s with no policy store', async () => {
    storeId.value = '';
    expect((await request(buildApp()).delete('/api/identity/policies/pol-1')).status).toBe(503);
    expect(avpSend).not.toHaveBeenCalled();
  });
});

describe('PUT /schema', () => {
  it('accepts an object and serialises it, and passes a string through untouched', async () => {
    avpSend.mockResolvedValue({});
    const app = buildApp();
    await request(app).put('/api/identity/schema').send({ schema: { OrgIQ: { entityTypes: {} } } });
    await request(app).put('/api/identity/schema').send({ schema: '{"OrgIQ":{}}' });
    const cedar = avpSend.mock.calls
      .map((c) => (c[0] as { input: { definition: { cedarJson: string } } }).input.definition.cedarJson);
    expect(cedar[0]).toBe('{"OrgIQ":{"entityTypes":{}}}');
    expect(cedar[1]).toBe('{"OrgIQ":{}}');
  });

  it('clears the authz cache — a schema change re-types every decision', async () => {
    avpSend.mockResolvedValue({});
    const res = await request(buildApp()).put('/api/identity/schema').send({ schema: {} });
    expect(res.body).toEqual({ ok: true });
    expect(clearAuthzCache).toHaveBeenCalled();
    expect(m(logAuthz).mock.calls[0]![0]).toMatchObject({ action: 'EditSchema.Put' });
  });

  it('relays an AVP schema rejection as a 400 with the detail', async () => {
    avpSend.mockRejectedValue(new Error('schema does not define OrgIQ::User'));
    const res = await request(buildApp()).put('/api/identity/schema').send({ schema: {} });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('AVP rejected schema');
    expect(res.body.detail).toMatch(/OrgIQ::User/);
    expect(clearAuthzCache).not.toHaveBeenCalled();
  });

  it('503s with no policy store', async () => {
    storeId.value = '';
    expect((await request(buildApp()).put('/api/identity/schema').send({ schema: {} })).status).toBe(503);
    expect(avpSend).not.toHaveBeenCalled();
  });
});

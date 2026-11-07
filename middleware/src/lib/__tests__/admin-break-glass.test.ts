// admin is the cross-tenant break-glass role (docs/next-steps.md §8 work item
// 22). Its Cedar policy stays unconditional by design — a tenant condition
// would break the one role tenants/manifest.json declares cross-tenant — so the
// control is visibility: every time an admin enters another tenant's routes,
// requireTenant raises an audit alert (lib/audit.ts alertAdminCrossTenant).

jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', auth: { policyStoreId: undefined, cognito: null, sessionSigningSecretArn: '' }, mock: { aurora: true } },
}));
jest.mock('@aws-sdk/client-verifiedpermissions', () => ({
  VerifiedPermissionsClient: class { send() { return Promise.resolve({}); } },
  IsAuthorizedCommand: class {},
}));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Request, Response } from 'express';
import { splitStatements } from '../cedar-parse.js';
import { requireTenant } from '../authz.js';
import { _resetAdminAlerts, alertAdminCrossTenant, recentAuthzEvents } from '../audit.js';
import type { Session } from '../session.js';

const ADMIN_CEDAR = readFileSync(join(__dirname, '..', '..', '..', 'seeds', 'roles', 'admin.cedar'), 'utf8');

function call(session: Session | undefined, tenant: 'orgiq' | 'assessment') {
  const req = { session, path: '/x' } as unknown as Request;
  const json = jest.fn();
  const res = { status: jest.fn(() => ({ json })) } as unknown as Response;
  const next = jest.fn();
  requireTenant(tenant)(req, res, next);
  return { next, res };
}

const admin: Session = { sub: 'u-operator', role: 'admin', tenant: 'orgiq', grants: { orgiq: ['admin'] }, iat: 0 } as Session;
const member: Session = { sub: 'u-m', role: 'member', tenant: 'orgiq', grants: { orgiq: ['member'] }, iat: 0 } as Session;

let stdout: jest.SpyInstance;
beforeEach(() => {
  _resetAdminAlerts();
  stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
});
afterEach(() => stdout.mockRestore());

const alerts = () => stdout.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('"audit-alert"')).map((l) => JSON.parse(l));

describe('admin.cedar is the named break-glass policy', () => {
  it('is one unconditional permit on the admin role, and says it is break-glass and alerted', () => {
    const statements = splitStatements(ADMIN_CEDAR);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/^permit \(\s*principal,\s*action,\s*resource\s*\)\s*when \{ principal\.role == "admin" \};$/);
    expect(ADMIN_CEDAR).toMatch(/^\/\/ admin_break_glass/);
    expect(ADMIN_CEDAR).toMatch(/alertAdminCrossTenant/);
  });
});

describe('requireTenant and the cross-tenant alert', () => {
  it('lets an admin into another tenant and raises one alert, with an AdminCrossTenant authz event', () => {
    const { next } = call(admin, 'assessment');
    expect(next).toHaveBeenCalled();
    expect(alerts()).toEqual([expect.objectContaining({
      alert: 'admin-cross-tenant', sub: 'u-operator', sessionTenant: 'orgiq', targetTenant: 'assessment', path: '/x',
    })]);
    expect(recentAuthzEvents({ action: 'AdminCrossTenant', limit: 1 })[0]).toMatchObject({
      decision: 'ALLOW', sub: 'u-operator', role: 'admin', tenant: 'orgiq',
      reason: 'break-glass: admin in tenant=orgiq entered tenant=assessment',
    });
  });

  it('raises nothing when the admin stays in its own tenant', () => {
    const { next } = call(admin, 'orgiq');
    expect(next).toHaveBeenCalled();
    expect(alerts()).toEqual([]);
  });

  it('folds repeats inside the window, and alerts again after it', () => {
    const t0 = 1_000_000;
    expect(alertAdminCrossTenant(admin, 'assessment', '/a', t0)).not.toBeNull();
    expect(alertAdminCrossTenant(admin, 'assessment', '/b', t0 + 30_000)).toBeNull();
    expect(alertAdminCrossTenant(admin, 'social', '/c', t0 + 30_000)).not.toBeNull();
    expect(alertAdminCrossTenant(admin, 'assessment', '/d', t0 + 61_000)).not.toBeNull();
  });

  it('names the real actor when the admin is masquerading', () => {
    const masq = { ...admin, sub: 'u-target', act: { sub: 'u-operator', role: 'admin' } } as Session;
    expect(alertAdminCrossTenant(masq, 'assessment', '/x')).toMatchObject({ sub: 'u-target', actor: 'u-operator' });
  });

  it('still refuses a non-admin outside its tenant, with no alert', () => {
    const { next, res } = call(member, 'assessment');
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(alerts()).toEqual([]);
  });
});

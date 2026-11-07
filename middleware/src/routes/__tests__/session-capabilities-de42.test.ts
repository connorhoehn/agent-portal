// GET /api/session/capabilities for the DE-42 actions, in open mode (no
// policy store) over the REAL Cedar seeds: each new action is a key, true for
// the roles the split kept them on, false for the rest. Policy editing is
// ManageSdlcPolicies since docs/next-steps.md §9 item 8b (org-leader and
// admin; it replaced EditSdlcPolicy, which hr-admin held).

jest.mock('../../config.js', () => ({
  config: {
    region: 'us-east-1',
    auth: { sessionSigningSecretArn: '', policyStoreId: '' },
    aurora: { clusterArn: '', secretArn: '', database: 'orgiq' },
    cognito: { userPoolId: '', clientId: '', clientSecret: '', domain: '', callbackUrl: '', postLoginUrl: '/', logoutRedirectUrl: '/' },
  },
}));
jest.mock('aws-jwt-verify', () => ({ CognitoJwtVerifier: { create: () => ({ verify: async () => ({}) }) } }));
jest.mock('../../providers/identity.js', () => ({
  listUsers: jest.fn(async () => []), getUser: jest.fn(async () => null),
  getUserByExternalSub: jest.fn(async () => null), getUserByEmail: jest.fn(async () => null),
  linkExternalSub: jest.fn(async () => undefined),
}));
jest.mock('@aws-sdk/client-verifiedpermissions', () => ({
  VerifiedPermissionsClient: class { send() { return Promise.resolve({}); } },
  IsAuthorizedCommand: class {},
}));
jest.mock('../../lib/role-registry.js', () => ({ roleRegistry: () => jest.requireActual('../../test-support/seed-roles').seedRoleRegistry() }));

import express from 'express';
import request from '../../test-support/http.js';
import { sessionRouter } from '../session.js';
import { CAPABILITY_ACTIONS } from '../../lib/authz.js';

const BOX = ['OpenDevboxShell', 'RunDevboxTask', 'DecideAgentChange', 'DeliverAgentChange'] as const;
const NEW = [...BOX, 'ManageSdlcPolicies'] as const;

function appAs(role: string) {
  const app = express();
  app.use((req, _res, next) => { (req as unknown as { session: unknown }).session = { sub: `u-${role}`, role, tenant: 'orgiq' }; next(); });
  app.use('/api/session', sessionRouter);
  return app;
}

async function caps(role: string): Promise<Record<string, boolean>> {
  const res = await request(appAs(role)).get('/api/session/capabilities');
  expect(res.status).toBe(200);
  return res.body.actions as Record<string, boolean>;
}

describe('DE-42 actions in GET /api/session/capabilities', () => {
  it('lists every new action in CAPABILITY_ACTIONS', () => {
    for (const a of NEW) expect(CAPABILITY_ACTIONS).toContain(a);
  });

  it('sme: shell, task, decide and deliver true; ManageSdlcPolicies false', async () => {
    const a = await caps('sme');
    expect(NEW.map((k) => [k, a[k]])).toEqual([
      ['OpenDevboxShell', true], ['RunDevboxTask', true], ['DecideAgentChange', true],
      ['DeliverAgentChange', true], ['ManageSdlcPolicies', false],
    ]);
  });

  it('hr-admin: the four box actions true (held through ManageDevbox); ManageSdlcPolicies false (§9 item 8b)', async () => {
    const a = await caps('hr-admin');
    for (const k of BOX) expect([k, a[k]]).toEqual([k, true]);
    expect(a['ManageSdlcPolicies']).toBe(false);
  });

  it('org-leader: ManageSdlcPolicies true, the box actions false', async () => {
    const a = await caps('org-leader');
    for (const k of BOX) expect([k, a[k]]).toEqual([k, false]);
    expect(a['ManageSdlcPolicies']).toBe(true);
  });

  it.each(['member', 'program-owner'])('%s: every new action is a key and false', async (role) => {
    const a = await caps(role);
    for (const k of NEW) expect([k, a[k]]).toEqual([k, false]);
  });

  it('EditSdlcPolicy is gone from the capability list', () => {
    expect(CAPABILITY_ACTIONS).not.toContain('EditSdlcPolicy');
  });
});

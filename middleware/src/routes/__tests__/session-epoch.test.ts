// session_epoch behavior at the route layer:
//   - a real (non-masquerade) tenant/role switch bumps the user's epoch and the
//     re-minted cookie carries the new epoch;
//   - a switch made WHILE masquerading does NOT bump (an operator's switch
//     inside an impersonation must not kill the impersonated user's sessions);
//   - POST /session/revoke-others bumps + keeps the current session, and 409s
//     while masquerading.
//
// config.ts uses import.meta and aws-jwt-verify is ESM — both mocked so the CJS
// test build can load the modules (same pattern as auth-session.test.ts).

jest.mock('../../config.js', () => ({
  config: {
    region: 'us-east-1',
    auth: { sessionSigningSecretArn: '', policyStoreId: '' },
    aurora: { clusterArn: '', secretArn: '', database: 'orgiq' },
    cognito: { userPoolId: '', clientId: '', clientSecret: '', domain: '', callbackUrl: '' },
  },
}));
jest.mock('aws-jwt-verify', () => ({
  CognitoJwtVerifier: { create: () => ({ verify: async () => ({}) }) },
}));

const bumpSessionEpoch = jest.fn(async () => 9);
jest.mock('../../providers/identity.js', () => ({
  listUsers: jest.fn(async () => []),
  getUser: jest.fn(async () => null),
  bumpSessionEpoch,
}));

import express from 'express';
import request from 'supertest';
import { sessionRouter } from '../session.js';
import { resetRateLimits } from '../../lib/rate-limit.js';
import type { Session } from '../../lib/session.js';

// Build an app that injects a fixed session ahead of the router, so we can
// drive the switch/revoke handlers with real (act-less) and masquerade sessions.
function buildApp(session: Session) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = session; next(); });
  app.use('/api/session', sessionRouter);
  return app;
}

/** Decode the freshly-minted (non-clearing) session cookie's payload JSON. */
function issuedPayload(res: request.Response): Record<string, unknown> {
  const raw = res.headers['set-cookie'];
  const arr = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const set = arr.map(c => c.split(';')[0]!).filter(c => c.startsWith('orgiq.session='));
  const value = set.map(c => c.slice('orgiq.session='.length)).find(v => v.length > 0)!;
  const payload = value.split('.')[0]!;
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

const realSession: Session = {
  sub: 'u-real', name: 'Real', role: 'member', tenant: 'orgiq',
  grants: { orgiq: ['member', 'org-leader'], newsroom: ['reporter'] }, iat: Math.floor(Date.now() / 1000), epoch: 3,
};

const masqSession: Session = {
  sub: 'u-target', name: 'Target', role: 'member', tenant: 'orgiq',
  grants: { orgiq: ['member', 'org-leader'] }, iat: Math.floor(Date.now() / 1000), epoch: 4,
  act: { sub: 'u-op', role: 'admin', tenant: 'orgiq', grants: { orgiq: ['admin'] }, epoch: 1 },
};

beforeEach(() => { resetRateLimits(); bumpSessionEpoch.mockClear(); });

describe('a real switch bumps the epoch and the cookie carries it', () => {
  it('POST /role bumps and stamps the new epoch', async () => {
    const res = await request(buildApp({ ...realSession })).post('/api/session/role').send({ role: 'org-leader' });
    expect(res.status).toBe(200);
    expect(bumpSessionEpoch).toHaveBeenCalledWith('u-real');
    expect(issuedPayload(res)).toMatchObject({ role: 'org-leader', epoch: 9 });
  });

  it('POST /tenant bumps and stamps the new epoch', async () => {
    const res = await request(buildApp({ ...realSession })).post('/api/session/tenant').send({ tenant: 'newsroom' });
    expect(res.status).toBe(200);
    expect(bumpSessionEpoch).toHaveBeenCalledWith('u-real');
    expect(issuedPayload(res)).toMatchObject({ tenant: 'newsroom', epoch: 9 });
  });
});

describe('a masquerade switch does NOT bump', () => {
  it('POST /role while masquerading keeps the impersonated epoch', async () => {
    const res = await request(buildApp({ ...masqSession })).post('/api/session/role').send({ role: 'org-leader' });
    expect(res.status).toBe(200);
    expect(bumpSessionEpoch).not.toHaveBeenCalled();
    // The impersonated session's own epoch (4) is preserved, not bumped.
    expect(issuedPayload(res)).toMatchObject({ role: 'org-leader', epoch: 4 });
  });
});

describe('POST /session/revoke-others', () => {
  it('bumps the epoch and keeps THIS session at the new epoch', async () => {
    const res = await request(buildApp({ ...realSession })).post('/api/session/revoke-others').send({});
    expect(res.status).toBe(200);
    expect(bumpSessionEpoch).toHaveBeenCalledWith('u-real');
    expect(res.body).toMatchObject({ sub: 'u-real' });
    expect(issuedPayload(res)).toMatchObject({ sub: 'u-real', epoch: 9 });
  });

  it('409s while masquerading and does not bump', async () => {
    const res = await request(buildApp({ ...masqSession })).post('/api/session/revoke-others').send({});
    expect(res.status).toBe(409);
    expect(bumpSessionEpoch).not.toHaveBeenCalled();
  });
});

// POST /api/session/masquerade/stop (routes/session.ts) had no test at all.
// That is dangerous specifically here: this is the ONE route whose job is to
// hand impersonated authority back — a regression that left the caller
// stuck as the impersonated target (or, worse, issued a cookie that kept
// BOTH identities' grants) would be a privilege-retention bug that nothing
// else in the suite would catch, because every other masquerade test
// (session-epoch.test.ts, authz tests) exercises entering a masquerade, not
// leaving one.
//
// Pinned here:
//   * 400 `not masquerading` when the session carries no `act` provenance —
//     stop is not a generic "log me out of whatever I am" button.
//   * 200 restores the OPERATOR's own identity (sub/role/tenant/grants),
//     not the impersonated target's, and the re-minted session no longer
//     carries `act` (publicView's `masquerading` goes back to null).
//   * the operator's frozen epoch travels back with them, not 0 — a stale
//     epoch would make their own next request look like a revoked session.
//   * a fresh session cookie is actually re-issued (Set-Cookie present) —
//     stop must not merely reply 200 while leaving the masquerade cookie live.
//
// config.ts uses import.meta and aws-jwt-verify is ESM — mocked the same way
// auth-session.test.ts does it, since this router is the same one.

jest.mock('../../config.js', () => ({
  config: {
    region: 'us-east-1',
    auth: { sessionSigningSecretArn: '', policyStoreId: '' },
    aurora: { clusterArn: '', secretArn: '', database: 'orgiq' },
    cognito: {
      userPoolId: '', clientId: '', clientSecret: '', domain: '', callbackUrl: '',
      postLoginUrl: '/', logoutRedirectUrl: '/',
    },
  },
}));
jest.mock('aws-jwt-verify', () => ({
  CognitoJwtVerifier: { create: () => ({ verify: async () => ({}) }) },
}));
jest.mock('../../providers/identity.js', () => ({
  listUsers: jest.fn(async () => []),
  getUser: jest.fn(async () => null),
  getUserByExternalSub: jest.fn(async () => null),
  getUserByEmail: jest.fn(async () => null),
  linkExternalSub: jest.fn(async () => undefined),
  bumpSessionEpoch: jest.fn(async () => 0),
}));

import express from 'express';
import request from '../../test-support/http.js';
import { sessionRouter } from '../session.js';
import type { Session } from '../../lib/session.js';

/** Same injected-session pattern as assessment-tenant-gate.test.ts — real
 * cookie signing is exercised elsewhere (auth-session.test.ts); this file is
 * only about what the handler does once a session already carries `act`. */
function appAs(session: Session) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = session; next(); });
  app.use('/api/session', sessionRouter);
  return app;
}

const OPERATOR_ACT = {
  sub: 'u-admin', role: 'admin' as const, tenant: 'orgiq' as const,
  grants: { orgiq: ['admin'] }, epoch: 3,
};

const MASQUERADING: Session = {
  sub: 'u-alice', role: 'member', tenant: 'orgiq', grants: { orgiq: ['member'] },
  iat: 0, epoch: 0, act: OPERATOR_ACT,
};

const NOT_MASQUERADING: Session = {
  sub: 'u-alice', role: 'member', tenant: 'orgiq', grants: { orgiq: ['member'] }, iat: 0,
};

describe('POST /api/session/masquerade/stop', () => {
  it('400s "not masquerading" when there is no act provenance to restore', async () => {
    const res = await request(appAs(NOT_MASQUERADING)).post('/api/session/masquerade/stop');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'not masquerading' });
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('restores the OPERATOR identity, not the impersonated target, and drops `act`', async () => {
    const res = await request(appAs(MASQUERADING)).post('/api/session/masquerade/stop');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ sub: 'u-admin', role: 'admin', tenant: 'orgiq' });
    expect(res.body.masquerading).toBeNull();
  });

  it('carries the operator\'s frozen epoch back, not 0', async () => {
    // Not directly visible on publicView, but a fresh cookie IS re-issued —
    // the epoch travels inside it (signSession). A missing Set-Cookie here
    // would mean stop replied 200 while the masquerade cookie stayed live.
    const res = await request(appAs(MASQUERADING)).post('/api/session/masquerade/stop');
    const cookies = Array.isArray(res.headers['set-cookie'])
      ? res.headers['set-cookie']
      : res.headers['set-cookie'] ? [res.headers['set-cookie']] : [];
    expect(cookies.some((c: string) => c.startsWith('orgiq.session='))).toBe(true);
  });
});

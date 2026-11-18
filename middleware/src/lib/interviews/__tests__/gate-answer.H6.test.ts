// Lane H6 (row E2; the plan's "open item 3"): what the interviews tenant gate answers a caller with no session and a
// candidate, in the product and in the development mode the mock world runs.
//
// A candidate's cookie is scoped to /api/interview-invite (lib/interviews/invite/guest.ts GUEST_COOKIE_PATH), so the
// candidate's browser sends nothing on /api/interviews/*: there it is a caller with no session. The product (no
// INSECURE_DEV_MODE) answers that caller 401 (lib/authz.ts denyUnauthenticated). The development mode hands a cookie-less
// caller the demo identity, an orgiq session; the tenant gate answers that stand-in for "no session" 401 too, so both worlds
// agree (the owner's decision, 18 November: 401). A guest cookie carried onto the route by hand is never the demo identity
// (lib/session.ts), so it is 401 in both.
jest.mock('../../../config.js', () => ({ config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '', policyStoreId: undefined, cognito: null }, cognito: { portalOrigin: '' }, mock: { aurora: true } } }));

import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { sessionMiddleware } from '../../session.js';
import { requireTenant } from '../../authz.js';
import { GUEST_COOKIE_PATH } from '../invite/guest.js';

function app() {
  const a = express();
  a.use(cookieParser());
  a.use(sessionMiddleware());
  a.get('/api/interviews/interviews', requireTenant('interviews'), (_req, res) => { res.json({ ok: true }); });
  return a;
}

const saved = { dev: process.env['INSECURE_DEV_MODE'], node: process.env['NODE_ENV'] };
afterEach(() => {
  if (saved.dev === undefined) delete process.env['INSECURE_DEV_MODE']; else process.env['INSECURE_DEV_MODE'] = saved.dev;
  if (saved.node === undefined) delete process.env['NODE_ENV']; else process.env['NODE_ENV'] = saved.node;
});
beforeEach(() => { jest.spyOn(console, 'log').mockImplementation(() => undefined); jest.spyOn(console, 'warn').mockImplementation(() => undefined); });
afterEach(() => jest.restoreAllMocks());

describe('the interviews tenant gate: no session and a guest', () => {
  it('scopes the candidate\'s cookie to its own routes', () => {
    expect(GUEST_COOKIE_PATH).toBe('/api/interview-invite');
  });

  it('the product: a caller with no session, and so a candidate\'s browser, is 401 sign-in required; a guest cookie by hand is a rejected credential', async () => {
    process.env['INSECURE_DEV_MODE'] = 'false';
    const anon = await request(app()).get('/api/interviews/interviews');
    expect([anon.status, anon.body.code]).toEqual([401, 'SIGN_IN_REQUIRED']);
    const guest = await request(app()).get('/api/interviews/interviews').set('Cookie', 'interviews.guest=any.value');
    expect([guest.status, guest.body.code]).toEqual([401, 'SESSION_INVALID']);
  });

  it('the development mode: no session is the demo identity, which this tenant does not cover, so 401 as in the product; a guest cookie by hand stays 401', async () => {
    process.env['INSECURE_DEV_MODE'] = 'true';
    process.env['NODE_ENV'] = 'development';
    // The same code as the product's caller with no session: never SESSION_INVALID, which the portal reads as a retired
    // session and refreshes, and a refresh here only hands back the same demo identity.
    const anon = await request(app()).get('/api/interviews/interviews');
    expect([anon.status, anon.body.code]).toEqual([401, 'SIGN_IN_REQUIRED']);
    const guest = await request(app()).get('/api/interviews/interviews').set('Cookie', 'interviews.guest=any.value');
    expect([guest.status, guest.body.code]).toEqual([401, 'SESSION_INVALID']);
  });
});

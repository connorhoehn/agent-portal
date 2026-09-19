// Session-hygiene tests for the auth + session routers:
//   1. GET /api/session/me — demo fallback only while no IdP is configured;
//      401 { ssoRequired } once Cognito is on.
//   2. POST /api/auth/logout — clears the session cookie ALWAYS, and returns
//      the hosted-UI logout URL when Cognito is on.
//   3. POST /api/session/login — clears any prior cookie before minting the
//      new user's session (no stale material survives a user switch).
//   4. Switch endpoints refuse anonymous requests once Cognito is on.
//
// config.ts uses import.meta and aws-jwt-verify is ESM — both are mocked so
// the CJS test build can load the modules (same pattern as oidc.test.ts).

jest.mock('../../config.js', () => ({
  config: {
    region: 'us-east-1',
    auth: { sessionSigningSecretArn: '', policyStoreId: '' },
    aurora: { clusterArn: '', secretArn: '', database: 'orgiq' },
    // Mutable in tests: setCognito() flips the IdP on/off per case.
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
  listUsers: jest.fn(async () => [] as unknown[]),
  getUser: jest.fn(async (id: string) =>
    id === 'u-alice' ? { id: 'u-alice', displayName: 'Alice', email: null, grants: { orgiq: ['member'] } } : null),
  getUserByExternalSub: jest.fn(async () => null),
  getUserByEmail: jest.fn(async () => null),
  linkExternalSub: jest.fn(async () => undefined),
}));

import express from 'express';
import request from '../../test-support/http.js';
import { config } from '../../config.js';
import { sessionRouter } from '../session.js';
import { authRouter, resolveRedirect } from '../auth.js';
import { resetRateLimits } from '../../lib/rate-limit.js';
import { getUser, listUsers } from '../../providers/identity.js';

/** Flip the mocked Cognito config on/off — the routes read it live. */
function setCognito(on: boolean) {
  const c = (config as unknown as { cognito: Record<string, string> }).cognito;
  c['userPoolId'] = on ? 'us-east-1_TEST' : '';
  c['clientId'] = on ? 'client123' : '';
  // clientSecret is part of the SSO-presence check (a secret-less half-config
  // must not disable the demo fallback) — the fixture supplies it.
  c['clientSecret'] = on ? 'secret123' : '';
  c['domain'] = on ? 'orgiq-auth.auth.us-east-1.amazoncognito.com' : '';
  c['callbackUrl'] = on ? 'http://localhost:3001/api/auth/callback' : '';
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/session', sessionRouter);
  app.use('/api/auth', authRouter);
  return app;
}

function sessionCookies(res: request.Response): string[] {
  const raw = res.headers['set-cookie'];
  const arr = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return arr.filter((c: string) => c.startsWith('orgiq.session='));
}

/** An expired/empty Set-Cookie for the session name — the "cleared" shape. */
function isClearing(cookie: string): boolean {
  return cookie.startsWith('orgiq.session=;') && /expires=Thu, 01 Jan 1970/i.test(cookie);
}

beforeEach(() => {
  resetRateLimits();
  setCognito(false);
});

afterEach(() => setCognito(false));

describe('GET /api/session/me', () => {
  it('falls back to demo-user while no IdP is configured', async () => {
    const res = await request(buildApp()).get('/api/session/me');
    expect(res.status).toBe(200);
    expect(res.body.sub).toBe('demo-user');
  });

  it('401s a cookie-less request with ssoRequired once Cognito is on', async () => {
    setCognito(true);
    const res = await request(buildApp()).get('/api/session/me');
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: 'Unauthenticated', ssoRequired: true });
  });
});

describe('POST /api/auth/logout', () => {
  it('clears the session cookie even when Cognito is off', async () => {
    const res = await request(buildApp()).post('/api/auth/logout');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    const cookies = sessionCookies(res);
    expect(cookies).toHaveLength(1);
    expect(isClearing(cookies[0]!)).toBe(true);
  });

  it('clears the cookie AND returns the hosted logout URL when Cognito is on', async () => {
    setCognito(true);
    const res = await request(buildApp()).post('/api/auth/logout');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.ssoLogoutUrl).toContain('/logout');
    expect(res.body.ssoLogoutUrl).toContain('client_id=client123');
    const cookies = sessionCookies(res);
    expect(cookies).toHaveLength(1);
    expect(isClearing(cookies[0]!)).toBe(true);
  });
});

describe('POST /api/session/login', () => {
  it('clears any prior cookie before minting the new session', async () => {
    const res = await request(buildApp()).post('/api/session/login').send({ userId: 'u-alice' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ sub: 'u-alice', tenant: 'orgiq', role: 'member' });
    const cookies = sessionCookies(res);
    // Two Set-Cookie headers for the session name: the clearing one first,
    // then the freshly-minted value.
    expect(cookies).toHaveLength(2);
    expect(isClearing(cookies[0]!)).toBe(true);
    expect(isClearing(cookies[1]!)).toBe(false);
    expect(cookies[1]!.length).toBeGreaterThan('orgiq.session='.length + 10);
  });
});

describe('switch endpoints refuse anonymous requests once Cognito is on', () => {
  it.each([
    ['/api/session/role', { role: 'member' }],
    ['/api/session/tenant', { tenant: 'assessment' }],
    ['/api/session/masquerade', { userId: 'u-alice' }],
  ])('%s → 401 ssoRequired', async (path, body) => {
    setCognito(true);
    const res = await request(buildApp()).post(path).send(body);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: 'Unauthenticated', ssoRequired: true });
  });
});

// 4. Post-login redirect. A relative path resolves against whoever serves the
//    redirect — the middleware. Same-origin in production, but in dev the
//    portal is on another port, so a successful SSO login used to dump the
//    browser on a middleware 404.
describe('resolveRedirect', () => {
  it('leaves the path alone when the portal shares this origin', () => {
    expect(resolveRedirect('/admin/budgets', '')).toBe('/admin/budgets');
  });

  it('absolutises against the portal origin when they differ', () => {
    expect(resolveRedirect('/admin/budgets', 'http://localhost:5183'))
      .toBe('http://localhost:5183/admin/budgets');
    // A trailing slash on the origin must not double up.
    expect(resolveRedirect('/iq/work', 'http://localhost:5183/'))
      .toBe('http://localhost:5183/iq/work');
  });

  // The origin is configuration and the path is already validated by
  // safeReturnTo, but prefixing must never manufacture a cross-origin jump
  // out of something that was not a same-origin path to begin with.
  it('never prefixes an absolute or protocol-relative target', () => {
    expect(resolveRedirect('https://evil.example/x', 'http://localhost:5183'))
      .toBe('https://evil.example/x');
    expect(resolveRedirect('//evil.example/x', 'http://localhost:5183'))
      .toBe('//evil.example/x');
  });
});

// The picker's user list and the session-cookie logout — two routes on the
// same router that the cases above never touch.
describe('GET /api/session/users — the picker list', () => {
  const listUsersMock = listUsers as unknown as jest.Mock;

  afterEach(() => { listUsersMock.mockReset(); listUsersMock.mockResolvedValue([]); });

  it('reshapes grants into a tenant/roles list, and leaks no credential material', async () => {
    listUsersMock.mockResolvedValue([{
      id: 'u-nora', displayName: 'Nora Vance', email: 'nora@example.com',
      personId: 'p-004', externalSub: 'cognito-1', sessionEpoch: 3,
      grants: { orgiq: ['sme'], assessment: ['assessor', 'lead-assessor'] },
    }]);
    const res = await request(buildApp()).get('/api/session/users');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    // Exactly four keys: the picker needs a name and where they can go, and
    // nothing else about the account travels to an unauthenticated caller.
    expect(Object.keys(res.body[0]).sort()).toEqual(['displayName', 'email', 'id', 'tenants']);
    expect(res.body[0].tenants).toEqual([
      { tenant: 'orgiq', roles: ['sme'] },
      { tenant: 'assessment', roles: ['assessor', 'lead-assessor'] },
    ]);
    const serialized = JSON.stringify(res.body);
    for (const forbidden of ['externalSub', 'sessionEpoch', 'personId']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('lists a user with no grants as an empty tenant list rather than dropping them', async () => {
    listUsersMock.mockResolvedValue([
      { id: 'u-new', displayName: 'New Hire', email: null, grants: {} },
    ]);
    const res = await request(buildApp()).get('/api/session/users');
    expect(res.body).toHaveLength(1);
    expect(res.body[0].tenants).toEqual([]);
    expect(res.body[0].email).toBeNull();
  });

  it('answers an empty array when nobody is provisioned', async () => {
    listUsersMock.mockResolvedValue([]);
    const res = await request(buildApp()).get('/api/session/users');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe('POST /api/session/logout', () => {
  it('CLEARS the session cookie and says so, with or without one to clear', async () => {
    const app = buildApp();
    const anonymous = await request(app).post('/api/session/logout');
    expect(anonymous.status).toBe(200);
    expect(anonymous.body).toEqual({ ok: true });
    expect(sessionCookies(anonymous).every(isClearing)).toBe(true);
    expect(sessionCookies(anonymous)).toHaveLength(1);
  });

  it('clears even when Cognito is on — the app cookie is ours either way', async () => {
    // The Cognito hosted-UI logout lives on POST /api/auth/logout; this route
    // is only about the cookie the browser actually holds.
    setCognito(true);
    const res = await request(buildApp()).post('/api/session/logout');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(sessionCookies(res).every(isClearing)).toBe(true);
  });
});


describe('production picker boundary', () => {
  const priorEnv = process.env['NODE_ENV'];
  const priorDemo = process.env['AUTH_DEMO_MODE'];
  beforeEach(() => {
    process.env['NODE_ENV'] = 'production';
    delete process.env['AUTH_DEMO_MODE'];
    jest.clearAllMocks();
  });
  afterEach(() => {
    if (priorEnv === undefined) delete process.env['NODE_ENV'];
    else process.env['NODE_ENV'] = priorEnv;
    if (priorDemo === undefined) delete process.env['AUTH_DEMO_MODE'];
    else process.env['AUTH_DEMO_MODE'] = priorDemo;
  });

  it.each([false, true])('refuses passwordless login with SSO configured=%s', async (sso) => {
    setCognito(sso);
    const res = await request(buildApp()).post('/api/session/login').send({ userId: 'u-alice' });
    expect(res.status).toBe(403);
    expect(res.body.ssoEnabled).toBe(sso);
    expect(sessionCookies(res)).toHaveLength(0);
    expect(getUser).not.toHaveBeenCalled();
  });

  it.each([false, true])('does not expose the picker directory with SSO configured=%s', async (sso) => {
    setCognito(sso);
    const res = await request(buildApp()).get('/api/session/users');
    expect(res.status).toBe(403);
    expect(listUsers).not.toHaveBeenCalled();
  });

  it('keeps an explicitly enabled production demo usable', async () => {
    process.env['AUTH_DEMO_MODE'] = 'true';
    const res = await request(buildApp()).post('/api/session/login').send({ userId: 'u-alice' });
    expect(res.status).toBe(200);
    expect(res.body.sub).toBe('u-alice');
    expect((await request(buildApp()).get('/api/session/users')).status).toBe(200);
  });
});

// Enterprise SSO — GET /api/auth/config, /login and /callback
// (routes/auth.ts). The BFF half of the OIDC authorization-code + PKCE flow.
// (POST /api/auth/logout has its own coverage in auth-session.test.ts.)
//
// What is pinned — this is the login flow, so the security properties are the
// point:
//   * the OPEN-REDIRECT defence on `?returnTo=`. The check is a whitelist
//     (`^/(?![/\\])`) rather than a "not //" blacklist, because browsers
//     normalise a backslash before resolving: `/\evil.com` becomes
//     protocol-relative and `new URL('/\\evil.com', origin)` resolves to
//     https://evil.com/. Every one of those shapes must fall back to the
//     configured post-login URL,
//   * the state cookie: httpOnly, SameSite=Lax, cleared on callback whatever
//     happens, and carrying a PKCE verifier that never leaves the server,
//   * every way the callback must refuse: an IdP error, a missing/expired/
//     mismatched state, no code, a failed exchange, and an authenticated
//     identity with no OrgIQ account — each a distinct status, none of them
//     minting a session,
//   * first-login LINKING: resolve by external_sub, fall back to email, and
//     record the sub so the next login is direct,
//   * that a refusal is AUDITED as a DENY with a reason, which is the only
//     record that someone tried,
//   * the 404 when SSO is not configured — the routes are mounted either way.

const cognito = {
  userPoolId: '', clientId: '', clientSecret: '', domain: '', callbackUrl: '',
  postLoginUrl: '/iq', logoutRedirectUrl: '/', portalOrigin: '',
};

jest.mock('../../config.js', () => ({
  config: {
    region: 'us-east-1',
    auth: { sessionSigningSecretArn: '', policyStoreId: '' },
    aurora: { clusterArn: '', secretArn: '', database: 'orgiq' },
    get cognito() { return cognito; },
  },
}));
jest.mock('aws-jwt-verify', () => ({
  CognitoJwtVerifier: { create: () => ({ verify: async () => ({}) }) },
}));
jest.mock('../../lib/oidc.js', () => ({
  cognitoEnabled: jest.fn(),
  randomToken: jest.fn(),
  pkceChallenge: jest.fn(() => 'challenge-abc'),
  authorizeUrl: jest.fn((state: string, challenge: string) =>
    `https://idp.example.com/authorize?state=${state}&code_challenge=${challenge}`),
  exchangeCode: jest.fn(),
  verifyIdToken: jest.fn(),
  hostedLogoutUrl: jest.fn(() => 'https://idp.example.com/logout'),
}));
jest.mock('../../providers/identity.js', () => ({
  getUserByExternalSub: jest.fn(), getUserByEmail: jest.fn(), linkExternalSub: jest.fn(),
}));
jest.mock('../../lib/audit.js', () => ({
  logAuthz: jest.fn(),
  eventFromSession: jest.fn(() => ({ decision: 'ALLOW', action: 'Login' })),
}));

import express from 'express';
import cookieParser from 'cookie-parser';
import request from '../../test-support/http.js';
import { authRouter } from '../auth.js';
import { errorHandler } from '../../lib/async-handler.js';
import { cognitoEnabled, randomToken, exchangeCode, verifyIdToken } from '../../lib/oidc.js';
import { getUserByExternalSub, getUserByEmail, linkExternalSub } from '../../providers/identity.js';
import { logAuthz } from '../../lib/audit.js';
import { signValue, verifySession } from '../../lib/session.js';
import { resetRateLimits } from '../../lib/rate-limit.js';

const m = <T,>(fn: T): jest.Mock => fn as unknown as jest.Mock;

const USER = { id: 'u-nora', displayName: 'Nora Vance', email: 'nora@example.com', grants: { orgiq: ['sme'] } };

function buildApp() {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api/auth', authRouter);
  app.use(errorHandler);
  return app;
}

/** Mint the real signed state cookie the callback will verify. */
async function stateCookie(over: Partial<{ state: string; verifier: string; returnTo: string; exp: number }> = {}) {
  const value = await signValue({
    state: 'st-1', verifier: 'ver-1', returnTo: '', exp: Date.now() + 60_000, ...over,
  });
  return `orgiq.oidc=${encodeURIComponent(value)}`;
}

beforeEach(() => {
  jest.clearAllMocks();
  resetRateLimits();
  cognito.postLoginUrl = '/iq';
  cognito.portalOrigin = '';
  m(cognitoEnabled).mockReturnValue(true);
  m(randomToken).mockReturnValueOnce('st-1').mockReturnValueOnce('ver-1');
});

describe('GET /api/auth/config', () => {
  it('reports whether the portal should offer the SSO button', async () => {
    m(cognitoEnabled).mockReturnValue(false);
    const off = await request(buildApp()).get('/api/auth/config');
    expect(off.status).toBe(200);
    expect(off.body).toEqual({ ssoEnabled: false });

    m(cognitoEnabled).mockReturnValue(true);
    const on = await request(buildApp()).get('/api/auth/config');
    expect(on.body).toEqual({ ssoEnabled: true });
  });
});

describe('GET /api/auth/login', () => {
  it('404s when no IdP is configured — the picker is the only login', async () => {
    m(cognitoEnabled).mockReturnValue(false);
    const res = await request(buildApp()).get('/api/auth/login');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/SSO is not configured/);
  });

  it('redirects to the hosted UI with the state and the PKCE CHALLENGE, not the verifier', async () => {
    const res = await request(buildApp()).get('/api/auth/login');
    expect(res.status).toBe(302);
    expect(res.headers['location']).toBe(
      'https://idp.example.com/authorize?state=st-1&code_challenge=challenge-abc',
    );
    // The verifier is the secret half of PKCE — it must never reach the IdP
    // on this leg, only on the token exchange.
    expect(res.headers['location']).not.toContain('ver-1');
  });

  it('sets the state cookie httpOnly and SameSite=Lax', async () => {
    const res = await request(buildApp()).get('/api/auth/login');
    const cookie = (res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('orgiq.oidc='))!;
    expect(cookie).toMatch(/HttpOnly/i);
    // Lax, not Strict: the IdP redirect is a cross-site top-level navigation
    // and Strict would drop the cookie exactly on the way back.
    expect(cookie).toMatch(/SameSite=Lax/i);
  });

  it('accepts only a same-origin ABSOLUTE PATH as returnTo — end to end', async () => {
    // `/\evil.com` normalises to `//evil.com` in a browser and
    // `new URL('/\\evil.com', origin)` resolves to https://evil.com/, so a
    // "not //" blacklist is not enough. This walks the whole flow: log in with
    // the hostile value, hand the cookie the server actually minted back to
    // the callback, and check where it sends the browser.
    const app = buildApp();
    m(exchangeCode).mockResolvedValue({ id_token: 'idt' });
    m(verifyIdToken).mockResolvedValue({ sub: 'cognito-1' });
    m(getUserByExternalSub).mockResolvedValue(USER);

    const hostile = ['//evil.com', '/\\evil.com', 'https://evil.com', 'evil.com', '', '/\\\\evil.com'];
    for (const returnTo of hostile) {
      m(randomToken).mockReturnValueOnce('st-1').mockReturnValueOnce('ver-1');
      const login = await request(app).get(`/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
      const issued = (login.headers['set-cookie'] as unknown as string[])
        .find((c) => c.startsWith('orgiq.oidc='))!.split(';')[0]!;
      const back = await request(app).get('/api/auth/callback?code=c&state=st-1').set('Cookie', issued);
      expect(back.status).toBe(302);
      // Always the configured destination, never anything derived from the
      // query string.
      expect(back.headers['location']).toBe('/iq');
    }
  });

  it('carries a genuinely same-origin returnTo through the whole flow', async () => {
    const app = buildApp();
    m(exchangeCode).mockResolvedValue({ id_token: 'idt' });
    m(verifyIdToken).mockResolvedValue({ sub: 'cognito-1' });
    m(getUserByExternalSub).mockResolvedValue(USER);
    m(randomToken).mockReturnValueOnce('st-1').mockReturnValueOnce('ver-1');
    const login = await request(app).get('/api/auth/login?returnTo=%2Fiq%2Fsprints%3Ftab%3Dmine');
    const issued = (login.headers['set-cookie'] as unknown as string[])
      .find((c) => c.startsWith('orgiq.oidc='))!.split(';')[0]!;
    const back = await request(app).get('/api/auth/callback?code=c&state=st-1').set('Cookie', issued);
    expect(back.headers['location']).toBe('/iq/sprints?tab=mine');
  });
});

describe('GET /api/auth/callback', () => {
  it('404s when no IdP is configured', async () => {
    m(cognitoEnabled).mockReturnValue(false);
    expect((await request(buildApp()).get('/api/auth/callback')).status).toBe(404);
  });

  it('CLEARS the state cookie on every outcome, including the failures', async () => {
    const res = await request(buildApp())
      .get('/api/auth/callback?error=access_denied')
      .set('Cookie', await stateCookie());
    expect(res.status).toBe(400);
    expect(res.text).toMatch(/Sign-in failed at the identity provider: access_denied/);
    const cleared = (res.headers['set-cookie'] as unknown as string[])
      .find((c) => c.startsWith('orgiq.oidc='))!;
    expect(cleared).toMatch(/orgiq\.oidc=;/);
  });

  it('refuses a missing, expired or MISMATCHED state without exchanging anything', async () => {
    const app = buildApp();
    const cases: Array<[string, string | null]> = [
      ['/api/auth/callback?code=c&state=st-1', null],                       // no cookie
      ['/api/auth/callback?code=c&state=st-1', await stateCookie({ exp: Date.now() - 1 })],
      ['/api/auth/callback?code=c&state=WRONG', await stateCookie()],       // state mismatch
      ['/api/auth/callback?state=st-1', await stateCookie()],               // no code
    ];
    for (const [url, cookie] of cases) {
      const req = request(app).get(url);
      if (cookie) req.set('Cookie', cookie);
      const res = await req;
      expect(res.status).toBe(400);
      expect(res.text).toMatch(/state expired or invalid/);
    }
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it('502s when the token exchange or ID-token verification fails', async () => {
    m(exchangeCode).mockRejectedValue(new Error('invalid_grant'));
    const res = await request(buildApp())
      .get('/api/auth/callback?code=c&state=st-1')
      .set('Cookie', await stateCookie());
    expect(res.status).toBe(502);
    expect(res.text).toMatch(/Could not complete sign-in/);
    expect(getUserByExternalSub).not.toHaveBeenCalled();
  });

  it('exchanges the code with the VERIFIER from the signed cookie', async () => {
    m(exchangeCode).mockResolvedValue({ id_token: 'idt' });
    m(verifyIdToken).mockResolvedValue({ sub: 'cognito-1', email: 'nora@example.com' });
    m(getUserByExternalSub).mockResolvedValue(USER);
    await request(buildApp())
      .get('/api/auth/callback?code=the-code&state=st-1')
      .set('Cookie', await stateCookie({ verifier: 'ver-secret' }));
    expect(exchangeCode).toHaveBeenCalledWith('the-code', 'ver-secret');
  });

  it('links the federated sub on FIRST login, then resolves directly', async () => {
    m(exchangeCode).mockResolvedValue({ id_token: 'idt' });
    m(verifyIdToken).mockResolvedValue({ sub: 'cognito-1', email: 'nora@example.com', emailVerified: true });
    m(getUserByExternalSub).mockResolvedValue(null);
    m(getUserByEmail).mockResolvedValue(USER);
    const res = await request(buildApp())
      .get('/api/auth/callback?code=c&state=st-1')
      .set('Cookie', await stateCookie());
    expect(res.status).toBe(302);
    expect(linkExternalSub).toHaveBeenCalledWith('u-nora', 'cognito-1');
  });

  it('never links by an UNVERIFIED email: the identity is refused as unprovisioned', async () => {
    m(exchangeCode).mockResolvedValue({ id_token: 'idt' });
    m(verifyIdToken).mockResolvedValue({ sub: 'cognito-evil', email: 'nora@example.com', emailVerified: false });
    m(getUserByExternalSub).mockResolvedValue(null);
    m(getUserByEmail).mockResolvedValue(USER);
    const res = await request(buildApp())
      .get('/api/auth/callback?code=c&state=st-1')
      .set('Cookie', await stateCookie());
    expect(res.status).toBe(403);
    expect(getUserByEmail).not.toHaveBeenCalled();
    expect(linkExternalSub).not.toHaveBeenCalled();
  });

  it('403s an authenticated identity with no OrgIQ account, and AUDITS the deny', async () => {
    m(exchangeCode).mockResolvedValue({ id_token: 'idt' });
    m(verifyIdToken).mockResolvedValue({ sub: 'cognito-9', email: 'stranger@example.com' });
    m(getUserByExternalSub).mockResolvedValue(null);
    m(getUserByEmail).mockResolvedValue(null);
    const res = await request(buildApp())
      .get('/api/auth/callback?code=c&state=st-1')
      .set('Cookie', await stateCookie());
    expect(res.status).toBe(403);
    expect(res.text).toMatch(/authenticated but not provisioned/);
    // The audit row is the only record that someone tried.
    expect(m(logAuthz).mock.calls[0]![0]).toMatchObject({
      decision: 'DENY', action: 'Login', sub: 'stranger@example.com',
      reason: 'no OrgIQ account for federated identity',
    });
    expect(linkExternalSub).not.toHaveBeenCalled();
  });

  it('403s a provisioned user who holds no tenant grants at all', async () => {
    m(exchangeCode).mockResolvedValue({ id_token: 'idt' });
    m(verifyIdToken).mockResolvedValue({ sub: 'cognito-1' });
    m(getUserByExternalSub).mockResolvedValue({ ...USER, grants: {} });
    const res = await request(buildApp())
      .get('/api/auth/callback?code=c&state=st-1')
      .set('Cookie', await stateCookie());
    expect(res.status).toBe(403);
    expect(res.text).toMatch(/no tenant grants/);
    // No session cookie is set for a user who cannot enter any tenant.
    const cookies = (res.headers['set-cookie'] as unknown as string[]) ?? [];
    expect(cookies.some((c) => c.startsWith('orgiq.session='))).toBe(false);
  });

  it('mints the app session cookie and returns the user to a SAFE destination', async () => {
    m(exchangeCode).mockResolvedValue({ id_token: 'idt' });
    m(verifyIdToken).mockResolvedValue({ sub: 'cognito-1' });
    m(getUserByExternalSub).mockResolvedValue(USER);
    const res = await request(buildApp())
      .get('/api/auth/callback?code=c&state=st-1')
      .set('Cookie', await stateCookie({ returnTo: '/iq/sprints' }));
    expect(res.status).toBe(302);
    expect(res.headers['location']).toBe('/iq/sprints');
    const cookies = res.headers['set-cookie'] as unknown as string[];
    expect(cookies.some((c) => c.startsWith('orgiq.session='))).toBe(true);
  });

  it('the minted session carries the directory epoch (a missing one reads as 0 and fails every strict check)', async () => {
    m(exchangeCode).mockResolvedValue({ id_token: 'idt' });
    m(verifyIdToken).mockResolvedValue({ sub: 'cognito-1' });
    m(getUserByExternalSub).mockResolvedValue({ ...USER, epoch: 61 });
    const res = await request(buildApp())
      .get('/api/auth/callback?code=c&state=st-1')
      .set('Cookie', await stateCookie({ returnTo: '/iq' }));
    const cookie = (res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('orgiq.session='))!;
    const value = decodeURIComponent(cookie.split(';')[0]!.slice('orgiq.session='.length));
    expect((await verifySession(value))?.epoch).toBe(61);
  });

  it('falls back to the configured post-login URL when the state carries no destination', async () => {
    m(exchangeCode).mockResolvedValue({ id_token: 'idt' });
    m(verifyIdToken).mockResolvedValue({ sub: 'cognito-1' });
    m(getUserByExternalSub).mockResolvedValue(USER);
    const res = await request(buildApp())
      .get('/api/auth/callback?code=c&state=st-1')
      .set('Cookie', await stateCookie({ returnTo: '' }));
    expect(res.headers['location']).toBe('/iq');
  });

  it('prefixes the PORTAL origin in dev, so the browser does not land on a middleware 404', async () => {
    cognito.portalOrigin = 'http://localhost:5183/';
    m(exchangeCode).mockResolvedValue({ id_token: 'idt' });
    m(verifyIdToken).mockResolvedValue({ sub: 'cognito-1' });
    m(getUserByExternalSub).mockResolvedValue(USER);
    const res = await request(buildApp())
      .get('/api/auth/callback?code=c&state=st-1')
      .set('Cookie', await stateCookie({ returnTo: '/iq/sprints' }));
    expect(res.headers['location']).toBe('http://localhost:5183/iq/sprints');
  });
});

// GET /api/session/realtime-token (routes/session.ts + lib/realtime-token.ts)
// — the token bridge for the websocket-gateway and platform-api
// (docs/social-calls-plan.md step 3).
//
// Pinned here:
//   * 200 with a signed-in session: an HS256 JWT that VERIFIES with the
//     configured secret and carries the briefed claims (sub, displayName, org,
//     tenants, role, iss, aud, a 10-minute exp, tokenKind), plus the optional
//     gateway / platform-api URLs only when configured.
//   * 401 with no session once the demo fallback is off (IdP configured).
//   * the org claim follows a tenant switch — a real cookie round trip through
//     cookie-parser + sessionMiddleware, not an injected session.
//   * masquerade: the token is the impersonated user, `act.sub` the operator.
//   * external_sub and email ride along when the directory has them, and
//     given_name / family_name split displayName (the SKIP_AUTH gateway reads
//     those, not displayName).
//   * production with REALTIME_JWT_SECRET unset → 503, never a dev-signed token.
//
// config.ts uses import.meta and aws-jwt-verify is ESM — mocked the same way
// auth-session.test.ts does it.

jest.mock('../../config.js', () => ({
  config: {
    region: 'us-east-1',
    auth: { sessionSigningSecretArn: '', policyStoreId: '' },
    aurora: { clusterArn: '', secretArn: '', database: 'orgiq' },
    cognito: {
      userPoolId: '', clientId: '', clientSecret: '', domain: '', callbackUrl: '',
      postLoginUrl: '/', logoutRedirectUrl: '/',
    },
    realtime: { gatewayUrl: undefined, platformApiUrl: undefined, videoUrl: undefined },
  },
}));
jest.mock('aws-jwt-verify', () => ({
  CognitoJwtVerifier: { create: () => ({ verify: async () => ({}) }) },
}));
jest.mock('../../providers/identity.js', () => ({
  listUsers: jest.fn(async () => []),
  getUser: jest.fn(async (id: string) => {
    if (id === 'u-operator') {
      return { id, displayName: 'Platform Operator', email: null, personId: null,
        grants: { orgiq: ['admin'], assessment: ['admin'] }, epoch: 0, externalSub: null };
    }
    if (id === 'u-sso') {
      return { id, displayName: 'Sso User', email: 'sso.user@orgiq.example', personId: null,
        grants: { orgiq: ['member'] }, epoch: 0, externalSub: 'cognito-sub-123' };
    }
    return null;
  }),
  getUserByExternalSub: jest.fn(async () => null),
  getUserByEmail: jest.fn(async () => null),
  linkExternalSub: jest.fn(async () => undefined),
  bumpSessionEpoch: jest.fn(async () => 0),
}));

import express from 'express';
import cookieParser from 'cookie-parser';
import { jwtVerify, decodeProtectedHeader } from 'jose';
import request from '../../test-support/http.js';
import { config } from '../../config.js';
import { sessionRouter } from '../session.js';
import { resetRateLimits } from '../../lib/rate-limit.js';
import { sessionMiddleware, type Session } from '../../lib/session.js';

const SECRET = 'test-realtime-secret';
const key = new TextEncoder().encode(SECRET);

async function verify(token: string) {
  const { payload } = await jwtVerify(token, key, { issuer: 'orgiq-middleware', audience: 'realtime' });
  return payload as Record<string, unknown>;
}

/** Injected-session app (the masquerade-stop/epoch test pattern). */
function appAs(session: Session | null) {
  const app = express();
  app.use(express.json());
  if (session) app.use((req, _res, next) => { req.session = session; next(); });
  app.use('/api/session', sessionRouter);
  return app;
}

/** Real cookie round trip, as index.ts mounts it. */
function cookieApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(sessionMiddleware());
  app.use('/api/session', sessionRouter);
  return app;
}

function sessionCookie(res: request.Response): string {
  const raw = res.headers['set-cookie'];
  const arr = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const c = arr.map((s: string) => s.split(';')[0]!)
    .filter((s: string) => s.startsWith('orgiq.session=') && s.length > 'orgiq.session='.length);
  return c[c.length - 1]!;
}

const cognito = (config as unknown as { cognito: Record<string, string> }).cognito;
const realtime = (config as unknown as { realtime: Record<string, string | undefined> }).realtime;
const ORIGINAL_ENV = process.env['NODE_ENV'];

const MEMBER: Session = {
  sub: 'u-alice', name: 'Alice', role: 'member', tenant: 'orgiq',
  grants: { orgiq: ['member'], assessment: ['assessor'] }, iat: Math.floor(Date.now() / 1000),
};

beforeEach(() => {
  resetRateLimits();
  process.env['REALTIME_JWT_SECRET'] = SECRET;
  realtime['gatewayUrl'] = undefined;
  realtime['platformApiUrl'] = undefined;
  realtime['videoUrl'] = undefined;
});
afterEach(() => {
  delete process.env['REALTIME_JWT_SECRET'];
  process.env['NODE_ENV'] = ORIGINAL_ENV;
  for (const k of ['userPoolId', 'clientId', 'clientSecret', 'domain', 'callbackUrl']) cognito[k] = '';
});

describe('GET /api/session/realtime-token', () => {
  it('carries the generic demo portrait without borrowing a directory identity', async () => {
    const res = await request(appAs({ ...MEMBER, sub: 'demo-user', name: 'Demo User' })).get('/api/session/realtime-token');
    expect(res.status).toBe(200);
    expect(await verify(res.body.token)).toMatchObject({ sub: 'demo-user', displayName: 'Demo User', avatarUrl: '/avatars/photos/demo-user.jpg' });
  });

  it('200s with an HS256 token carrying the effective identity', async () => {
    const before = Math.floor(Date.now() / 1000);
    const res = await request(appAs(MEMBER)).get('/api/session/realtime-token');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(decodeProtectedHeader(res.body.token).alg).toBe('HS256');
    const claims = await verify(res.body.token);
    expect(claims).toMatchObject({
      sub: 'u-alice', displayName: 'Alice', org: 'orgiq', role: 'member',
      tenants: ['orgiq', 'assessment'], iss: 'orgiq-middleware', aud: 'realtime',
      tokenKind: 'orgiq-hs256',
    });
    // A single-word name: given_name is the whole thing, family_name is ''.
    expect(claims['given_name']).toBe('Alice');
    expect(claims['family_name']).toBe('');
    expect(claims['act']).toBeUndefined();
    expect(claims['external_sub']).toBeUndefined();
    expect(claims['email']).toBeUndefined();
    const exp = claims['exp'] as number;
    const iat = claims['iat'] as number;
    expect(exp - iat).toBe(600);
    expect(iat).toBeGreaterThanOrEqual(before);
    expect(res.body.expiresAt).toBe(new Date(exp * 1000).toISOString());
    // Unset URLs are omitted, not sent as empty strings.
    expect(res.body).not.toHaveProperty('gatewayUrl');
    expect(res.body).not.toHaveProperty('platformApiUrl');
    expect(res.body).not.toHaveProperty('videoUrl');
  });

  it('echoes the gateway, platform-api and video URLs when configured (the portal reads them instead of VITE_* URLs)', async () => {
    realtime['gatewayUrl'] = 'ws://localhost:18080';
    realtime['platformApiUrl'] = 'http://localhost:13001';
    realtime['videoUrl'] = 'http://localhost:3901';
    const res = await request(appAs(MEMBER)).get('/api/session/realtime-token');
    expect(res.status).toBe(200);
    expect(res.body.gatewayUrl).toBe('ws://localhost:18080');
    expect(res.body.platformApiUrl).toBe('http://localhost:13001');
    expect(res.body.videoUrl).toBe('http://localhost:3901');
  });

  it('a token signed with another secret does not verify', async () => {
    const res = await request(appAs(MEMBER)).get('/api/session/realtime-token');
    await expect(jwtVerify(res.body.token, new TextEncoder().encode('wrong'))).rejects.toThrow();
  });

  it('401s without a session once the demo fallback is off', async () => {
    cognito['userPoolId'] = 'us-east-1_TEST';
    cognito['clientId'] = 'client123';
    cognito['clientSecret'] = 'secret123';
    cognito['domain'] = 'orgiq-auth.auth.us-east-1.amazoncognito.com';
    cognito['callbackUrl'] = 'http://localhost:3001/api/auth/callback';
    const res = await request(appAs(null)).get('/api/session/realtime-token');
    expect(res.status).toBe(401);
    expect(res.body.token).toBeUndefined();
  });

  it('the org claim follows a tenant switch (real cookie round trip)', async () => {
    const app = cookieApp();
    const login = await request(app).post('/api/session/login').send({ userId: 'u-operator' });
    expect(login.status).toBe(200);
    let cookie = sessionCookie(login);

    const first = await request(app).get('/api/session/realtime-token').set('Cookie', cookie);
    expect(first.status).toBe(200);
    expect((await verify(first.body.token))['org']).toBe('orgiq');

    const switched = await request(app).post('/api/session/tenant').set('Cookie', cookie).send({ tenant: 'assessment' });
    expect(switched.status).toBe(200);
    cookie = sessionCookie(switched);

    const second = await request(app).get('/api/session/realtime-token').set('Cookie', cookie);
    const claims = await verify(second.body.token);
    expect(claims['org']).toBe('assessment');
    expect(claims['sub']).toBe('u-operator');
    expect(claims['tenants']).toEqual(['orgiq', 'assessment']);
  });

  it('while masquerading, the token is the impersonated user and act names the operator', async () => {
    const masquerading: Session = {
      sub: 'u-alice', name: 'Alice', role: 'member', tenant: 'orgiq', grants: { orgiq: ['member'] },
      iat: Math.floor(Date.now() / 1000),
      act: { sub: 'u-operator', role: 'admin', tenant: 'orgiq', grants: { orgiq: ['admin'] } },
    };
    const res = await request(appAs(masquerading)).get('/api/session/realtime-token');
    expect(res.status).toBe(200);
    const claims = await verify(res.body.token);
    expect(claims['sub']).toBe('u-alice');
    expect(claims['role']).toBe('member');
    expect(claims['epoch']).toBe(0);
    expect(claims['act']).toEqual({ sub: 'u-operator', epoch: 0 });
  });

  it('carries external_sub, email and the split name from the directory', async () => {
    const sso: Session = {
      sub: 'u-sso', name: 'Sso User', role: 'member', tenant: 'orgiq', grants: { orgiq: ['member'] },
      iat: Math.floor(Date.now() / 1000),
    };
    const res = await request(appAs(sso)).get('/api/session/realtime-token');
    const claims = await verify(res.body.token);
    expect(claims['external_sub']).toBe('cognito-sub-123');
    expect(claims['email']).toBe('sso.user@orgiq.example');
    expect(claims['given_name']).toBe('Sso');
    expect(claims['family_name']).toBe('User');
  });

  it('503s in production when REALTIME_JWT_SECRET is unset', async () => {
    delete process.env['REALTIME_JWT_SECRET'];
    process.env['NODE_ENV'] = 'production';
    const res = await request(appAs(MEMBER)).get('/api/session/realtime-token');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'realtime token signing unavailable' });
  });

  it('signs with the dev secret in development when REALTIME_JWT_SECRET is unset', async () => {
    delete process.env['REALTIME_JWT_SECRET'];
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await request(appAs(MEMBER)).get('/api/session/realtime-token');
    expect(res.status).toBe(200);
    const { payload } = await jwtVerify(res.body.token, new TextEncoder().encode('orgiq-dev-realtime'));
    expect(payload['sub']).toBe('u-alice');
    warn.mockRestore();
  });
});

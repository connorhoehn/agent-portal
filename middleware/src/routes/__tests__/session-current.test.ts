// The shell's /me must use the same fresh provenance as Communication, even
// before sessionMiddleware's 120-second cookie-grants refresh is due.
jest.mock('../../config.js', () => ({ config: {
  region: 'us-east-1', auth: { sessionSigningSecretArn: '', policyStoreId: '' },
  aurora: {}, cognito: {}, mock: { aurora: true },
} }));
jest.mock('aws-jwt-verify', () => ({ CognitoJwtVerifier: { create: () => ({ verify: async () => ({}) }) } }));
jest.mock('../../providers/identity.js', () => ({ getUser: jest.fn(), listUsers: jest.fn(async () => []), bumpSessionEpoch: jest.fn() }));

import express from 'express';
import cookieParser from 'cookie-parser';
import request from '../../test-support/http.js';
import { getUser, type UserInfo } from '../../providers/identity.js';
import { AppError, errorHandler } from '../../lib/async-handler.js';
import { sessionRouter } from '../session.js';
import { sessionMiddleware, setGrantsResolver, signSession, type Session } from '../../lib/session.js';
import { requireSession } from '../../lib/authz.js';
import { currentLiveSession } from '../../lib/live-principal.js';

const signed: Session = { sub: 'current-fixture', name: 'Old label', role: 'member', tenant: 'orgiq',
  grants: { orgiq: ['member'] }, epoch: 3, iat: Math.floor(Date.now() / 1000) };
let directory: Map<string, UserInfo>;
const appAs = (session = signed) => {
  const app = express();
  app.use((req, _res, next) => { req.session = session; next(); });
  app.get('/upstream-401', (_req, _res, next) => next(new AppError(401, 'Upstream authentication failed')));
  app.get('/forbidden', (_req, _res, next) => next(new AppError(403, 'Forbidden')));
  app.use('/api/session', sessionRouter); app.use(errorHandler);
  return app;
};
const cookieApp = () => {
  const app = express(); app.use(express.json()); app.use(cookieParser()); app.use(sessionMiddleware());
  app.get('/protected', requireSession('Fixture'), (_req, res) => res.json({ private: true }));
  app.get('/strict', requireSession('Fixture'), async (req, res, next) => {
    try { await currentLiveSession(req.session!); res.json({ private: true }); } catch (error) { next(error); }
  });
  app.use('/api/session', sessionRouter); app.use(errorHandler); return app;
};
beforeEach(() => {
  directory = new Map([[signed.sub, { id: signed.sub, displayName: 'Current label', email: null, personId: null,
    grants: { orgiq: ['member', 'sme'], social: ['participant'] }, epoch: 3 }]]);
  jest.mocked(getUser).mockImplementation(async id => {
    const user = directory.get(id); return user ? structuredClone(user) : null;
  });
  setGrantsResolver(async id => {
    const user = await getUser(id, { authoritative: true });
    return user ? { displayName: user.displayName, grants: user.grants, epoch: user.epoch } : null;
  });
});
afterEach(() => jest.clearAllMocks());

it('publishes current presentation/grants while preserving the exact signed actor, tenant and role', async () => {
  const response = await request(appAs()).get('/api/session/me');
  expect(response.status).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.body).toMatchObject({ sub: signed.sub, name: 'Current label', role: 'member', tenant: 'orgiq',
    grants: { orgiq: ['member', 'sme'], social: ['participant'] } });
  expect(getUser).toHaveBeenCalledWith(signed.sub, { authoritative: true });
});

it.each(['epoch', 'role', 'missing'] as const)('tags a %s refusal immediately without issuing a replacement/demo cookie', async reason => {
  if (reason === 'epoch') directory.get(signed.sub)!.epoch = 4;
  if (reason === 'role') directory.get(signed.sub)!.grants.orgiq = ['sme'];
  if (reason === 'missing') directory.delete(signed.sub);
  const response = await request(appAs()).get('/api/session/me');
  expect(response.status).toBe(401);
  expect(response.body).toMatchObject({ code: 'SESSION_INVALID', ssoRequired: false });
  expect(response.body.sub).toBeUndefined();
  expect(response.headers['set-cookie']).toBeUndefined();
});

it('checks the real masquerade actor independently of the effective account', async () => {
  directory.set('actor-fixture', { id: 'actor-fixture', displayName: 'Actor', email: null, personId: null,
    grants: { orgiq: ['admin'] }, epoch: 7 });
  const masquerade: Session = { ...signed, act: { sub: 'actor-fixture', tenant: 'orgiq', role: 'admin', grants: { orgiq: ['admin'] }, epoch: 6 } };
  const response = await request(appAs(masquerade)).get('/api/session/me');
  expect(response.status).toBe(401); expect(response.body.code).toBe('SESSION_INVALID');
});

it('keeps an identity-store outage, upstream 401 and policy 403 distinct from a retired session', async () => {
  jest.mocked(getUser).mockRejectedValueOnce(new Error('Directory unavailable'));
  const outage = await request(appAs()).get('/api/session/me');
  expect(outage.status).toBe(503); expect(outage.body.code).toBeUndefined();
  for (const [path, status] of [['/upstream-401', 401], ['/forbidden', 403]] as const) {
    const response = await request(appAs()).get(path);
    expect(response.status).toBe(status); expect(response.body.code).toBeUndefined();
  }
});

describe('presented credentials never become anonymous demo authority', () => {
  const old = () => ({ ...signed, iat: Math.floor(Date.now() / 1000) - 200 });
  it.each(['epoch', 'role', 'deleted', 'expired', 'bad-signature'] as const)('rejects an aged %s cookie with the shared protocol on /me and normal guards', async reason => {
    let source = old();
    if (reason === 'epoch') directory.get(signed.sub)!.epoch = 4;
    if (reason === 'role') directory.get(signed.sub)!.grants.orgiq = ['sme'];
    if (reason === 'deleted') directory.delete(signed.sub);
    if (reason === 'expired') source = { ...source, iat: Math.floor(Date.now() / 1000) - 13 * 3600 };
    const cookie = reason === 'bad-signature' ? 'invalid.signature' : await signSession(source);
    const app = cookieApp();
    for (const path of ['/api/session/me', '/protected', '/strict']) {
      const response = await request(app).get(path).set('Cookie', `orgiq.session=${cookie}`);
      expect(response.status).toBe(401); expect(response.body.code).toBe('SESSION_INVALID');
      expect(response.body.sub).toBeUndefined(); expect(response.body.private).toBeUndefined();
    }
  });

  it('preserves cookie-less dev fallback and the picker recovery door despite a rejected cookie', async () => {
    const app = cookieApp();
    const anonymous = await request(app).get('/api/session/me');
    expect(anonymous.status).toBe(200); expect(anonymous.body.sub).toBe('demo-user');
    const picker = await request(app).get('/api/session/users').set('Cookie', 'orgiq.session=invalid.signature');
    expect(picker.status).toBe(200);
    const login = await request(app).post('/api/session/login').set('Cookie', 'orgiq.session=invalid.signature').send({ userId: signed.sub });
    expect(login.status).toBe(200); expect(login.body.sub).toBe(signed.sub);
  });

  it('does not label a directory outage as a bad cookie, while fresh authority still refuses with 503', async () => {
    const cookie = await signSession(old());
    jest.mocked(getUser).mockRejectedValue(new Error('Directory unavailable'));
    const response = await request(cookieApp()).get('/strict').set('Cookie', `orgiq.session=${cookie}`);
    expect(response.status).toBe(503); expect(response.body.code).toBeUndefined();
    expect(response.headers['set-cookie']).toBeUndefined();
  });
});

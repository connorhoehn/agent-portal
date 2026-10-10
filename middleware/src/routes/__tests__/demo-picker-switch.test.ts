// The context picker is two calls: POST /tenant, then POST /role. For the
// cookie-less demo identity the first narrows the cookie to the tenant's
// fallback role (that is the point — the persona BECOMES the role), which
// must not make the second call a 403. Validation runs against what the demo
// persona may become, not against the cookie it was just narrowed to.

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
jest.mock('../../providers/identity.js', () => ({
  listUsers: jest.fn(async () => []),
  getUser: jest.fn(async () => null),
  bumpSessionEpoch: jest.fn(async () => 1),
}));

import express from 'express';
import request from '../../test-support/http.js';
import { sessionRouter } from '../session.js';
import { resetRateLimits } from '../../lib/rate-limit.js';
import { DEMO_SUB, permissiveGrants, type Session } from '../../lib/session.js';

function buildApp(session: Session) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = session; next(); });
  app.use('/api/session', sessionRouter);
  return app;
}

function issuedPayload(res: request.Response): Record<string, unknown> {
  const raw = res.headers['set-cookie'];
  const arr = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const set = arr.map(c => c.split(';')[0]!).filter(c => c.startsWith('orgiq.session='));
  const value = set.map(c => c.slice('orgiq.session='.length)).find(v => v.length > 0)!;
  return JSON.parse(Buffer.from(value.split('.')[0]!, 'base64url').toString('utf8'));
}

const demo: Session = {
  sub: DEMO_SUB, name: 'Demo User', role: 'member', tenant: 'orgiq',
  grants: permissiveGrants(), iat: Math.floor(Date.now() / 1000), epoch: 0,
};

beforeEach(() => resetRateLimits());

describe('demo picker: /tenant then /role', () => {
  it('lands on program-lead after the tenant switch narrowed the cookie to assessor', async () => {
    const first = await request(buildApp(demo)).post('/api/session/tenant').send({ tenant: 'assessment' });
    expect(first.status).toBe(200);
    const narrowed = issuedPayload(first);
    expect(narrowed.grants).toEqual({ assessment: ['assessor'] });

    // The portal's second call runs with the narrowed cookie.
    const second = await request(buildApp(narrowed as unknown as Session))
      .post('/api/session/role').send({ role: 'program-lead' });
    expect(second.status).toBe(200);
    expect(issuedPayload(second).grants).toEqual({ assessment: ['program-lead'] });
  });

  it('a narrowed demo persona can still leave for another tenant, or become admin', async () => {
    const sme: Session = { ...demo, role: 'sme', grants: { orgiq: ['sme'] } };
    const out = await request(buildApp(sme)).post('/api/session/tenant').send({ tenant: 'assessment' });
    expect(out.status).toBe(200);
    expect(issuedPayload(out).grants).toEqual({ assessment: ['assessor'] });
    const admin = await request(buildApp(sme)).post('/api/session/role').send({ role: 'admin' });
    expect(admin.status).toBe(200);
    expect(issuedPayload(admin).grants).toEqual(permissiveGrants());
  });

  it('a real user is still held to the grants in the cookie', async () => {
    const nora: Session = { ...demo, sub: 'u-nora', role: 'sme', grants: { orgiq: ['sme'] } };
    expect((await request(buildApp(nora)).post('/api/session/tenant').send({ tenant: 'assessment' })).status).toBe(403);
    expect((await request(buildApp(nora)).post('/api/session/role').send({ role: 'org-leader' })).status).toBe(403);
  });
});

// The picker offers what the identity may BECOME (`switchable`), the
// session carries what it IS (`grants`). A narrowed demo persona still sees
// every persona on /workspaces; a real user sees exactly their grants.
describe('GET /me exposes switchable grants', () => {
  it('is the permissive set for the demo persona and the real grants for a user', async () => {
    const narrowed: Session = { ...demo, role: 'program-lead', tenant: 'assessment', grants: { assessment: ['program-lead'] } };
    const me = await request(buildApp(narrowed)).get('/api/session/me');
    expect(me.status).toBe(200);
    expect(me.body.grants).toEqual({ assessment: ['program-lead'] });
    expect(me.body.switchable).toEqual(permissiveGrants());
    expect(me.body.availableTenants).toEqual(['assessment']);
    const nora: Session = { ...demo, sub: 'u-nora', role: 'sme', grants: { orgiq: ['sme'] } };
    const meNora = await request(buildApp(nora)).get('/api/session/me');
    expect(meNora.body.switchable).toEqual({ orgiq: ['sme'] });
  });
});

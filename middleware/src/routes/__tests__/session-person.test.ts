// GET /api/session/person — which org-graph person the session's account is
// connected to.
//
// What is pinned:
//   * the cookie-less demo persona reads UNLINKED — the Initiatives "Mine"
//     empty state's "connect your profile" copy is for exactly this account,
//   * a seeded member (u-theo) reads linked to p-001,
//   * u-release reads linked (p-005) even though p-005 owns and SMEs nothing —
//     "linked" and "has initiatives" are different questions, and the page
//     needs both answers to pick its copy (the list half is pinned in
//     providers/__tests__/projects-initiatives-fixture.test.ts),
//   * no session and no demo fallback is a 401, not an "unlinked" 200 — an
//     anonymous caller has no account to be linked or not.
//
// The identity provider is the REAL one: with Aurora unconfigured it answers
// from its seed mirror (FALLBACK_USERS), which is what dev:mock reads.

jest.mock('../../config.js', () => ({
  config: {
    region: 'us-east-1',
    mock: { aurora: true },
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

import express from 'express';
import request from '../../test-support/http.js';
import { sessionRouter } from '../session.js';

type FakeSession = { sub: string; name: string; role: string; tenant: string; grants: Record<string, string[]>; iat: number };

function buildApp(session: FakeSession | null) {
  const app = express();
  app.use((req, _res, next) => {
    if (session) (req as unknown as { session: FakeSession }).session = session;
    next();
  });
  app.use('/api/session', sessionRouter);
  return app;
}

function sessionFor(sub: string): FakeSession {
  return { sub, name: sub, role: 'member', tenant: 'orgiq', grants: { orgiq: ['member'] }, iat: 0 };
}

const savedDemo = process.env['AUTH_DEMO_MODE'];
const savedEnv = process.env['NODE_ENV'];
afterEach(() => {
  if (savedDemo === undefined) delete process.env['AUTH_DEMO_MODE'];
  else process.env['AUTH_DEMO_MODE'] = savedDemo;
  process.env['NODE_ENV'] = savedEnv;
});

describe('GET /api/session/person', () => {
  it('reads the cookie-less demo persona as unlinked', async () => {
    process.env['AUTH_DEMO_MODE'] = 'true';
    const res = await request(buildApp(null)).get('/api/session/person');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ linked: false, personId: null });
  });

  it('reads a seeded member as linked to their person', async () => {
    const res = await request(buildApp(sessionFor('u-theo'))).get('/api/session/person');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ linked: true, personId: 'p-001' });
  });

  it('reads the release manager as linked even though p-005 is on no initiative', async () => {
    const res = await request(buildApp(sessionFor('u-release'))).get('/api/session/person');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ linked: true, personId: 'p-005' });
  });

  it('reads an account with no person (hr-admin u-hr) as unlinked', async () => {
    const res = await request(buildApp(sessionFor('u-hr'))).get('/api/session/person');
    expect(res.body).toEqual({ linked: false, personId: null });
  });

  it('401s with no session and no demo fallback', async () => {
    process.env['NODE_ENV'] = 'production';
    delete process.env['AUTH_DEMO_MODE'];
    const res = await request(buildApp(null)).get('/api/session/person');
    expect(res.status).toBe(401);
    expect(res.body).not.toHaveProperty('linked');
  });
});

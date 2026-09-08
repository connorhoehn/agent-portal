// GET /api/session/capabilities + no-5xx-on-permission tests:
//   1. The capabilities endpoint evaluates every CAPABILITY_ACTIONS id through
//      the same evaluate() path requireAction uses (AVP + decision cache) and
//      reports { actions, role, tenant, degraded }.
//   2. An AVP outage degrades (per-action false + degraded: true) instead of
//      500ing; anonymous-with-Cognito stays 401 { ssoRequired }.
//   3. requireAction returns 503 { error: 'authorization unavailable' } when
//      the evaluation itself fails — DENY stays 403, ALLOW passes.
//
// config.ts uses import.meta and aws-jwt-verify is ESM — both are mocked so
// the CJS test build can load the modules (same pattern as auth-session.test.ts).

const mockSend = jest.fn();

jest.mock('../../config.js', () => ({
  config: {
    region: 'us-east-1',
    // policyStoreId non-empty so evaluate() actually calls AVP (mocked below).
    auth: { sessionSigningSecretArn: '', policyStoreId: 'ps-test' },
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
}));
jest.mock('@aws-sdk/client-verifiedpermissions', () => ({
  VerifiedPermissionsClient: class {
    send(cmd: unknown) { return mockSend(cmd); }
  },
  IsAuthorizedCommand: class {
    constructor(public readonly input: unknown) {}
  },
}));

import express from 'express';
import request from '../../test-support/http.js';
import { config } from '../../config.js';
import { sessionRouter } from '../session.js';
import { requireAction, clearAuthzCache, CAPABILITY_ACTIONS } from '../../lib/authz.js';
import { resetRateLimits } from '../../lib/rate-limit.js';

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
  app.get('/gated', requireAction('ManageDevbox'), (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

/** The actionId a mocked IsAuthorizedCommand asks about. */
function actionIdOf(cmd: unknown): string {
  return (cmd as { input: { action: { actionId: string } } }).input.action.actionId;
}

function allow() { return Promise.resolve({ decision: 'ALLOW' }); }
function deny() { return Promise.resolve({ decision: 'DENY' }); }

beforeEach(() => {
  mockSend.mockReset();
  clearAuthzCache();
  resetRateLimits();
  setCognito(false);
});

afterEach(() => setCognito(false));

describe('GET /api/session/capabilities', () => {
  it('reports every capability action true when AVP allows everything', async () => {
    mockSend.mockImplementation(allow);
    const res = await request(buildApp()).get('/api/session/capabilities');
    expect(res.status).toBe(200);
    expect(res.body.degraded).toBe(false);
    expect(res.body.role).toBe('member');
    expect(typeof res.body.tenant).toBe('string');
    expect(Object.keys(res.body.actions).sort()).toEqual([...CAPABILITY_ACTIONS].sort());
    for (const action of CAPABILITY_ACTIONS) {
      expect(res.body.actions[action]).toBe(true);
    }
  });

  it('reports every action false when AVP denies everything (still 200, not degraded)', async () => {
    mockSend.mockImplementation(deny);
    const res = await request(buildApp()).get('/api/session/capabilities');
    expect(res.status).toBe(200);
    expect(res.body.degraded).toBe(false);
    for (const action of CAPABILITY_ACTIONS) {
      expect(res.body.actions[action]).toBe(false);
    }
  });

  it('mixes decisions per action', async () => {
    const allowed = new Set(['ManageDevbox', 'Search']);
    mockSend.mockImplementation((cmd: unknown) =>
      allowed.has(actionIdOf(cmd)) ? allow() : deny());
    const res = await request(buildApp()).get('/api/session/capabilities');
    expect(res.status).toBe(200);
    expect(res.body.degraded).toBe(false);
    expect(res.body.actions['ManageDevbox']).toBe(true);
    expect(res.body.actions['Search']).toBe(true);
    expect(res.body.actions['ManageUsers']).toBe(false);
    expect(res.body.actions['ApproveTransaction']).toBe(false);
  });

  it('degrades (per-action false + degraded flag) when AVP is down — never 500', async () => {
    mockSend.mockImplementation(() => Promise.reject(new Error('AVP unreachable')));
    const res = await request(buildApp()).get('/api/session/capabilities');
    expect(res.status).toBe(200);
    expect(res.body.degraded).toBe(true);
    for (const action of CAPABILITY_ACTIONS) {
      expect(res.body.actions[action]).toBe(false);
    }
  });

  it('flags degraded on a partial outage while keeping the healthy decisions', async () => {
    mockSend.mockImplementation((cmd: unknown) =>
      actionIdOf(cmd) === 'ManageKB'
        ? Promise.reject(new Error('throttled'))
        : allow());
    const res = await request(buildApp()).get('/api/session/capabilities');
    expect(res.status).toBe(200);
    expect(res.body.degraded).toBe(true);
    expect(res.body.actions['ManageKB']).toBe(false);
    expect(res.body.actions['ManageDevbox']).toBe(true);
  });

  it('serves the second call from the decision cache (same cache requireAction uses)', async () => {
    mockSend.mockImplementation(allow);
    const app = buildApp();
    await request(app).get('/api/session/capabilities');
    const callsAfterFirst = mockSend.mock.calls.length;
    expect(callsAfterFirst).toBe(CAPABILITY_ACTIONS.length);
    const res = await request(app).get('/api/session/capabilities');
    expect(res.status).toBe(200);
    expect(mockSend.mock.calls.length).toBe(callsAfterFirst); // no new AVP calls
  });

  it('401s an anonymous request with ssoRequired once Cognito is on', async () => {
    setCognito(true);
    const res = await request(buildApp()).get('/api/session/capabilities');
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: 'Unauthenticated', ssoRequired: true });
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('requireAction on authorization-infrastructure failure', () => {
  it('returns 503 authorization unavailable when evaluate() throws', async () => {
    mockSend.mockImplementation(() => Promise.reject(new Error('AVP unreachable')));
    const res = await request(buildApp()).get('/gated');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'authorization unavailable', action: 'ManageDevbox' });
  });

  it('still 403s a real DENY', async () => {
    mockSend.mockImplementation(deny);
    const res = await request(buildApp()).get('/gated');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'Forbidden', action: 'ManageDevbox' });
  });

  it('passes through on ALLOW', async () => {
    mockSend.mockImplementation(allow);
    const res = await request(buildApp()).get('/gated');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('still 401s anonymous (ssoRequired) once Cognito is on', async () => {
    setCognito(true);
    const res = await request(buildApp()).get('/gated');
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: 'Unauthenticated', ssoRequired: true });
  });
});

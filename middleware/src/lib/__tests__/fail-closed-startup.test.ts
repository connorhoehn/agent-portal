// Fail-closed defaults for the middleware (docs/fail-open-audit.md, 2026-11-07).
//
// One assertion per security decision that depends on an unset or default
// value. Every test starts from NOTHING SET: NODE_ENV deleted (jest sets it to
// `test`), no secrets, no INSECURE_DEV_MODE, no AUTH_DEMO_MODE, no MOCK_*.
// Each assertion states the fail-closed behaviour the audit asks for. Where
// the code is open today the test is `test.failing`, so this file is green
// now and turns red — "this gap closed, drop the `.failing`" — as each default
// is fixed. A plain test beside it pins the production branch, which already
// fails closed, so nobody can "fix" a gap by widening production.
//
// Entry points: lib/runtime-profile.ts is the only static start-up check
// (index.ts exits 2 on its problems) and it never reads NODE_ENV or a secret.
// config.ts cannot be imported under the CommonJS jest build (import.meta), so
// it is mocked with every value unset, which is exactly the scenario.

jest.mock('../../config.js', () => ({
  config: {
    region: 'us-east-1',
    auth: { policyStoreId: '', sessionSigningSecretArn: '' },
    cognito: { userPoolId: '', clientId: '', clientSecret: '', domain: '', callbackUrl: '', portalOrigin: '' },
    aurora: { clusterArn: '', secretArn: '', database: 'orgiq' },
    // Read live so mockControlEnabled() sees the MOCK_* flags a test sets.
    get mock() {
      return {
        aurora: process.env['MOCK_AURORA'] === 'true', agentcore: process.env['MOCK_AGENTCORE'] === 'true',
        guardrails: false, cloudwatch: false,
      };
    },
  },
}));
// Open-mode authz decides from the Cedar seeds through role-registry (import.meta there too).
jest.mock('../role-registry.js', () => ({ roleRegistry: () => jest.requireActual('../../test-support/seed-roles').seedRoleRegistry() }));
jest.mock('@aws-sdk/client-verifiedpermissions', () => ({
  VerifiedPermissionsClient: class { send() { return Promise.resolve({}); } },
  IsAuthorizedCommand: class {},
}));
const auroraExec = jest.fn(async () => undefined);
jest.mock('../../providers/aurora.js', () => ({ exec: (...args: unknown[]) => auroraExec(...(args as [])) }));

import express from 'express';
import request from 'supertest';
import type { Request, Response } from 'express';
import { resolveRuntimeProfile, validateRuntimeProfile } from '../runtime-profile.js';
import { assertDemoModeAllowed, demoFallbackAllowed, demoModeEnabled, sessionMiddleware, signSession, type Session } from '../session.js';
import { isAllowed } from '../authz.js';
import {
  APPROVALS_SERVICE_AUTH, ASSESSMENT_RUN_COMPLETE_SERVICE_AUTH, HARNESS_TRACE_SERVICE_AUTH, LAB_CALLBACK_SERVICE_AUTH,
  MOCK_CONTROL_SERVICE_AUTH, legacyHeadersAccepted, requireServiceAuth, serviceAuthOr, type ServiceAuthSpec,
} from '../service-auth.js';
import { legacyBodyOnlyAccepted } from '../internal-service-auth.js';
import { DEV_REALTIME_SECRET, realtimeSigningSecret } from '../realtime-token.js';
import { realtimeGatewayEnabled } from '../gateway/auth.js';
import { authorityCacheEnabled, inboundRateLimit } from '../gateway/env.js';
import { gatewayUploadConfig } from '../gateway-attachments.js';
import { isAllowedBrowserOrigin } from '../browser-origin.js';
import { trustedProxyHops } from '../trusted-proxy.js';
import { budgetFailClosed } from '../budget-decisions.js';
import { rlsEnforced } from '../../providers/db-tenant.js';
import { twoPersonRuleOn } from '../sdlc-policy-governance.js';
import { allowedRepoHosts } from '../local-compute-repo.js';
import { mockControlEnabled } from '../../routes/mock-control.js';
import { testFixturesRouter } from '../../routes/test-fixtures.js';

// ── nothing set ─────────────────────────────────────────────────────────────

const ENV = [
  'NODE_ENV', 'INSECURE_DEV_MODE', 'AUTH_DEMO_MODE', 'SESSION_SIGNING_KEY_DEV', 'REALTIME_JWT_SECRET', 'REALTIME_GATEWAY',
  'REALTIME_AUTHORITY_CACHE', 'REALTIME_INBOUND_RATE_LIMIT', 'GATEWAY_UPLOADS', 'GATEWAY_UPLOAD_DIR', 'BUDGET_FAIL_CLOSED',
  'SERVICE_AUTH_LEGACY_HEADERS', 'SERVICE_AUTH_LEGACY_BODY_ONLY', 'TRUST_PROXY_HOPS', 'RLS_ENFORCE', 'CORS_ALLOWED_ORIGINS',
  'PUBLIC_BASE_URL', 'LOCAL_ALLOWED_REPO_HOSTS', 'SDLC_POLICY_TWO_PERSON', 'MOCK_AURORA', 'MOCK_AGENTCORE',
  'APPROVALS_REQUEST_SECRET', 'HARNESS_TRACE_SECRET', 'ASSESSMENT_RUN_COMPLETE_SECRET', 'LAB_CALLBACK_SECRET',
  'MOCK_CONTROL_SECRET', 'HARNESS_RUNNER_SECRET',
] as const;
const saved: Record<string, string | undefined> = {};
beforeAll(() => { for (const k of ENV) saved[k] = process.env[k]; });
beforeEach(() => { for (const k of ENV) delete process.env[k]; });
afterAll(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
// The dev-secret and RLS warnings are the point of some tests; keep the run quiet.
beforeAll(() => { jest.spyOn(console, 'warn').mockImplementation(() => undefined); });
afterAll(() => { jest.restoreAllMocks(); });

const production = () => { process.env['NODE_ENV'] = 'production'; };
const live = { aurora: false, agentcore: false, guardrails: false, cloudwatch: false };
const session: Session = { sub: 'u-test', name: 'Test', role: 'member', tenant: 'orgiq', grants: { orgiq: ['member'] }, iat: 1 };

// ── 1. start-up ─────────────────────────────────────────────────────────────

describe('start-up: lib/runtime-profile.ts', () => {
  it('a bare process starts in local-ephemeral; the profile never reads NODE_ENV or a secret', () => {
    process.env['INSECURE_DEV_MODE'] = 'true';
    const profile = resolveRuntimeProfile({ mock: live, inProcessQueue: false });
    expect(profile.profile).toBe('local-ephemeral');
    expect(validateRuntimeProfile(profile)).toEqual([]);
  });
  it('a bare process (no INSECURE_DEV_MODE, nothing configured) refuses to start', () => {
    // The convention: every open default below requires INSECURE_DEV_MODE=true,
    // and the static check names the one that is missing before listen().
    expect(validateRuntimeProfile(resolveRuntimeProfile({ mock: live, inProcessQueue: false }))).not.toEqual([]);
  });
});

// ── 2. identity: lib/session.ts ─────────────────────────────────────────────

describe('session signing key (session.ts loadSigningKey)', () => {
  // Production first: loadSigningKey caches the key it settles on, so the
  // refusal must be observed before any test signs with the dev key.
  it('production with SESSION_SIGNING_SECRET_ARN unset refuses to sign', async () => {
    production();
    await expect(signSession(session)).rejects.toThrow(/SESSION_SIGNING_SECRET_ARN is unset in production/);
  });
  it('NODE_ENV unset with no ARN refuses to sign instead of using the published dev key', async () => {
    await expect(signSession(session)).rejects.toThrow();
  });
});

describe('anonymous demo identity (session.ts demoModeEnabled / demoFallbackAllowed)', () => {
  it('production: anonymous callers hold no demo identity, AUTH_DEMO_MODE=true or not', () => {
    production();
    expect(demoModeEnabled()).toBe(false);
    expect(demoFallbackAllowed()).toBe(false);
    process.env['AUTH_DEMO_MODE'] = 'true';
    expect(demoModeEnabled()).toBe(false);
    expect(demoFallbackAllowed()).toBe(false);
    process.env['INSECURE_DEV_MODE'] = 'true';
    expect(demoModeEnabled()).toBe(false);
  });
  it('NODE_ENV unset: AUTH_DEMO_MODE alone does not turn demo mode on; only INSECURE_DEV_MODE does', () => {
    expect(demoModeEnabled()).toBe(false);
    process.env['AUTH_DEMO_MODE'] = 'true';
    expect(demoModeEnabled()).toBe(false);
    process.env['INSECURE_DEV_MODE'] = 'true';
    expect(demoModeEnabled()).toBe(true);
  });
  it('boot gate: AUTH_DEMO_MODE=true without the dev flag, or in production, refuses to start', () => {
    expect(() => assertDemoModeAllowed()).not.toThrow();
    process.env['AUTH_DEMO_MODE'] = 'true';
    expect(() => assertDemoModeAllowed()).toThrow(/AUTH_DEMO_MODE=true requires INSECURE_DEV_MODE=true/);
    process.env['INSECURE_DEV_MODE'] = 'true';
    expect(() => assertDemoModeAllowed()).not.toThrow();
    production();
    expect(() => assertDemoModeAllowed()).toThrow(/not allowed in production/);
  });
  it('NODE_ENV unset: a cookie-less request gets no session (call-access, live-principal and document-session inherit this)', async () => {
    const req = { cookies: {}, headers: {} } as unknown as Request;
    await new Promise<void>((resolve) => { void sessionMiddleware()(req, {} as Response, () => resolve()); });
    expect(req.session).toBeUndefined();
  });
});

// ── 3. authorization: lib/authz.ts ──────────────────────────────────────────

describe('no POLICY_STORE_ID (authz.ts evaluate)', () => {
  const admin = { sub: 'u-admin', role: 'admin', tenant: 'orgiq' };
  it('production denies every action', async () => {
    production();
    expect(await isAllowed(admin, 'ViewAgents')).toBe(false);
  });
  it('NODE_ENV unset denies too, instead of deciding from the seed policies', async () => {
    expect(await isAllowed(admin, 'ViewAgents')).toBe(false);
  });
});

// ── 4. machine callbacks: lib/service-auth.ts, lib/internal-service-auth.ts ──

const CALLBACKS: ServiceAuthSpec[] = [
  APPROVALS_SERVICE_AUTH, HARNESS_TRACE_SERVICE_AUTH, ASSESSMENT_RUN_COMPLETE_SERVICE_AUTH, LAB_CALLBACK_SERVICE_AUTH, MOCK_CONTROL_SERVICE_AUTH,
];
function guarded(handler: express.RequestHandler) {
  const app = express();
  app.post('/cb', handler, (_req, res) => { res.json({ ok: true }); });
  return app;
}

describe.each(CALLBACKS.map((spec) => [spec.envVar, spec] as const))('requireServiceAuth with %s unset', (_name, spec) => {
  it('production answers 503', async () => {
    production();
    expect((await request(guarded(requireServiceAuth(spec))).post('/cb')).status).toBe(503);
  });
  it('NODE_ENV unset refuses the write (401/503) instead of letting it through', async () => {
    expect((await request(guarded(requireServiceAuth(spec))).post('/cb')).status).toBeGreaterThanOrEqual(401);
  });
});

describe('serviceAuthOr (dual-caller routes) and the transition flags', () => {
  it('an unset secret never opens a human-gated route', async () => {
    const deny: express.RequestHandler = (_req, res) => { res.status(401).json({ error: 'Unauthenticated' }); };
    expect((await request(guarded(serviceAuthOr(APPROVALS_SERVICE_AUTH, deny))).post('/cb')).status).toBe(401);
  });
  it('SERVICE_AUTH_LEGACY_HEADERS unset refuses the static bearer header', () => {
    expect(legacyHeadersAccepted()).toBe(false);
  });
  it('SERVICE_AUTH_LEGACY_BODY_ONLY unset refuses the body-only envelope', () => {
    expect(legacyBodyOnlyAccepted()).toBe(false);
  });
});

// ── 5. realtime: lib/realtime-token.ts, lib/gateway/*.ts, lib/gateway-attachments.ts ──

describe('realtime token secret (realtime-token.ts realtimeSigningSecret)', () => {
  it('production with REALTIME_JWT_SECRET unset has no secret, so minting and /ws verification 503', () => {
    production();
    expect(realtimeSigningSecret()).toBeNull();
  });
  it('NODE_ENV unset has no secret either, instead of the published dev secret', () => {
    expect(realtimeSigningSecret()).not.toBe(DEV_REALTIME_SECRET);
  });
});

describe('gateway switches (gateway/auth.ts, gateway/env.ts, gateway-attachments.ts)', () => {
  it('REALTIME_GATEWAY: on outside production, off in production — a feature switch, not an auth decision', () => {
    expect(realtimeGatewayEnabled({})).toBe(true);
    expect(realtimeGatewayEnabled({ NODE_ENV: 'production' })).toBe(false);
  });
  it('the inbound rate limit and authority cache are ON with nothing set (the brakes default closed)', () => {
    expect(inboundRateLimit({})).toEqual({ framesPerSecond: 50, burst: 100 });
    expect(authorityCacheEnabled({})).toBe(true);
  });
  it('…and OFF in production until an operator sets them (documented; the audit flags the inverted default)', () => {
    expect(inboundRateLimit({ NODE_ENV: 'production' })).toBe(false);
    expect(authorityCacheEnabled({ NODE_ENV: 'production' })).toBe(false);
  });
  it('GATEWAY_UPLOADS: on outside production, off in production without a mounted dir', () => {
    expect(gatewayUploadConfig({}).enabled).toBe(true);
    expect(gatewayUploadConfig({ NODE_ENV: 'production' }).enabled).toBe(false);
    expect(gatewayUploadConfig({ NODE_ENV: 'production', GATEWAY_UPLOAD_DIR: '/data/uploads' }).enabled).toBe(true);
  });
});

// ── 6. dev planes: routes/mock-control.ts, routes/test-fixtures.ts ──────────

describe('mock control plane (mock-control.ts mockControlEnabled)', () => {
  it('nothing set: off — it needs an explicit MOCK_* flag, not just a non-production NODE_ENV', () => {
    expect(mockControlEnabled()).toBe(false);
  });
  it('MOCK_AURORA=true turns it on outside production and never in production', () => {
    process.env['MOCK_AURORA'] = 'true';
    expect(mockControlEnabled()).toBe(true);
    production();
    expect(mockControlEnabled()).toBe(false);
  });
});

describe('E2E fixture resets (test-fixtures.ts)', () => {
  const app = () => { const a = express(); a.use(express.json()); a.use('/fx', testFixturesRouter); return a; };
  beforeEach(() => { auroraExec.mockClear(); });
  it('production answers 403 and touches no table', async () => {
    production();
    expect((await request(app()).post('/fx/reset-approvals')).status).toBe(403);
    expect(auroraExec).not.toHaveBeenCalled();
  });
  it('NODE_ENV unset answers 403 too, instead of running the reset', async () => {
    expect((await request(app()).post('/fx/reset-approvals')).status).toBe(403);
  });
});

// ── 7. browser edge: lib/browser-origin.ts, lib/trusted-proxy.ts ────────────

describe('browser origin allowlist (browser-origin.ts isAllowedBrowserOrigin)', () => {
  it('the API’s own origin passes; a foreign origin is refused; production refuses localhost', () => {
    expect(isAllowedBrowserOrigin('https://api.example', 'https://api.example')).toBe(true);
    expect(isAllowedBrowserOrigin('https://evil.example', 'https://api.example')).toBe(false);
    production();
    expect(isAllowedBrowserOrigin('http://localhost:5183', 'https://api.example')).toBe(false);
  });
  it('NODE_ENV unset refuses a localhost origin too, unless INSECURE_DEV_MODE opts in', () => {
    expect(isAllowedBrowserOrigin('http://localhost:5183', 'https://api.example')).toBe(false);
  });
  it('TRUST_PROXY_HOPS unset ignores forwarding headers (closed)', () => {
    expect(trustedProxyHops()).toBe(false);
  });
});

// ── 8. money: lib/budget-decisions.ts ───────────────────────────────────────

describe('BUDGET_FAIL_CLOSED (budget-decisions.ts budgetFailClosed)', () => {
  it('production refuses on an unreadable budget; the flag overrides either way', () => {
    production();
    expect(budgetFailClosed()).toBe(true);
    process.env['BUDGET_FAIL_CLOSED'] = 'false';
    expect(budgetFailClosed()).toBe(false);
  });
  it('NODE_ENV unset refuses too, instead of spending unbraked', () => {
    expect(budgetFailClosed()).toBe(true);
  });
});

// ── 9. data: providers/db-tenant.ts ─────────────────────────────────────────

describe('RLS_ENFORCE (db-tenant.ts rlsEnforced)', () => {
  it('the flag wins when set', () => {
    process.env['RLS_ENFORCE'] = 'true';
    expect(rlsEnforced()).toBe(true);
    process.env['RLS_ENFORCE'] = 'false';
    expect(rlsEnforced()).toBe(false);
  });
  it('unset with no AURORA_SECRET_ARN enforces (the master-login fallback should have to ask for it)', () => {
    expect(rlsEnforced()).toBe(true);
  });
});

// ── 10. closed by default already ───────────────────────────────────────────

describe('defaults that already fail closed', () => {
  it('SDLC_POLICY_TWO_PERSON is on unless set to off', () => { expect(twoPersonRuleOn()).toBe(true); });
  it('LOCAL_ALLOWED_REPO_HOSTS unset means github.com only', () => { expect(allowedRepoHosts()).toEqual(['github.com']); });
});

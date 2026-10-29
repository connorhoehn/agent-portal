// src/routes/__tests__/devbox-profile-routes.test.ts
//
// DE-40 done-when, at the routes: an unlisted model is a 400 naming the
// allowed set at /api/devbox/:sid/task AND at the internal router (before
// either transport is reached); a timeout above the profile is clamped; a box
// records its profile version and keeps it after the profile changes.
//
// The profile store is an in-memory stand-in for providers/devbox-profiles.ts
// (the real provider imports config.ts, which this CommonJS suite cannot load).

import express from 'express';
import request from '../../test-support/http.js';
import { SERVICE_AUTH_HEADER, signEnvelope } from '@connorhoehn/service-runtime';
import { devboxRouter, _internal } from '../devbox.js';
import { internalDevboxRouter } from '../internal-devbox.js';
import { registerBox, _resetFleet, getBoxBySession } from '../../lib/devbox-fleet.js';
import { _resetLoopMock } from '../../mock/devbox-agent-loop.js';

interface DevboxProfile {
  id: string; version: number; models: string[]; task_timeout_s: number; idle_minutes: number;
  max_lifetime_minutes: number; network_class: string; org_access: string; created_by: string; reason: string; created_at: string;
}

const store: { rows: DevboxProfile[]; initiative: Record<string, string> } = { rows: [], initiative: {} };

function profile(id: string, version: number, models: string[], task = 840): DevboxProfile {
  return {
    id, version, models, task_timeout_s: task, idle_minutes: 20, max_lifetime_minutes: 240,
    network_class: 'public', org_access: 'none', created_by: 'test', reason: 'test', created_at: '',
  };
}

jest.mock('../../providers/devbox-profiles.js', () => {
  const latest = (id: string) => store.rows.filter((r) => r.id === id).sort((a, b) => b.version - a.version)[0] ?? null;
  return {
    latestProfile: jest.fn(async (id: string) => latest(id)),
    getProfileVersion: jest.fn(async (id: string, v: number) => store.rows.find((r) => r.id === id && r.version === v) ?? null),
    ensureDefaultProfile: jest.fn(async () => latest('default')),
    initiativeProfileId: jest.fn(async (pid: string) => store.initiative[pid] ?? null),
  };
});
jest.mock('../../lib/initiative-scope.js', () => ({
  ...jest.requireActual('../../lib/initiative-scope.js'),
  userStewardsInitiative: jest.fn(async () => true),
  userReachesBox: jest.fn(async (userId: string, box: { ownerId?: string | null }) => box.ownerId === userId),
}));
jest.mock('../../lib/agent-actions.js', () => ({
  requireBoxAction: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../providers/spend-ledger.js', () => ({
  recordSpend: jest.fn(async () => undefined),
  getBoxSpend: jest.fn(async () => null), spendLedgerMode: () => 'fixture', ledgerIsFixture: () => true,
}));
// The DE-34 hold store reaches config.ts; a hold is not what this suite tests.
jest.mock('../../lib/spend-holds.js', () => ({
  reserveSpend: jest.fn(async () => ({ kind: 'held', holdId: null, initiativeId: null, grantId: null, amountUsd: 0 })),
  forecastP75ForModel: jest.fn(async () => null),
  HOLD_GRACE_MS: 60_000,
  // DE-35's meter is run-meter.test.ts's business; a null meter leaves the task unmetered.
  meterForHold: jest.fn(async () => null),
}));
jest.mock('../../providers/spend-holds.js', () => ({ releaseHold: jest.fn(async () => undefined), settleHold: jest.fn(async () => undefined) }));

const SESSION = 'devbox-0123456789abcdef0123456789abcdef';
const ARN = 'arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/orgiq_devbox-abc123';
const HAIKU = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
const SONNET = 'us.anthropic.claude-sonnet-5';
const OPUS = 'us.anthropic.claude-opus-4-8';
const SECRET = 'devbox-profile-test-secret';
const originalEnv = { ...process.env };

function publicApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = { sub: 'u-test', role: 'hr-admin', tenant: 'orgiq', grants: {}, iat: 0 };
    next();
  });
  app.use('/api/devbox', devboxRouter);
  return app;
}

function internalApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/internal/devbox', internalDevboxRouter);
  return app;
}

function signed(body: object): Record<string, string> {
  return { [SERVICE_AUTH_HEADER]: signEnvelope(body, { secret: SECRET, serviceId: 'platform-api' }) };
}

type Sent = { input: Record<string, unknown> };
function dataClient() {
  const calls: Sent[] = [];
  const upstream = ['data: {"type":"devbox_start"}\n', 'data: {"type":"devbox_end","exit_code":0}\n']
    .map((s) => new TextEncoder().encode(s));
  async function* iter() { for (const u of upstream) yield u; }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _internal.setDataClient({ send: jest.fn(async (c: Sent) => { calls.push(c); return { response: iter() }; }) } as any);
  return calls;
}
const sentPayload = (c: Sent) => JSON.parse(new TextDecoder().decode(c.input['payload'] as Uint8Array)) as Record<string, unknown>;

beforeEach(() => {
  store.rows = [profile('default', 1, [HAIKU, SONNET, OPUS]), profile('restricted', 1, [HAIKU], 600)];
  store.initiative = { 'p-locked': 'restricted' };
  process.env['DEVBOX_RUNTIME_ARN'] = ARN;
  process.env['WORK_GRAPH_SERVICE_AUTH_SECRET'] = SECRET;
  _internal.resetArnCache();
  _resetFleet();
  _resetLoopMock();
});

afterEach(() => {
  _internal.setDataClient(null);
  delete process.env['MOCK_AGENTCORE'];
});

afterAll(() => {
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});

describe('POST /api/devbox/:sessionId/task under a profile', () => {
  it('answers 400 naming the allowed set for an unlisted model, and reaches no runtime', async () => {
    const calls = dataClient();
    registerBox({ sessionId: SESSION, ownerId: 'u-test', projectId: 'p-locked', profile: { id: 'restricted', version: 1 } });
    const res = await request(publicApp()).post(`/api/devbox/${SESSION}/task`).send({ prompt: 'hi', model: OPUS });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MODEL_NOT_ALLOWED', allowedModels: [HAIKU], profile: { id: 'restricted', version: 1 } });
    expect(calls).toHaveLength(0);
  });

  it('always sends a model, the profile\'s first when none was asked for', async () => {
    const calls = dataClient();
    registerBox({ sessionId: SESSION, ownerId: 'u-test', profile: { id: 'default', version: 1 } });
    const res = await request(publicApp()).post(`/api/devbox/${SESSION}/task`).send({ prompt: 'hi' });
    expect(res.status).toBe(200);
    expect(sentPayload(calls[0]!)['model']).toBe(HAIKU);
  });

  it('clamps a timeout above the profile to the profile\'s task timeout', async () => {
    const calls = dataClient();
    registerBox({ sessionId: SESSION, ownerId: 'u-test', projectId: 'p-locked', profile: { id: 'restricted', version: 1 } });
    const res = await request(publicApp()).post(`/api/devbox/${SESSION}/task`).send({ prompt: 'hi', timeout: 3300 });
    expect(res.status).toBe(200);
    expect(sentPayload(calls[0]!)['timeout']).toBe(600);
  });

  it('a box records its profile version at creation and keeps it after the profile changes', async () => {
    const calls = dataClient();
    const created = await request(publicApp()).post('/api/devbox/boxes').send({ sessionId: SESSION, projectId: 'p-locked' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ profileId: 'restricted', profileVersion: 1 });

    // v2 widens the list; the box keeps v1's rules.
    store.rows.push(profile('restricted', 2, [HAIKU, OPUS], 600));
    const refused = await request(publicApp()).post(`/api/devbox/${SESSION}/task`).send({ prompt: 'hi', model: OPUS });
    expect(refused.status).toBe(400);
    expect(getBoxBySession(SESSION)).toMatchObject({ profileId: 'restricted', profileVersion: 1 });

    // A new box on the same initiative gets v2.
    const other = 'devbox-ffffffffffffffffffffffffffffffff0';
    const next = await request(publicApp()).post('/api/devbox/boxes').send({ sessionId: other, projectId: 'p-locked' });
    expect(next.body).toMatchObject({ profileId: 'restricted', profileVersion: 2 });
    const ok = await request(publicApp()).post(`/api/devbox/${other}/task`).send({ prompt: 'hi', model: OPUS });
    expect(ok.status).toBe(200);
    expect(sentPayload(calls[calls.length - 1]!)['model']).toBe(OPUS);
  });

  it('an unstamped box is stamped on its first task, write-once', async () => {
    dataClient();
    registerBox({ sessionId: SESSION, ownerId: 'u-test', projectId: 'p-locked' });
    await request(publicApp()).post(`/api/devbox/${SESSION}/task`).send({ prompt: 'hi' });
    expect(getBoxBySession(SESSION)).toMatchObject({ profileId: 'restricted', profileVersion: 1 });
    store.rows.push(profile('restricted', 2, [SONNET], 600));
    await request(publicApp()).post(`/api/devbox/${SESSION}/task`).send({ prompt: 'again' });
    expect(getBoxBySession(SESSION)).toMatchObject({ profileId: 'restricted', profileVersion: 1 });
  });
});

describe('internal router /internal/devbox/:sessionId/task under a profile', () => {
  it('answers 400 for an unlisted model before the mock or real transport', async () => {
    process.env['MOCK_AGENTCORE'] = 'true';
    const sBody = { principal: { service: 'platform-api', requestedBy: 'u-loop' }, label: 'loop', projectId: 'p-locked' };
    const made = await request(internalApp()).post('/internal/devbox/sessions').set(signed(sBody)).send(sBody);
    expect(made.status).toBe(201);
    expect(made.body.profile).toEqual({ id: 'restricted', version: 1 });

    const body = { principal: { service: 'platform-api', requestedBy: 'u-loop' }, prompt: 'go', model: SONNET };
    const res = await request(internalApp()).post(`/internal/devbox/${made.body.sessionId}/task`).set(signed(body)).send(body);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MODEL_NOT_ALLOWED', allowedModels: [HAIKU] });
  });
});

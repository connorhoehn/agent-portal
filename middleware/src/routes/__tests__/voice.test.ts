// The voice navigator's middleware half (docs/voice-navigator-spec.md §6, §7,
// §9 and the middleware lines of §10).
//
// OpenAI is a fake transport (lib/voice/openai.ts `_setVoiceFetch`); the
// spend holds, the ledger, the user budgets and the voice rows are the REAL
// providers on their offline (MOCK_AURORA) stores, so "the hold settled" and
// "one ledger row" are read back from the tables. Cedar decides from the seed
// files themselves: a role holds VoiceNavigate when its .cedar names it.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true, agentcore: true }, aurora: {}, auth: {}, cognito: {} } }));
jest.mock('../../lib/authz.js', () => {
  const fs = jest.requireActual<typeof import('node:fs')>('node:fs');
  const path = jest.requireActual<typeof import('node:path')>('node:path');
  const seeds = path.join(__dirname, '..', '..', '..', 'seeds', 'roles');
  const holds = (tenant: string, role: string, action: string): boolean => {
    const file = path.join(seeds, tenant, `${role}.cedar`);
    if (!fs.existsSync(file)) return false;
    const permits = fs.readFileSync(file, 'utf8').replace(/\/\/[^\n]*/g, '').split(/\bpermit\b/).slice(1).map((b: string) => b.split(';')[0]);
    return permits.some((p: string) => p.includes(`OrgIQ::Action::"${action}"`) && p.includes(`principal.tenant == "${tenant}"`));
  };
  return {
    requireSession: () => (req: { session?: unknown }, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) =>
      (req.session ? next() : res.status(401).json({ error: 'Unauthenticated' })),
    resolveSession: (req: { session?: unknown }) => req.session ?? null,
    isAllowed: jest.fn(async (p: { tenant: string; role: string }, action: string) => holds(p.tenant, p.role, action)),
  };
});

import express from 'express';
import request from '../../test-support/http.js';
import { voiceRouter } from '../voice.js';
import { errorHandler } from '../../lib/async-handler.js';
import { _setVoiceFetch } from '../../lib/voice/openai.js';
import { VOICE_TOOLS } from '../../lib/voice/catalogue.js';
import { sweepVoiceSessions, defaultVoiceReaperDeps } from '../../lib/voice/reaper.js';
import { sweepOnce } from '../../lib/devbox-reaper.js';
import { resetRateLimits } from '../../lib/rate-limit.js';
import { userBudgets } from '../../mock/user-budgets.js';
import { spendHolds } from '../../mock/spend-holds.js';
import { spendEntries } from '../../mock/spend-ledger.js';
import { voiceSessions, voiceToolCalls } from '../../mock/voice-sessions.js';
import { freezeClock, unfreezeClock } from '../../mock/core/index.js';
import { userSpendThisPeriod } from '../../providers/user-budgets.js';

const KEY = 'sk-test-THE_SERVER_SIDE_KEY_never_in_a_body';
const SDP = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\n';
const ANSWER = 'v=0\r\no=- 9 9 IN IP4 10.0.0.1\r\ns=answer\r\n';
const USER = 'u-vera';

let principal: Record<string, unknown> = { sub: USER, role: 'member', tenant: 'orgiq', grants: {} };
const app = express(); app.use(express.json());
app.use((req, _res, next) => { if (principal) (req as unknown as { session: unknown }).session = principal; next(); });
app.use('/api/voice', voiceRouter); app.use(errorHandler);

interface Call { url: string; init: { method: string; headers: Record<string, string>; body?: string } }
let calls: Call[] = [];
let upstream: { status: number; body: unknown } = { status: 200, body: { session: { id: 'sess_live_1' }, transport: { sdp: ANSWER } } };

const ENV_KEYS = ['OPENAI_API_KEY', 'MOCK_VOICE', 'VOICE_DELEGATION_MODEL', 'VOICE_SESSION_MAX_MINUTES', 'VOICE_USD_PER_MINUTE',
  'VOICE_SESSION_MINUTES_P75', 'VOICE_LIVE_MODEL', 'VOICE_VOICE', 'INSECURE_DEV_MODE', 'SPEND_HOLDS_UNATTRIBUTED'];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

function budget(allocatedUsd = 1_000, hardCapUsd: number | null = null): void {
  userBudgets.rows().push({ userId: USER, allocatedUsd, hardCapUsd, note: null, setBy: 'u-release' });
}

beforeEach(() => {
  jest.clearAllMocks();
  resetRateLimits();
  unfreezeClock();
  for (const f of [spendHolds, spendEntries, userBudgets, voiceSessions, voiceToolCalls]) f.reset();
  for (const k of ENV_KEYS) delete process.env[k];
  process.env['INSECURE_DEV_MODE'] = 'true';
  process.env['OPENAI_API_KEY'] = KEY;
  process.env['VOICE_DELEGATION_MODEL'] = 'gpt-delegate';
  principal = { sub: USER, role: 'member', tenant: 'orgiq', grants: {} };
  calls = [];
  upstream = { status: 200, body: { session: { id: 'sess_live_1' }, transport: { sdp: ANSWER } } };
  _setVoiceFetch(async (url, init) => {
    calls.push({ url, init });
    return { status: upstream.status, ok: upstream.status < 400, text: async () => JSON.stringify(upstream.body) };
  });
});
afterAll(() => {
  _setVoiceFetch(null);
  unfreezeClock();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

const mint = (body: Record<string, unknown> = { sdp: SDP }) => request(app).post('/api/voice/sessions').send(body);
const voiceRows = () => spendEntries.rows().filter((r) => r.source === 'voice_session');
const voiceHolds = () => spendHolds.rows().filter((h) => h.source === 'voice_session');

describe('POST /api/voice/sessions — the mint', () => {
  it('mints through OpenAI with the server-side session and answers what the browser needs (P3 builds against this)', async () => {
    budget();
    const res = await mint();
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      sessionId: expect.stringMatching(/^vs_[0-9a-f-]{36}$/), voiceSessionId: res.body.sessionId,
      holdId: expect.any(String), maxSeconds: 1800, expiresAt: expect.any(String), sdp: ANSWER, mock: false,
      model: 'gpt-live-1', voice: null, toolsEnabled: true, tools: VOICE_TOOLS.map((t) => t.name),
      budget: { holdUsd: 0.5, usdPerMinute: 0.05 },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/live/sessions');
    expect(calls[0]!.init.headers['Authorization']).toBe(`Bearer ${KEY}`);
    const sent = JSON.parse(calls[0]!.init.body!);
    expect(sent.transport).toEqual({ type: 'webrtc', sdp: SDP });
    expect(sent.session.model).toBe('gpt-live-1');
    expect(voiceSessions.rows()).toEqual([expect.objectContaining({
      id: res.body.sessionId, user_sub: USER, tenant: 'orgiq', hold_id: res.body.holdId, provider_session_id: 'sess_live_1',
      max_seconds: 1800, usd_per_minute: 0.05, ended_at: null,
    })]);
  });

  it('the session object names exactly the catalogue\'s functions and no web_search', async () => {
    budget();
    await mint();
    const session = JSON.parse(calls[0]!.init.body!).session;
    expect(session.delegation.responses.tools.map((t: { name: string }) => t.name)).toEqual(VOICE_TOOLS.map((t) => t.name));
    expect(session.delegation.responses.tools.every((t: { type: string; strict: boolean }) => t.type === 'function' && t.strict)).toBe(true);
    expect(session.delegation.responses.model).toBe('gpt-delegate');
    expect(session).not.toHaveProperty('tools');
    expect(session.client.data_channel.allowed_client_events).not.toContain('session.update');
    expect(JSON.stringify(session)).not.toContain('web_search');
    expect(session.delegation.responses.tools).toMatchSnapshot();
  });

  it('never leaks the key, the instructions or the session object in its body', async () => {
    budget();
    const res = await mint();
    const text = JSON.stringify(res.body);
    const instructions = JSON.parse(calls[0]!.init.body!).session.instructions as string;
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(instructions.slice(0, 60));
    expect(text).not.toContain('sess_live_1');
    expect(res.body).not.toHaveProperty('session');
  });

  it('is 403 without VoiceNavigate (an assessment role holds none)', async () => {
    principal = { sub: USER, role: 'assessor', tenant: 'assessment', grants: {} };
    const res = await mint();
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ action: 'VoiceNavigate' });
    expect(calls).toHaveLength(0);
    expect(voiceHolds()).toHaveLength(0);
  });

  it('a social participant may mint, and is offered only the social tools', async () => {
    principal = { sub: USER, role: 'participant', tenant: 'social', grants: {} };
    const res = await mint();
    expect(res.status).toBe(201);
    expect(res.body.tools.sort()).toEqual(['access_request_status', 'navigate', 'send_chat_message', 'set_status']);
  });

  it('is 503 voice-unavailable with no key and no mock, even under INSECURE_DEV_MODE, and holds nothing', async () => {
    delete process.env['OPENAI_API_KEY'];
    const res = await mint();
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: 'voice-unavailable', reason: 'no-key' });
    expect(voiceHolds()).toHaveLength(0);
    expect(voiceSessions.rows()).toHaveLength(0);
  });

  it('treats a REPLACE_ME placeholder key as no key', async () => {
    process.env['OPENAI_API_KEY'] = 'REPLACE_ME';
    expect((await mint()).status).toBe(503);
  });

  it('refuses the demo persona outside INSECURE_DEV_MODE, before any hold or call', async () => {
    delete process.env['INSECURE_DEV_MODE'];
    principal = { sub: 'demo-user', role: 'member', tenant: 'orgiq', grants: {} };
    const res = await mint();
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'voice-demo-refused' });
    expect(calls).toHaveLength(0);
    expect(voiceHolds()).toHaveLength(0);
  });

  it('lets the demo persona mint under INSECURE_DEV_MODE, as it may click', async () => {
    principal = { sub: 'demo-user', role: 'member', tenant: 'orgiq', grants: {} };
    expect((await mint()).status).toBe(201);
  });

  it('a spent user budget answers the shared spend refusal shape and never calls OpenAI', async () => {
    const spent = (await userSpendThisPeriod(USER)).spentUsd;
    budget(spent, spent);
    const res = await mint();
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ gate: 'user-cap', reason: 'budget', userBudget: { userId: USER }, amountUsd: 0.5 });
    expect(calls).toHaveLength(0);
    expect(voiceSessions.rows()).toHaveLength(0);
  });

  it('a soft user-budget brake is a 409 with the confirm flag, and the flag opens it', async () => {
    const spent = (await userSpendThisPeriod(USER)).spentUsd;
    budget(spent + 0.1, spent + 100);
    const res = await mint();
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ gate: 'user-budget', confirmFlag: 'confirmOverUserBudget', reason: 'budget' });
    expect(calls).toHaveLength(0);
    expect((await mint({ sdp: SDP, confirmOverUserBudget: true })).status).toBe(201);
  });

  it('unattributed spend refused by config is the 403 spend-hold refusal', async () => {
    process.env['SPEND_HOLDS_UNATTRIBUTED'] = 'refuse';
    const res = await mint();
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ gate: 'spend-hold', reason: 'budget' });
  });

  it('holds for max minutes × 60 s + grace at the configured rate', async () => {
    budget();
    process.env['VOICE_SESSION_MAX_MINUTES'] = '20';
    process.env['VOICE_USD_PER_MINUTE'] = '0.10';
    const restore = freezeClock('2026-11-08T10:00:00.000Z');
    try {
      const res = await mint();
      expect(res.body.maxSeconds).toBe(1200);
      expect(voiceHolds()).toEqual([expect.objectContaining({
        sourceId: res.body.sessionId, actorId: USER, initiativeId: null, status: 'held', amountUsd: 1,
        expiresAt: '2026-11-08T10:25:00.000Z',
      })]);
    } finally { restore(); }
  });

  it('a provider refusal gives the money back and books nothing', async () => {
    budget();
    upstream = { status: 401, body: { error: { message: `bad key ${KEY}` } } };
    const res = await mint();
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: 'voice-unavailable', reason: 'provider' });
    expect(JSON.stringify(res.body)).not.toContain(KEY);
    expect(voiceHolds()).toEqual([expect.objectContaining({ status: 'released' })]);
    expect(voiceSessions.rows()).toEqual([expect.objectContaining({ stop_reason: 'mint-failed' })]);
    expect(voiceRows()).toHaveLength(0);
  });

  it('needs an SDP offer for a real session', async () => {
    expect((await mint({})).status).toBe(400);
    expect((await mint({ sdp: 'hello' })).status).toBe(400);
  });

  it('MOCK_VOICE=1 mints a scripted session with no key and no OpenAI call', async () => {
    delete process.env['OPENAI_API_KEY'];
    process.env['MOCK_VOICE'] = '1';
    const res = await mint({});
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ mock: true, toolsEnabled: true, sdp: expect.stringMatching(/^v=0/) });
    const done = res.body.mockScript.onStart.find((f: { event: { type: string; event?: { type: string } } }) => f.event.event?.type === 'response.output_item.done');
    expect(done.event.event.item).toMatchObject({ type: 'function_call', name: 'search_people' });
    expect(calls).toHaveLength(0);
    expect(voiceSessions.rows()).toEqual([expect.objectContaining({ mock: true })]);
  });

  it('defaults the delegation model to gpt-6-luna', async () => {
    delete process.env['VOICE_DELEGATION_MODEL'];
    await mint();
    expect(JSON.parse(calls[0]!.init.body!).session.delegation.responses.model).toBe('gpt-6-luna');
  });

  it('VOICE_DELEGATION_MODEL=off: the voice answers but no tools are offered (§8)', async () => {
    process.env['VOICE_DELEGATION_MODEL'] = 'off';
    const res = await mint();
    expect(res.body).toMatchObject({ toolsEnabled: false, tools: [] });
    expect(JSON.parse(calls[0]!.init.body!).session).not.toHaveProperty('delegation');
  });
});

describe('POST /api/voice/sessions/:id/events — tool-call rows', () => {
  async function minted(): Promise<string> {
    process.env['MOCK_VOICE'] = '1';
    return (await mint({})).body.sessionId as string;
  }

  it('writes one row per call with the arguments hashed, never stored raw', async () => {
    const id = await minted();
    const secret = 'kubernetes experts in the Lisbon office';
    const res = await request(app).post(`/api/voice/sessions/${id}/events`)
      .send({ tool: 'search_people', args: { query: secret, limit: 5 }, outcome: 'done', durationMs: 412 });
    expect(res.status).toBe(201);
    const rows = voiceToolCalls.rows();
    expect(rows).toEqual([expect.objectContaining({
      session_id: id, tenant: 'orgiq', tool: 'search_people', outcome: 'done', duration_ms: 412,
      args_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    })]);
    expect(JSON.stringify(rows)).not.toContain(secret);
    expect(JSON.stringify(rows)).not.toContain('Lisbon');
    expect(voiceSessions.rows()[0]!.tool_calls).toBe(1);
  });

  it('takes the dock\'s own hash and the confirmation channel', async () => {
    const id = await minted();
    const sha = 'a'.repeat(64);
    await request(app).post(`/api/voice/sessions/${id}/events`).send({ tool: 'send_chat_message', argsSha256: sha, outcome: 'done', confirmedBy: 'voice' });
    expect(voiceToolCalls.rows()[0]).toMatchObject({ args_sha256: sha, confirmed_by: 'voice' });
  });

  it('refuses another user\'s session as not found, and writes nothing', async () => {
    const id = await minted();
    principal = { sub: 'u-mallory', role: 'member', tenant: 'orgiq', grants: {} };
    const res = await request(app).post(`/api/voice/sessions/${id}/events`).send({ tool: 'navigate', outcome: 'done' });
    expect(res.status).toBe(404);
    expect(voiceToolCalls.rows()).toHaveLength(0);
  });

  it('refuses the same user from another tenant', async () => {
    const id = await minted();
    principal = { sub: USER, role: 'participant', tenant: 'social', grants: {} };
    expect((await request(app).post(`/api/voice/sessions/${id}/events`).send({ tool: 'navigate', outcome: 'done' })).status).toBe(404);
  });

  it('refuses a tool outside the catalogue, a bad outcome and a malformed hash', async () => {
    const id = await minted();
    const post = (b: Record<string, unknown>) => request(app).post(`/api/voice/sessions/${id}/events`).send(b);
    expect((await post({ tool: 'shell_exec', outcome: 'done' })).status).toBe(400);
    expect((await post({ tool: 'navigate', outcome: 'maybe' })).status).toBe(400);
    expect((await post({ tool: 'navigate', outcome: 'done', argsSha256: 'not-hex' })).status).toBe(400);
    expect(voiceToolCalls.rows()).toHaveLength(0);
  });
});

describe('POST /api/voice/sessions/:id/close — settlement', () => {
  it('books one ledger row at seconds / 60 × rate, estimated, openai, and settles the hold', async () => {
    budget();
    const restore = freezeClock('2026-11-08T10:00:00.000Z');
    let id: string;
    try {
      id = (await mint()).body.sessionId;
    } finally { restore(); }
    const later = freezeClock('2026-11-08T10:05:00.000Z');
    try {
      const res = await request(app).post(`/api/voice/sessions/${id}/close`).send({ seconds: 240 });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ sessionId: id, seconds: 240, costUsd: 0.2, costBasis: 'estimated', stopReason: 'closed', alreadyClosed: false });
    } finally { later(); }
    expect(voiceRows()).toEqual([expect.objectContaining({
      sourceId: id, actorId: USER, initiativeId: null, costUsd: 0.2, costBasis: 'estimated', provider: 'openai', model: 'gpt-live-1',
    })]);
    expect(voiceHolds()).toEqual([expect.objectContaining({ sourceId: id, status: 'settled' })]);
  });

  it('closing twice writes one ledger row and answers the stored figure', async () => {
    budget();
    const id = (await mint()).body.sessionId;
    await request(app).post(`/api/voice/sessions/${id}/close`).send({ seconds: 60 });
    const again = await request(app).post(`/api/voice/sessions/${id}/close`).send({ seconds: 600 });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ alreadyClosed: true, seconds: 60, costUsd: 0.05 });
    expect(voiceRows()).toHaveLength(1);
    expect(voiceRows()[0]!.costUsd).toBe(0.05);
  });

  it('floors a reported figure at the 15-second minimum', async () => {
    const id = (await mint()).body.sessionId;
    const res = await request(app).post(`/api/voice/sessions/${id}/close`).send({ seconds: 2 });
    expect(res.body).toMatchObject({ seconds: 15, costUsd: 0.0125 });
  });

  it('no seconds from the dock is an unknown cost, never 0, and the hold stays held', async () => {
    budget();
    const id = (await mint()).body.sessionId;
    const res = await request(app).post(`/api/voice/sessions/${id}/close`).send({ reason: 'dropped' });
    expect(res.body).toMatchObject({ seconds: null, costUsd: null, costBasis: 'unknown', stopReason: 'dropped' });
    expect(voiceRows()).toEqual([expect.objectContaining({ costUsd: null, costBasis: 'unknown' })]);
    expect(voiceHolds()[0]!.status).toBe('held');
    // A dropped session is hung up at the provider so it stops billing.
    expect(calls.map((c) => c.url)).toContain('https://api.openai.com/v1/live/sessions/sess_live_1/hangup');
  });

  it('a tenant switch ends the session: the close is accepted from the new tenant and settles the hold', async () => {
    budget();
    const id = (await mint()).body.sessionId;
    principal = { sub: USER, role: 'participant', tenant: 'social', grants: {} };
    const res = await request(app).post(`/api/voice/sessions/${id}/close`).send({ seconds: 90, reason: 'tenant-switch' });
    expect(res.body).toMatchObject({ stopReason: 'tenant-switch', alreadyClosed: false });
    expect(voiceHolds()[0]!.status).toBe('settled');
  });

  it('refuses another user\'s session', async () => {
    const id = (await mint()).body.sessionId;
    principal = { sub: 'u-mallory', role: 'member', tenant: 'orgiq', grants: {} };
    expect((await request(app).post(`/api/voice/sessions/${id}/close`).send({ seconds: 60 })).status).toBe(404);
    expect(voiceRows()).toHaveLength(0);
  });
});

describe('the reaper (§7)', () => {
  async function abandoned(): Promise<string> {
    budget();
    const restore = freezeClock('2026-11-08T10:00:00.000Z');
    try { return (await mint()).body.sessionId; } finally { restore(); }
  }

  it('leaves a session inside its ceiling plus grace alone', async () => {
    const id = await abandoned();
    const restore = freezeClock('2026-11-08T10:34:00.000Z');
    try {
      expect(await sweepVoiceSessions(await defaultVoiceReaperDeps())).toEqual([]);
    } finally { restore(); }
    expect(voiceSessions.rows().find((r) => r.id === id)!.ended_at).toBeNull();
  });

  it('closes a session past max minutes + grace, books it unknown (never 0), hangs up and expires the hold', async () => {
    const id = await abandoned();
    const restore = freezeClock('2026-11-08T10:35:01.000Z');
    try {
      expect(await sweepVoiceSessions(await defaultVoiceReaperDeps())).toEqual([id]);
    } finally { restore(); }
    expect(voiceSessions.rows()[0]).toMatchObject({ stop_reason: 'reaped', seconds: null, cost_usd: null, cost_basis: 'unknown' });
    expect(voiceRows()).toEqual([expect.objectContaining({ sourceId: id, costUsd: null, costBasis: 'unknown' })]);
    expect(voiceRows()[0]!.costUsd).not.toBe(0);
    expect(voiceHolds()[0]!.status).toBe('expired');
    expect(calls.map((c) => c.url)).toContain('https://api.openai.com/v1/live/sessions/sess_live_1/hangup');
  });

  it('runs from the devbox reaper\'s sweep hook', async () => {
    const id = await abandoned();
    const restore = freezeClock('2026-11-08T11:00:00.000Z');
    try {
      await sweepOnce({
        client: () => { throw new Error('no AgentCore here'); }, runtimeArn: async () => null, refresh: async () => undefined,
        voiceSweep: async () => { await sweepVoiceSessions(await defaultVoiceReaperDeps()); },
      });
    } finally { restore(); }
    expect(voiceSessions.rows().find((r) => r.id === id)!.stop_reason).toBe('reaped');
  });

  it('a late close from the dock replaces the unknown figure once, and a second sweep changes nothing', async () => {
    const id = await abandoned();
    const restore = freezeClock('2026-11-08T10:40:00.000Z');
    try {
      await sweepVoiceSessions(await defaultVoiceReaperDeps());
      const res = await request(app).post(`/api/voice/sessions/${id}/close`).send({ seconds: 600 });
      expect(res.body).toMatchObject({ alreadyClosed: true, seconds: 600, costUsd: 0.5, costBasis: 'estimated' });
      expect(await sweepVoiceSessions(await defaultVoiceReaperDeps())).toEqual([]);
    } finally { restore(); }
    expect(voiceRows()).toEqual([expect.objectContaining({ costUsd: 0.5, costBasis: 'estimated' })]);
  });

  it('a session the dock closed is never reaped', async () => {
    const id = await abandoned();
    await request(app).post(`/api/voice/sessions/${id}/close`).send({ seconds: 30 });
    const restore = freezeClock('2026-11-08T12:00:00.000Z');
    try { expect(await sweepVoiceSessions(await defaultVoiceReaperDeps())).toEqual([]); } finally { restore(); }
    expect(voiceRows()).toHaveLength(1);
  });
});

// The seeds the Cedar mock reads must exist where it looks.
test('the seed directory the authz mock reads is present', () => {
  const dir = join(__dirname, '..', '..', '..', 'seeds', 'roles', 'orgiq', 'member.cedar');
  expect(existsSync(dir)).toBe(true);
  expect(readFileSync(dir, 'utf8')).toContain('VoiceNavigate');
});

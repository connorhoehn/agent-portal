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
import { _setVoiceFetch, _setVoiceWebSocket, _resetSidebands } from '../../lib/voice/openai.js';
import { SilentSideband } from '../../test-support/fake-sideband.js';
import { VOICE_TOOLS } from '../../lib/voice/catalogue.js';
import { sweepVoiceSessions, defaultVoiceReaperDeps } from '../../lib/voice/reaper.js';
import { sweepOnce } from '../../lib/devbox-reaper.js';
import { resetRateLimits } from '../../lib/rate-limit.js';
import { userBudgets } from '../../mock/user-budgets.js';
import { spendHolds } from '../../mock/spend-holds.js';
import { spendEntries } from '../../mock/spend-ledger.js';
import { voiceSessions, voiceToolCalls } from '../../mock/voice-sessions.js';
import type { VoiceSessionRow } from '../../providers/voice-sessions.js';
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
  'VOICE_SESSION_MINUTES_P75', 'VOICE_LIVE_MODEL', 'VOICE_VOICE', 'INSECURE_DEV_MODE', 'SPEND_HOLDS_UNATTRIBUTED',
  'VOICE_DELEGATION_USD_PER_1M_INPUT', 'VOICE_DELEGATION_USD_PER_1M_OUTPUT', 'VOICE_DAILY_MINUTES', 'VOICE_TOAST_SECONDS'];
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
  // The sideband (G12) never opens here: these tests settle on the dock's figures. voice-sideband.test.ts drives it.
  _resetSidebands();
  _setVoiceWebSocket(SilentSideband);
  _setVoiceFetch(async (url, init) => {
    calls.push({ url, init });
    return { status: upstream.status, ok: upstream.status < 400, text: async () => JSON.stringify(upstream.body) };
  });
});
afterAll(() => {
  _setVoiceFetch(null);
  _resetSidebands();
  _setVoiceWebSocket(null);
  unfreezeClock();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

const mint = (body: Record<string, unknown> = { sdp: SDP }) => request(app).post('/api/voice/sessions').send(body);
/** The voice row of each session (the one that settles the hold); the delegated tokens' row is `tokenRows`. */
const voiceRows = () => spendEntries.rows().filter((r) => r.source === 'voice_session' && !r.sourceId.endsWith(':tokens'));
const tokenRows = () => spendEntries.rows().filter((r) => r.source === 'voice_session' && r.sourceId.endsWith(':tokens'));
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
      budget: { holdUsd: 0.5, usdPerMinute: 0.05 }, toastSeconds: 8,
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

  it('offers only the run_command phrases the devbox allowlist runs (G9)', async () => {
    budget();
    const phrases = async () => {
      calls = [];
      expect((await mint()).status).toBe(201);
      const tools = JSON.parse(calls[0]!.init.body!).session.delegation.responses.tools as Array<{ name: string; parameters: { properties: { phrase?: { enum: string[] } } } }>;
      return tools.find((t) => t.name === 'run_command')?.parameters.properties.phrase?.enum ?? null;
    };
    const saved = process.env['DEVBOX_COMMAND_ALLOWLIST'];
    try {
      delete process.env['DEVBOX_COMMAND_ALLOWLIST'];
      const byDefault = await phrases();
      expect(byDefault).toContain('commits-since');
      expect(byDefault!.filter((p) => ['test', 'lint', 'build'].includes(p))).toEqual([]);
      process.env['DEVBOX_COMMAND_ALLOWLIST'] = 'git log,git status,ls,pwd,npm test';
      expect((await phrases())!.filter((p) => ['test', 'lint', 'build'].includes(p))).toEqual(['test']);
    } finally {
      if (saved === undefined) delete process.env['DEVBOX_COMMAND_ALLOWLIST']; else process.env['DEVBOX_COMMAND_ALLOWLIST'] = saved;
    }
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

  it('is 403 without VoiceNavigate (a role the tenant\'s seeds do not hold: an orgiq member parked in assessment)', async () => {
    principal = { sub: USER, role: 'member', tenant: 'assessment', grants: {} };
    const res = await mint();
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ action: 'VoiceNavigate' });
    expect(calls).toHaveLength(0);
    expect(voiceHolds()).toHaveLength(0);
  });

  it.each([['assessor', 'assessment'], ['author', 'pipelines'], ['requester', 'access']])(
    'an %s (%s) mints and is offered the read tools only (gaps doc Q1)', async (role, tenant) => {
      principal = { sub: USER, role, tenant, grants: {} };
      const res = await mint();
      expect(res.status).toBe(201);
      // Reads and navigation; pipelines adds queue_work's dry-run (G19, gated per kind on RunPipeline by the dock).
      const offered = ['access_request_status', 'get', 'list', 'navigate', 'open_result', ...(tenant === 'pipelines' ? ['queue_work'] : []), 'search'];
      expect(res.body.tools.sort()).toEqual(offered);
      const sent = JSON.parse(calls[0]!.init.body!).session;
      expect(sent.delegation.responses.tools.map((t: { name: string }) => t.name).sort()).toEqual(offered);
    });

  it('a social participant may mint, and is offered only the social tools', async () => {
    principal = { sub: USER, role: 'participant', tenant: 'social', grants: {} };
    const res = await mint();
    expect(res.status).toBe(201);
    expect(res.body.tools.sort()).toEqual(['access_request_status', 'activity', 'get', 'list', 'navigate', 'open_result', 'search', 'send_chat_message', 'set_status', 'start_call']);
  });

  it('an access approver\'s scripted session reads their approvals; a requester\'s their own requests', async () => {
    delete process.env['OPENAI_API_KEY'];
    process.env['MOCK_VOICE'] = '1';
    const scripted = async (role: string) => {
      principal = { sub: USER, role, tenant: 'access', grants: {} };
      const res = await mint({});
      expect(res.status).toBe(201);
      const done = res.body.mockScript.onStart.find((f: { event: { event?: { type: string } } }) => f.event.event?.type === 'response.output_item.done');
      return { name: done.event.event.item.name, args: JSON.parse(done.event.event.item.arguments) };
    };
    expect(await scripted('approver')).toEqual({ name: 'access_request_status', args: { query: null, scope: 'approvals' } });
    expect(await scripted('requester')).toMatchObject({ name: 'list', args: { kind: 'request', filter: { scope: 'mine' } } });
  });

  it('the social scripted session searches its own index for live huddles', async () => {
    delete process.env['OPENAI_API_KEY'];
    process.env['MOCK_VOICE'] = '1';
    principal = { sub: USER, role: 'participant', tenant: 'social', grants: {} };
    const res = await mint({});
    expect(res.status).toBe(201);
    const done = res.body.mockScript.onStart.find((f: { event: { event?: { type: string } } }) => f.event.event?.type === 'response.output_item.done');
    expect(done.event.event.item).toMatchObject({ type: 'function_call', name: 'search' });
    expect(JSON.parse(done.event.event.item.arguments)).toMatchObject({ type: 'huddle' });
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

  it('passes VOICE_TOAST_SECONDS to the dock (G19: a queued job\'s toast; default 8, above), capped at 120', async () => {
    budget();
    process.env['VOICE_TOAST_SECONDS'] = '5';
    expect((await mint()).body.toastSeconds).toBe(5);
    process.env['VOICE_TOAST_SECONDS'] = '900';
    expect((await mint()).body.toastSeconds).toBe(120);
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
    expect(done.event.event.item).toMatchObject({ type: 'function_call', name: 'search' });
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
    const session = JSON.parse(calls[0]!.init.body!).session;
    expect(session).not.toHaveProperty('delegation');
    // ...and the voice is not told to delegate into nothing.
    expect(session.instructions).toMatch(/no backend is connected/);
    expect(session.instructions).not.toMatch(/Delegate to the backend/);
  });

  // The live failure of 8 November: the delegation block was sent, but the voice prompt never said to delegate,
  // so the voice answered "find me the Kubernetes experts" itself with invented names and no function call.
  it('the minted voice prompt carries the delegation directive alongside the delegation block', async () => {
    budget();
    await mint();
    const session = JSON.parse(calls[0]!.init.body!).session;
    expect(session.delegation.responses.tools.length).toBeGreaterThan(0);
    expect(session.instructions).toMatch(/Delegate to the backend whenever the user asks to open a page, search, find or look up a person/);
    expect(session.instructions).toMatch(/never invent names, people, results/i);
    expect(session.delegation.responses.instructions).toMatch(/never invent names/);
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
      .send({ tool: 'search', args: { query: secret, limit: 5 }, outcome: 'done', durationMs: 412 });
    expect(res.status).toBe(201);
    const rows = voiceToolCalls.rows();
    expect(rows).toEqual([expect.objectContaining({
      session_id: id, tenant: 'orgiq', tool: 'search', outcome: 'done', duration_ms: 412,
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

describe('the delegated tokens (G11): a second ledger row per session', () => {
  const close = (id: string, body: Record<string, unknown>) => request(app).post(`/api/voice/sessions/${id}/close`).send(body);
  const toolCall = (id: string) => request(app).post(`/api/voice/sessions/${id}/events`).send({ tool: VOICE_TOOLS[0]!.name, outcome: 'done' });

  /** What the dock sums: every nested response.completed.response.usage the script plays. */
  function scriptedUsage(script: { onStart: Array<{ event: Record<string, any> }>; onResponseCreate: Array<{ event: Record<string, any> }> }) {
    const done = [...script.onStart, ...script.onResponseCreate]
      .filter((f) => f.event['type'] === 'response.event' && f.event['event']?.type === 'response.completed')
      .map((f) => f.event['event'].response.usage as { input_tokens: number; output_tokens: number; input_tokens_details?: { cached_tokens?: number } });
    return {
      inputTokens: done.reduce((n, u) => n + u.input_tokens, 0), outputTokens: done.reduce((n, u) => n + u.output_tokens, 0),
      cachedTokens: done.reduce((n, u) => n + (u.input_tokens_details?.cached_tokens ?? 0), 0), responses: done.length,
    };
  }

  it('the scripted session\'s two response.completed frames settle to 2,254 in and 48 out, priced as gpt-6-luna', async () => {
    process.env['MOCK_VOICE'] = '1';
    delete process.env['OPENAI_API_KEY'];
    delete process.env['VOICE_DELEGATION_MODEL'];
    budget();
    const res = await mint({});
    expect(res.status).toBe(201);
    const id = res.body.sessionId as string;
    const delegated = scriptedUsage(res.body.mockScript);
    expect(delegated).toEqual({ inputTokens: 2254, outputTokens: 48, cachedTokens: 0, responses: 2 });
    await toolCall(id);
    expect((await close(id, { seconds: 15, delegated })).status).toBe(200);
    expect(voiceRows()).toEqual([expect.objectContaining({ sourceId: id, costUsd: 0.0125, costBasis: 'estimated', model: 'gpt-live-1' })]);
    // 2,254 × $0.10/M + 48 × $0.50/M = $0.0002494, to the ledger's four places.
    expect(tokenRows()).toEqual([expect.objectContaining({
      sourceId: `${id}:tokens`, actorId: USER, initiativeId: null, trigger: 'voice-delegation', model: 'gpt-6-luna',
      inputTokens: 2254, outputTokens: 48, costUsd: 0.0002, costBasis: 'estimated', provider: 'openai',
    })]);
    expect(spendEntries.rows().filter((r) => r.source === 'voice_session')).toHaveLength(2);
    // The token row never matches the hold: the voice row settled it.
    expect(voiceHolds()).toEqual([expect.objectContaining({ sourceId: id, status: 'settled' })]);
  });

  it('VOICE_DELEGATION_USD_PER_1M_INPUT / _OUTPUT price a model the table lacks; cached input at the input override', async () => {
    process.env['VOICE_DELEGATION_USD_PER_1M_INPUT'] = '1';
    process.env['VOICE_DELEGATION_USD_PER_1M_OUTPUT'] = '2';
    budget();
    const id = (await mint()).body.sessionId as string;
    await toolCall(id);
    await close(id, { seconds: 60, delegated: { inputTokens: 3000, cachedTokens: 1000, outputTokens: 100, responses: 2 } });
    // 2,000 + 1,000 cached at $1/M, 100 at $2/M.
    expect(tokenRows()).toEqual([expect.objectContaining({ model: 'gpt-delegate', inputTokens: 3000, outputTokens: 100, costUsd: 0.0032, costBasis: 'estimated' })]);
  });

  it('an unpriced delegation model keeps its tokens with an unknown cost, never 0', async () => {
    budget();
    const id = (await mint()).body.sessionId as string;
    await close(id, { seconds: 60, delegated: { inputTokens: 1060, cachedTokens: 0, outputTokens: 20, responses: 1 } });
    expect(tokenRows()).toEqual([expect.objectContaining({ model: 'gpt-delegate', inputTokens: 1060, outputTokens: 20, costUsd: null, costBasis: 'unknown' })]);
    expect(voiceHolds()[0]!.status).toBe('settled');
  });

  it('bounds the browser\'s figures: responses at tool calls + 1, 50,000 tokens per response, cached within input', async () => {
    process.env['VOICE_DELEGATION_MODEL'] = 'gpt-6-luna';
    budget();
    const id = (await mint()).body.sessionId as string;
    await close(id, { seconds: 60, delegated: { inputTokens: 900_000, cachedTokens: 2_000_000, outputTokens: 70_000, responses: 9 } });
    // No tool call reported: one response, 50,000 in (all of it cached) and 50,000 out.
    expect(tokenRows()).toEqual([expect.objectContaining({ inputTokens: 50_000, outputTokens: 50_000, costUsd: 0.0255, costBasis: 'estimated' })]);
  });

  it('a close without the token block (or with a malformed one) books the token row unknown', async () => {
    budget();
    const a = (await mint()).body.sessionId as string;
    await close(a, { seconds: 60 });
    const b = (await mint()).body.sessionId as string;
    await close(b, { seconds: 60, delegated: { inputTokens: -1, outputTokens: 'lots', responses: 1 } });
    expect(tokenRows()).toEqual([
      expect.objectContaining({ sourceId: `${a}:tokens`, inputTokens: null, costUsd: null, costBasis: 'unknown' }),
      expect.objectContaining({ sourceId: `${b}:tokens`, inputTokens: null, costUsd: null, costBasis: 'unknown' }),
    ]);
  });

  it('a reaped session books both rows unknown; a late close prices them once', async () => {
    process.env['VOICE_DELEGATION_MODEL'] = 'gpt-6-luna';
    budget();
    let id: string;
    const at = freezeClock('2026-11-08T10:00:00.000Z');
    try { id = (await mint()).body.sessionId; } finally { at(); }
    const later = freezeClock('2026-11-08T10:40:00.000Z');
    try {
      await sweepVoiceSessions(await defaultVoiceReaperDeps());
      expect(tokenRows()).toEqual([expect.objectContaining({ sourceId: `${id}:tokens`, costUsd: null, costBasis: 'unknown' })]);
      await close(id, { seconds: 600, delegated: { inputTokens: 1060, cachedTokens: 0, outputTokens: 20, responses: 1 } });
      await close(id, { seconds: 900, delegated: { inputTokens: 50_000, cachedTokens: 0, outputTokens: 50_000, responses: 1 } });
    } finally { later(); }
    expect(voiceRows()).toEqual([expect.objectContaining({ costUsd: 0.5, costBasis: 'estimated' })]);
    expect(tokenRows()).toEqual([expect.objectContaining({ costUsd: 0.0001, costBasis: 'estimated' })]);
  });
});

describe('the daily minutes (G13, §3 Q2)', () => {
  const NOW = '2026-11-08T15:00:00.000Z';
  let n = 0;
  /** A session row already in the table: `seconds` null = still open or reaped unknown. */
  function used(over: Partial<VoiceSessionRow> & { started_at: string }): void {
    n += 1;
    voiceSessions.rows().push({
      id: `vs_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, user_sub: USER, tenant: 'orgiq', hold_id: null,
      provider_session_id: null, model: 'gpt-live-1', voice: null, mock: false, max_seconds: 1800, usd_per_minute: 0.05,
      ended_at: over.started_at, seconds: null, cost_usd: null, cost_basis: null, stop_reason: 'closed', tool_calls: 0,
      provider_seconds: null, provider_tokens_in: null, provider_tokens_out: null, provider_tokens_cached: null, ...over,
    });
  }
  async function at<T>(iso: string, fn: () => Promise<T>): Promise<T> {
    const restore = freezeClock(iso);
    try { return await fn(); } finally { restore(); }
  }

  it('55 minutes used today mints a session capped at 300 s, and the next mint is refused', async () => {
    budget();
    used({ started_at: '2026-11-08T09:00:00.000Z', seconds: 3300 });
    // Mock rows never count, however long.
    used({ started_at: '2026-11-08T10:00:00.000Z', seconds: 3600, mock: true });
    const first = await at(NOW, () => mint());
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ maxSeconds: 300, dailyMinutesLeft: 5, budget: { holdUsd: 0.25, usdPerMinute: 0.05 } });
    expect(voiceSessions.rows().find((r) => r.id === first.body.sessionId)!.max_seconds).toBe(300);
    expect(Date.parse(first.body.expiresAt) - Date.parse(NOW)).toBe(300_000);

    // The open session counts at its ceiling: nothing is left.
    const second = await at('2026-11-08T15:01:00.000Z', () => mint());
    expect(second.status).toBe(429);
    expect(second.body).toEqual({
      error: 'voice-unavailable', reason: 'daily-minutes', minutesLeft: 0, dailyMinutes: 60, resetsAt: '2026-11-09T00:00:00.000Z',
      message: expect.stringMatching(/60 minutes of voice are used/),
    });
    expect(second.headers['retry-after']).toBe(String(9 * 3600 - 60));
    expect(calls).toHaveLength(1);
    expect(voiceHolds()).toHaveLength(1);
  });

  it('a closed session counts its seconds, an open or reaped one its ceiling; yesterday and other users never count', async () => {
    budget();
    used({ started_at: '2026-11-07T23:59:00.000Z', seconds: 3600 });
    used({ started_at: '2026-11-08T08:00:00.000Z', seconds: 600, user_sub: 'u-someone-else' });
    used({ started_at: '2026-11-08T08:00:00.000Z', seconds: 600 });
    used({ started_at: '2026-11-08T09:00:00.000Z', seconds: null, max_seconds: 1200, stop_reason: 'reaped', cost_basis: 'unknown' });
    used({ started_at: '2026-11-08T14:50:00.000Z', seconds: null, max_seconds: 1500, ended_at: null, stop_reason: null });
    // 600 + 1200 + 1500 = 3300 of 3600.
    expect((await at(NOW, () => mint())).body).toMatchObject({ maxSeconds: 300, dailyMinutesLeft: 5 });
  });

  it('a session that fits whole is not cut and carries no dailyMinutesLeft', async () => {
    budget();
    used({ started_at: '2026-11-08T09:00:00.000Z', seconds: 1200 });
    const res = await at(NOW, () => mint());
    expect(res.body.maxSeconds).toBe(1800);
    expect(res.body).not.toHaveProperty('dailyMinutesLeft');
  });

  it('VOICE_DAILY_MINUTES sets the allowance and 0 turns it off', async () => {
    budget();
    used({ started_at: '2026-11-08T09:00:00.000Z', seconds: 3600 });
    process.env['VOICE_DAILY_MINUTES'] = '90';
    expect((await at(NOW, () => mint())).body).toMatchObject({ maxSeconds: 1800 });
    process.env['VOICE_DAILY_MINUTES'] = '0';
    expect((await at(NOW, () => mint())).status).toBe(201);
    process.env['VOICE_DAILY_MINUTES'] = '61';
    // 3600 + 1800 + the off mint's 1800 are well past 61 minutes.
    expect((await at(NOW, () => mint())).body).toMatchObject({ reason: 'daily-minutes' });
  });

  it('MOCK_VOICE sessions are unaffected: never capped, never counted', async () => {
    process.env['MOCK_VOICE'] = '1';
    delete process.env['OPENAI_API_KEY'];
    budget();
    used({ started_at: '2026-11-08T09:00:00.000Z', seconds: 3600 });
    const res = await at(NOW, () => mint({}));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ mock: true, maxSeconds: 1800 });
    expect(res.body).not.toHaveProperty('dailyMinutesLeft');
    expect(voiceSessions.rows().filter((r) => r.mock)).toHaveLength(1);
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

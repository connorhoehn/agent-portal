// The sideband (docs/voice-navigator-gaps.md §2.4, G12): the middleware's own
// read of a live session's usage, preferred over the dock's.
//
// OpenAI is two fakes: fetch (`_setVoiceFetch`) for the mint and the hangup,
// and the WebSocket constructor (`_setVoiceWebSocket`, test-support/fake-sideband.ts)
// for wss://…/live/sessions/{id}/attach. The holds, the ledger and the voice
// rows are the real providers on their offline (MOCK_AURORA) stores. The
// frames are the shapes V1 recorded (docs/voice/live-events.jsonl).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true, agentcore: true }, aurora: {}, auth: {}, cognito: {} } }));
jest.mock('../../lib/authz.js', () => ({
  requireSession: () => (req: { session?: unknown }, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) =>
    (req.session ? next() : res.status(401).json({ error: 'Unauthenticated' })),
  resolveSession: (req: { session?: unknown }) => req.session ?? null,
  isAllowed: jest.fn(async () => true),
}));

import express from 'express';
import request from '../../test-support/http.js';
import { voiceRouter } from '../voice.js';
import { errorHandler } from '../../lib/async-handler.js';
import {
  _setVoiceFetch, _setVoiceWebSocket, _resetSidebands, attachSideband, sidebandUsage, SIDEBAND_MAX_RECONNECTS,
} from '../../lib/voice/openai.js';
import { sweepVoiceSessions, defaultVoiceReaperDeps } from '../../lib/voice/reaper.js';
import { resetRateLimits } from '../../lib/rate-limit.js';
import { userBudgets } from '../../mock/user-budgets.js';
import { spendHolds } from '../../mock/spend-holds.js';
import { spendEntries } from '../../mock/spend-ledger.js';
import { voiceSessions, voiceToolCalls } from '../../mock/voice-sessions.js';
import { freezeClock, unfreezeClock } from '../../mock/core/index.js';
import { FakeSideband } from '../../test-support/fake-sideband.js';

const KEY = 'sk-test-THE_SERVER_SIDE_KEY_never_in_a_body';
const SDP = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\n';
const ANSWER = 'v=0\r\no=- 9 9 IN IP4 10.0.0.1\r\ns=answer\r\n';
const USER = 'u-vera';
const LIVE_ID = 'live_u0_EhooRp3oNHkEqte9InC7ZnHXY7uP029e';

const principal = { sub: USER, role: 'member', tenant: 'orgiq', grants: {} };
const app = express(); app.use(express.json());
app.use((req, _res, next) => { (req as unknown as { session: unknown }).session = principal; next(); });
app.use('/api/voice', voiceRouter); app.use(errorHandler);

let calls: string[] = [];
/** What a hangup does on the fake sideband (V1: session.closed with the final usage arrives on it). */
let onHangup: (() => void) | null = null;

const ENV_KEYS = ['OPENAI_API_KEY', 'MOCK_VOICE', 'VOICE_DELEGATION_MODEL', 'VOICE_DAILY_MINUTES', 'INSECURE_DEV_MODE',
  'VOICE_DELEGATION_USD_PER_1M_INPUT', 'VOICE_DELEGATION_USD_PER_1M_OUTPUT', 'VOICE_USD_PER_MINUTE', 'VOICE_SESSION_MAX_MINUTES'];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

beforeEach(() => {
  resetRateLimits();
  unfreezeClock();
  for (const f of [spendHolds, spendEntries, userBudgets, voiceSessions, voiceToolCalls]) f.reset();
  for (const k of ENV_KEYS) delete process.env[k];
  process.env['INSECURE_DEV_MODE'] = 'true';
  process.env['OPENAI_API_KEY'] = KEY;
  process.env['VOICE_DELEGATION_MODEL'] = 'gpt-6-luna';
  userBudgets.rows().push({ userId: USER, allocatedUsd: 1_000, hardCapUsd: null, note: null, setBy: 'u-release' });
  calls = [];
  onHangup = null;
  _resetSidebands();
  FakeSideband.reset();
  _setVoiceWebSocket(FakeSideband);
  _setVoiceFetch(async (url) => {
    calls.push(url);
    if (url.endsWith('/hangup')) { onHangup?.(); return { status: 200, ok: true, text: async () => '{}' }; }
    return { status: 201, ok: true, text: async () => JSON.stringify({ session: { id: LIVE_ID }, transport: { type: 'webrtc', sdp: ANSWER } }) };
  });
});
afterAll(() => {
  _resetSidebands();
  _setVoiceFetch(null);
  _setVoiceWebSocket(null);
  unfreezeClock();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

const mint = () => request(app).post('/api/voice/sessions').send({ sdp: SDP });
const close = (id: string, body: Record<string, unknown>) => request(app).post(`/api/voice/sessions/${id}/close`).send(body);
const voiceRows = () => spendEntries.rows().filter((r) => r.source === 'voice_session' && !r.sourceId.endsWith(':tokens'));
const tokenRows = () => spendEntries.rows().filter((r) => r.source === 'voice_session' && r.sourceId.endsWith(':tokens'));
const row = (id: string) => voiceSessions.rows().find((r) => r.id === id)!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const usageUpdated = (seconds: number) => ({ type: 'session.usage.updated', usage: { seconds }, context_window: { usage_ratio: 0.01 } });
const closedFrame = (seconds: number) => ({ type: 'session.closed', reason: 'close_requested', session: { id: LIVE_ID }, usage: { seconds } });
const completed = (id: string, input: number, output: number, cached = 0) => ({
  type: 'response.event', delegation_id: 'item_1',
  event: { type: 'response.completed', response: { id, status: 'completed', output: [], usage: {
    input_tokens: input, input_tokens_details: { cached_tokens: cached, cache_write_tokens: 0 }, output_tokens: output,
    output_tokens_details: { reasoning_tokens: 0 }, total_tokens: input + output } }, sequence_number: 12 },
});

describe('the attach at mint', () => {
  it('opens one sideband per live session with the server key, and the mint answers without waiting for it', async () => {
    const res = await mint();
    expect(res.status).toBe(201);
    expect(FakeSideband.sockets).toHaveLength(1);
    const socket = FakeSideband.sockets[0]!;
    expect(socket.url).toBe(`wss://api.openai.com/v1/live/sessions/${LIVE_ID}/attach`);
    expect(socket.init.headers).toEqual({ Authorization: `Bearer ${KEY}` });
    expect(JSON.stringify(res.body)).not.toContain(KEY);
    expect(JSON.stringify(res.body)).not.toContain(LIVE_ID);
    // Attaching the same provider session again reuses the socket.
    expect(attachSideband(LIVE_ID)).toBe(true);
    expect(FakeSideband.sockets).toHaveLength(1);
  });

  it('is skipped under MOCK_VOICE', async () => {
    process.env['MOCK_VOICE'] = '1';
    delete process.env['OPENAI_API_KEY'];
    const res = await request(app).post('/api/voice/sessions').send({});
    expect(res.status).toBe(201);
    expect(res.body.mock).toBe(true);
    expect(FakeSideband.sockets).toHaveLength(0);
  });

  it('a sideband that cannot be built or errors never fails the mint (still 201)', async () => {
    _setVoiceWebSocket(class { constructor() { throw new Error('no sockets today'); } } as never);
    const first = await mint();
    expect(first.status).toBe(201);
    // One open session per person: the first ends before the second mint.
    row(first.body.sessionId).ended_at = new Date().toISOString();
    _setVoiceWebSocket(FakeSideband);
    FakeSideband.onCreate = (s) => queueMicrotask(() => s.fail());
    const res = await mint();
    expect(res.status).toBe(201);
    expect(res.body.sdp).toBe(ANSWER);
  });

  it('reconnects at most twice after unexpected closes, keeping the figures it already had', async () => {
    const id = (await mint()).body.sessionId as string;
    FakeSideband.sockets[0]!.open().frame(usageUpdated(16)).drop();
    await sleep(700);
    expect(FakeSideband.sockets).toHaveLength(2);
    FakeSideband.sockets[1]!.fail();
    await sleep(1_200);
    expect(FakeSideband.sockets).toHaveLength(1 + SIDEBAND_MAX_RECONNECTS);
    FakeSideband.sockets[2]!.fail();
    await sleep(1_700);
    expect(FakeSideband.sockets).toHaveLength(1 + SIDEBAND_MAX_RECONNECTS);
    expect(row(id).provider_seconds).toBe(16);
    expect(sidebandUsage(LIVE_ID)).toMatchObject({ seconds: 16, final: false });
  }, 10_000);
});

describe('the close prefers the provider\'s figures', () => {
  it('usage 56 s on the sideband while the dock posts 30 s: the row says 56, reported', async () => {
    const id = (await mint()).body.sessionId as string;
    const socket = FakeSideband.sockets[0]!.open();
    for (const s of [16, 34, 51]) socket.frame(usageUpdated(s));
    expect(row(id).provider_seconds).toBe(51);
    socket.frame(closedFrame(56));
    const res = await close(id, { seconds: 30 });
    expect(res.body).toMatchObject({ seconds: 56, costUsd: 0.0467, costBasis: 'reported', alreadyClosed: false });
    expect(row(id)).toMatchObject({ seconds: 56, cost_basis: 'reported', provider_seconds: 56 });
    expect(voiceRows()).toEqual([expect.objectContaining({ sourceId: id, costUsd: 0.0467, costBasis: 'reported' })]);
    expect(spendHolds.rows().filter((h) => h.source === 'voice_session')[0]!.status).toBe('settled');
    // The dock said closed and the provider confirmed it: no hangup needed.
    expect(calls.filter((u) => u.endsWith('/hangup'))).toEqual([]);
  });

  it('no sideband (it never opened): the row says the dock\'s 30, estimated', async () => {
    const id = (await mint()).body.sessionId as string;
    const res = await close(id, { seconds: 30 });
    expect(res.body).toMatchObject({ seconds: 30, costUsd: 0.025, costBasis: 'estimated' });
    expect(voiceRows()).toEqual([expect.objectContaining({ costBasis: 'estimated', costUsd: 0.025 })]);
  });

  it('the close waits briefly for session.closed and takes it when it lands', async () => {
    const id = (await mint()).body.sessionId as string;
    const socket = FakeSideband.sockets[0]!.open().frame(usageUpdated(20));
    setTimeout(() => socket.frame(closedFrame(44)), 150);
    const res = await close(id, { seconds: 30 });
    expect(res.body).toMatchObject({ seconds: 44, costBasis: 'reported' });
  });

  it('a partial provider figure below the dock\'s yields to it (estimated), and the unconfirmed session is hung up', async () => {
    const id = (await mint()).body.sessionId as string;
    FakeSideband.sockets[0]!.open().frame(usageUpdated(20));
    const res = await close(id, { seconds: 30 });
    expect(res.body).toMatchObject({ seconds: 30, costBasis: 'estimated' });
    expect(calls).toContain(`https://api.openai.com/v1/live/sessions/${LIVE_ID}/hangup`);
  }, 10_000);

  it('a dropped dock: hang up, read the final usage the hangup brings, book it reported', async () => {
    const id = (await mint()).body.sessionId as string;
    const socket = FakeSideband.sockets[0]!.open().frame(usageUpdated(34));
    onHangup = () => setTimeout(() => socket.frame(closedFrame(41)), 20);
    const res = await close(id, { reason: 'dropped' });
    expect(res.body).toMatchObject({ seconds: 41, costBasis: 'reported', stopReason: 'dropped' });
    expect(calls.filter((u) => u.endsWith('/hangup'))).toHaveLength(1);
  });

  it('tokens from the sideband win over the dock\'s totals for the :tokens row, each response counted once', async () => {
    const id = (await mint()).body.sessionId as string;
    await request(app).post(`/api/voice/sessions/${id}/events`).send({ tool: 'search', outcome: 'done' });
    const socket = FakeSideband.sockets[0]!.open();
    socket.frame(completed('resp_1', 1060, 20)).frame(completed('resp_1', 1060, 20)).frame(completed('resp_2', 1194, 28));
    expect(row(id)).toMatchObject({ provider_tokens_in: 2254, provider_tokens_out: 48, provider_tokens_cached: 0 });
    socket.frame(closedFrame(15));
    await close(id, { seconds: 15, delegated: { inputTokens: 100, outputTokens: 2, cachedTokens: 0, responses: 1 } });
    // 2,254 × $0.10/M + 48 × $0.50/M = $0.0002494.
    expect(tokenRows()).toEqual([expect.objectContaining({
      sourceId: `${id}:tokens`, model: 'gpt-6-luna', inputTokens: 2254, outputTokens: 48, costUsd: 0.0002, costBasis: 'reported',
    })]);
  });

  it('a session that ended with no delegation books zero tokens, reported, not the dock\'s figure', async () => {
    const id = (await mint()).body.sessionId as string;
    FakeSideband.sockets[0]!.open().frame(closedFrame(15));
    await close(id, { seconds: 15, delegated: { inputTokens: 900, outputTokens: 9, cachedTokens: 0, responses: 1 } });
    expect(tokenRows()).toEqual([expect.objectContaining({ inputTokens: 0, outputTokens: 0, costBasis: 'reported' })]);
  });

  it('the socket is closed on close', async () => {
    const id = (await mint()).body.sessionId as string;
    const socket = FakeSideband.sockets[0]!.open().frame(usageUpdated(16));
    socket.frame(closedFrame(18));
    await close(id, { seconds: 18 });
    expect(socket.closedByClient).toBe(true);
    expect(sidebandUsage(LIVE_ID)).toBeNull();
    await sleep(700);
    expect(FakeSideband.sockets).toHaveLength(1);
  });

  it('a close on another replica (no socket here) reads the figures the sideband wrote to the row', async () => {
    const id = (await mint()).body.sessionId as string;
    FakeSideband.sockets[0]!.open().frame(usageUpdated(51)).frame(completed('resp_1', 1060, 20));
    _resetSidebands();
    const res = await close(id, { seconds: 30, delegated: { inputTokens: 10, outputTokens: 1, cachedTokens: 0, responses: 1 } });
    expect(res.body).toMatchObject({ seconds: 51, costBasis: 'reported' });
    expect(tokenRows()).toEqual([expect.objectContaining({ inputTokens: 1060, outputTokens: 20, costBasis: 'reported' })]);
  });
});

describe('the reaper', () => {
  async function abandoned(): Promise<string> {
    const at = freezeClock('2026-11-08T10:00:00.000Z');
    try { return (await mint()).body.sessionId as string; } finally { at(); }
  }
  const sweep = async () => {
    const at = freezeClock('2026-11-08T10:40:00.000Z');
    try { return await sweepVoiceSessions(await defaultVoiceReaperDeps()); } finally { at(); }
  };

  it('hangs up, reads the final usage from the same socket, books it reported and closes the socket', async () => {
    const id = await abandoned();
    const socket = FakeSideband.sockets[0]!.open().frame(usageUpdated(1790)).frame(completed('resp_1', 1060, 20));
    onHangup = () => setTimeout(() => socket.frame(closedFrame(1801)), 20);
    expect(await sweep()).toEqual([id]);
    expect(row(id)).toMatchObject({ stop_reason: 'reaped', seconds: 1801, cost_basis: 'reported' });
    expect(voiceRows()).toEqual([expect.objectContaining({ costUsd: 1.5008, costBasis: 'reported' })]);
    expect(tokenRows()).toEqual([expect.objectContaining({ inputTokens: 1060, outputTokens: 20, costBasis: 'reported' })]);
    expect(calls.filter((u) => u.endsWith('/hangup'))).toHaveLength(1);
    expect(socket.closedByClient).toBe(true);
  });

  it('with no socket here, takes what the sideband wrote to the row', async () => {
    const id = await abandoned();
    FakeSideband.sockets[0]!.open().frame(usageUpdated(600));
    _resetSidebands();
    await sweep();
    expect(row(id)).toMatchObject({ seconds: 600, cost_basis: 'reported' });
    expect(tokenRows()).toEqual([expect.objectContaining({ costUsd: null, costBasis: 'unknown' })]);
  });

  it('keeps unknown when neither the sideband nor the dock reported anything', async () => {
    const id = await abandoned();
    expect(await sweep()).toEqual([id]);
    expect(row(id)).toMatchObject({ seconds: null, cost_usd: null, cost_basis: 'unknown' });
    expect(voiceRows()).toEqual([expect.objectContaining({ costUsd: null, costBasis: 'unknown' })]);
    expect(calls.filter((u) => u.endsWith('/hangup'))).toHaveLength(1);
    // The socket that never opened is closed all the same.
    expect(FakeSideband.sockets[0]!.closedByClient).toBe(true);
  });
});

describe('the recorded session (docs/voice/live-events.jsonl, `live-responses`)', () => {
  it('folds V1\'s real frames to 56 s and four responses\' tokens', () => {
    const file = join(__dirname, '..', '..', '..', '..', 'docs', 'voice', 'live-events.jsonl');
    const frames = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((e) => e['s'] === 'live-responses' && e['dir'] === 'in');
    expect(attachSideband(LIVE_ID)).toBe(true);
    const socket = FakeSideband.sockets[0]!.open();
    for (const f of frames) {
      const { t: _t, s: _s, dir: _d, ...event } = f;
      socket.frame(event);
    }
    expect(sidebandUsage(LIVE_ID)).toEqual({
      seconds: 56, inputTokens: 1060 + 1194 + 1336 + 1387, outputTokens: 20 + 28 + 21 + 10, cachedTokens: 1191 + 1333, responses: 4, final: true,
    });
  });
});

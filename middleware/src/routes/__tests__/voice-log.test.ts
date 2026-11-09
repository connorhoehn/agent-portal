// The voice session log (lib/voice/session-log.ts, routes/voice-log.ts): the
// structured events the mint, the dock, the sideband, the close and the reaper
// write, read back by the session's owner only.
//
// Same harness as voice.test.ts: OpenAI is a fake transport, the voice rows,
// holds and ledger are the real providers on their offline (MOCK_AURORA) stores.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
import { voiceLogRouter } from '../voice-log.js';
import { errorHandler } from '../../lib/async-handler.js';
import { _setVoiceFetch, _setVoiceWebSocket, _resetSidebands } from '../../lib/voice/openai.js';
import { FakeSideband, SilentSideband } from '../../test-support/fake-sideband.js';
import { hashToolArgs } from '../../lib/voice/catalogue.js';
import { sweepVoiceSessions, defaultVoiceReaperDeps } from '../../lib/voice/reaper.js';
import {
  checkDiagnostic, parseClientEvent, sanitizeEventData, sweepVoiceEventRetention, voiceLogFile, LIVE_FRAME_TYPES, MAX_EVENT_BATCH, MAX_EVENT_DATA_BYTES, VOICE_EVENT_KINDS,
} from '../../lib/voice/session-log.js';
import { resetRateLimits } from '../../lib/rate-limit.js';
import { userBudgets } from '../../mock/user-budgets.js';
import { spendHolds } from '../../mock/spend-holds.js';
import { spendEntries } from '../../mock/spend-ledger.js';
import { voiceSessionEvents, voiceSessions, voiceToolCalls } from '../../mock/voice-sessions.js';
import {
  insertVoiceSession, insertVoiceSessionEvent, listVoiceSessionEvents, MAX_EVENTS_PER_SESSION,
} from '../../providers/voice-sessions.js';
import { freezeClock, unfreezeClock } from '../../mock/core/index.js';

const KEY = 'sk-test-THE_SERVER_SIDE_KEY_never_in_a_body';
const SDP = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\n';
const ANSWER = 'v=0\r\no=- 9 9 IN IP4 10.0.0.1\r\ns=answer\r\n';
const USER = 'u-vera';
const OTHER = 'u-otto';

let principal: Record<string, unknown> = { sub: USER, role: 'member', tenant: 'orgiq', grants: {} };
const app = express(); app.use(express.json());
app.use((req, _res, next) => { (req as unknown as { session: unknown }).session = principal; next(); });
app.use('/api/voice', voiceRouter); app.use('/api/voice', voiceLogRouter); app.use(errorHandler);

const ENV_KEYS = ['OPENAI_API_KEY', 'MOCK_VOICE', 'VOICE_DELEGATION_MODEL', 'INSECURE_DEV_MODE', 'VOICE_LOG_DIR', 'NODE_ENV', 'VOICE_DAILY_MINUTES'];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

beforeEach(() => {
  resetRateLimits();
  unfreezeClock();
  for (const f of [spendHolds, spendEntries, userBudgets, voiceSessions, voiceToolCalls, voiceSessionEvents]) f.reset();
  for (const k of ENV_KEYS) delete process.env[k];
  process.env['NODE_ENV'] = 'test';
  process.env['INSECURE_DEV_MODE'] = 'true';
  process.env['OPENAI_API_KEY'] = KEY;
  process.env['VOICE_DELEGATION_MODEL'] = 'gpt-delegate';
  principal = { sub: USER, role: 'member', tenant: 'orgiq', grants: {} };
  for (const userId of [USER, OTHER]) userBudgets.rows().push({ userId, allocatedUsd: 1_000, hardCapUsd: null, note: null, setBy: 'u-release' });
  _resetSidebands();
  FakeSideband.reset();
  _setVoiceWebSocket(SilentSideband);
  _setVoiceFetch(async () => ({ status: 200, ok: true, text: async () => JSON.stringify({ session: { id: 'sess_live_1' }, transport: { sdp: ANSWER } }) }));
});
afterAll(() => {
  _setVoiceFetch(null);
  _resetSidebands();
  _setVoiceWebSocket(null);
  unfreezeClock();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

const as = (sub: string, extra: Record<string, unknown> = {}) => { principal = { sub, role: 'member', tenant: 'orgiq', grants: {}, ...extra }; };
const mint = async (): Promise<string> => {
  const res = await request(app).post('/api/voice/sessions').send({ sdp: SDP });
  expect(res.status).toBe(201);
  return res.body.sessionId as string;
};
const post = (id: string, body: Record<string, unknown>) => request(app).post(`/api/voice/sessions/${id}/events`).send(body);
const close = (id: string, body: Record<string, unknown> = { seconds: 60 }) => request(app).post(`/api/voice/sessions/${id}/close`).send(body);
const get = (path: string) => request(app).get(`/api/voice${path}`);

/** Every key at any depth of a JSON value. */
function keysOf(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => keysOf(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.add(k); keysOf(x, out); }
  return out;
}

describe('the event log, written by the mint, the dock and the close', () => {
  it('numbers each session\'s events by seq in the order they were written', async () => {
    const id = await mint();
    expect((await post(id, { kind: 'started', data: { phase: 'listening' } })).body).toEqual({ seq: 2 });
    expect((await post(id, { kind: 'tool-call', tool: 'search', args: { query: 'vera' } })).body).toEqual({ seq: 3 });
    expect((await post(id, { kind: 'confirm-shown', tool: 'search' })).status).toBe(201);
    expect((await post(id, { kind: 'confirmed', tool: 'search', data: { by: 'click' } })).status).toBe(201);
    const call = await post(id, { tool: 'search', args: { query: 'vera' }, outcome: 'done', durationMs: 120, summary: { results: 3 } });
    expect(call.status).toBe(201);
    expect(call.body).toEqual({ id: expect.any(String) });
    expect((await close(id)).status).toBe(200);

    const res = await get(`/sessions/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.events.map((e: { seq: number; kind: string }) => [e.seq, e.kind])).toEqual([
      [1, 'minted'], [2, 'started'], [3, 'tool-call'], [4, 'confirm-shown'], [5, 'confirmed'], [6, 'tool-result'], [7, 'closed'],
    ]);
    const [minted, , toolCall, , , toolResult, closed] = res.body.events;
    expect(minted.data).toEqual(expect.objectContaining({ mock: false, maxSeconds: 1800, toolsEnabled: true, holdUsd: 0.5 }));
    expect(toolCall.data).toEqual({ tool: 'search', argsSha256: hashToolArgs({ query: 'vera' }) });
    expect(toolResult.data).toEqual(expect.objectContaining({
      tool: 'search', outcome: 'done', durationMs: 120, toolCallId: call.body.id, argsSha256: hashToolArgs({ query: 'vera' }), summary: { results: 3 },
    }));
    expect(closed.data).toEqual(expect.objectContaining({ stopReason: 'closed', seconds: 60, basis: 'estimated' }));
    expect(res.body.toolCalls).toEqual([expect.objectContaining({ id: call.body.id, tool: 'search', outcome: 'done', durationMs: 120 })]);
    expect(res.body.session).toEqual(expect.objectContaining({ id, tenant: 'orgiq', toolCallCount: 1, lastOutcome: 'done', stopReason: 'closed', seconds: 60 }));
    expect(res.body.session).not.toHaveProperty('providerSessionId');
    expect(JSON.stringify(res.body)).not.toContain('sess_live_1');
  });

  it('takes only the dock\'s kinds, a known tool name, and hex digests', async () => {
    const id = await mint();
    expect((await post(id, { kind: 'minted' })).status).toBe(400);
    expect((await post(id, { kind: 'reaper' })).status).toBe(400);
    expect((await post(id, { kind: 'nonsense' })).status).toBe(400);
    expect((await post(id, { kind: 'client', data: [1, 2] })).status).toBe(400);
    expect((await post(id, { kind: 'tool-call', argsSha256: 'not-hex' })).status).toBe(400);
    expect((await post(id, { kind: 'refused', tool: 'drop_tables' })).status).toBe(201);
    const events = (await get(`/sessions/${id}`)).body.events;
    expect(events.at(-1)).toEqual(expect.objectContaining({ kind: 'refused', data: { tool: 'unknown', knownTool: false } }));
  });

  it('takes a batch of events in one request, in order, and refuses the whole batch for one bad event', async () => {
    const id = await mint();
    const batch = await post(id, { events: [
      { kind: 'client', data: { phase: 'listening' } },
      { kind: 'tool-call', tool: 'search', args: { query: 'vera' } },
      { kind: 'confirm-shown', tool: 'search', data: { requestId: 3 } },
    ] });
    expect(batch.status).toBe(201);
    expect(batch.body).toEqual({ seqs: [2, 3, 4] });
    expect((await post(id, { events: [{ kind: 'client' }, { kind: 'minted' }] })).body).toEqual({ error: expect.stringMatching(/^events\[1\]: kind must be/) });
    expect((await post(id, { events: [] })).status).toBe(400);
    expect((await post(id, { events: Array.from({ length: MAX_EVENT_BATCH + 1 }, () => ({ kind: 'client' })) })).status).toBe(400);
    expect((await post(id, { events: ['x'] })).status).toBe(400);
    const events = (await get(`/sessions/${id}`)).body.events;
    expect(events.map((e: { kind: string }) => e.kind)).toEqual(['minted', 'client', 'tool-call', 'confirm-shown']);
    expect(events[2].data).toEqual({ tool: 'search', argsSha256: hashToolArgs({ query: 'vera' }) });
  });

  it('logs a mint that fails after its row exists as an error and a close', async () => {
    _setVoiceFetch(async () => ({ status: 500, ok: false, text: async () => '{}' }));
    const res = await request(app).post('/api/voice/sessions').send({ sdp: SDP });
    expect(res.status).toBe(503);
    const latest = await get('/sessions/latest');
    expect(latest.body.events.map((e: { kind: string; data: Record<string, unknown> }) => [e.kind, e.data])).toEqual([
      ['error', { stage: 'mint', status: 500 }], ['closed', { stopReason: 'mint-failed' }],
    ]);
  });

  it('logs the sideband\'s life and its usage, never a frame\'s words', async () => {
    _setVoiceWebSocket(FakeSideband);
    const id = await mint();
    const socket = FakeSideband.sockets[0]!.open();
    socket.frame({ type: 'session.output_transcript.delta', delta: 'the secret plan' });
    socket.frame({ type: 'session.usage.updated', usage: { seconds: 12 } });
    socket.frame({ type: 'session.closed', reason: 'close_requested', usage: { seconds: 20 } });
    await new Promise((r) => setTimeout(r, 20));
    const events = (await get(`/sessions/${id}`)).body.events as Array<{ kind: string; data: Record<string, unknown> }>;
    expect(events.filter((e) => e.kind === 'sideband').map((e) => e.data)).toEqual(expect.arrayContaining([
      { state: 'connected', connects: 1 }, { state: 'closed', reason: 'close_requested' },
    ]));
    expect(events.filter((e) => e.kind === 'usage').at(-1)!.data).toEqual(expect.objectContaining({ source: 'sideband', seconds: 20, final: true }));
    expect(JSON.stringify(events)).not.toContain('secret plan');
  });

  it('logs the reaper closing an abandoned session', async () => {
    const at = freezeClock('2026-11-08T10:00:00.000Z');
    let id: string;
    try { id = await mint(); } finally { at(); }
    const later = freezeClock('2026-11-08T10:40:00.000Z');
    try { expect(await sweepVoiceSessions(await defaultVoiceReaperDeps())).toEqual([id]); } finally { later(); }
    const events = (await get(`/sessions/${id}`)).body.events as Array<{ kind: string; data: Record<string, unknown> }>;
    expect(events.map((e) => e.kind)).toEqual(['minted', 'reaper', 'closed']);
    expect(events[1]!.data).toEqual(expect.objectContaining({ minutesOpen: 40, hungUp: true }));
    expect(events[2]!.data).toEqual(expect.objectContaining({ stopReason: 'reaped', basis: 'unknown', seconds: null }));
  });
});

describe('the read routes are the owner\'s only', () => {
  it('answers 404 for another user\'s session, an admin included, and lists only the caller\'s', async () => {
    const mine = await mint();
    as(OTHER);
    expect((await get(`/sessions/${mine}`)).status).toBe(404);
    expect((await get(`/sessions/${mine}/export`)).status).toBe(404);
    expect((await get('/sessions')).body).toEqual({ sessions: [] });
    expect((await get('/sessions/latest')).status).toBe(404);
    expect((await post(mine, { kind: 'client', note: 'hi' })).status).toBe(404);
    as(OTHER, { role: 'admin' });
    expect((await get(`/sessions/${mine}`)).status).toBe(404);
    expect((await get('/sessions')).body).toEqual({ sessions: [] });
    as(USER);
    expect((await get(`/sessions/${mine}`)).status).toBe(200);
    expect((await get('/sessions/vs_not-an-id')).status).toBe(404);
  });

  it('reads the caller\'s own session from another tenant', async () => {
    const id = await mint();
    as(USER, { tenant: 'social' });
    expect((await get(`/sessions/${id}`)).status).toBe(200);
    expect((await get('/sessions')).body.sessions.map((s: { id: string }) => s.id)).toEqual([id]);
  });

  it('lists newest first with since and limit, and latest is the newest', async () => {
    const t1 = freezeClock('2026-11-08T09:00:00.000Z');
    let a: string;
    try { a = await mint(); await close(a); } finally { t1(); }
    const t2 = freezeClock('2026-11-08T10:00:00.000Z');
    let b: string;
    try { b = await mint(); await post(b, { tool: 'search', outcome: 'refused' }); } finally { t2(); }
    const all = (await get('/sessions')).body.sessions;
    expect(all.map((s: { id: string }) => s.id)).toEqual([b, a]);
    expect(all[0]).toEqual({
      id: b, tenant: 'orgiq', mock: false, startedAt: '2026-11-08T10:00:00.000Z', endedAt: null, seconds: null, maxSeconds: 1800,
      costUsd: null, costBasis: null, toolCallCount: 1, lastOutcome: 'refused', stopReason: null, resumeOf: null,
    });
    expect(all[1]).toEqual(expect.objectContaining({ id: a, stopReason: 'closed', costBasis: 'estimated', lastOutcome: null }));
    expect((await get('/sessions?limit=1')).body.sessions.map((s: { id: string }) => s.id)).toEqual([b]);
    expect((await get(`/sessions?since=${encodeURIComponent('2026-11-08T09:30:00Z')}`)).body.sessions.map((s: { id: string }) => s.id)).toEqual([b]);
    expect((await get('/sessions?limit=0')).status).toBe(400);
    expect((await get('/sessions?since=yesterday')).status).toBe(400);
    expect((await get('/sessions/latest')).body.session.id).toBe(b);
  });
});

describe('the export', () => {
  it('is one attachment with everything, and no key, transcript field or raw argument in it', async () => {
    const id = await mint();
    await post(id, { kind: 'client', note: `pasted ${KEY} by mistake`, data: { transcript: 'what I said', delta: 'he', text: 'hi', nested: { text: 'x', ok: 1 } } });
    await post(id, { kind: 'error', data: { code: 'fetch-failed', where: 'https://bucket.s3.amazonaws.com/a/b.pdf?X-Amz-Signature=abc123&X-Amz-Credential=zzz', auth: 'Bearer abc.def.ghi' } });
    await post(id, { kind: 'tool-call', tool: 'search', args: { message: 'RAW_ARGUMENT_VALUE to the team' } });
    await post(id, { tool: 'search', args: { message: 'RAW_ARGUMENT_VALUE to the team' }, outcome: 'done', confirmedBy: 'voice' });
    await close(id);

    const res = await get(`/sessions/${id}/export`);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toBe(`attachment; filename="voice-session-${id}.json"`);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    const text = res.text;
    const doc = JSON.parse(text);
    expect(doc).toEqual(expect.objectContaining({ format: 'voice-session-log/1', exportedAt: expect.any(String) }));
    expect(doc.session.id).toBe(id);
    expect(doc.toolCalls).toHaveLength(1);
    expect(doc.events.map((e: { kind: string }) => e.kind)).toEqual(['minted', 'client', 'error', 'tool-call', 'tool-result', 'closed']);
    expect(text).not.toContain('sk-');
    expect(text).not.toContain('RAW_ARGUMENT_VALUE');
    expect(text).not.toContain('X-Amz-Signature');
    expect(text).not.toContain('abc.def.ghi');
    expect(text).not.toContain('what I said');
    const keys = keysOf(doc);
    for (const k of ['delta', 'transcript', 'text', 'args', 'arguments']) expect(keys.has(k)).toBe(false);
    const client = doc.events[1].data;
    expect(client._dropped).toEqual(expect.arrayContaining(['transcript', 'delta', 'text']));
    expect(client.nested).toEqual({ ok: 1 });
    expect(doc.events[2].data.where).toBe('https://bucket.s3.amazonaws.com/a/b.pdf');
    expect(doc.events[3].data.argsSha256).toBe(hashToolArgs({ message: 'RAW_ARGUMENT_VALUE to the team' }));
  });
});

describe('the dev file log', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'voice-log-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('appends every event row as one JSON line under VOICE_LOG_DIR', async () => {
    process.env['VOICE_LOG_DIR'] = join(dir, 'nested');
    const id = await mint();
    await post(id, { kind: 'started' });
    await close(id);
    const file = voiceLogFile(id)!;
    expect(file).toBe(join(dir, 'nested', `${id}.jsonl`));
    const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => [l.seq, l.kind])).toEqual([[1, 'minted'], [2, 'started'], [3, 'closed']]);
    expect(lines[0]).toEqual(expect.objectContaining({ sessionId: id, tenant: 'orgiq', at: expect.any(String), data: expect.any(Object) }));
  });

  it('is refused under NODE_ENV=production, and the rows are still written', async () => {
    process.env['VOICE_LOG_DIR'] = dir;
    process.env['NODE_ENV'] = 'production';
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const id = await mint();
      await post(id, { kind: 'started' });
      expect(voiceLogFile(id)).toBeNull();
      expect(existsSync(join(dir, `${id}.jsonl`))).toBe(false);
      expect(voiceSessionEvents.rows().filter((r) => r.session_id === id)).toHaveLength(2);
    } finally { warn.mockRestore(); }
  });

  it('is off without VOICE_LOG_DIR outside INSECURE_DEV_MODE, and defaults to .voice-log under it', async () => {
    const flag = process.env['INSECURE_DEV_MODE'];
    delete process.env['INSECURE_DEV_MODE'];
    try {
      const id = await mint();
      expect(voiceLogFile(id)).toBeNull();
      await close(id);
    } finally { if (flag !== undefined) process.env['INSECURE_DEV_MODE'] = flag; }
    process.env['INSECURE_DEV_MODE'] = 'true';
    try {
      const id = await mint();
      expect(voiceLogFile(id)).toMatch(/\.voice-log\/vs_[0-9a-f-]+\.jsonl$/);
    } finally { if (flag === undefined) delete process.env['INSECURE_DEV_MODE']; else process.env['INSECURE_DEV_MODE'] = flag; }
  });
});

describe('retention and the store', () => {
  it('the reaper\'s retention sweep deletes rows older than 30 days and keeps the rest', async () => {
    const t0 = freezeClock('2026-10-01T10:00:00.000Z');
    let old: string;
    try { old = await mint(); await post(old, { kind: 'started' }); } finally { t0(); }
    const t1 = freezeClock('2026-10-20T10:00:00.000Z');
    let recent: string;
    try { recent = await mint(); } finally { t1(); }
    const now = freezeClock('2026-11-08T10:00:00.000Z');
    try {
      const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
      try { expect(await sweepVoiceEventRetention()).toBe(2); } finally { log.mockRestore(); }
    } finally { now(); }
    expect(voiceSessionEvents.rows().map((r) => r.session_id)).toEqual([recent]);
    expect(voiceSessions.rows().map((r) => r.id)).toEqual(expect.arrayContaining([old, recent]));
  });

  it('round-trips through the mock store, in seq order, capped at 500 rows', async () => {
    const row = await insertVoiceSession({
      id: 'vs_00000000-0000-4000-8000-000000000001', user_sub: USER, tenant: 'orgiq', hold_id: null, model: 'm', voice: null,
      mock: true, max_seconds: 60, usd_per_minute: 0,
    });
    const first = await insertVoiceSessionEvent({ session_id: row.id, tenant: 'orgiq', kind: 'client', data: { n: 1, nested: { a: [1, 2] } } });
    expect(first).toEqual({ id: expect.any(String), session_id: row.id, tenant: 'orgiq', seq: 1, at: expect.any(String), kind: 'client', data: { n: 1, nested: { a: [1, 2] } } });
    for (let i = 2; i <= MAX_EVENTS_PER_SESSION; i += 1) await insertVoiceSessionEvent({ session_id: row.id, tenant: 'orgiq', kind: 'client', data: { n: i } });
    expect(await insertVoiceSessionEvent({ session_id: row.id, tenant: 'orgiq', kind: 'client', data: {} })).toBeNull();
    const back = await listVoiceSessionEvents(row.id);
    expect(back).toHaveLength(MAX_EVENTS_PER_SESSION);
    expect(back.map((e) => e.seq)).toEqual(Array.from({ length: MAX_EVENTS_PER_SESSION }, (_, i) => i + 1));
    expect(back[0]!.data).toEqual({ n: 1, nested: { a: [1, 2] } });
    expect(await insertVoiceSessionEvent({ session_id: 'vs_00000000-0000-4000-8000-00000000ffff', tenant: 'orgiq', kind: 'client', data: {} })).toBeNull();
  });

  it('answers 429 once a session\'s log is full', async () => {
    const id = await mint();
    for (let i = 2; i <= MAX_EVENTS_PER_SESSION; i += 1) await insertVoiceSessionEvent({ session_id: id, tenant: 'orgiq', kind: 'client', data: {} });
    expect((await post(id, { kind: 'client' })).status).toBe(429);
  });
});

describe('sanitizeEventData', () => {
  it('keeps a row at 2 KB, replacing an oversized one with its keys', () => {
    const big = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, 'x'.repeat(190)]));
    const out = sanitizeEventData(big);
    expect(Buffer.byteLength(JSON.stringify(out))).toBeLessThanOrEqual(MAX_EVENT_DATA_BYTES);
    expect(out).toEqual({ _truncated: true, keys: expect.arrayContaining(['k0', 'k19']) });
  });

  it('cuts strings at 200 characters, depth at 3, and drops non-objects', () => {
    const out = sanitizeEventData({ s: 'y'.repeat(500), a: { b: { c: { d: 1 } } }, n: Number.NaN });
    expect((out['s'] as string).length).toBe(200);
    expect(out['a']).toEqual({ b: {} });
    expect(out['n']).toBeNull();
    expect(sanitizeEventData('text')).toEqual({});
    expect(sanitizeEventData([1])).toEqual({});
  });

  it('names a closed set of kinds the schema checks', () => {
    const sql = readFileSync(join(__dirname, '..', '..', '..', '..', 'schema', 'voice_sessions.sql'), 'utf8');
    const check = /kind\s+TEXT\s+NOT NULL CHECK \(kind IN \(([^)]*)\)\)/.exec(sql)![1]!;
    expect([...check.matchAll(/'([a-z-]+)'/g)].map((m) => m[1])).toEqual([...VOICE_EVENT_KINDS]);
  });
});

// G63 (docs/voice-navigator-gaps.md): the dock's diagnostics are numbers and enums, checked field by field.
describe('G63 diagnostics without words', () => {
  const HEARD = { event: 'heard', n: 3, wordCount: 7, ms: 2400, outcome: 'ignored', afterMs: null, delegations: 0, atMs: 1794141391000 };
  const SPOKE = { event: 'spoke', n: 2, wordCount: 11, ms: 5100, after: 'unprompted', atMs: 1794141393000 };
  const GOOD = [
    HEARD, SPOKE,
    { event: 'context', ratio: 0.0153, seconds: 34 },
    { event: 'frames', windowS: 60, counts: { info: 2, rate_limits_updated: 1, unknown: 1 } },
    { event: 'mic', muted: true, by: 'user' },
    { event: 'level', windowS: 30, samples: 300, min: 0, avg: 0.041, max: 0.62, mutedPct: 0 },
  ];
  const deps = { knownTool: () => true, hashArgs: () => '0'.repeat(64) };

  it('takes each diagnostic as given, numbers and enums only', async () => {
    const id = await mint();
    const res = await post(id, { events: GOOD.map((data) => ({ kind: 'client', data })) });
    expect(res.status).toBe(201);
    const events = (await get(`/sessions/${id}`)).body.events as Array<{ kind: string; data: Record<string, unknown> }>;
    expect(events.slice(1).map((e) => e.data)).toEqual(GOOD);
  });

  it('refuses free text in any of them: a sentence for an enum, an extra key, a word as a frame name, a tool or a note', async () => {
    const refused: Array<Record<string, unknown>> = [
      { ...HEARD, outcome: 'the user asked for the budget' },
      { ...HEARD, said: 'what is on my plate' },
      { ...HEARD, wordCount: 'seven' },
      { ...HEARD, words: 7 },
      { ...SPOKE, after: 'Here is what I found' },
      { ...SPOKE, ms: -5 },
      { event: 'frames', windowS: 60, counts: { 'Find me the Kubernetes experts': 1 } },
      { event: 'frames', windowS: 60, counts: { 'session.output_transcript.delta': 1 } },
      { event: 'frames', windowS: 60, counts: { info: 'two' } },
      { event: 'context', ratio: 1.5, seconds: 3 },
      { event: 'mic', muted: 'yes', by: 'user' },
      { event: 'mic', muted: true, by: 'my manager' },
      { event: 'level', windowS: 30, samples: 3, min: -1, avg: 0, max: 0, mutedPct: 0 },
    ];
    for (const data of refused) {
      const one = parseClientEvent({ kind: 'client', data }, deps);
      expect(one).toEqual({ error: expect.stringMatching(new RegExp(`^${String(data['event'])}: `)) });
    }
    expect(parseClientEvent({ kind: 'client', tool: 'search', data: HEARD }, deps)).toEqual({ error: expect.stringContaining('tool is not allowed') });
    expect(parseClientEvent({ kind: 'client', note: 'the user said hi', data: SPOKE }, deps)).toEqual({ error: expect.stringContaining('note is not allowed') });
    expect(parseClientEvent({ kind: 'client', args: { q: 'x' }, data: SPOKE }, deps)).toEqual({ error: expect.stringContaining('args is not allowed') });
    expect(checkDiagnostic({ event: 'phase', phase: 'listening' })).toMatch(/not a diagnostic event/);
    // The other client events are untouched: their fields still pass the sanitizer alone.
    expect(parseClientEvent({ kind: 'client', data: { event: 'phase', phase: 'listening', from: 'speaking' } }, deps)).toEqual({ kind: 'client', data: { event: 'phase', phase: 'listening', from: 'speaking' } });
    // Over the route: one bad diagnostic refuses its whole batch, and nothing of it is written.
    const id = await mint();
    const res = await post(id, { events: [{ kind: 'client', data: { event: 'phase', phase: 'listening' } }, { kind: 'client', data: { ...HEARD, outcome: 'open the budget page' } }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/^events\[1\]: heard: outcome/);
    expect((await get(`/sessions/${id}`)).body.events).toHaveLength(1);
  });

  it('every frame name is a row key the sanitizer keeps', () => {
    const counts = Object.fromEntries([...LIVE_FRAME_TYPES.map((t) => t.replace(/\./g, '_')), 'unknown'].map((k) => [k, 1]));
    expect(checkDiagnostic({ event: 'frames', windowS: 60, counts })).toBeNull();
    expect(sanitizeEventData({ event: 'frames', windowS: 60, counts })).toEqual({ event: 'frames', windowS: 60, counts });
  });

  it('the sideband\'s usage row carries the voice\'s context ratio, what it sees open, and the frame types since the last row', async () => {
    _setVoiceWebSocket(FakeSideband);
    const id = await mint();
    const socket = FakeSideband.sockets[0]!.open();
    const env = (event: Record<string, unknown>) => ({ type: 'response.event', delegation_id: 'item_1', event });
    socket.frame({ type: 'session.input_transcript.delta', delta: 'the secret plan', start_ms: 0, end_ms: 200 });
    socket.frame({ type: 'session.delegation.created', delegation: { id: 'item_1', type: 'delegation', target: 'responses' } });
    socket.frame(env({ type: 'response.created', response: { id: 'resp_1' } }));
    socket.frame(env({ type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_1', name: 'search', arguments: '{"query":"secret"}' } }));
    socket.frame(env({ type: 'response.completed', response: { id: 'resp_1', output: [] } }));
    socket.frame({ type: 'rate_limits.updated', rate_limits: [] });
    socket.frame({ type: 'brand.new.event' });
    socket.frame({ type: 'session.usage.updated', usage: { seconds: 12 }, context_window: { usage_ratio: 0.012345678 } });
    await new Promise((r) => setTimeout(r, 20));
    const events = (await get(`/sessions/${id}`)).body.events as Array<{ kind: string; data: Record<string, unknown> }>;
    const usage = events.filter((e) => e.kind === 'usage').at(-1)!.data;
    expect(usage).toEqual(expect.objectContaining({
      source: 'sideband', seconds: 12, contextRatio: 0.0123, openResponses: 0, awaiting: 1, delegations: 1,
      frames: { session_input_transcript_delta: 1, session_delegation_created: 1, response_event: 3, rate_limits_updated: 1, unknown: 1, session_usage_updated: 1 },
    }));
    expect(JSON.stringify(events)).not.toContain('secret');
  });
});

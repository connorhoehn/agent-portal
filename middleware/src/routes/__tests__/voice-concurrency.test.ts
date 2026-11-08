// The voice routes against the two things the offline store hides
// (sweep 1, M1 and M3): row-level security and two mints at once.
//
// M1. `voice_sessions` is a tenant table: inside a request the database sees
// only the caller's tenants (providers/db-tenant.ts). The fixture here does
// the same — its rows are filtered by `currentDbTenant()` — so a close sent
// after a tenant switch fails here exactly as it would under RLS unless the
// route reads and closes the row as the system after its owner check.
//
// M3. One open real session per person: a second mint is a 409 naming the
// open session, and two mints racing past that check are settled after the
// insert (the oldest open session wins; the day's minutes are re-read).

jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true, agentcore: true }, aurora: {}, auth: {}, cognito: {} } }));
jest.mock('../../lib/authz.js', () => ({
  requireSession: () => (req: { session?: unknown }, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) =>
    (req.session ? next() : res.status(401).json({ error: 'Unauthenticated' })),
  resolveSession: (req: { session?: unknown }) => req.session ?? null,
  isAllowed: jest.fn(async () => true),
}));
// The offline rows, seen through the request's tenant scope as RLS would show them.
jest.mock('../../mock/voice-sessions.js', () => {
  const actual = jest.requireActual('../../mock/voice-sessions.js');
  const scoped = <R extends { tenant: string }>(fixture: { rows: () => R[]; reset: () => void }) => ({
    reset: () => fixture.reset(),
    rows: (): R[] => {
      const all = fixture.rows();
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const scope: string = require('../../providers/db-tenant.js').currentDbTenant();
      if (scope === '*') return all;
      const tenants = scope.split(',');
      const view = all.filter((r) => tenants.includes(r.tenant));
      // An insert lands in the table, not in the filtered view.
      view.push = (...xs: R[]) => { all.push(...xs); return Array.prototype.push.apply(view, xs); };
      return view;
    },
  });
  return { voiceSessions: scoped(actual.voiceSessions), voiceToolCalls: scoped(actual.voiceToolCalls) };
});

import express from 'express';
import request from '../../test-support/http.js';
import { voiceRouter } from '../voice.js';
import { errorHandler } from '../../lib/async-handler.js';
import { _setVoiceFetch, _setVoiceWebSocket, _resetSidebands } from '../../lib/voice/openai.js';
import { SilentSideband } from '../../test-support/fake-sideband.js';
import { resetRateLimits } from '../../lib/rate-limit.js';
import { userBudgets } from '../../mock/user-budgets.js';
import { spendHolds } from '../../mock/spend-holds.js';
import { spendEntries } from '../../mock/spend-ledger.js';
import { voiceSessions, voiceToolCalls } from '../../mock/voice-sessions.js';
import * as sessionsProvider from '../../providers/voice-sessions.js';
import { dbTenantScopeFor, runWithDbTenant } from '../../providers/db-tenant.js';
import { freezeClock, unfreezeClock } from '../../mock/core/index.js';

const SDP = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\n';
const ANSWER = 'v=0\r\no=- 9 9 IN IP4 10.0.0.1\r\ns=answer\r\n';
const USER = 'u-vera';

type Principal = { sub: string; role: string; tenant: string; grants: Record<string, string[]> };
let principal: Principal = { sub: USER, role: 'member', tenant: 'orgiq', grants: {} };
const app = express(); app.use(express.json());
// lib/session.ts's scope, as sessionMiddleware opens it for every request with a session.
app.use((req, _res, next) => {
  (req as unknown as { session: unknown }).session = principal;
  runWithDbTenant(dbTenantScopeFor(principal), () => next());
});
app.use('/api/voice', voiceRouter); app.use(errorHandler);

const ENV_KEYS = ['OPENAI_API_KEY', 'MOCK_VOICE', 'VOICE_DELEGATION_MODEL', 'VOICE_SESSION_MAX_MINUTES', 'VOICE_DAILY_MINUTES', 'INSECURE_DEV_MODE'];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
let provider = 0;

beforeEach(() => {
  jest.restoreAllMocks();
  provider = 0;
  resetRateLimits();
  unfreezeClock();
  for (const f of [spendHolds, spendEntries, userBudgets, voiceSessions, voiceToolCalls]) f.reset();
  for (const k of ENV_KEYS) delete process.env[k];
  process.env['INSECURE_DEV_MODE'] = 'true';
  process.env['OPENAI_API_KEY'] = 'sk-test-key';
  process.env['VOICE_DELEGATION_MODEL'] = 'gpt-delegate';
  principal = { sub: USER, role: 'member', tenant: 'orgiq', grants: {} };
  userBudgets.rows().push({ userId: USER, allocatedUsd: 1_000, hardCapUsd: null, note: null, setBy: 'u-release' });
  _resetSidebands();
  _setVoiceWebSocket(SilentSideband);
  _setVoiceFetch(async () => {
    provider += 1;
    return { status: 200, ok: true, text: async () => JSON.stringify({ session: { id: `sess_live_${provider}` }, transport: { sdp: ANSWER } }) };
  });
});
afterAll(() => {
  _setVoiceFetch(null);
  _resetSidebands();
  _setVoiceWebSocket(null);
  unfreezeClock();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

const mint = () => request(app).post('/api/voice/sessions').send({ sdp: SDP });
const close = (id: string, body: Record<string, unknown> = { seconds: 90 }) => request(app).post(`/api/voice/sessions/${id}/close`).send(body);
const holds = () => spendHolds.rows().filter((h) => h.source === 'voice_session');
const voiceRows = () => spendEntries.rows().filter((r) => r.source === 'voice_session' && !r.sourceId.endsWith(':tokens'));
const allRows = () => runWithDbTenant('*', () => voiceSessions.rows());

describe('M1: the close after a tenant switch, under row-level security', () => {
  it('the fixture hides another tenant\'s row, as RLS does', async () => {
    const id = (await mint()).body.sessionId as string;
    expect(runWithDbTenant('social', () => voiceSessions.rows()).map((r) => r.id)).toEqual([]);
    expect(runWithDbTenant('orgiq', () => voiceSessions.rows()).map((r) => r.id)).toEqual([id]);
  });

  it('a session minted in orgiq closes from social: the row closes and the hold settles', async () => {
    const id = (await mint()).body.sessionId as string;
    principal = { sub: USER, role: 'participant', tenant: 'social', grants: {} };
    const res = await close(id, { seconds: 90, reason: 'tenant-switch' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ sessionId: id, stopReason: 'tenant-switch', alreadyClosed: false, costBasis: 'estimated' });
    expect(allRows()).toEqual([expect.objectContaining({ id, stop_reason: 'tenant-switch', ended_at: expect.any(String) })]);
    expect(holds()).toEqual([expect.objectContaining({ sourceId: id, status: 'settled' })]);
    expect(voiceRows()).toEqual([expect.objectContaining({ sourceId: id, costBasis: 'estimated' })]);
  });

  it('the owner check still holds across tenants: another user in social reads 404 and nothing settles', async () => {
    const id = (await mint()).body.sessionId as string;
    principal = { sub: 'u-mallory', role: 'participant', tenant: 'social', grants: {} };
    expect((await close(id)).status).toBe(404);
    expect(allRows()[0]!.ended_at).toBeNull();
    expect(holds()[0]!.status).toBe('held');
  });

  it('tool-call rows still need the caller in the session\'s tenant', async () => {
    const id = (await mint()).body.sessionId as string;
    principal = { sub: USER, role: 'participant', tenant: 'social', grants: {} };
    expect((await request(app).post(`/api/voice/sessions/${id}/events`).send({ tool: 'open', outcome: 'done' })).status).toBe(404);
  });
});

describe('M3: one open real session per person', () => {
  it('a second mint while one is open is a 409 naming the open session, and holds nothing', async () => {
    const first = await mint();
    expect(first.status).toBe(201);
    const second = await mint();
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ error: 'voice-unavailable', reason: 'session-open', openSessionId: first.body.sessionId });
    expect(holds()).toHaveLength(1);
    // The dock closes it, and the next mint goes through.
    expect((await close(first.body.sessionId)).status).toBe(200);
    expect((await mint()).status).toBe(201);
  });

  it('the open session is found from another tenant too', async () => {
    const first = await mint();
    principal = { sub: USER, role: 'participant', tenant: 'social', grants: {} };
    expect((await mint()).body).toMatchObject({ reason: 'session-open', openSessionId: first.body.sessionId });
  });

  it('a session past its ceiling plus grace no longer blocks (the reaper\'s business); mock sessions never do', async () => {
    const restore = freezeClock('2026-11-08T10:00:00.000Z');
    try { expect((await mint()).status).toBe(201); } finally { restore(); }
    const later = freezeClock('2026-11-08T10:40:00.000Z');
    try { expect((await mint()).status).toBe(201); } finally { later(); }
    voiceSessions.reset();
    process.env['MOCK_VOICE'] = '1';
    delete process.env['OPENAI_API_KEY'];
    expect((await request(app).post('/api/voice/sessions').send({})).status).toBe(201);
    expect((await request(app).post('/api/voice/sessions').send({})).status).toBe(201);
  });

  it('five mints at once: at most one is minted; every other is refused with its row closed at zero and its hold released', async () => {
    const all = await Promise.all([mint(), mint(), mint(), mint(), mint()]);
    const won = all.filter((r) => r.status === 201).map((r) => r.body.sessionId as string);
    expect(won.length).toBeLessThanOrEqual(1);
    for (const r of all.filter((x) => x.status !== 201)) expect([r.status, r.body.reason]).toEqual([409, 'session-open']);
    expect(allRows().filter((r) => !r.ended_at).map((r) => r.id)).toEqual(won);
    expect(allRows().filter((r) => r.ended_at).every((r) => r.stop_reason === 'mint-failed' && r.seconds === 0)).toBe(true);
    expect(holds().filter((h) => h.status === 'held').map((h) => h.sourceId)).toEqual(won);
    expect(provider).toBe(won.length);
    expect(voiceRows()).toHaveLength(0);
  });

  it('two mints that both read before either inserted, and again after both did: neither goes through, and the retry does', async () => {
    // The worst interleaving, forced: a barrier holds each pair of reads (the two pre-insert checks, then the
    // two post-insert ones) until both requests have made it, so each post-insert read sees the other's row.
    const real = sessionsProvider.userOpenVoiceSessions;
    const gates = [[], []] as Array<Array<() => void>>;
    let reads = 0;
    jest.spyOn(sessionsProvider, 'userOpenVoiceSessions').mockImplementation(async (sub) => {
      const gate = gates[reads++ < 2 ? 0 : 1]!;
      await new Promise<void>((go) => { gate.push(go); if (gate.length === 2) gate.forEach((g) => g()); });
      return real(sub);
    });
    const [a, b] = await Promise.all([mint(), mint()]);
    expect([a.status, b.status]).toEqual([409, 409]);
    expect([a.body.reason, b.body.reason]).toEqual(['session-open', 'session-open']);
    expect(allRows()).toHaveLength(2);
    expect(allRows().every((r) => r.ended_at && r.stop_reason === 'mint-failed' && r.seconds === 0 && r.cost_usd === 0)).toBe(true);
    expect(holds().map((h) => h.status)).toEqual(['released', 'released']);
    expect(provider).toBe(0);
    jest.restoreAllMocks();
    expect((await mint()).status).toBe(201);
  });

  it('the day\'s minutes are re-read after the insert: a mint that crossed them is closed and refused', async () => {
    const restore = freezeClock('2026-11-08T15:00:00.000Z');
    try {
      // 55 minutes used today. The pre-insert read is stale: it misses a 10-minute session closed meanwhile.
      allRows().push({
        id: 'vs_00000000-0000-4000-8000-000000000001', user_sub: USER, tenant: 'orgiq', hold_id: null, provider_session_id: null,
        model: 'gpt-live-1', voice: null, mock: false, max_seconds: 3600, usd_per_minute: 0.05, started_at: '2026-11-08T09:00:00.000Z',
        ended_at: '2026-11-08T10:00:00.000Z', seconds: 3300, cost_usd: 2.75, cost_basis: 'estimated', stop_reason: 'closed', tool_calls: 0,
        provider_seconds: null, provider_tokens_in: null, provider_tokens_out: null, provider_tokens_cached: null,
      });
      const real = sessionsProvider.userVoiceSecondsSince;
      jest.spyOn(sessionsProvider, 'userVoiceSecondsSince')
        .mockImplementationOnce(async (sub, since) => (await real(sub, since)) - 600)
        .mockImplementation(real);
      const before = provider;
      const res = await mint();
      expect(res.status).toBe(429);
      expect(res.body).toMatchObject({ error: 'voice-unavailable', reason: 'daily-minutes', dailyMinutes: 60 });
      expect(allRows().filter((r) => !r.ended_at)).toEqual([]);
      expect(allRows().find((r) => r.id !== 'vs_00000000-0000-4000-8000-000000000001')).toMatchObject({ stop_reason: 'mint-failed', seconds: 0 });
      expect(holds()).toEqual([expect.objectContaining({ status: 'released' })]);
      // Refused before the provider was asked for anything.
      expect(provider).toBe(before);
    } finally { restore(); }
  });
});

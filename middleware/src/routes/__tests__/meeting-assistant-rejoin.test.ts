// Milo invited back into a call it left (POST /invite on a `left` record): a second listening period on the same record, its money,
// its consent and its refusals, through the real holds, ledger and user budgets on their offline stores. Harness: meeting-assistant-spend.test.ts.
const mockConfig = { region: 'us-east-1', auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true, agentcore: true }, aurora: {},
  meetingAssistant: { enabled: true, transcriptRetentionDays: 30 } };
jest.mock('../../config.js', () => ({ config: mockConfig }));
// The directory answers for the three people of the call; everything else in the module stays real (the budget reads use it).
jest.mock('../../providers/identity.js', () => ({ ...jest.requireActual('../../providers/identity.js'), getUser: jest.fn() }));
const mockInviters = new Set<string>();
jest.mock('../../lib/authz.js', () => ({
  resolveSession: (req: { session?: unknown }) => req.session,
  isAllowed: jest.fn(async () => true),
  requireTenant: (tenant: string) => (req: { session?: { tenant: string; role: string } }, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) =>
    (req.session?.tenant === tenant || req.session?.role === 'admin' ? next() : res.status(403).json({ error: 'Forbidden' })),
  requireAction: (action: string) => (req: { session?: { sub: string } }, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) =>
    (action === 'InviteMeetingAssistant' && req.session && mockInviters.has(req.session.sub) ? next() : res.status(403).json({ error: 'Forbidden', action })),
}));

import express from 'express';
import request from '../../test-support/http.js';
import { InMemoryCallStateStore } from '@connorhoehn/realtime-modules/call';
import { InMemoryChatStore } from '@connorhoehn/realtime-modules/chat';
import type { RealtimeRouter } from '@connorhoehn/realtime-modules/server';
import { meetingAssistantRouter } from '../meeting-assistant.js';
import { errorHandler } from '../../lib/async-handler.js';
import { CallChatRuntime, callChatChannel, setCallChatRuntime } from '../../lib/call-chat.js';
import { MemoryCallChatStateStore } from '../../lib/call-chat-state.js';
import { observeCallPageLifecycle } from '../../lib/call-pages.js';
import { assistantStore, assistantIntake, setAssistantStore, setAssistantIntake, LineIntake, MemoryAssistantStore, setTranscriptSource, MockTranscriptSource } from '../../lib/meeting-assistant/index.js';
import { AssistantRuntime, RunStillStopping, setAssistantRuntime, defaultRolesOf } from '../../lib/meeting-assistant/orchestrator.js';
import { ScriptedSession } from '../../lib/meeting-assistant/scripted-session.js';
import { settleFinished, setAssistantSpend, realSpend } from '../../lib/meeting-assistant/spend.js';
import { setSessionFactory } from '../../lib/meeting-assistant/session-select.js';
import { sessionOf } from '../../lib/meeting-assistant/types.js';
import { CALL_ENDED, coverageOf, DELETE_WHILE_BACK, heardSoFar, REJOIN_DELETED, REJOIN_LIMIT, REJOIN_STILL_LEAVING, setRejoinWaitMs } from '../meeting-assistant.js';
import { settleFromRecord } from '../../lib/meeting-assistant/reconcile.js';
import { minutesIdle, onCallEnded } from '../../lib/meeting-assistant/minutes-service.js';
import { newAssistantSession } from '../../lib/meeting-assistant/types.js';
import { userBudgets } from '../../mock/user-budgets.js';
import { spendHolds } from '../../mock/spend-holds.js';
import { spendEntries } from '../../mock/spend-ledger.js';
import { getUser } from '../../providers/identity.js';
import type { Session } from '../../lib/session.js';

const CALL = 'call-1'; const LOBBY = 'orgiq:dm:alice:bob:carol';
const mk = (sub: string): Session => ({ sub, name: sub, tenant: 'orgiq', role: 'member', epoch: 0, grants: { orgiq: ['member'], social: ['participant'] }, iat: 100 });
let sessions: Map<string, Session>; let contexts: Map<string, Record<string, unknown>>;
let calls: InMemoryCallStateStore; let rt: CallChatRuntime; let clock: number; let runtime: AssistantRuntime;
const ENV = ['MEETING_ASSISTANT_MAX_MINUTES', 'MEETING_ASSISTANT_HARD_MAX_MINUTES', 'VOICE_USD_PER_MINUTE'];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
const app = express(); app.use(express.json());
app.use((req, _res, next) => { req.session = sessions.get(String(req.headers['x-user'])); next(); });
app.use('/api/calls/:callId/assistant', meetingAssistantRouter); app.use(errorHandler);
const ctx = (s: Session) => ({ userId: s.sub, org: s.tenant, role: s.role, displayName: s.sub, epoch: s.epoch ?? 0, sessionIat: s.iat });
const url = (path: string) => `/api/calls/${CALL}/assistant/${path}`;
const post = (path: string, user = 'alice', body: object = {}) => request(app).post(url(path)).set('x-user', user).send(body);
const del = (path: string, user = 'alice') => request(app).delete(url(path)).set('x-user', user);
const get = (path: string, user = 'alice') => request(app).get(url(path)).set('x-user', user);
const holds = () => spendHolds.rows().filter((h) => h.source === 'meeting_assistant');
const entries = () => spendEntries.rows().filter((r) => r.source === 'meeting_assistant');
const budget = (userId: string, allocatedUsd = 1000, hardCapUsd: number | null = null) => userBudgets.rows().push({ userId, allocatedUsd, hardCapUsd, note: null, setBy: 'u-release' });
const flush = async () => { for (let i = 0; i < 6; i += 1) await new Promise<void>((r) => setImmediate(r)); };

beforeEach(async () => {
  clock = Date.parse('2026-11-13T12:00:00.000Z');
  for (const f of [spendHolds, spendEntries, userBudgets]) f.reset();
  for (const k of ENV) delete process.env[k];
  mockInviters.clear(); mockInviters.add('alice'); mockInviters.add('bob');
  sessions = new Map(['alice', 'bob', 'carol'].map((u) => [u, mk(u)]));
  contexts = new Map([['a', ctx(mk('alice'))], ['b', ctx(mk('bob'))], ['c', ctx(mk('carol'))]]);
  jest.mocked(getUser).mockImplementation(async (id: string) => ({ id, displayName: id, email: null, personId: null, epoch: 0, grants: mk(id).grants }) as never);
  calls = new InMemoryCallStateStore();
  const router = { sendToClient: jest.fn(), sendToChannel: jest.fn(), isClientLive: (id: string) => contexts.has(id), getClientData: (id: string) => ({ userContext: contexts.get(id) }), unsubscribeFromChannel: jest.fn() } as unknown as RealtimeRouter;
  rt = new CallChatRuntime({ calls, state: new MemoryCallChatStateStore(), messages: new InMemoryChatStore(), router, maintenanceIntervalMs: 0, now: () => clock, lobbyAllowed: (_a, lobby) => lobby.startsWith('orgiq:') });
  setCallChatRuntime(rt);
  const observed = observeCallPageLifecycle(calls, () => null, () => rt);
  for (const [cid, u] of [['a', 'alice'], ['b', 'bob'], ['c', 'carol']] as const) await observed.registerParticipant(CALL, cid, u, LOBBY, ['alice', 'bob', 'carol']);
  setAssistantStore(new MemoryAssistantStore());
  const source = new MockTranscriptSource(); setTranscriptSource(source);
  setAssistantIntake(new LineIntake(assistantStore(), { clock: () => clock, tickMs: 0, source: () => source }));
  runtime = new AssistantRuntime({ store: assistantStore, intake: assistantIntake, clock: () => clock, makeSession: () => new ScriptedSession(() => clock), rolesOf: defaultRolesOf,
    onFinished: (e) => settleFinished(e, clock) }, { tickMs: 0 });
  setAssistantRuntime(runtime);
});
afterEach(() => {
  setRejoinWaitMs(null);
  setAssistantRuntime(null); setAssistantIntake(null); setAssistantStore(null); setTranscriptSource(null); rt.dispose(); setCallChatRuntime(null);
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

const record = async () => (await assistantStore().get(CALL))!;
const texts = async () => (await rt.messages.listMessages(callChatChannel(CALL), 100)).map((m) => String(m.message));

describe('inviting Milo back', () => {
  it('anyone who may invite brings Milo back: a fresh hold against them under the next part, the whole call on the clock, acks reset, the voice off, the period kept', async () => {
    budget('alice'); budget('bob');
    const first = await post('invite', 'alice');
    expect(first.status).toBe(201);
    const invitedAt = first.body.invitedAt as number;
    await post('ack', 'bob'); await post('ack', 'carol');
    expect((await post('voice', 'alice', { on: true })).body.voice).toBe(true);
    clock += 600_000; await post('dismiss', 'carol'); await flush();
    const leftAt = (await record()).leftAt!;
    expect(entries().map((e) => [e.sourceId, e.actorId])).toEqual([['ma:call-1', 'alice']]);
    // The bar is told it may ask again.
    expect((await get('state', 'bob')).body).toMatchObject({ state: 'left', rejoin: 'allowed', period: 1 });

    clock += 120_000;
    const back = await post('invite', 'bob');
    expect(back.status).toBe(200);
    expect(back.body).toMatchObject({ state: 'listening', invitedBy: 'bob', invitedAt, pausedBy: null, leftAt: null, leftBy: null, voice: false, period: 2,
      listeningSeconds: 600, ceilingSeconds: 600 + 3600, mustAck: ['alice', 'carol'] });
    expect(runtime.isRunning(CALL)).toBe(true);
    const r = await record();
    expect(r.acked).toEqual(['bob']);
    expect(r.presentAtInvite.sort()).toEqual(['alice', 'bob', 'carol']);
    const s = sessionOf(r);
    expect(s).toMatchObject({ settled: false, ledgerPart: 1, extensions: 1, holds: [], listeningSeconds: 0, settledListeningSeconds: 600, ceilingSeconds: 4200, periodFrom: clock,
      periods: [{ invitedBy: 'alice', from: invitedAt, leftAt, leftBy: 'carol' }] });
    expect(holds().map((h) => [h.sourceId, h.actorId, h.status, h.amountUsd])).toEqual([['ma:call-1', 'alice', 'settled', 3], ['ma:call-1:x1', 'bob', 'held', 3]]);
    expect((await texts()).at(-1)).toMatch(/^Milo is back in this call at bob's invitation and is listening again\./);
    // The new period is billed to bob, under its own part; the first period's row is not touched.
    clock += 90_000; await post('dismiss', 'alice'); await flush();
    expect(entries().map((e) => [e.sourceId, e.actorId, e.costUsd])).toEqual([['ma:call-1', 'alice', 0.5], ['ma:call-1:x1', 'bob', 0.075]]);
    expect(holds().map((h) => h.status)).toEqual(['settled', 'settled']);
    expect(sessionOf(await record()).periods).toHaveLength(1);
    expect((await get('state', 'bob')).body).toMatchObject({ state: 'left', leftBy: 'alice', invitedBy: 'bob', listeningSeconds: 690 });
  });

  it('a seat without the right to invite is refused, and nothing changes', async () => {
    budget('alice');
    await post('invite', 'alice'); await post('dismiss', 'alice');
    expect((await post('invite', 'carol')).status).toBe(403);
    expect((await record()).state).toBe('left');
  });

  it('a call that left at its limit gets real time again, up to the hard maximum for the whole call, then never', async () => {
    process.env['MEETING_ASSISTANT_MAX_MINUTES'] = '10'; process.env['MEETING_ASSISTANT_HARD_MAX_MINUTES'] = '15';
    budget('alice');
    await post('invite', 'alice');
    clock += 600_000; await runtime.tick(); await flush();
    expect((await record()).state).toBe('left');
    const back = await post('invite', 'alice');
    expect(back.body).toMatchObject({ state: 'listening', listeningSeconds: 600, ceilingSeconds: 900 }); // five minutes are left under the maximum
    expect(holds().at(-1)).toMatchObject({ sourceId: 'ma:call-1:x1', amountUsd: 0.25, status: 'held' });
    expect((await post('extend', 'alice')).status).toBe(409);                  // the call is at its maximum
    clock += 300_000; await runtime.tick(); await flush();
    expect((await get('state')).body).toMatchObject({ state: 'left', rejoin: 'limit' });
    const refused = await post('invite', 'alice');
    expect([refused.status, refused.body.error]).toEqual([409, REJOIN_LIMIT]);
    expect(holds().filter((h) => h.status === 'held')).toEqual([]);
    expect((await record()).state).toBe('left');
  });

  it('a deleted record is never joined again, and the state says why', async () => {
    budget('alice');
    await post('invite', 'alice'); await post('dismiss', 'alice'); await flush();
    expect((await del('transcript', 'alice')).status).toBe(200);
    expect((await get('state', 'bob')).body.rejoin).toBe('deleted');
    const refused = await post('invite', 'bob');
    expect([refused.status, refused.body.error]).toEqual([409, REJOIN_DELETED]);
    expect(holds().filter((h) => h.status === 'held')).toEqual([]);
  });

  it('with no session provider, or a session that does not start, Milo stays out and the hold goes back', async () => {
    budget('alice'); budget('bob');
    await post('invite', 'alice'); await post('dismiss', 'alice'); await flush();
    setSessionFactory(() => null);
    expect((await post('invite', 'bob')).status).toBe(503);
    setSessionFactory(null);
    expect(holds().filter((h) => h.status === 'held')).toEqual([]);
    runtime.deps.makeSession = () => { throw new Error('provider down'); };
    const failed = await post('invite', 'bob');
    expect([failed.status, failed.body.error]).toEqual([503, 'Milo could not start. Try again in a moment.']);
    expect(holds().map((h) => [h.sourceId, h.status])).toEqual([['ma:call-1', 'settled'], ['ma:call-1:x1', 'released']]);
    expect((await record()).state).toBe('left');
    expect(assistantIntake().isListening(CALL)).toBe(false);
    expect(runtime.isRunning(CALL)).toBe(false);
  });

  it('a budget that refuses refuses the invitation back in the usual words; the person inviting may confirm past their own budget', async () => {
    budget('alice'); budget('bob', 1, 100);
    await post('invite', 'alice'); await post('dismiss', 'alice'); await flush();
    const refused = await post('invite', 'bob');
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ reason: 'budget', confirmFlag: 'confirmOverUserBudget', error: "This would put Milo's time over your budget." });
    expect((await record()).state).toBe('left');
    expect(assistantIntake().isListening(CALL)).toBe(false);
    const ok = await post('invite', 'bob', { confirmOverUserBudget: true });
    expect([ok.status, ok.body.state, ok.body.invitedBy]).toEqual([200, 'listening', 'bob']);
  });

  it('two invitations back at once make one period: one hold stays, the other goes back, one notice', async () => {
    budget('alice'); budget('bob');
    await post('invite', 'alice'); await post('dismiss', 'alice'); await flush();
    let arrived = 0; let open!: () => void; const gate = new Promise<void>((r) => { open = r; });
    setAssistantSpend({ ...realSpend, reserve: async (i) => { arrived += 1; if (arrived >= 2) open(); await gate; return realSpend.reserve(i); } });
    const [a, b] = await Promise.all([post('invite', 'alice'), post('invite', 'bob')]);
    setAssistantSpend(null);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.body.state).toBe('listening'); expect(b.body.state).toBe('listening');
    expect(a.body.invitedBy).toBe(b.body.invitedBy);
    const fresh = holds().filter((h) => h.sourceId === 'ma:call-1:x1');
    expect(fresh.map((h) => h.status).sort()).toEqual(['held', 'released']);
    expect(fresh.find((h) => h.status === 'held')!.actorId).toBe(a.body.invitedBy);
    expect(sessionOf(await record()).periods).toHaveLength(1);
    expect((await texts()).filter((t) => t.startsWith('Milo is back in this call'))).toHaveLength(1);
    expect(runtime.isRunning(CALL)).toBe(true);
  });

  it('a dismissal racing an invitation back ends in one consistent state', async () => {
    budget('alice'); budget('bob');
    await post('invite', 'alice'); clock += 60_000;
    const [d, i] = await Promise.all([post('dismiss', 'carol'), post('invite', 'bob')]);
    expect(d.status).toBe(200); expect([200, 201]).toContain(i.status);
    await flush();
    const r = await record(); const s = sessionOf(r);
    // Either the invitation found Milo still there (nothing changed) or it brought Milo back after the dismissal (one new period).
    if (r.state === 'left') expect(s.periods ?? []).toEqual([]);
    else expect([r.state, s.periods?.length, r.invitedBy]).toEqual(['listening', 1, 'bob']);
    expect(holds().filter((h) => h.status === 'held')).toHaveLength(r.state === 'left' ? 0 : 1);
    expect(entries().filter((e) => e.sourceId === 'ma:call-1')).toHaveLength(1);
  });

  it('two dismissals of the second period settle it once', async () => {
    budget('alice'); budget('bob');
    await post('invite', 'alice'); await post('dismiss', 'alice'); await flush();
    await post('invite', 'bob'); clock += 30_000;
    await Promise.all([post('dismiss', 'alice'), post('dismiss', 'carol')]); await flush();
    expect(entries().filter((e) => e.sourceId === 'ma:call-1:x1')).toHaveLength(1);
    expect((await record()).state).toBe('left');
  });

  it('a leave whose settlement never finished (the process died) is settled from the record before the new period starts', async () => {
    budget('alice'); budget('bob');
    await post('invite', 'alice'); clock += 120_000; await runtime.tick(); // its last heartbeat
    // The process died while listening: the record says left (the call-end path) but nothing settled and the period is still open.
    await assistantStore().transition(CALL, { from: ['listening'], to: 'left', by: 'system', at: clock });
    setAssistantRuntime(null);
    runtime = new AssistantRuntime({ store: assistantStore, intake: assistantIntake, clock: () => clock, makeSession: () => new ScriptedSession(() => clock), rolesOf: defaultRolesOf,
      onFinished: (e) => settleFinished(e, clock) }, { tickMs: 0 });
    setAssistantRuntime(runtime);
    expect(sessionOf(await record()).settled).toBe(false);
    const back = await post('invite', 'bob');
    expect(back.status).toBe(200);
    expect(entries().map((e) => [e.sourceId, e.actorId])).toEqual([['ma:call-1', 'alice']]);
    expect(sessionOf(await record())).toMatchObject({ settledListeningSeconds: 120, ledgerPart: 1, settled: false });
  });

  it('a period a dead process left open counts to its last heartbeat, not to now: the call is not wrongly out of listening time', async () => {
    process.env['MEETING_ASSISTANT_MAX_MINUTES'] = '10'; process.env['MEETING_ASSISTANT_HARD_MAX_MINUTES'] = '15';
    budget('alice'); budget('bob');
    await post('invite', 'alice'); clock += 120_000; await runtime.tick();      // its last heartbeat, two minutes in
    const lastAliveAt = clock;
    // The process died; half an hour later the call's end (elsewhere) moved the record to left without closing the clock or settling.
    clock += 1_800_000;
    await assistantStore().transition(CALL, { from: ['listening'], to: 'left', by: 'system', at: clock });
    setAssistantRuntime(null);
    runtime = new AssistantRuntime({ store: assistantStore, intake: assistantIntake, clock: () => clock, makeSession: () => new ScriptedSession(() => clock), rolesOf: defaultRolesOf,
      onFinished: (e) => settleFinished(e, clock) }, { tickMs: 0 });
    setAssistantRuntime(runtime);
    clock += 3_600_000;                                                           // an hour later still
    const r = await record();
    expect(sessionOf(r)).toMatchObject({ listeningSince: expect.any(Number), lastAliveAt });
    expect(heardSoFar(r, clock)).toBe(120);
    expect(heardSoFar({ ...r, session: { ...sessionOf(r), lastAliveAt: undefined } }, clock)).toBe(1920);   // no heartbeat: up to the leave, still not now
    expect((await get('state', 'bob')).body).toMatchObject({ state: 'left', rejoin: 'allowed' });
    const back = await post('invite', 'bob');
    expect([back.status, back.body.listeningSeconds, back.body.ceilingSeconds]).toEqual([200, 120, 120 + 600]);
  });

  it('the person who invited Milo in any period may delete the record afterwards; an attendee who never did gets 403', async () => {
    budget('alice'); budget('bob');
    await post('invite', 'alice'); await post('dismiss', 'alice'); await flush();
    await post('invite', 'bob'); await post('dismiss', 'bob'); await flush();
    expect((await del('transcript', 'carol')).status).toBe(403);
    expect((await del('transcript', 'alice')).status).toBe(200);
  });

  it('while Milo is back in the call the record cannot be deleted, by either inviter', async () => {
    budget('alice'); budget('bob');
    await post('invite', 'alice'); await post('dismiss', 'alice'); await flush();
    await post('invite', 'bob');
    expect((await del('transcript', 'alice')).status).toBe(409);
    expect((await del('transcript', 'bob')).status).toBe(409);
  });
});

describe('inviting Milo back while its earlier period is still stopping', () => {
  /** The dismissal's stop is held at its settlement until `open()`; the dismiss request answers only then. */
  const slowStop = () => {
    let open!: () => void; const gate = new Promise<void>((r) => { open = r; });
    runtime.deps.onFinished = async (e) => { await gate; await settleFinished(e, clock); };
    return open;
  };
  const leftNow = async () => { for (let i = 0; i < 40 && (await record()).state !== 'left'; i += 1) await flush(); expect((await record()).state).toBe('left'); };

  it('waits for the stop, then settles the first period once under its own part and starts the second with a live session', async () => {
    budget('alice'); budget('bob');
    await post('invite', 'alice'); clock += 600_000;
    const open = slowStop();
    const dismissed = post('dismiss', 'carol').then((r) => r);
    await leftNow();
    const back = post('invite', 'bob').then((r) => r);
    await flush(); await new Promise<void>((r) => setTimeout(r, 60));
    expect(holds().map((h) => h.sourceId)).toEqual(['ma:call-1']);      // nothing is held while the stop is still finishing
    open();
    const [d, b] = await Promise.all([dismissed, back]);
    expect(d.status).toBe(200);
    expect([b.status, b.body.state, b.body.invitedBy, b.body.period]).toEqual([200, 'listening', 'bob', 2]);
    expect(entries().map((e) => [e.sourceId, e.costUsd])).toEqual([['ma:call-1', 0.5]]);
    expect(runtime.isRunning(CALL)).toBe(true); expect(runtime.hasSession(CALL)).toBe(true);
    expect(holds().map((h) => [h.sourceId, h.status])).toEqual([['ma:call-1', 'settled'], ['ma:call-1:x1', 'held']]);
    expect(sessionOf(await record())).toMatchObject({ settled: false, ledgerPart: 1, listeningSince: clock, listeningSeconds: 0, settledListeningSeconds: 600 });
    // The second period is billed on its own when it ends.
    clock += 60_000; await post('dismiss', 'alice'); await flush();
    expect(entries().map((e) => e.sourceId)).toEqual(['ma:call-1', 'ma:call-1:x1']);
  });

  it('a stop that takes longer than the wait answers that Milo is still leaving, and nothing is held', async () => {
    budget('alice'); budget('bob');
    setRejoinWaitMs(40);
    await post('invite', 'alice'); clock += 600_000;
    const open = slowStop();
    const dismissed = post('dismiss', 'carol').then((r) => r);
    await leftNow();
    const refused = await post('invite', 'bob');
    expect([refused.status, refused.body.error]).toEqual([409, REJOIN_STILL_LEAVING]);
    expect(holds().map((h) => h.sourceId)).toEqual(['ma:call-1']);
    expect(entries()).toEqual([]);
    open(); expect((await dismissed).status).toBe(200);
    expect(entries().map((e) => e.sourceId)).toEqual(['ma:call-1']);
    expect((await record()).state).toBe('left');
    expect((await post('invite', 'bob')).status).toBe(200);                 // once it has left, the invitation back goes through
  });

  it('a stop that ends after Milo was invited back never changes the newer period\'s clock, usage or ledger', async () => {
    budget('alice'); budget('bob');
    const invitedAt = (await post('invite', 'alice')).body.invitedAt as number;
    clock += 300_000;
    // The record left and came back (as another process would) while this process's run of the first period still exists.
    await assistantStore().transition(CALL, { from: ['listening'], to: 'left', by: 'system', at: clock });
    await settleFromRecord(CALL, { clock: () => clock });
    expect(entries().map((e) => e.sourceId)).toEqual(['ma:call-1']);
    await assistantStore().rejoin(CALL, { leftAt: clock, by: 'bob', at: clock, present: ['bob'], session: {
      settled: false, ledgerPart: 1, extensions: 1, holds: [], listeningSeconds: 0, listeningSince: clock, settledListeningSeconds: 300, usageSeconds: 0, tokensIn: 0,
      periodFrom: clock, periods: [{ invitedBy: 'alice', from: invitedAt, leftAt: clock, leftBy: 'system' }] } });
    clock += 60_000;
    const before = sessionOf(await record());
    await runtime.stop(CALL); await flush();
    const after = sessionOf(await record());
    expect(after).toEqual(before);
    expect(after).toMatchObject({ settled: false, listeningSince: clock - 60_000, listeningSeconds: 0, usageSeconds: 0 });
    expect(entries().map((e) => e.sourceId)).toEqual(['ma:call-1']);
  });

  it('an invitation back that finds Milo already back after its wait answers with the record and touches nothing of that period', async () => {
    budget('alice'); budget('bob');
    const invitedAt = (await post('invite', 'alice')).body.invitedAt as number;
    clock += 600_000;
    const open = slowStop();
    const dismissed = post('dismiss', 'carol').then((r) => r);
    await leftNow();
    const leftAt = (await record()).leftAt!;
    const back = post('invite', 'bob').then((r) => r);
    await flush();
    // Meanwhile Milo is brought back elsewhere (another process): the second period is open and unsettled.
    await assistantStore().rejoin(CALL, { leftAt, by: 'alice', at: clock, present: ['alice'], session: {
      settled: false, ledgerPart: 1, extensions: 1, holds: [], listeningSeconds: 0, listeningSince: clock, settledListeningSeconds: 600,
      periodFrom: clock, periods: [{ invitedBy: 'alice', from: invitedAt, leftAt, leftBy: 'carol' }] } });
    const period2 = sessionOf(await record());
    open();
    const [d, b] = await Promise.all([dismissed, back]);
    expect(d.status).toBe(200);
    expect([b.status, b.body.state, b.body.invitedBy, b.body.period]).toEqual([200, 'listening', 'alice', 2]);
    expect(sessionOf(await record())).toEqual(period2);
    expect(holds().map((h) => h.sourceId)).toEqual(['ma:call-1']);
    expect(entries().map((e) => e.sourceId)).not.toContain('ma:call-1:x1');
  });

  it('start refuses a second run while the earlier one is stopping, and is a no-op for a live run of the same period', async () => {
    budget('alice');
    await post('invite', 'alice');
    const ctx = { callId: CALL, tenant: 'orgiq', inviterId: 'alice', roster: [], recordName: null };
    await expect(runtime.start({ ...ctx, period: 1 })).resolves.toBeUndefined();
    await expect(runtime.start({ ...ctx, period: 2 })).rejects.toBeInstanceOf(RunStillStopping);
    const open = slowStop();
    const stopping = runtime.stop(CALL);
    await expect(runtime.start(ctx)).rejects.toBeInstanceOf(RunStillStopping);
    expect(await runtime.settled(CALL, 20)).toBe(false);
    open(); await stopping;
    expect(await runtime.settled(CALL, 20)).toBe(true);
  });
});

describe('a delete racing an invitation back', () => {
  it('the delete first: the invitation back in flight gives its hold back, starts nothing and says the record was deleted', async () => {
    budget('alice'); budget('bob');
    await post('invite', 'alice'); clock += 60_000; await post('dismiss', 'alice'); await flush();
    let open!: () => void; const gate = new Promise<void>((r) => { open = r; });
    setAssistantSpend({ ...realSpend, reserve: async (i) => { await gate; return realSpend.reserve(i); } });
    const back = post('invite', 'bob').then((r) => r);
    await flush();
    expect((await del('transcript', 'alice')).status).toBe(200);           // the record was still left: it is erased
    open();
    const refused = await back;
    setAssistantSpend(null);
    expect([refused.status, refused.body.error]).toEqual([409, REJOIN_DELETED]);
    expect((await record()).state).toBe('left');
    expect(holds().map((h) => [h.sourceId, h.status])).toEqual([['ma:call-1', 'settled'], ['ma:call-1:x1', 'released']]);
    expect(runtime.isRunning(CALL)).toBe(false);
    expect(assistantIntake().isListening(CALL)).toBe(false);
    expect(entries().map((e) => e.sourceId)).toEqual(['ma:call-1']);
  });

  it('the invitation back first (between the delete\'s check and its erase): nothing is erased and the delete says Milo is back', async () => {
    budget('alice'); budget('bob');
    await post('invite', 'alice'); clock += 60_000; await post('dismiss', 'alice'); await flush();
    const store = assistantStore() as MemoryAssistantStore;
    const getMinutes = store.getMinutes.bind(store); let armed = true;
    // The delete reads the record (left), then its minutes: at that moment someone invites Milo back.
    store.getMinutes = async (id: string) => { if (armed) { armed = false; expect((await post('invite', 'bob')).status).toBe(200); } return getMinutes(id); };
    const refused = await del('transcript', 'alice');
    store.getMinutes = getMinutes;
    expect([refused.status, refused.body.error]).toEqual([409, DELETE_WHILE_BACK]);
    expect((await record()).state).toBe('listening');
    expect((await store.getMinutes(CALL))?.deleted).toBeUndefined();
    expect(sessionOf(await record()).erasedAt).toBeUndefined();
    expect((await texts()).some((t) => t.startsWith('Milo is back in this call'))).toBe(true);   // the chat was not erased either
    expect(runtime.isRunning(CALL)).toBe(true);
  });
});

describe('the call ending during an invitation back', () => {
  it('Milo leaves with the call at once: the new period is closed and settled, nothing stays held or running, and the person is told', async () => {
    budget('alice'); budget('bob');
    await post('invite', 'alice'); clock += 60_000; await post('dismiss', 'alice'); await flush();
    let open!: () => void; const gate = new Promise<void>((r) => { open = r; });
    setAssistantSpend({ ...realSpend, reserve: async (i) => { await gate; return realSpend.reserve(i); } });
    const back = post('invite', 'bob').then((r) => r);
    await flush();
    // The call ends while the invitation back is past its seat check: the end finds Milo still out and has nothing to stop.
    jest.spyOn(rt, 'lobbyOf').mockResolvedValue(null);
    await onCallEnded(CALL, { stop: (id) => runtime.stop(id), stopIntake: (id) => assistantIntake().stop(id) });
    open();
    const ended = await back;
    setAssistantSpend(null); await minutesIdle();
    expect([ended.status, ended.body.error]).toEqual([409, CALL_ENDED]);
    const r = await record();
    expect([r.state, r.leftBy, r.invitedBy]).toEqual(['left', 'system', 'bob']);
    expect(sessionOf(r)).toMatchObject({ settled: true, listeningSince: null, ledgerPart: 1 });
    expect(holds().map((h) => [h.sourceId, h.status])).toEqual([['ma:call-1', 'settled'], ['ma:call-1:x1', 'settled']]);
    expect(entries().map((e) => e.sourceId)).toEqual(['ma:call-1', 'ma:call-1:x1']);
    expect(runtime.isRunning(CALL)).toBe(false);
    expect(assistantIntake().isListening(CALL)).toBe(false);
  });
});

describe('the meeting page coverage', () => {
  it('counts listening across every period and Milo\'s time in the call as the sum of its periods (not the time it was away)', () => {
    const t0 = 1_000_000;
    const r = { callId: CALL, tenant: 'orgiq', lobby: LOBBY, initiativeId: null, state: 'left' as const, invitedBy: 'bob', invitedAt: t0, pausedBy: null, leftAt: t0 + 1_500_000, leftBy: 'alice',
      acked: ['bob', 'alice'], attendees: ['alice', 'bob', 'carol'], presentAtInvite: ['alice', 'bob', 'carol'], requests: 0, linesStored: 0, nextSeq: 1, pendingRequests: [],
      session: { ...newAssistantSession(3600), settledListeningSeconds: 120, listeningSeconds: 60, periodFrom: t0 + 1_400_000,
        periods: [{ invitedBy: 'alice', from: t0, leftAt: t0 + 180_000, leftBy: 'carol' }] } };
    // 180 s in the first period (120 listened, 60 paused), 100 s in the second (60 listened, 40 paused); the 1,220 s between are neither.
    expect(coverageOf(r, r.attendees)).toEqual({ listenedSeconds: 180, pausedSeconds: 100, untranscribed: 1 });
  });
});

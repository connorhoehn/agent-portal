// After a restart (audit M5): the boot reconcile closes the listening period at the last heartbeat, books the spend once, pauses the record
// with one notice, and a resume then starts a fresh session with a fresh hold. Same harness as meeting-assistant-spend.test.ts (real holds and ledger).
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
import { AssistantRuntime, setAssistantRuntime, defaultRolesOf } from '../../lib/meeting-assistant/orchestrator.js';
import { ScriptedSession } from '../../lib/meeting-assistant/scripted-session.js';
import { settleFinished } from '../../lib/meeting-assistant/spend.js';
import { reconcileAfterRestart, settleAtShutdown, RESTART_NOTICE } from '../../lib/meeting-assistant/reconcile.js';
import { minutesIdle } from '../../lib/meeting-assistant/minutes-service.js';
import { NOVA_USER_ID } from '../../lib/meeting-assistant/chat-types.js';
import { userBudgets } from '../../mock/user-budgets.js';
import { spendHolds } from '../../mock/spend-holds.js';
import { spendEntries } from '../../mock/spend-ledger.js';
import { getUser } from '../../providers/identity.js';
import type { Session } from '../../lib/session.js';

const CALL = 'call-1'; const LOBBY = 'orgiq:dm:alice:bob:carol';
const mk = (sub: string): Session => ({ sub, name: sub, tenant: 'orgiq', role: 'member', epoch: 0, grants: { orgiq: ['member'], social: ['participant'] }, iat: 100 });
let sessions: Map<string, Session>; let contexts: Map<string, Record<string, unknown>>;
let chat: InMemoryChatStore; let calls: InMemoryCallStateStore; let rt: CallChatRuntime; let clock: number; let runtime: AssistantRuntime;
const ENV = ['MEETING_ASSISTANT_MAX_MINUTES', 'MEETING_ASSISTANT_HARD_MAX_MINUTES', 'VOICE_USD_PER_MINUTE'];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
const app = express(); app.use(express.json());
app.use((req, _res, next) => { req.session = sessions.get(String(req.headers['x-user'])); next(); });
app.use('/api/calls/:callId/assistant', meetingAssistantRouter); app.use(errorHandler);
const ctx = (s: Session) => ({ userId: s.sub, org: s.tenant, role: s.role, displayName: s.sub, epoch: s.epoch ?? 0, sessionIat: s.iat });
const url = (path: string) => `/api/calls/${CALL}/assistant/${path}`;
const post = (path: string, user = 'alice', body: object = {}) => request(app).post(url(path)).set('x-user', user).send(body);
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
  rt = new CallChatRuntime({ calls, state: new MemoryCallChatStateStore(), messages: chat = new InMemoryChatStore(), router, maintenanceIntervalMs: 0, now: () => clock, lobbyAllowed: (_a, lobby) => lobby.startsWith('orgiq:') });
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
  setAssistantRuntime(null); setAssistantIntake(null); setAssistantStore(null); setTranscriptSource(null); rt.dispose(); setCallChatRuntime(null);
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});


const novaTexts = async () => (await chat.listMessages(callChatChannel(CALL), 100)).filter((m) => m.userId === NOVA_USER_ID).map((m) => m.message);
const freshRuntime = () => {
  const next = new AssistantRuntime({ store: assistantStore, intake: assistantIntake, clock: () => clock, makeSession: () => new ScriptedSession(() => clock), rolesOf: defaultRolesOf,
    onFinished: (e) => settleFinished(e, clock) }, { tickMs: 0 });
  setAssistantRuntime(next); return next;
};
const noTaps = { taps: () => null, callOver: async () => false };

describe('a restart leaves a listening record behind', () => {
  it('closes the period at the last heartbeat, books one ledger row, pauses by the system with one notice, and does nothing the second time', async () => {
    budget('alice');
    expect((await post('invite')).status).toBe(201);
    clock += 60_000; await runtime.tick();                 // the heartbeat: the process was alive at +60 s
    freshRuntime();                                         // it dies here (the old runtime is dropped at +60 s)
    clock += 3 * 3600_000;                                  // and the next boot's clock is hours later
    const first = await reconcileAfterRestart({ clock: () => clock, ...noTaps });
    await flush();
    expect(first).toMatchObject({ paused: 1, left: 0, settled: 1 });
    const record = (await assistantStore().get(CALL))!;
    expect(record).toMatchObject({ state: 'paused', pausedBy: 'system' });
    expect(record.session).toMatchObject({ listeningSeconds: 60, listeningSince: null, settled: true });
    expect(entries()).toEqual([expect.objectContaining({ sourceId: 'ma:call-1', costUsd: 0.05 })]);
    expect(holds()[0]!.status).toBe('settled');
    expect((await novaTexts()).filter((t) => t === RESTART_NOTICE)).toHaveLength(1);

    const second = await reconcileAfterRestart({ clock: () => clock + 1000, ...noTaps });
    expect(second).toEqual({ paused: 0, left: 0, settled: 0, tapsDeleted: 0 });
    expect(entries()).toHaveLength(1);
    expect((await novaTexts()).filter((t) => t === RESTART_NOTICE)).toHaveLength(1);
    expect((await assistantStore().get(CALL))!.session!.listeningSeconds).toBe(60);
  });

  it('uses invitedAt when no heartbeat was ever written', async () => {
    budget('alice');
    await post('invite');
    clock += 10 * 60_000;
    freshRuntime();
    await reconcileAfterRestart({ clock: () => clock, ...noTaps });
    expect((await assistantStore().get(CALL))!.session!.listeningSeconds).toBe(0);
  });

  it('resume after the settlement starts a fresh session with a fresh hold, and its own ledger row at the end', async () => {
    budget('alice');
    await post('invite'); clock += 60_000; await runtime.tick();
    freshRuntime(); clock += 3600_000;
    await reconcileAfterRestart({ clock: () => clock, ...noTaps });
    expect(holds().map((h) => h.sourceId)).toEqual(['ma:call-1']);
    expect((await post('resume', 'bob')).status).toBe(200);
    expect(holds().map((h) => [h.sourceId, h.status])).toEqual([['ma:call-1', 'settled'], ['ma:call-1:x1', 'held']]);
    expect((await assistantStore().get(CALL))!.session).toMatchObject({ settled: false, ledgerPart: 1, listeningSeconds: 0, holds: [] });
    clock += 30_000; await post('dismiss', 'alice'); await flush();
    expect(entries().map((e) => e.sourceId).sort()).toEqual(['ma:call-1', 'ma:call-1:x1']);
    expect(holds().every((h) => h.status === 'settled')).toBe(true);
  });

  it('the ceiling survives a restart: after 50 of 60 minutes, the warning comes 5 minutes after the resume and the limit at 10', async () => {
    budget('alice');
    await post('invite');
    clock += 50 * 60_000; await runtime.tick();             // 50 minutes listened, then the process dies
    const rt2 = freshRuntime(); clock += 3600_000;
    await reconcileAfterRestart({ clock: () => clock, ...noTaps });
    expect((await post('resume', 'bob')).status).toBe(200);
    const view = (await get('state')).body;
    expect(view).toMatchObject({ listeningSeconds: 3000, ceilingSeconds: 3600 });
    expect(await assistantStore().get(CALL)).toMatchObject({ session: { settledListeningSeconds: 3000, listeningSeconds: 0 } });
    clock += 4 * 60_000; await rt2.tick(); await flush();
    expect((await novaTexts()).some((t) => /leaves in 5 minutes/.test(t))).toBe(false);
    clock += 60_000; await rt2.tick(); await flush();
    expect((await novaTexts()).filter((t) => /leaves in 5 minutes/.test(t))).toHaveLength(1);
    expect((await assistantStore().get(CALL))!.state).toBe('listening');
    clock += 5 * 60_000; await rt2.tick(); await flush();
    expect((await assistantStore().get(CALL))!.state).toBe('left');
    expect((await novaTexts()).some((t) => /reached its 60-minute limit/.test(t))).toBe(true);
  });

  it('a resume the budget refuses leaves the record paused and holds nothing new', async () => {
    budget('alice');
    await post('invite'); freshRuntime(); clock += 1000;
    await reconcileAfterRestart({ clock: () => clock, ...noTaps });
    userBudgets.reset(); budget('alice', 0, 0);
    const res = await post('resume', 'bob');
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await assistantStore().get(CALL))!.state).toBe('paused');
    expect(holds().filter((h) => h.status === 'held')).toEqual([]);
  });
});

describe('records the reconcile does not move', () => {
  it('a paused record keeps its state and pauser and posts nothing; its spend is settled and its holds released', async () => {
    budget('alice');
    await post('invite'); clock += 20_000; await post('pause', 'bob');
    const noticesBefore = (await novaTexts()).length;
    freshRuntime(); clock += 3600_000;
    expect(await reconcileAfterRestart({ clock: () => clock, ...noTaps })).toMatchObject({ paused: 0, left: 0, settled: 1 });
    expect(await assistantStore().get(CALL)).toMatchObject({ state: 'paused', pausedBy: 'bob' });
    expect((await novaTexts()).length).toBe(noticesBefore);
    expect(entries()).toHaveLength(1); expect(holds()[0]!.status).toBe('settled');
  });

  it('a record whose process is still running it is left alone', async () => {
    budget('alice'); await post('invite');
    expect(await reconcileAfterRestart({ clock: () => clock, ...noTaps, isRunning: () => true })).toEqual({ paused: 0, left: 0, settled: 0, tapsDeleted: 0 });
    expect((await assistantStore().get(CALL))!.state).toBe('listening');
  });
});

describe('a call that ended while the process was down', () => {
  it('moves to left and writes its minutes through the existing service', async () => {
    budget('alice');
    await post('invite'); clock += 30_000;
    await assistantStore().appendLine({ callId: CALL, userId: 'alice', participantId: 'p', speakerName: 'alice', text: 'We decided to ship Thursday.', at: clock, captionId: 'c1' });
    freshRuntime();
    const result = await reconcileAfterRestart({ clock: () => clock, taps: () => null, callOver: async () => true });
    await minutesIdle(); await flush();
    expect(result).toMatchObject({ left: 1, paused: 0 });
    expect(await assistantStore().get(CALL)).toMatchObject({ state: 'left', leftBy: 'system' });
    expect(await assistantStore().getMinutes(CALL)).toMatchObject({ callId: CALL, lineCount: 1, writer: expect.any(String) });
    expect((await assistantStore().getMinutes(CALL))!.deleted).toBeUndefined();
    expect(entries().map((e) => e.sourceId).sort()).toEqual(['ma:call-1', 'ma:call-1:minutes']);   // the listening row once, plus the minutes' own
    expect((await novaTexts()).filter((t) => t === RESTART_NOTICE)).toEqual([]);
  });
});

describe('the call\'s tap', () => {
  it('is deleted on the channel the record names; a failure keeps the channel and is tried again on the next boot', async () => {
    budget('alice'); await post('invite');
    await assistantStore().patchSession(CALL, { channelArn: 'arn:mock:channel/1' });
    freshRuntime();
    const deleteStale = jest.fn(async () => false);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await reconcileAfterRestart({ clock: () => clock, callOver: async () => false, taps: () => ({ deleteStale }) });
    expect(deleteStale).toHaveBeenCalledWith('arn:mock:channel/1');
    expect((await assistantStore().get(CALL))!.session!.channelArn).toBe('arn:mock:channel/1');
    deleteStale.mockResolvedValue(true);
    expect(await reconcileAfterRestart({ clock: () => clock, callOver: async () => false, taps: () => ({ deleteStale }) })).toMatchObject({ tapsDeleted: 1 });
    expect((await assistantStore().get(CALL))!.session!.channelArn).toBe('');
    warn.mockRestore();
  });
});

describe('shutdown', () => {
  it('settles a live run the way a restart would find it: period closed at the last heartbeat, one ledger row, paused by the system', async () => {
    budget('alice'); await post('invite');
    clock += 45_000;
    await settleAtShutdown();
    await flush();
    expect(runtime.hasRuns()).toBe(false);
    expect(await assistantStore().get(CALL)).toMatchObject({ state: 'paused', pausedBy: 'system' });
    expect((await assistantStore().get(CALL))!.session).toMatchObject({ listeningSeconds: 45, listeningSince: null, settled: true });
    expect(entries()).toHaveLength(1); expect(holds()[0]!.status).toBe('settled');
    await settleAtShutdown();                                  // nothing is running now: nothing happens
    expect(entries()).toHaveLength(1);
  });
});

describe('the heartbeat', () => {
  it('the orchestrator tick writes lastAliveAt on the record at most every 30 seconds', async () => {
    budget('alice'); await post('invite');
    const alive = async () => (await assistantStore().get(CALL))!.session!.lastAliveAt;
    const t0 = clock; await runtime.tick();
    expect(await alive()).toBe(t0);
    clock += 10_000; await runtime.tick();
    expect(await alive()).toBe(t0);
    clock += 21_000; await runtime.tick();
    expect(await alive()).toBe(t0 + 31_000);
  });
});

// What Nova costs, through the real holds, ledger and user budgets on their offline (MOCK_AURORA) stores (package 4a, decision 10).
// "The hold is held" and "one ledger row" are read back from the tables. The harness is meeting-assistant-turns.test.ts.
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
  setAssistantRuntime(null); setAssistantIntake(null); setAssistantStore(null); setTranscriptSource(null); rt.dispose(); setCallChatRuntime(null);
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

describe('the invite reserves, the dismissal settles', () => {
  it('holds the ceiling\'s minutes at the voice rate against the inviter, then books one ledger row for the seconds listened', async () => {
    budget('alice');
    expect((await post('invite')).status).toBe(201);
    expect(holds()).toEqual([expect.objectContaining({ source: 'meeting_assistant', sourceId: 'ma:call-1', actorId: 'alice', amountUsd: 3, status: 'held' })]);
    expect(entries()).toEqual([]);
    clock += 90_000;
    expect((await get('state')).body).toMatchObject({ state: 'listening', listeningSeconds: 90, ceilingSeconds: 3600, refusedCalls: 0 });
    expect((await post('dismiss', 'bob')).status).toBe(200);
    await flush();
    expect(entries()).toEqual([expect.objectContaining({ source: 'meeting_assistant', sourceId: 'ma:call-1', actorId: 'alice', costUsd: 0.075, costBasis: 'estimated', provider: 'openai', trigger: 'meeting-assistant:orgiq' })]);
    expect(holds()[0]!.status).toBe('settled');
    await post('dismiss', 'alice');
    expect(entries()).toHaveLength(1);
  });

  it('a pause is not billed as listening: the ledger row counts the seconds the session was open', async () => {
    budget('alice');
    await post('invite');
    clock += 60_000; await post('pause', 'bob');
    clock += 3 * 3600_000; await post('resume', 'bob');
    clock += 30_000; await post('dismiss', 'alice');
    await flush();
    expect(entries()[0]!.costUsd).toBe(0.075);          // 60 s + 30 s at $0.05 a minute
  });

  it('a budget that cannot hold the minutes refuses the invite with voice\'s refusal shape: no record, no join notice, no hold left', async () => {
    budget('alice', 1000, 0.5);                         // a hard cap of fifty cents against a $3 hold
    const res = await post('invite');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ reason: 'budget' });
    expect((await get('state')).body.state).toBe('none');
    expect(holds().filter((h) => h.status === 'held')).toEqual([]);
    expect(assistantIntake().isListening(CALL)).toBe(false);
    expect(runtime.isRunning(CALL)).toBe(false);
  });

  it('a soft brake asks to confirm; confirming goes through', async () => {
    budget('alice', 1, 100);                         // $1 allocated against a $3 hold, a high hard cap: the user budget asks first
    const refused = await post('invite');
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ reason: 'budget' });
    expect((await get('state')).body.state).toBe('none');
    const ok = await post('invite', 'alice', { confirmOverUserBudget: true });
    expect(ok.status).toBe(201);
    expect(holds().filter((h) => h.status === 'held')).toHaveLength(1);
  });

  it('settles at the ceiling too, when the clock passes it', async () => {
    process.env['MEETING_ASSISTANT_MAX_MINUTES'] = '5';
    budget('alice');
    await post('invite');
    expect(holds()[0]!.amountUsd).toBe(0.25);
    clock += 301_000; await runtime.tick(); await flush();
    expect((await get('state')).body.state).toBe('left');
    expect(entries()).toHaveLength(1);
    expect(entries()[0]!.costUsd).toBe(0.2508);         // 301 s, rounded to the ledger's four places
  });
});

describe('extension', () => {
  it('adds the default minutes, holds them, shows them in the state, stops at the hard maximum, and releases the extension holds at the end', async () => {
    process.env['MEETING_ASSISTANT_MAX_MINUTES'] = '60'; process.env['MEETING_ASSISTANT_HARD_MAX_MINUTES'] = '120';
    budget('alice');
    await post('invite');
    const extended = await post('extend', 'bob');
    expect(extended.status).toBe(200);
    expect(extended.body).toMatchObject({ ceilingSeconds: 7200 });
    expect(holds().map((h) => [h.sourceId, h.status, h.amountUsd])).toEqual([['ma:call-1', 'held', 3], ['ma:call-1:x1', 'held', 3]]);
    expect(holds().every((h) => h.actorId === 'alice')).toBe(true);          // the inviter pays, whoever extended
    const again = await post('extend', 'alice');
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/longest/);
    expect((await post('extend', 'carol')).status).toBe(403);               // a seat is not enough: InviteMeetingAssistant
    clock += 10_000; await post('dismiss', 'alice'); await flush();
    expect(holds().map((h) => [h.sourceId, h.status])).toEqual([['ma:call-1', 'settled'], ['ma:call-1:x1', 'released']]);
  });

  it('an extension the budget refuses is refused in the same shape and the ceiling stays', async () => {
    budget('alice', 1000, 4);                           // room for one $3 hold, not two
    await post('invite');
    const res = await post('extend', 'alice');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ reason: 'budget' });
    expect((await get('state')).body.ceilingSeconds).toBe(3600);
  });

  it('confirming past the inviter\'s budget is honoured only from the inviter (M6)', async () => {
    budget('alice', 1, 100);
    expect((await post('invite', 'alice', { confirmOverUserBudget: true })).status).toBe(201);
    const byBob = await post('extend', 'bob', { confirmOverUserBudget: true });
    expect(byBob.status).toBe(409);                      // the ordinary refusal, as if no confirmation had been sent
    expect(byBob.body).toMatchObject({ reason: 'budget' });
    expect((await get('state')).body.ceilingSeconds).toBe(3600);
    expect(holds().filter((h) => h.status === 'held')).toHaveLength(1);
    const byAlice = await post('extend', 'alice', { confirmOverUserBudget: true });
    expect(byAlice.status).toBe(200);
    expect((await get('state')).body.ceilingSeconds).toBe(7200);
  });

  it('a call whose assistant left cannot be extended, and one without an assistant is a 404', async () => {
    expect((await post('extend', 'alice')).status).toBe(404);
    budget('alice');
    await post('invite'); await post('dismiss', 'alice');
    expect((await post('extend', 'alice')).status).toBe(409);
  });
});

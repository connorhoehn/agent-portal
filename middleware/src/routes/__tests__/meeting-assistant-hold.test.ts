// The hold button and the floor (hands-free Milo, lane D) through the real routes: auth, seats and the record are real; the call's
// hands-free run is a fake of types.ts HandsfreeRun handed out by the runtime. Harness as in meeting-assistant-turns.test.ts.
const mockConfig = { region: 'us-east-1', auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true },
  meetingAssistant: { enabled: true, transcriptRetentionDays: 30 } };
jest.mock('../../config.js', () => ({ config: mockConfig }));
jest.mock('../../providers/identity.js', () => ({ getUser: jest.fn() }));
jest.mock('../../providers/projects.js', () => ({ getProject: jest.fn() }));
jest.mock('../../providers/work-items.js', () => ({ getWorkItem: jest.fn() }));
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
import { meetingAssistantDevRouter } from '../meeting-assistant-dev.js';
import { errorHandler } from '../../lib/async-handler.js';
import { CallChatRuntime, callChatChannel, setCallChatRuntime } from '../../lib/call-chat.js';
import { MemoryCallChatStateStore } from '../../lib/call-chat-state.js';
import { observeCallPageLifecycle } from '../../lib/call-pages.js';
import { setNotificationSink, type NotificationInputLike } from '../../lib/social-notify.js';
import { assistantStore, assistantIntake, setAssistantStore, setAssistantIntake, LineIntake, MemoryAssistantStore, setTranscriptSource, MockTranscriptSource } from '../../lib/meeting-assistant/index.js';
import { AssistantRuntime, setAssistantRuntime, defaultRolesOf } from '../../lib/meeting-assistant/orchestrator.js';
import { ScriptedSession } from '../../lib/meeting-assistant/scripted-session.js';
import { setSessionFactory } from '../../lib/meeting-assistant/session-select.js';
import { getUser } from '../../providers/identity.js';
import type { Session } from '../../lib/session.js';

const CALL = 'call-1'; const LOBBY = 'orgiq:dm:alice:bob:carol'; const CHANNEL = callChatChannel(CALL);
const NAMES: Record<string, string> = { alice: 'Alice Ames', bob: 'Bob Baker' };
const mk = (sub: string): Session => ({ sub, name: NAMES[sub] ?? sub, tenant: 'orgiq', role: 'member', epoch: 0, grants: { orgiq: ['member'], social: ['participant'] }, iat: 100 });
let sessions: Map<string, Session>; let contexts: Map<string, Record<string, unknown>>;
let calls: InMemoryCallStateStore; let rt: CallChatRuntime; let source: MockTranscriptSource; let clock: number; let chatStore: InMemoryChatStore;
let notified: Array<{ userId: string; input: NotificationInputLike }>;
const app = express(); app.use(express.json());
app.use((req, _res, next) => { req.session = sessions.get(String(req.headers['x-user'])); next(); });
app.use(meetingAssistantDevRouter);
app.use('/api/calls/:callId/assistant', meetingAssistantRouter); app.use(errorHandler);
const ctx = (s: Session) => ({ userId: s.sub, org: s.tenant, role: s.role, displayName: s.sub, epoch: s.epoch ?? 0, sessionIat: s.iat });
const url = (path: string) => `/api/calls/${CALL}/assistant/${path}`;
const post = (path: string, user = 'alice', body: object = {}) => request(app).post(url(path)).set('x-user', user).send(body);
const get = (path: string, user = 'alice') => request(app).get(url(path)).set('x-user', user);
const inject = (body: object) => request(app).post(`/api/dev/calls/${CALL}/transcript-lines`).send(body);
const devCall = (body: object) => request(app).post(`/api/dev/calls/${CALL}/assistant-tool-call`).send(body);
const chat = async () => (await chatStore.listMessages(CHANNEL, 100));
const flush = async () => { for (let i = 0; i < 8; i += 1) await new Promise<void>((r) => setImmediate(r)); };
/** A spoken request, then the quiet that lets the detector close it. */
async function ask(user: string, text: string) {
  await inject({ userId: user, text, at: clock });
  clock += 5000;
  await assistantIntake().tick();
  await flush();
}
const assistantRows = async (kind: string) => (await chat()).filter((m) => (m.metadata as { kind?: string } | undefined)?.kind === kind);

beforeEach(async () => {
  clock = Date.parse('2026-11-13T12:00:00.000Z');
  mockConfig.meetingAssistant.enabled = true; mockConfig.mock.aurora = true;
  mockInviters.clear(); mockInviters.add('alice'); mockInviters.add('bob');
  const people = [mk('alice'), mk('bob'), mk('carol')];
  sessions = new Map(people.map((s) => [s.sub, s]));
  contexts = new Map([['a', ctx(mk('alice'))], ['b', ctx(mk('bob'))], ['c', ctx(mk('carol'))]]);
  jest.mocked(getUser).mockImplementation(async (id: string) => ({ id, displayName: NAMES[id] ?? id, email: null, personId: null, epoch: 0, grants: mk(id).grants }) as never);
  calls = new InMemoryCallStateStore(); chatStore = new InMemoryChatStore(); notified = [];
  setNotificationSink({ notifyUser: async (userId, input) => { notified.push({ userId, input }); } });
  const router = { sendToClient: jest.fn(), sendToChannel: jest.fn(), isClientLive: (id: string) => contexts.has(id), getClientData: (id: string) => ({ userContext: contexts.get(id) }), unsubscribeFromChannel: jest.fn() } as unknown as RealtimeRouter;
  rt = new CallChatRuntime({ calls, state: new MemoryCallChatStateStore(), messages: chatStore, router, maintenanceIntervalMs: 0, now: () => clock, lobbyAllowed: (_a, lobby) => lobby.startsWith('orgiq:') });
  setCallChatRuntime(rt);
  const observed = observeCallPageLifecycle(calls, () => null, () => rt);
  for (const [cid, u] of [['a', 'alice'], ['b', 'bob'], ['c', 'carol']] as const) await observed.registerParticipant(CALL, cid, u, LOBBY, ['alice', 'bob', 'carol']);
  setAssistantStore(new MemoryAssistantStore());
  source = new MockTranscriptSource(); setTranscriptSource(source);
  setAssistantIntake(new LineIntake(assistantStore(), { clock: () => clock, tickMs: 0, source: () => source }));
  setSessionFactory(() => new ScriptedSession(() => clock));
  setAssistantRuntime(new AssistantRuntime({ store: assistantStore, intake: assistantIntake, clock: () => clock, makeSession: () => new ScriptedSession(() => clock), rolesOf: defaultRolesOf }, { tickMs: 0 }));
});
afterEach(() => { setAssistantRuntime(null); setSessionFactory(null); setAssistantIntake(null); setAssistantStore(null); setTranscriptSource(null); setNotificationSink(null); rt.dispose(); setCallChatRuntime(null); });

import type { HandsfreeRun, HoldResult, RouteState } from '../../lib/meeting-assistant/handsfree/types.js';
import { assistantRuntime } from '../../lib/meeting-assistant/orchestrator.js';

function fakeRun() {
  let state: RouteState = { phase: 'idle' };
  const calls: string[] = [];
  const run = {
    state: () => state,
    holdPress: async (u: string): Promise<HoldResult> => {
      calls.push(`press:${u}`);
      if (state.phase !== 'idle') return { ok: false, reason: state.phase !== 'follow-up' && state.userId === u ? 'already-holding' : 'busy' };
      state = { phase: 'routing', userId: u, via: 'hold', sinceMs: 0 }; return { ok: true };
    },
    holdRelease: (u: string) => { calls.push(`release:${u}`); if (state.phase === 'routing' && state.userId === u) state = { phase: 'answering', userId: u, via: 'hold', sinceMs: 1 }; },
    holdCancel: (u: string) => { calls.push(`cancel:${u}`); if (state.phase !== 'idle' && state.userId === u) state = { phase: 'idle' }; },
  } as unknown as HandsfreeRun;
  return { run, calls };
}

describe('the hold button', () => {
  it('without a hands-free run: no button in the state, and a press is 409 NOT_HANDSFREE', async () => {
    await post('invite');
    expect((await get('state')).body).toMatchObject({ handsfree: false, mayHold: false });
    expect((await post('hold/press')).status).toBe(409);
    expect((await get('floor', 'bob')).body).toEqual({ callId: CALL, handsfree: false, floor: null });
  });

  it('Alice holds: every seat reads "Alice is talking to Milo"; Bob is refused busy; release and cancel are hers alone', async () => {
    await post('invite'); await post('ack', 'bob');
    const { run, calls } = fakeRun();
    jest.spyOn(assistantRuntime(), 'handsfreeRun').mockReturnValue(run);
    expect((await get('state')).body).toMatchObject({ handsfree: true, mayHold: true });
    const pressed = await post('hold/press');
    expect(pressed.status).toBe(200);
    expect(pressed.body).toMatchObject({ holding: true, floor: { userId: 'alice', name: 'Alice Ames', via: 'hold' } });
    expect((await get('floor', 'bob')).body.floor).toMatchObject({ userId: 'alice', name: 'Alice Ames', phase: 'routing' });
    const busy = await post('hold/press', 'bob');
    expect(busy.status).toBe(409); expect(busy.body).toMatchObject({ code: 'BUSY', floor: { name: 'Alice Ames' } });
    expect((await post('hold/release', 'alice')).body).toMatchObject({ holding: false, floor: { phase: 'answering' } });
    expect((await post('hold/cancel', 'alice')).body).toMatchObject({ floor: null });
    expect(calls).toEqual(['press:alice', 'press:bob', 'release:alice', 'cancel:alice']);
    expect((await post('hold/grab')).status).toBe(404);
  });

  it('someone who has not acknowledged gets no button; nobody without a seat reads the floor or holds', async () => {
    await post('invite');
    jest.spyOn(assistantRuntime(), 'handsfreeRun').mockReturnValue(fakeRun().run);
    expect((await get('state', 'bob')).body).toMatchObject({ handsfree: true, mayHold: false });
    sessions.set('dave', mk('dave'));
    expect((await get('floor', 'dave')).status).toBeGreaterThanOrEqual(403);
    expect((await post('hold/press', 'dave')).status).toBeGreaterThanOrEqual(403);
  });
});

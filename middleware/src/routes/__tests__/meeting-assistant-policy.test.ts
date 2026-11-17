// The meeting assistant's policy seam (lib/meeting-assistant/policy.ts, interviews plan row I3.1), observed through the real routes: a
// stub policy registered for the call's lobby family denies an invite, narrows who reads, switches who pays, empties the tools, keeps
// the live model's words out of the call, answers a fixed request from held text, takes an acknowledgement from elsewhere, and keeps a
// meeting out of a person's list. With nothing registered every call keeps the default (the other suites prove that is today's).
// Harness: routes/__tests__/meeting-assistant-turns.test.ts (the scripted session on a test clock, the real call chat).
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
import { ACKED_ELSEWHERE, meetingAssistantRouter, meetingsRouter } from '../meeting-assistant.js';
import { meetingAssistantDevRouter } from '../meeting-assistant-dev.js';
import { errorHandler } from '../../lib/async-handler.js';
import { CallChatRuntime, callChatChannel, setCallChatRuntime } from '../../lib/call-chat.js';
import { MemoryCallChatStateStore } from '../../lib/call-chat-state.js';
import { observeCallPageLifecycle } from '../../lib/call-pages.js';
import { setNotificationSink, type NotificationInputLike } from '../../lib/social-notify.js';
import { assistantStore, assistantIntake, setAssistantStore, setAssistantIntake, LineIntake, MemoryAssistantStore, setTranscriptSource, MockTranscriptSource } from '../../lib/meeting-assistant/index.js';
import { AssistantRuntime, setAssistantRuntime, defaultRolesOf } from '../../lib/meeting-assistant/orchestrator.js';
import { DEFAULT_POLICY, registerMeetingAssistantPolicy, type MeetingAssistantPolicy } from '../../lib/meeting-assistant/policy.js';
import { ScriptedSession } from '../../lib/meeting-assistant/scripted-session.js';
import { setSessionFactory } from '../../lib/meeting-assistant/session-select.js';
import type { SessionStartInput } from '../../lib/meeting-assistant/session.js';
import { setAssistantSpend, type ReserveInput, type SettleInput } from '../../lib/meeting-assistant/spend.js';
import { getUser } from '../../providers/identity.js';
import type { Session } from '../../lib/session.js';

const CALL = 'call-1'; const LOBBY = 'orgiq:dm:alice:bob:carol'; const FAMILY = 'orgiq:dm'; const CHANNEL = callChatChannel(CALL);
const NAMES: Record<string, string> = { alice: 'Alice Ames', bob: 'Bob Baker', carol: 'Carol Cole' };
const mk = (sub: string): Session => ({ sub, name: NAMES[sub] ?? sub, tenant: 'orgiq', role: 'member', epoch: 0, grants: { orgiq: ['member'], social: ['participant'] }, iat: 100 });
let sessions: Map<string, Session>; let contexts: Map<string, Record<string, unknown>>;
let calls: InMemoryCallStateStore; let rt: CallChatRuntime; let source: MockTranscriptSource; let clock: number; let chatStore: InMemoryChatStore;
let notified: Array<{ userId: string; input: NotificationInputLike }>; let started: SessionStartInput[];
let reserved: ReserveInput[]; let settled: SettleInput[];
let unregister: Array<() => void>;
const app = express(); app.use(express.json());
app.use((req, _res, next) => { req.session = sessions.get(String(req.headers['x-user'])); next(); });
app.use(meetingAssistantDevRouter);
app.use('/api/calls/:callId/assistant', meetingAssistantRouter); app.use('/api/meetings', meetingsRouter); app.use(errorHandler);
const ctx = (s: Session) => ({ userId: s.sub, org: s.tenant, role: s.role, displayName: s.sub, epoch: s.epoch ?? 0, sessionIat: s.iat });
const url = (path: string) => `/api/calls/${CALL}/assistant/${path}`;
const post = (path: string, user = 'alice', body: object = {}) => request(app).post(url(path)).set('x-user', user).send(body);
const get = (path: string, user = 'alice') => request(app).get(url(path)).set('x-user', user);
const inject = (body: object) => request(app).post(`/api/dev/calls/${CALL}/transcript-lines`).send(body);
const chat = async () => (await chatStore.listMessages(CHANNEL, 100));
const flush = async () => { for (let i = 0; i < 8; i += 1) await new Promise<void>((r) => setImmediate(r)); };
async function ask(user: string, text: string) {
  await inject({ userId: user, text, at: clock });
  clock += 5000;
  await assistantIntake().tick();
  await flush();
}
const replies = async () => (await chat()).filter((m) => (m.metadata as { kind?: string } | undefined)?.kind === 'assistant-reply')
  .map((m) => [m.message, (m.metadata as { askedBy: string }).askedBy]);
/** Register a policy for the call's family: the default with these answers changed. */
const use = (over: Partial<MeetingAssistantPolicy>): MeetingAssistantPolicy => {
  const policy: MeetingAssistantPolicy = { ...DEFAULT_POLICY, id: 'stub', ...over };
  unregister.push(registerMeetingAssistantPolicy(FAMILY, policy));
  return policy;
};

beforeEach(async () => {
  clock = Date.parse('2026-11-13T12:00:00.000Z');
  mockConfig.meetingAssistant.enabled = true; mockConfig.mock.aurora = true;
  mockInviters.clear(); mockInviters.add('alice'); mockInviters.add('bob');
  const people = [mk('alice'), mk('bob'), mk('carol')];
  sessions = new Map(people.map((s) => [s.sub, s]));
  contexts = new Map([['a', ctx(mk('alice'))], ['b', ctx(mk('bob'))], ['c', ctx(mk('carol'))]]);
  jest.mocked(getUser).mockImplementation(async (id: string) => ({ id, displayName: NAMES[id] ?? id, email: null, personId: null, epoch: 0, grants: mk(id).grants }) as never);
  calls = new InMemoryCallStateStore(); chatStore = new InMemoryChatStore(); notified = []; started = []; reserved = []; settled = []; unregister = [];
  setNotificationSink({ notifyUser: async (userId, input) => { notified.push({ userId, input }); } });
  setAssistantSpend({
    reserve: async (i) => { reserved.push(i); return { ok: true, holdId: `h${reserved.length}` }; },
    release: async () => undefined,
    settle: async (i) => { settled.push(i); },
  });
  const router = { sendToClient: jest.fn(), sendToChannel: jest.fn(), isClientLive: (id: string) => contexts.has(id), getClientData: (id: string) => ({ userContext: contexts.get(id) }), unsubscribeFromChannel: jest.fn() } as unknown as RealtimeRouter;
  rt = new CallChatRuntime({ calls, state: new MemoryCallChatStateStore(), messages: chatStore, router, maintenanceIntervalMs: 0, now: () => clock, lobbyAllowed: (_a, lobby) => lobby.startsWith('orgiq:') });
  setCallChatRuntime(rt);
  const observed = observeCallPageLifecycle(calls, () => null, () => rt);
  for (const [cid, u] of [['a', 'alice'], ['b', 'bob'], ['c', 'carol']] as const) await observed.registerParticipant(CALL, cid, u, LOBBY, ['alice', 'bob', 'carol']);
  setAssistantStore(new MemoryAssistantStore());
  source = new MockTranscriptSource(); setTranscriptSource(source);
  setAssistantIntake(new LineIntake(assistantStore(), { clock: () => clock, tickMs: 0, source: () => source }));
  setSessionFactory(() => new ScriptedSession(() => clock));
  const makeSession = () => {
    const s = new ScriptedSession(() => clock); const start = s.start.bind(s);
    s.start = async (input) => { started.push(input); return start(input); };
    return s;
  };
  setAssistantRuntime(new AssistantRuntime({ store: assistantStore, intake: assistantIntake, clock: () => clock, makeSession, rolesOf: defaultRolesOf }, { tickMs: 0 }));
});
afterEach(() => {
  for (const off of unregister.splice(0)) off();
  setAssistantRuntime(null); setSessionFactory(null); setAssistantIntake(null); setAssistantStore(null); setTranscriptSource(null); setNotificationSink(null); setAssistantSpend(null);
  rt.dispose(); setCallChatRuntime(null);
});

describe('who may invite', () => {
  it('a family\'s policy can refuse an invite Cedar allows: 403 with its sentence, nothing held, Milo never joins; voice and extend ask it too', async () => {
    const asked: Array<[string, string | null]> = [];
    use({ inviteRefusal: async (person, call) => { asked.push([person.userId, call.lobby]); return person.userId === 'bob' ? null : 'Only the person leading this call can invite Milo.'; } });
    const refused = await post('invite', 'alice');
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe('Only the person leading this call can invite Milo.');
    expect(asked).toEqual([['alice', LOBBY]]);
    expect((await get('state')).body).toEqual({ callId: CALL, state: 'none' });
    expect(reserved).toEqual([]); expect(started).toEqual([]);
    // The person it allows invites as usual; the one it refuses cannot turn the voice on or add time either.
    expect((await post('invite', 'bob')).status).toBe(201);
    expect((await post('voice', 'alice', { on: true })).status).toBe(403);
    expect((await post('extend', 'alice')).status).toBe(403);
    expect((await post('voice', 'bob', { on: true })).status).toBe(200);
  });

  it('Cedar still comes first: someone without the grant is refused before the policy is asked', async () => {
    const asked: string[] = [];
    use({ inviteRefusal: async (person) => { asked.push(person.userId); return null; } });
    expect((await post('invite', 'carol')).status).toBe(403);
    expect(asked).toEqual([]);
  });
});

describe('who reads', () => {
  it('a family\'s policy can narrow the readers: an attendee it shuts out gets the same 404 as a stranger, the others read as before', async () => {
    use({ reads: (viewer, record) => (viewer.userId === 'bob' ? { record: false, transcript: false, minutes: false } : DEFAULT_POLICY.reads(viewer, record)) });
    expect((await post('invite')).status).toBe(201);
    await post('ack', 'bob');
    await ask('bob', 'We should ship on Friday.');
    expect((await assistantStore().get(CALL))!.attendees).toContain('bob');
    expect((await get('transcript', 'alice')).body.lines.map((l: { text: string }) => l.text)).toEqual(['We should ship on Friday.']);
    expect((await get('transcript', 'bob')).status).toBe(404);
    expect((await get('proposals', 'bob')).status).toBe(404);
    expect((await get('proposals', 'alice')).status).toBe(200);
    expect((await post('dismiss', 'alice')).status).toBe(200);
    await flush();
    expect((await get('minutes', 'bob')).status).toBe(404);
    expect((await get('transcript', 'bob')).status).toBe(404);
    expect((await get('transcript', 'alice')).status).toBe(200);
  });

  it('a family\'s policy can keep a meeting out of a person\'s Meetings list', async () => {
    const minutes = { callId: CALL, tenant: 'orgiq', lobby: LOBBY, initiativeId: null, callName: 'A call', startedAt: clock - 60_000, endedAt: clock, invitedBy: 'alice',
      attendees: ['alice', 'bob'], summary: 'Shipping on Friday.', decisions: [], actionItems: [], topics: [], lineCount: 1, truncated: false, writer: 'scripted' as const, createdAt: clock };
    await assistantStore().putMinutes(minutes);
    const list = async (user: string) => (await request(app).get('/api/meetings').set('x-user', user)).body.meetings.map((m: { callId: string }) => m.callId);
    expect(await list('bob')).toEqual([CALL]);
    use({ listsMeeting: (_m, userId) => userId !== 'bob' });
    expect(await list('bob')).toEqual([]);
    expect(await list('alice')).toEqual([CALL]);
  });
});

describe('who pays', () => {
  it('a family\'s policy can switch the payer: every hold goes to its person, initiative and source, and only that person\'s confirmation counts', async () => {
    use({ payer: () => ({ actorId: 'carol', initiativeId: 'p-budget', source: 'voice_session' }) });
    expect((await post('invite', 'alice', { confirmOverUserBudget: true })).status).toBe(201);
    expect(reserved[0]).toMatchObject({ callId: CALL, inviterId: 'carol', initiativeId: 'p-budget', source: 'voice_session', part: 0 });
    expect(reserved[0]!.confirmOverUserBudget).toBeUndefined();
    expect((await post('extend', 'bob', { confirmOverUserBudget: true })).status).toBe(200);
    expect(reserved[1]).toMatchObject({ inviterId: 'carol', initiativeId: 'p-budget', source: 'voice_session', part: 1 });
    expect(reserved[1]!.confirmOverUserBudget).toBeUndefined();
  });

  it('with no policy of its own the call pays as before: the inviter, the meeting assistant\'s source, their own confirmation', async () => {
    expect((await post('invite', 'alice', { confirmOverUserBudget: true })).status).toBe(201);
    expect(reserved[0]).toMatchObject({ inviterId: 'alice', initiativeId: null, source: 'meeting_assistant', confirmOverUserBudget: true });
  });
});

describe('which tools', () => {
  it('a family\'s policy can empty the tools: the session is offered none, and a tool call is refused without a turn', async () => {
    use({ sessionTools: () => ({ tools: [], backendInstructions: '' }), mayUseTool: () => false });
    expect((await post('invite')).status).toBe(201);
    expect(started.map((s) => s.tools.length)).toEqual([0]);
    await post('ack', 'bob');
    await ask('bob', 'Milo, find the Kubernetes experts');
    expect((await get('turns?mine=1', 'bob')).body.turns).toEqual([]);
    expect((await get('state', 'alice')).body.refusedCalls).toBe(1);
  });

  it('with no policy of its own the session is offered the tenant\'s meeting tools and the same request becomes a turn', async () => {
    expect((await post('invite')).status).toBe(201);
    expect(started[0]!.tools.length).toBeGreaterThan(0);
    await post('ack', 'bob');
    await ask('bob', 'Milo, find the Kubernetes experts');
    expect((await get('turns?mine=1', 'bob')).body.turns).toHaveLength(1);
  });
});

describe('what Milo says and answers', () => {
  it('a family\'s policy can keep the live model\'s words out of the call', async () => {
    use({ relaysLiveSpeech: () => false });
    expect((await post('invite')).status).toBe(201);
    await ask('alice', 'Milo, what is two plus two?');
    expect(await replies()).toEqual([]);
  });

  it('a fixed request is answered from held text and never reaches the model; anything else still does', async () => {
    const heard: string[] = [];
    use({ answerFromHeldText: async (_call, r) => { heard.push(r.text); return /time is left/i.test(r.text) ? 'There are 12 minutes left.' : null; } });
    expect((await post('invite')).status).toBe(201);
    await ask('alice', 'Milo, how much time is left?');
    expect(await replies()).toEqual([['There are 12 minutes left.', 'alice']]);
    await ask('alice', 'Milo, what is two plus two?');
    expect(await replies()).toEqual([['There are 12 minutes left.', 'alice'], ['Four.', 'alice']]);
    expect(heard).toHaveLength(2);
  });
});

describe('where an acknowledgement comes from', () => {
  it('a person whose acknowledgement comes from elsewhere is not asked in the call, cannot acknowledge there, and is heard once they gave it there', async () => {
    const gave = new Set<string>();
    use({
      acknowledgement: (_call, userId) => (userId === 'bob' ? 'elsewhere' : 'in-call-notice'),
      acknowledgedElsewhere: async (_call, userIds) => userIds.filter((u) => gave.has(u)),
    });
    expect((await post('invite')).status).toBe(201);
    expect((await get('state', 'alice')).body.mustAck).toEqual(['carol']);
    const ack = await post('ack', 'bob');
    expect(ack.status).toBe(409); expect(ack.body.error).toBe(ACKED_ELSEWHERE);
    await ask('bob', 'Not stored yet.');
    gave.add('bob');
    expect((await get('state', 'bob')).body.youMustAck).toBe(false);
    expect((await assistantStore().get(CALL))!.acked).toContain('bob');
    await ask('bob', 'Stored now.');
    expect((await get('transcript', 'alice')).body.lines.map((l: { text: string }) => l.text)).toEqual(['Stored now.']);
  });

  it('acknowledged elsewhere before the invite: on the record from the start', async () => {
    use({ acknowledgement: (_call, userId) => (userId === 'alice' ? 'in-call-notice' : 'elsewhere'), acknowledgedElsewhere: async (_call, ids) => ids.filter((u) => u === 'bob') });
    expect((await post('invite')).status).toBe(201);
    expect((await assistantStore().get(CALL))!.acked).toEqual(['alice', 'bob']);
    expect((await get('state', 'alice')).body.mustAck).toEqual([]);
  });
});

describe('the bell', () => {
  it('a family\'s policy can keep a person\'s bell quiet: a private answer is not sent to them', async () => {
    use({ rings: (_call, userId) => userId !== 'alice' });
    expect((await post('invite')).status).toBe(201);
    await ask('alice', 'Milo, how much budget do I have');
    const [turn] = (await get('turns?mine=1', 'alice')).body.turns;
    expect(turn.kind).toBe('private-read');
    const { claimId } = (await post(`turns/${turn.turnId}/claim`, 'alice')).body;
    await post(`turns/${turn.turnId}/result`, 'alice', { claimId, ok: true, output: { spent: 3 } });
    await flush();
    expect(notified.filter((n) => n.userId === 'alice')).toEqual([]);
  });
});

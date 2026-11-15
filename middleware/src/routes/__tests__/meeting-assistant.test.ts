// The meeting assistant's routes and the mock-only injector (docs/meeting-assistant-design.md, package 1).
// Seats are real: the harness is the call-chat suite's (CallChatRuntime over in-memory call, chat and state stores).
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
import { setAssistantRuntime } from '../../lib/meeting-assistant/orchestrator.js';
import { meetingAssistantDevRouter } from '../meeting-assistant-dev.js';
import { errorHandler } from '../../lib/async-handler.js';
import { CallChatRuntime, setCallChatRuntime } from '../../lib/call-chat.js';
import { MemoryCallChatStateStore } from '../../lib/call-chat-state.js';
import { observeCallPageLifecycle } from '../../lib/call-pages.js';
import { assistantStore, setAssistantStore, setAssistantIntake, LineIntake, MemoryAssistantStore, setTranscriptSource, MockTranscriptSource, notConfiguredTranscriptSource } from '../../lib/meeting-assistant/index.js';
import { getUser } from '../../providers/identity.js';
import { getProject } from '../../providers/projects.js';
import type { Session } from '../../lib/session.js';

const CALL = 'call-1'; const LOBBY = 'orgiq:dm:alice:bob:carol';
const mk = (sub: string, over: Partial<Session> = {}): Session => ({ sub, name: sub, tenant: 'orgiq', role: 'member', epoch: 0, grants: { orgiq: ['member'], social: ['participant'] }, iat: 100, ...over });
let sessions: Map<string, Session>; let contexts: Map<string, Record<string, unknown>>;
let calls: InMemoryCallStateStore; let runtime: CallChatRuntime; let source: MockTranscriptSource; let clock: number;
const app = express(); app.use(express.json());
app.use((req, _res, next) => { req.session = sessions.get(String(req.headers['x-user'])); next(); });
app.use(meetingAssistantDevRouter);
app.use('/api/calls/:callId/assistant', meetingAssistantRouter); app.use(errorHandler);
const ctx = (s: Session) => ({ userId: s.sub, org: s.tenant, role: s.role, displayName: s.sub, epoch: s.epoch ?? 0, sessionIat: s.iat });
const url = (path: string, call = CALL) => `/api/calls/${call}/assistant/${path}`;
const post = (path: string, user = 'alice', body: object = {}) => request(app).post(url(path)).set('x-user', user).send(body);
const get = (path: string, user = 'alice') => request(app).get(url(path)).set('x-user', user);
const inject = (body: object | object[]) => request(app).post(`/api/dev/calls/${CALL}/transcript-lines`).send(body);

beforeEach(async () => {
  clock = Date.parse('2026-11-13T12:00:00.000Z');
  mockConfig.meetingAssistant.enabled = true; mockConfig.mock.aurora = true;
  mockInviters.clear(); mockInviters.add('alice'); mockInviters.add('bob');
  const people = [mk('alice'), mk('bob'), mk('carol'), mk('dave'), mk('root', { role: 'admin', tenant: 'orgiq' }), mk('alice', { act: { sub: 'root', epoch: 0 } } as Partial<Session>)];
  sessions = new Map(people.slice(0, 5).map((s) => [s.sub, s])); sessions.set('masked', people[5]!);
  contexts = new Map([['a', ctx(mk('alice'))], ['b', ctx(mk('bob'))], ['c', ctx(mk('carol'))], ['m', ctx(people[5]!)]]);
  jest.mocked(getUser).mockImplementation(async (id: string) => ({ id, displayName: id, email: null, personId: null, epoch: 0, grants: mk(id).grants }) as never);
  jest.mocked(getProject).mockImplementation(async (id: string) => (id === 'p-auth' ? { id, name: 'Auth Migration' } : null) as never);
  calls = new InMemoryCallStateStore();
  const router = { sendToClient: jest.fn(), sendToChannel: jest.fn(), isClientLive: (id: string) => contexts.has(id), getClientData: (id: string) => ({ userContext: contexts.get(id) }), unsubscribeFromChannel: jest.fn() } as unknown as RealtimeRouter;
  runtime = new CallChatRuntime({ calls, state: new MemoryCallChatStateStore(), messages: new InMemoryChatStore(), router, maintenanceIntervalMs: 0, now: () => clock,
    lobbyAllowed: (_auth, lobby) => lobby.startsWith('orgiq:') });
  setCallChatRuntime(runtime);
  const observed = observeCallPageLifecycle(calls, () => null, () => runtime);
  await observed.registerParticipant(CALL, 'a', 'alice', LOBBY, ['alice', 'bob', 'carol']);
  await observed.registerParticipant(CALL, 'b', 'bob', LOBBY, ['alice', 'bob', 'carol']);
  setAssistantStore(new MemoryAssistantStore());
  source = new MockTranscriptSource(); setTranscriptSource(source);
  setAssistantIntake(new LineIntake(assistantStore(), { clock: () => clock, tickMs: 0, source: () => source }));
});
afterEach(() => { setAssistantRuntime(null); setAssistantIntake(null); setAssistantStore(null); setTranscriptSource(null); runtime.dispose(); setCallChatRuntime(null); });

describe('the flag and the gates', () => {
  it('with the flag off every route answers 404, injector included', async () => {
    mockConfig.meetingAssistant.enabled = false;
    for (const p of ['invite', 'pause', 'resume', 'dismiss', 'ack']) expect((await post(p)).status).toBe(404);
    for (const p of ['state', 'transcript']) expect((await get(p)).status).toBe(404);
    expect((await inject({ userId: 'alice', text: 'x' })).status).toBe(404);
  });

  it('another tenant is refused; a person without a seat is refused; an unauthenticated caller is refused', async () => {
    sessions.set('eve', mk('eve', { tenant: 'assessment', role: 'assessor', grants: { assessment: ['assessor'] } }));
    expect((await post('invite', 'eve')).status).toBe(403);
    mockInviters.add('dave');
    expect((await post('invite', 'dave')).status).toBe(403);
    expect((await get('state', 'dave')).status).toBe(403);
    expect((await get('state', 'nobody')).status).toBeGreaterThanOrEqual(401);
  });

  it('invite also needs InviteMeetingAssistant; carol has a seat but not the action', async () => {
    contexts.set('c', ctx(mk('carol')));
    const observed = observeCallPageLifecycle(calls, () => null, () => runtime);
    await observed.registerParticipant(CALL, 'c', 'carol', LOBBY, ['alice', 'bob', 'carol']);
    expect((await post('invite', 'carol')).status).toBe(403);
    const r = await get('state', 'carol');
    expect(r.status).toBe(200);
  });

  it('every route is refused under a masquerade, reads included (B5)', async () => {
    await post('invite');
    await inject({ userId: 'alice', text: 'private words' });
    for (const p of ['invite', 'pause', 'resume', 'dismiss', 'ack', 'extend', 'voice', 'participant', 'actions/a-1/decision', 'turns/t-1/result']) {
      const r = await post(p, 'masked');
      expect([r.status, r.body.code]).toEqual([403, 'MASQUERADING']);
    }
    for (const p of ['state', 'transcript', 'turns?mine=1', 'minutes']) {
      const r = await get(p, 'masked');
      expect([p, r.status, r.body.code]).toEqual([p, 403, 'MASQUERADING']);
      expect(JSON.stringify(r.body)).not.toContain('private words');
    }
    expect((await request(app).delete(url('minutes')).set('x-user', 'masked')).body.code).toBe('MASQUERADING');
    expect((await request(app).delete(url('transcript')).set('x-user', 'masked')).body.code).toBe('MASQUERADING');
  });
});

describe('invite, pause, resume, dismiss', () => {
  it('state is "none" before an invite; invite records the call, the lobby, the initiative and the inviter', async () => {
    expect((await get('state')).body).toEqual({ callId: CALL, state: 'none' });
    const res = await post('invite');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ state: 'listening', invitedBy: 'alice', lobby: LOBBY, initiativeId: null, counters: { requests: 0, linesStored: 0 }, mustAck: ['bob'], youMustAck: false });
    expect((await assistantStore().get(CALL))).toMatchObject({ tenant: 'orgiq', acked: ['alice'] });
  });

  it('a second invite is a no-op success; bob sees that he owes an ack', async () => {
    await post('invite');
    expect((await post('invite', 'bob')).status).toBe(200);
    const s = (await get('state', 'bob')).body;
    expect(s).toMatchObject({ state: 'listening', invitedBy: 'alice', invitedByName: 'alice', mustAck: ['bob'], youMustAck: true });
    expect((await post('ack', 'bob')).body).toMatchObject({ mustAck: [], youMustAck: false });
  });

  it('a repeated invite from the inviter completes a record stuck in invited, once, with one joined notice', async () => {
    const stuck = { callId: CALL, tenant: 'orgiq', lobby: LOBBY, initiativeId: null, state: 'invited' as const, invitedBy: 'alice', invitedAt: 1, pausedBy: null, leftAt: null, leftBy: null,
      acked: ['alice'], attendees: ['alice'], presentAtInvite: ['alice'], requests: 0, linesStored: 0, nextSeq: 1, pendingRequests: [] };
    await assistantStore().create(stuck);
    const joined = async () => (await runtime.messages.listMessages(`orgiq:huddle:${CALL}`, 50)).filter((m) => (m.metadata as { kind?: string } | undefined)?.kind === 'assistant-notice').length;
    expect((await post('invite', 'bob')).body).toMatchObject({ state: 'invited' });   // someone else's repeat does not complete it
    const res = await post('invite');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ state: 'listening', invitedBy: 'alice' });
    expect(await joined()).toBe(1);
    await post('invite');
    expect(await joined()).toBe(1);
  });

  it('a poll from someone already on the record writes no attendance', async () => {
    await post('invite');
    const attend = jest.spyOn(assistantStore(), 'attend');
    try {
      for (let i = 0; i < 3; i += 1) expect((await get('state', 'alice')).status).toBe(200);
      expect(attend).not.toHaveBeenCalled();
      expect((await get('state', 'bob')).status).toBe(200);          // bob was in the call at the invite, so he is on the record already
      expect(attend).not.toHaveBeenCalled();
    } finally { attend.mockRestore(); }
  });

  it('anyone with a seat can pause, resume and dismiss; repeats succeed; a dismissed assistant stays gone', async () => {
    await post('invite');
    expect((await post('pause', 'bob')).body).toMatchObject({ state: 'paused', pausedBy: 'bob' });
    expect((await post('pause', 'alice')).status).toBe(200);
    expect((await post('resume', 'bob')).body).toMatchObject({ state: 'listening', pausedBy: null });
    expect((await post('resume', 'alice')).status).toBe(200);
    expect((await post('dismiss', 'bob')).body).toMatchObject({ state: 'left', leftBy: 'bob', leftByName: expect.any(String), openRequests: [], waitingActions: [] });
    expect((await post('dismiss', 'alice')).status).toBe(200);
    expect((await post('resume')).status).toBe(409);
    expect((await post('invite')).status).toBe(409);
    expect((await post('ack', 'bob')).status).toBe(409);
  });

  it('pause with no assistant is a 404', async () => {
    expect((await post('pause')).status).toBe(404);
    expect((await post('ack')).status).toBe(404);
  });

  it('with no transcript source (no mock world) the invite fails plainly and records nothing', async () => {
    setTranscriptSource(notConfiguredTranscriptSource());
    setAssistantIntake(new LineIntake(assistantStore(), { tickMs: 0, source: notConfiguredTranscriptSource }));
    const res = await post('invite');
    expect(res.status).toBe(503);
    expect(await assistantStore().get(CALL)).toBeNull();
  });
});

describe('Nova\'s voice switch (package 7a)', () => {
  const notices = async () => (await runtime.messages.listMessages(`orgiq:huddle:${CALL}`, 50)).map((m) => String(m.message)).filter((t) => /voice/.test(t));
  it('is off by default; an inviter turns it on and off, each with one notice in the call chat; a repeat is a quiet success', async () => {
    await post('invite');
    expect((await get('state')).body).toMatchObject({ voice: false, voiceFramesRelayed: 0, voiceFramesDropped: 0, voiceFramesWithheld: 0, voiceUtterancesWithheld: 0 });
    expect((await post('voice', 'alice', { on: true })).body).toMatchObject({ voice: true });
    expect((await post('voice', 'alice', { on: true })).status).toBe(200);
    expect((await get('state', 'bob')).body).toMatchObject({ voice: true });
    expect((await assistantStore().get(CALL))!.voice).toBe(true);
    expect((await post('voice', 'bob', { on: false })).body).toMatchObject({ voice: false });
    expect(await notices()).toEqual(["alice turned Nova's voice on. Each person can mute it for themselves.", "bob turned Nova's voice off."]);
  });
  it('needs the invite right and a seat, a boolean, and an assistant that has not left', async () => {
    expect((await post('voice', 'alice', { on: true })).status).toBe(404); // no assistant yet
    await post('invite');
    expect((await post('voice', 'carol', { on: true })).status).toBe(403); // a seat, but not InviteMeetingAssistant
    expect((await post('voice', 'dave', { on: true })).status).not.toBe(200); // no seat
    expect((await post('voice', 'alice', { on: 'yes' })).status).toBe(400);
    expect((await post('voice', 'alice', {})).status).toBe(400);
    await post('dismiss');
    expect((await post('voice', 'alice', { on: true })).status).toBe(409);
    expect((await assistantStore().get(CALL))!.voice).toBe(false);
  });
});

describe('lines, acknowledgement and the transcript', () => {
  it('lines are stored only after the speaker acknowledges; the request lands as pending in state', async () => {
    await post('invite');
    await inject({ userId: 'bob', text: 'bob says hello before acknowledging' });
    await inject({ userId: 'alice', text: 'Nova, list the open work items.' });
    clock += 5000; await (await import('../../lib/meeting-assistant/index.js')).assistantIntake().tick();
    expect((await get('transcript')).body.lines.map((l: { text: string }) => l.text)).toEqual(['Nova, list the open work items.']);
    const s = (await get('state', 'bob')).body;
    expect(s.counters).toEqual({ requests: 1, linesStored: 1 });
    expect(s.pendingRequests[0]).toMatchObject({ askedBy: 'alice', text: 'list the open work items.' });
    await post('ack', 'bob');
    await inject({ userId: 'bob', text: 'now stored', speakers: ['bob', 'alice'], startMs: 5, endMs: 9 });
    const t = (await get('transcript?after=1&limit=5', 'bob')).body;
    expect(t.lines).toHaveLength(1);
    expect(t.lines[0]).toMatchObject({ seq: 2, userId: 'bob', speakers: ['bob', 'alice'], startMs: 5, endMs: 9 });
    expect(t.next).toBe(2);
  });

  it('pause stops storing; resume starts again; a spoken "stop listening" pauses', async () => {
    await post('invite');
    await post('pause', 'bob');
    await inject({ userId: 'alice', text: 'said while paused' });
    await post('resume', 'bob');
    await inject({ userId: 'alice', text: 'Nova, stop listening.' });
    expect((await get('state')).body.state).toBe('paused');
    expect((await get('transcript')).body.lines.map((l: { text: string }) => l.text)).toEqual(['Nova, stop listening.']);
  });

  it('the transcript is for people who hold or held a seat: never a stranger, another tenant or an admin', async () => {
    await post('invite');
    await inject({ userId: 'alice', text: 'private words' });
    for (const user of ['dave', 'root', 'nobody']) {
      const r = await get('transcript', user);
      expect(r.status).toBeGreaterThanOrEqual(401);
      expect(JSON.stringify(r.body)).not.toContain('private words');
    }
    expect((await get('transcript', 'carol')).status).toBe(404);
    expect((await get('transcript', 'bob')).status).toBe(200);
  });

  it('someone who left still reads it, and everyone seated at the dismissal keeps reading after the call ends', async () => {
    await post('invite');
    await inject({ userId: 'alice', text: 'minutes please' });
    await post('dismiss', 'bob');
    await runtime.finish(CALL);
    expect((await get('transcript', 'alice')).body.lines).toHaveLength(1);
    expect((await get('transcript', 'bob')).body.lines).toHaveLength(1);
    expect((await get('transcript', 'dave')).status).toBe(404);
  });

  describe('attendance means an active seat while Nova was present (M1)', () => {
    const seat = async (user: string, clientId: string) => {
      contexts.set(clientId, ctx(mk(user)));
      await observeCallPageLifecycle(calls, () => null, () => runtime).registerParticipant(CALL, clientId, user, LOBBY, ['alice', 'bob', 'carol', 'dave']);
    };
    const leave = async (clientId: string) => { runtime.invalidate(CALL, clientId); await calls.removeParticipant(CALL, clientId); await runtime.removed(CALL, clientId); };

    it('someone who left before the invite cannot read the transcript or the minutes', async () => {
      await seat('dave', 'd'); await leave('d');
      expect((await runtime.seatedUsers(CALL)).find((u) => u.userId === 'dave')).toMatchObject({ active: false });
      await post('invite');
      await inject({ userId: 'alice', text: 'after dave left' });
      expect((await get('transcript', 'dave')).status).toBe(404);
      expect((await get('minutes', 'dave')).status).toBe(404);
      expect((await assistantStore().get(CALL))!.attendees).not.toContain('dave');
    });

    it('someone who joins after Nova left cannot read; someone who was there still can, after the call too', async () => {
      await post('invite');
      await inject({ userId: 'alice', text: 'during the call' });
      await post('dismiss', 'bob');
      await seat('dave', 'd'); // joins after Nova left, then asks for state like any seated person
      expect((await get('state', 'dave')).status).toBe(200);
      expect((await get('transcript', 'dave')).status).toBe(404);
      await runtime.finish(CALL);
      expect((await get('transcript', 'dave')).status).toBe(404);
      expect((await get('transcript', 'bob')).body.lines).toHaveLength(1);
    });

    it('someone who was present at the invite and left while Nova was there is still an attendee', async () => {
      await seat('dave', 'd');
      await post('invite'); // dave is present at the invite
      await leave('d');
      await post('dismiss', 'alice');
      expect((await get('transcript', 'dave')).status).toBe(200);
    });
  });

  it('rejects odd paging values', async () => {
    await post('invite');
    for (const q of ['after=-1', 'after=x', 'limit=0', 'limit=501', 'limit=1e3', 'tail=0', 'tail=501', 'tail=x', 'tail=5&after=1', 'tail=5&limit=5', 'before=3', 'tail=5&before=0']) expect((await get(`transcript?${q}`)).status).toBe(400);
  });

  describe('the live view reads (tail, before, speakers)', () => {
    const texts = (b: { lines: Array<{ text: string }> }) => b.lines.map((l) => l.text);
    const seed = async (n: number) => {
      await post('invite'); await post('ack', 'bob');
      for (let i = 1; i <= n; i += 1) await inject({ userId: i % 2 ? 'alice' : 'bob', text: `line ${i}` });
    };

    it('tail answers the newest lines oldest first and says whether earlier ones exist', async () => {
      await seed(5);
      const t = (await get('transcript?tail=2')).body;
      expect(texts(t)).toEqual(['line 4', 'line 5']);
      expect(t.earlier).toBe(true);
      expect(t.next).toBe(5);
      const all = (await get('transcript?tail=10')).body;
      expect(texts(all)).toHaveLength(5);
      expect(all.earlier).toBe(false);
      expect((await get('transcript')).body.earlier).toBeUndefined();
    });

    it('tail with before pages back from the oldest line a view holds', async () => {
      await seed(5);
      const t = (await get('transcript?tail=2&before=4')).body;
      expect(texts(t)).toEqual(['line 2', 'line 3']);
      expect(t.earlier).toBe(true);
      const first = (await get('transcript?tail=2&before=2')).body;
      expect(texts(first)).toEqual(['line 1']);
      expect(first.earlier).toBe(false);
    });

    it('every answer names the speakers of its lines once, with portraits', async () => {
      await seed(3);
      const t = (await get('transcript?tail=10')).body;
      expect(t.speakers).toEqual([{ userId: 'alice', name: expect.any(String), avatarUrl: null }, { userId: 'bob', name: expect.any(String), avatarUrl: null }]);
      expect((await get('transcript?after=2', 'bob')).body.speakers.map((p: { userId: string }) => p.userId)).toEqual(['alice']);
      expect((await get('transcript?after=3')).body.speakers).toEqual([]);
    });

    it('tail keeps the same access rule: a stranger, an admin, a later joiner and another tenant read nothing', async () => {
      await seed(1);
      for (const user of ['dave', 'root', 'nobody', 'carol']) {
        const r = await get('transcript?tail=10', user);
        expect(r.status).toBeGreaterThanOrEqual(401);
        expect(JSON.stringify(r.body)).not.toContain('line 1');
      }
      expect((await get('transcript?tail=10', 'bob')).status).toBe(200);
    });
  });
});

describe('the injector', () => {
  it('takes one line or a batch, validates the body, and says how many were listening', async () => {
    expect((await inject({ userId: 'alice', text: 'nobody listening yet' })).body).toEqual({ accepted: 1, listeners: 0 });
    await post('invite');
    expect((await inject([{ userId: 'alice', text: 'one' }, { userId: 'alice', text: 'two' }])).body).toEqual({ accepted: 2, listeners: 1 });
    expect((await inject({ text: 'no user' })).status).toBe(400);
    expect((await inject({ userId: 'alice', text: 5 })).status).toBe(400);
    expect((await inject({ userId: 'alice', text: 'x', speakers: 'bob' })).status).toBe(400);
    expect((await inject([])).status).toBe(400);
  });

  it('is unreachable without the mock world: 404 with mocks off, and 404 in production', async () => {
    mockConfig.mock.aurora = false;
    expect((await inject({ userId: 'alice', text: 'x' })).status).toBe(404);
    mockConfig.mock.aurora = true;
    const before = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';
    try { expect((await inject({ userId: 'alice', text: 'x' })).status).toBe(404); } finally { process.env['NODE_ENV'] = before; }
    expect((await inject({ userId: 'alice', text: 'x' })).status).toBe(202);
  });
});

// Nova in the call chat, package 2: notices from the routes, the action decision route, the dev poster, private delivery.
// Harness: routes/__tests__/meeting-assistant.test.ts (CallChatRuntime over in-memory call, chat and state stores).
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
import { CallChatRuntime, callChatChannel, setCallChatRuntime } from '../../lib/call-chat.js';
import { MemoryCallChatStateStore } from '../../lib/call-chat-state.js';
import { observeCallPageLifecycle } from '../../lib/call-pages.js';
import { setNotificationSink, type NotificationInputLike } from '../../lib/social-notify.js';
import { assistantStore, setAssistantStore, setAssistantIntake, LineIntake, MemoryAssistantStore, setTranscriptSource, MockTranscriptSource } from '../../lib/meeting-assistant/index.js';
import { noticeText, postPrivately } from '../../lib/meeting-assistant/chat.js';
import { getUser } from '../../providers/identity.js';
import type { Session } from '../../lib/session.js';

const CALL = 'call-1'; const LOBBY = 'orgiq:dm:alice:bob:carol'; const CHANNEL = callChatChannel(CALL);
const NAMES: Record<string, string> = { alice: 'Alice Ames', bob: 'Bob Baker' };
const mk = (sub: string, over: Partial<Session> = {}): Session => ({ sub, name: NAMES[sub] ?? sub, tenant: 'orgiq', role: 'member', epoch: 0, grants: { orgiq: ['member'], social: ['participant'] }, iat: 100, ...over });
let sessions: Map<string, Session>; let contexts: Map<string, Record<string, unknown>>;
let calls: InMemoryCallStateStore; let runtime: CallChatRuntime; let source: MockTranscriptSource; let clock: number; let chatStore: InMemoryChatStore;
const app = express(); app.use(express.json());
app.use((req, _res, next) => { req.session = sessions.get(String(req.headers['x-user'])); next(); });
app.use(meetingAssistantDevRouter);
app.use('/api/calls/:callId/assistant', meetingAssistantRouter); app.use(errorHandler);
const ctx = (s: Session) => ({ userId: s.sub, org: s.tenant, role: s.role, displayName: s.sub, epoch: s.epoch ?? 0, sessionIat: s.iat });
const url = (path: string, call = CALL) => `/api/calls/${call}/assistant/${path}`;
const post = (path: string, user = 'alice', body: object = {}) => request(app).post(url(path)).set('x-user', user).send(body);
const dev = (body: object) => request(app).post(`/api/dev/calls/${CALL}/assistant-messages`).send(body);
const decide = (actionId: string, decision: unknown, user = 'alice') => post(`actions/${actionId}/decision`, user, { decision });
const chat = async () => (await chatStore.listMessages(CHANNEL, 100));
const texts = async () => (await chat()).map((m) => m.message);
const ACTION = { kind: 'action', actionId: 'act-1', askedBy: 'alice', askedByName: 'Alice', summary: 'Create work item "Login cookie bug"', detail: ['Assignee: Priya'], tool: { name: 'create_work_item', argsDigest: 'sha256:ab' } };

beforeEach(async () => {
  clock = Date.parse('2026-11-13T12:00:00.000Z');
  mockConfig.meetingAssistant.enabled = true; mockConfig.mock.aurora = true; mockConfig.meetingAssistant.transcriptRetentionDays = 30;
  mockInviters.clear(); mockInviters.add('alice'); mockInviters.add('bob');
  const people = [mk('alice'), mk('bob'), mk('carol'), mk('dave'), mk('alice', { act: { sub: 'root', epoch: 0 } } as Partial<Session>)];
  sessions = new Map(people.slice(0, 4).map((s) => [s.sub, s])); sessions.set('masked', people[4]!);
  contexts = new Map([['a', ctx(mk('alice'))], ['b', ctx(mk('bob'))], ['c', ctx(mk('carol'))], ['m', ctx(people[4]!)]]);
  jest.mocked(getUser).mockImplementation(async (id: string) => ({ id, displayName: NAMES[id] ?? id, email: null, personId: null, epoch: 0, grants: mk(id).grants }) as never);
  calls = new InMemoryCallStateStore(); chatStore = new InMemoryChatStore();
  const router = { sendToClient: jest.fn(), sendToChannel: jest.fn(), isClientLive: (id: string) => contexts.has(id), getClientData: (id: string) => ({ userContext: contexts.get(id) }), unsubscribeFromChannel: jest.fn() } as unknown as RealtimeRouter;
  runtime = new CallChatRuntime({ calls, state: new MemoryCallChatStateStore(), messages: chatStore, router, maintenanceIntervalMs: 0, now: () => clock,
    lobbyAllowed: (_auth, lobby) => lobby.startsWith('orgiq:') });
  setCallChatRuntime(runtime);
  const observed = observeCallPageLifecycle(calls, () => null, () => runtime);
  await observed.registerParticipant(CALL, 'a', 'alice', LOBBY, ['alice', 'bob', 'carol']);
  await observed.registerParticipant(CALL, 'b', 'bob', LOBBY, ['alice', 'bob', 'carol']);
  await observed.registerParticipant(CALL, 'c', 'carol', LOBBY, ['alice', 'bob', 'carol']);
  setAssistantStore(new MemoryAssistantStore());
  source = new MockTranscriptSource(); setTranscriptSource(source);
  setAssistantIntake(new LineIntake(assistantStore(), { clock: () => clock, tickMs: 0, source: () => source }));
});
afterEach(() => { setAssistantRuntime(null); setAssistantIntake(null); setAssistantStore(null); setTranscriptSource(null); setNotificationSink(null); runtime.dispose(); setCallChatRuntime(null); });

describe('notices', () => {
  it('invite posts the join notice once, with the inviter\'s name and the configured retention; a repeat invite posts nothing', async () => {
    mockConfig.meetingAssistant.transcriptRetentionDays = 14;
    expect((await post('invite')).status).toBe(201);
    const [notice] = await chat();
    expect(notice).toMatchObject({ userId: 'agent:nova', metadata: { kind: 'assistant-notice', assistant: true, displayName: 'Nova' } });
    expect(notice!.message).toBe("Nova joined at Alice Ames's invitation. While Nova is listening, what you say in this call is sent to the speech provider and kept as text for 14 days. Anyone here can pause or dismiss Nova.");
    await post('invite');
    expect(await chat()).toHaveLength(1);
  });

  it('names: the session name when there is one, else the directory name; the raw id only when nothing else exists', async () => {
    sessions.set('bob', mk('bob', { name: undefined }));
    await post('invite', 'alice'); await post('pause', 'bob'); await post('resume', 'carol');
    expect((await texts()).slice(0, 3)).toEqual([expect.stringContaining("Nova joined at Alice Ames's invitation."), 'Bob Baker paused Nova. Nothing is being heard or stored.', 'carol resumed Nova. Nova is listening again.']);
  });

  it('pause, resume and dismiss each post one sentence naming who did it; repeats post nothing; nothing after dismissal', async () => {
    await post('invite');
    await post('pause', 'bob'); await post('pause', 'bob');
    await post('resume', 'carol'); await post('resume', 'carol');
    await post('dismiss', 'alice'); await post('dismiss', 'alice'); await post('pause', 'bob');
    expect((await texts()).slice(1)).toEqual([
      noticeText.paused('Bob Baker'), noticeText.resumed('carol'), noticeText.dismissed('Alice Ames', true),
    ]);
    expect((await texts())[1]).toBe('Bob Baker paused Nova. Nothing is being heard or stored.');
    expect((await texts())[3]).toBe('Alice Ames dismissed Nova. Nothing was recorded, so there are no minutes.');
    // The invite after dismissal is refused and posts nothing.
    expect((await post('invite')).status).toBe(409);
    expect(await chat()).toHaveLength(4);
  });

  it('a failed post never fails the route', async () => {
    jest.spyOn(chatStore, 'putMessage').mockRejectedValueOnce(new Error('store down'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect((await post('invite')).status).toBe(201);
    warn.mockRestore();
    expect((await request(app).get(url('state')).set('x-user', 'alice')).body.state).toBe('listening');
  });
});

describe('the action decision route', () => {
  beforeEach(async () => { await post('invite'); expect((await dev(ACTION)).status).toBe(201); });

  it('only the asker decides: confirm flips the status, records who and when, and updates the same chat message', async () => {
    const before = await chat();
    const card = before.find((m) => m.metadata?.['kind'] === 'assistant-action')!;
    expect(card.metadata).toMatchObject({ status: 'waiting', askedBy: 'alice', askedByName: 'Alice', summary: ACTION.summary, detail: ['Assignee: Priya'], tool: { name: 'create_work_item', argsDigest: 'sha256:ab' } });
    const res = await decide('act-1', 'confirm');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ actionId: 'act-1', status: 'confirmed', decidedBy: 'alice' });
    expect(typeof res.body.decidedAt).toBe('number');
    const after = await chat();
    expect(after).toHaveLength(before.length);
    expect(after.find((m) => m.id === card.id)!.metadata).toMatchObject({ status: 'confirmed', summary: ACTION.summary });
    expect(await assistantStore().getAction(CALL, 'act-1')).toMatchObject({ status: 'confirmed', decidedBy: 'alice', askedBy: 'alice', messageId: card.id });
  });

  it('anyone else with a seat gets 403 and nothing changes, for confirm and decline alike', async () => {
    for (const who of ['bob', 'carol']) for (const decision of ['confirm', 'decline']) expect((await decide('act-1', decision, who)).status).toBe(403);
    expect((await assistantStore().getAction(CALL, 'act-1'))!.status).toBe('waiting');
    expect((await chat()).find((m) => m.metadata?.['kind'] === 'assistant-action')!.metadata?.['status']).toBe('waiting');
  });

  it('no seat, other tenant, no session, masquerade, flag off: refused', async () => {
    expect((await decide('act-1', 'confirm', 'dave')).status).toBe(403);
    expect((await decide('act-1', 'confirm', 'nobody')).status).toBe(403);
    expect((await decide('act-1', 'confirm', 'masked')).status).toBe(403);
    sessions.set('outside', mk('outside', { tenant: 'assessment', role: 'assessor' }));
    expect((await decide('act-1', 'confirm', 'outside')).status).toBe(403);
    mockConfig.meetingAssistant.enabled = false;
    expect((await decide('act-1', 'confirm')).status).toBe(404);
    expect((await assistantStore().getAction(CALL, 'act-1'))!.status).toBe('waiting');
  });

  it('decline works; a second identical decision is a success; the opposite one is a 409; unknown action 404; bad body 400', async () => {
    expect((await decide('act-1', 'decline')).body.status).toBe('declined');
    expect((await decide('act-1', 'decline')).status).toBe(200);
    expect((await decide('act-1', 'confirm')).status).toBe(409);
    expect((await decide('nope', 'confirm')).status).toBe(404);
    expect((await decide('act-1', 'maybe')).status).toBe(400);
    expect((await post('actions/act-1/decision', 'alice', {})).status).toBe(400);
    expect((await post('actions/bad id!/decision', 'alice', { decision: 'confirm' })).status).toBe(400);
  });

  it('after dismissal a decision is a 409 and the card stays as it was', async () => {
    await post('dismiss', 'bob');
    expect((await decide('act-1', 'confirm')).status).toBe(409);
    expect((await assistantStore().getAction(CALL, 'act-1'))!.status).toBe('waiting');
  });

  it('with no assistant in the call there is nothing to decide', async () => {
    setAssistantStore(new MemoryAssistantStore());
    expect((await decide('act-1', 'confirm')).status).toBe(404);
  });
});

describe('the dev poster', () => {
  it('posts a reply labelled with who asked, an action once per id, a notice, and moves an action to done with a result', async () => {
    await post('invite');
    expect((await dev({ kind: 'reply', text: 'The login bug is WI-AUTH-12.', askedBy: 'bob', askedByName: 'Bob Baker' })).status).toBe(201);
    expect((await dev(ACTION)).status).toBe(201);
    const again = await dev(ACTION);
    expect(again.status).toBe(200); expect(again.body.created).toBe(false);
    expect((await dev({ kind: 'notice', text: 'Nova has 5 minutes left in this call.' })).status).toBe(201);
    const rows = await chat();
    expect(rows.filter((m) => m.metadata?.['kind'] === 'assistant-action')).toHaveLength(1);
    expect(rows.find((m) => m.metadata?.['kind'] === 'assistant-reply')).toMatchObject({ userId: 'agent:nova', message: 'The login bug is WI-AUTH-12.', metadata: { askedBy: 'bob', askedByName: 'Bob Baker', private: false } });
    await decide('act-1', 'confirm');
    const done = await dev({ kind: 'action-status', actionId: 'act-1', to: 'done', resultText: 'Created WI-AUTH-13.' });
    expect(done.body.status).toBe('done');
    expect((await chat()).find((m) => m.metadata?.['kind'] === 'assistant-action')!.metadata).toMatchObject({ status: 'done', resultText: 'Created WI-AUTH-13.' });
    expect((await dev({ kind: 'action-status', actionId: 'act-1', to: 'failed' })).status).toBe(409);
  });

  it('posts nothing and answers 409 when the assistant is not in the call; validates its body; 404 off the mock world and with the flag off', async () => {
    expect((await dev({ kind: 'notice', text: 'x' })).status).toBe(409);
    expect(await chat()).toHaveLength(0);
    await post('invite');
    expect((await dev({ kind: 'reply', text: 'x' })).status).toBe(400);
    expect((await dev({ kind: 'what' })).status).toBe(400);
    expect((await dev({ ...ACTION, detail: 'no' })).status).toBe(400);
    mockConfig.mock.aurora = false;
    expect((await dev({ kind: 'notice', text: 'x' })).status).toBe(404);
    mockConfig.mock.aurora = true; mockConfig.meetingAssistant.enabled = false;
    expect((await dev({ kind: 'notice', text: 'x' })).status).toBe(404);
  });
});

describe('private delivery', () => {
  const sent: { userId: string; input: NotificationInputLike }[] = [];
  beforeEach(() => {
    sent.length = 0;
    setNotificationSink({ notifyUser: async (userId, input) => { sent.push({ userId, input }); } });
  });

  it('goes to the one person through their notifications and writes nothing to the call chat', async () => {
    await post('invite');
    const before = await chat();
    expect(await postPrivately(CALL, 'bob', { text: 'You have 3 days of budget left this month.' })).toBe(true);
    expect(sent.map((s) => s.userId)).toEqual(['bob']);
    expect(sent[0]!.input).toMatchObject({ type: 'assistant-private-reply', body: 'You have 3 days of budget left this month.', payload: { tenant: 'orgiq', callId: CALL, kind: 'assistant-private-reply' } });
    expect(await chat()).toEqual(before);
  });

  it('is refused with no assistant in the call, after it left, and through the dev route reports delivered', async () => {
    expect(await postPrivately(CALL, 'bob', { text: 'x' })).toBe(false);
    await post('invite');
    expect((await dev({ kind: 'private', userId: 'bob', text: 'only for you' })).status).toBe(202);
    await post('dismiss');
    expect(await postPrivately(CALL, 'bob', { text: 'x' })).toBe(false);
    expect(sent).toHaveLength(1);
  });
});

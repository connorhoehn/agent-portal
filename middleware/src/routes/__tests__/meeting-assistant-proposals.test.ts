// Proposals through the real routes (docs/meeting-consent-design.md, package 1): who may see and answer them, every answer, two at
// once, the reason's limits, masquerade and flag, expiry at the end of the call, and the delete. Harness: meeting-assistant-turns.test.ts.
const mockConfig = { region: 'us-east-1', auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true },
  meetingAssistant: { enabled: true, transcriptRetentionDays: 30 } };
jest.mock('../../config.js', () => ({ config: mockConfig }));
jest.mock('../../providers/identity.js', () => ({ getUser: jest.fn() }));
jest.mock('../../providers/projects.js', () => ({ getProject: jest.fn() }));
jest.mock('../../providers/work-items.js', () => ({ getWorkItem: jest.fn() }));
jest.mock('../../lib/authz.js', () => ({
  resolveSession: (req: { session?: unknown }) => req.session,
  isAllowed: jest.fn(async () => true),
  requireTenant: (tenant: string) => (req: { session?: { tenant: string; role: string } }, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) =>
    (req.session?.tenant === tenant || req.session?.role === 'admin' ? next() : res.status(403).json({ error: 'Forbidden' })),
  requireAction: (action: string) => (req: { session?: { sub: string } }, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) =>
    (action === 'InviteMeetingAssistant' && req.session?.sub === 'priya' ? next() : res.status(403).json({ error: 'Forbidden', action })),
}));

import express from 'express';
import request from '../../test-support/http.js';
import { InMemoryCallStateStore } from '@connorhoehn/realtime-modules/call';
import { InMemoryChatStore } from '@connorhoehn/realtime-modules/chat';
import type { RealtimeRouter } from '@connorhoehn/realtime-modules/server';
import { meetingAssistantRouter } from '../meeting-assistant.js';
import { meetingAssistantDevRouter } from '../meeting-assistant-dev.js';
import { errorHandler } from '../../lib/async-handler.js';
import { CallChatRuntime, setCallChatRuntime } from '../../lib/call-chat.js';
import { MemoryCallChatStateStore } from '../../lib/call-chat-state.js';
import { observeCallPageLifecycle } from '../../lib/call-pages.js';
import { setNotificationSink } from '../../lib/social-notify.js';
import { assistantStore, assistantIntake, setAssistantStore, setAssistantIntake, LineIntake, MemoryAssistantStore, setTranscriptSource, MockTranscriptSource } from '../../lib/meeting-assistant/index.js';
import { AssistantRuntime, setAssistantRuntime, defaultRolesOf } from '../../lib/meeting-assistant/orchestrator.js';
import { ScriptedSession } from '../../lib/meeting-assistant/scripted-session.js';
import { setSessionFactory } from '../../lib/meeting-assistant/session-select.js';
import { onProposalConsented, PROPOSAL_AFTER_CALL_MS } from '../../lib/meeting-assistant/proposals.js';
import { getUser } from '../../providers/identity.js';
import type { Session } from '../../lib/session.js';

const CALL = 'call-1'; const LOBBY = 'orgiq:dm:lee:priya:sam';
const NAMES: Record<string, string> = { priya: 'Priya Patel', sam: 'Sam Song', lee: 'Lee Lin' };
const mk = (sub: string, over: Partial<Session> = {}): Session => ({ sub, name: NAMES[sub] ?? sub, tenant: 'orgiq', role: 'member', epoch: 0, grants: { orgiq: ['member'], social: ['participant'] }, iat: 100, ...over });
let sessions: Map<string, Session>; let contexts: Map<string, Record<string, unknown>>; let rt: CallChatRuntime; let clock: number;
const app = express(); app.use(express.json());
app.use((req, _res, next) => { req.session = sessions.get(String(req.headers['x-user'])); next(); });
app.use(meetingAssistantDevRouter);
app.use('/api/calls/:callId/assistant', meetingAssistantRouter); app.use(errorHandler);
const ctx = (s: Session) => ({ userId: s.sub, org: s.tenant, role: s.role, displayName: s.sub, epoch: s.epoch ?? 0, sessionIat: s.iat });
const url = (path: string) => `/api/calls/${CALL}/assistant/${path}`;
const post = (path: string, user: string, body: object = {}) => request(app).post(url(path)).set('x-user', user).send(body);
const get = (path: string, user: string) => request(app).get(url(path)).set('x-user', user);
const propose = (body: object = {}) => request(app).post(`/api/dev/calls/${CALL}/assistant-proposals`).send({ id: 'p-1', statement: 'Cut over the smallest tenants first', outcome: { kind: 'decision' }, executor: 'priya', ...body });
const respond = (user: string, response: string, reason?: string, id = 'p-1') => post(`proposals/${id}/response`, user, { response, ...(reason !== undefined ? { reason } : {}) });

beforeEach(async () => {
  clock = Date.parse('2026-11-14T10:00:00.000Z');
  mockConfig.meetingAssistant.enabled = true;
  const people = [mk('priya'), mk('sam'), mk('lee'), mk('dave'), mk('erin'), mk('olga', { tenant: 'assessment' }), mk('priya', { act: { sub: 'root', epoch: 0 } } as Partial<Session>)];
  sessions = new Map(people.map((s) => [s.sub, s])); sessions.set('masked', people[people.length - 1]!); sessions.set('priya', mk('priya'));
  contexts = new Map([['a', ctx(mk('priya'))], ['b', ctx(mk('sam'))], ['c', ctx(mk('lee'))]]);
  jest.mocked(getUser).mockImplementation(async (id: string) => ({ id, displayName: NAMES[id] ?? id, email: null, personId: null, epoch: 0, grants: mk(id).grants }) as never);
  const calls = new InMemoryCallStateStore();
  setNotificationSink({ notifyUser: async () => undefined });
  const router = { sendToClient: jest.fn(), sendToChannel: jest.fn(), isClientLive: (id: string) => contexts.has(id), getClientData: (id: string) => ({ userContext: contexts.get(id) }), unsubscribeFromChannel: jest.fn() } as unknown as RealtimeRouter;
  rt = new CallChatRuntime({ calls, state: new MemoryCallChatStateStore(), messages: new InMemoryChatStore(), router, maintenanceIntervalMs: 0, now: () => clock, lobbyAllowed: (_a, lobby) => lobby.startsWith('orgiq:') });
  setCallChatRuntime(rt);
  const observed = observeCallPageLifecycle(calls, () => null, () => rt);
  for (const [cid, u] of [['a', 'priya'], ['b', 'sam'], ['c', 'lee']] as const) await observed.registerParticipant(CALL, cid, u, LOBBY, ['priya', 'sam', 'lee']);
  setAssistantStore(new MemoryAssistantStore());
  const source = new MockTranscriptSource(); setTranscriptSource(source);
  setAssistantIntake(new LineIntake(assistantStore(), { clock: () => clock, tickMs: 0, source: () => source }));
  setSessionFactory(() => new ScriptedSession(() => clock));
  setAssistantRuntime(new AssistantRuntime({ store: assistantStore, intake: assistantIntake, clock: () => clock, makeSession: () => new ScriptedSession(() => clock), rolesOf: defaultRolesOf }, { tickMs: 0 }));
  expect((await post('invite', 'priya')).status).toBe(201);
});
afterEach(() => { setAssistantRuntime(null); setSessionFactory(null); setAssistantIntake(null); setAssistantStore(null); setTranscriptSource(null); setNotificationSink(null); rt.dispose(); setCallChatRuntime(null); });

describe('creating one (dev route)', () => {
  it('creates an open proposal with nobody consented, on the call\'s initiative, once', async () => {
    const res = await propose();
    expect(res.status).toBe(201);
    expect(res.body.proposal).toMatchObject({ state: 'open', responses: [], source: 'dev', outcome: { kind: 'decision', initiativeId: null }, executor: 'priya', expiresAt: null });
    expect((await propose({ statement: 'Something else' })).status).toBe(200);
    expect((await propose({ id: 'p-2', statement: 'x'.repeat(281) })).status).toBe(400);
    expect((await request(app).post('/api/dev/calls/call-none/assistant-proposals').send({ statement: 'a', outcome: { kind: 'decision' }, executor: 'priya' })).status).toBe(409);
  });

  it('does not exist with the flag off', async () => {
    mockConfig.meetingAssistant.enabled = false;
    expect((await propose()).status).toBe(404);
  });
});

describe('the consent rule through the routes', () => {
  beforeEach(async () => { expect((await propose()).status).toBe(201); });

  it('two people including the executor: consented, with the answers and who is missing shown', async () => {
    const first = await respond('sam', 'consent');
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ state: 'open', missing: { people: ['priya'], more: 0 }, you: { response: 'consent', isExecutor: false } });
    const second = await respond('priya', 'consent');
    expect(second.body).toMatchObject({ state: 'consented', executor: { userId: 'priya', name: 'Priya Patel' }, missing: { people: [], more: 0 } });
    expect(second.body.responses.map((r: { name: string }) => r.name).sort()).toEqual(['Priya Patel', 'Sam Song']);
  });

  it('an objection with a shared reason blocks, and its withdrawal re-evaluates', async () => {
    await respond('sam', 'consent');
    const objected = await respond('lee', 'object', "I'm out next week");
    expect(objected.body).toMatchObject({ state: 'objected', missing: { objectedBy: ['lee'] } });
    expect(objected.body.responses.find((r: { userId: string }) => r.userId === 'lee')).toMatchObject({ reason: "I'm out next week", reasonShared: true });
    expect((await respond('priya', 'consent')).body.state).toBe('objected');
    expect((await respond('lee', 'withdraw')).body.state).toBe('consented');
  });

  it('a named person who is missing holds it open', async () => {
    await propose({ id: 'p-2', named: ['lee'] });
    await respond('sam', 'consent', undefined, 'p-2');
    expect((await respond('priya', 'consent', undefined, 'p-2')).body).toMatchObject({ state: 'open', missing: { people: ['lee'] } });
    expect((await respond('lee', 'consent', undefined, 'p-2')).body.state).toBe('consented');
  });

  it('two answers at once are both kept', async () => {
    const seen: string[] = [];
    const off = onProposalConsented((p) => { seen.push(p.id); });
    const [a, b] = await Promise.all([respond('sam', 'consent'), respond('priya', 'consent')]);
    off();
    expect([a.status, b.status]).toEqual([200, 200]);
    const list = await get('proposals', 'lee');
    // Consented, then run at once: this call (a direct message) has no initiative to record a decision on, so the run fails with a reason.
    expect(list.body.proposals[0]).toMatchObject({ state: 'failed', run: { note: expect.stringMatching(/no initiative/) } });
    expect(list.body.proposals[0].responses).toHaveLength(2);
    expect(seen).toEqual(['p-1']);
  });

  it('consenting again to run it is for a consented proposal only, and the flag is a boolean', async () => {
    expect((await post('proposals/p-1/response', 'sam', { response: 'consent', asExecutor: 'yes' })).status).toBe(400);
    expect((await post('proposals/p-1/response', 'sam', { response: 'consent', asExecutor: true })).status).toBe(409);
    expect((await get('proposals', 'sam')).body.proposals[0]).toMatchObject({ state: 'open', run: null, you: { canRun: false } });
  });

  it('"Not a decision" dismisses it, and then nothing more is taken', async () => {
    expect((await respond('lee', 'not-a-decision')).body).toMatchObject({ state: 'dismissed', dismissedBy: 'lee' });
    expect((await respond('sam', 'consent')).status).toBe(409);
  });

  it('refuses a bad answer, a reason on anything but an objection, and a reason too long or of two lines', async () => {
    expect((await respond('sam', 'maybe')).status).toBe(400);
    expect((await respond('sam', 'consent', 'sure')).status).toBe(400);
    expect((await respond('sam', 'object', 'x'.repeat(201))).status).toBe(400);
    expect((await respond('sam', 'object', 'one\ntwo')).status).toBe(400);
    expect((await respond('sam', 'object', 'x'.repeat(200))).status).toBe(200);
  });

  it('an unknown proposal is 404', async () => {
    expect((await respond('sam', 'consent', undefined, 'p-none')).status).toBe(404);
  });
});

describe('who may see and answer', () => {
  beforeEach(async () => { expect((await propose()).status).toBe(201); });

  it('someone who never held a seat gets 404 on both routes, as does another tenant', async () => {
    expect((await get('proposals', 'dave')).status).toBe(404);
    expect((await respond('dave', 'consent')).status).toBe(404);
    expect((await get('proposals', 'olga')).status).toBe(403); // requireTenant answers first
  });

  it('a recorded attendee who has left may read and answer, but not dismiss', async () => {
    await assistantStore().attend(CALL, 'erin');
    expect((await get('proposals', 'erin')).status).toBe(200);
    expect((await respond('erin', 'consent')).status).toBe(200);
    expect((await respond('erin', 'not-a-decision')).status).toBe(403);
  });

  it('a named person who was never there sees and answers only the proposals that need them', async () => {
    await propose({ id: 'p-2', named: ['dave'] });
    const list = await get('proposals', 'dave');
    expect(list.status).toBe(200);
    expect(list.body.proposals.map((p: { id: string }) => p.id)).toEqual(['p-2']);
    expect((await respond('dave', 'consent', undefined, 'p-2')).status).toBe(200);
    expect((await respond('dave', 'consent', undefined, 'p-1')).status).toBe(404);
  });

  it('a masquerade is refused on every method', async () => {
    expect((await get('proposals', 'masked')).body.code).toBe('MASQUERADING');
    expect((await respond('masked', 'consent')).body.code).toBe('MASQUERADING');
  });

  it('the flag off: 404', async () => {
    mockConfig.meetingAssistant.enabled = false;
    expect((await get('proposals', 'sam')).status).toBe(404);
    expect((await respond('sam', 'consent')).status).toBe(404);
  });
});

describe('after the call', () => {
  beforeEach(async () => { expect((await propose()).status).toBe(201); });

  it('dismissing the assistant gives open proposals end + 72 h; after that they expire unrun', async () => {
    expect((await post('dismiss', 'sam')).status).toBe(200);
    const leftAt = (await assistantStore().get(CALL))!.leftAt!;
    const [p] = (await get('proposals', 'sam')).body.proposals;
    expect(p).toMatchObject({ state: 'open', expiresAt: leftAt + PROPOSAL_AFTER_CALL_MS });
    expect((await respond('sam', 'consent')).body.state).toBe('open');
    const later = jest.spyOn(Date, 'now').mockReturnValue(leftAt + PROPOSAL_AFTER_CALL_MS);
    try {
      expect((await respond('priya', 'consent')).status).toBe(409);
      expect((await get('proposals', 'sam')).body.proposals[0].state).toBe('expired');
    } finally { later.mockRestore(); }
  });

  it('the inviter\'s delete removes the proposals', async () => {
    await post('dismiss', 'priya');
    expect((await request(app).delete(url('minutes')).set('x-user', 'priya')).status).toBe(200);
    expect(await assistantStore().listProposals(CALL)).toEqual([]);
    expect((await get('proposals', 'sam')).status).toBe(404);
  });
});

// The meeting-assistant routes in the interviews tenant (row I3.2): the tenant gate lets an interviews session reach an interview's
// call and nothing else, a Work session never reaches an interview's call (and the reverse), a guest (no session) reaches nothing, and
// the interview's policy (lib/interviews/milo-policy.ts) decides who invites and who reads. Harness: meeting-assistant-policy.test.ts.
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
    (!req.session ? res.status(401).json({ error: 'Unauthenticated' }) : req.session.tenant === tenant || req.session.role === 'admin' ? next() : res.status(403).json({ error: 'Forbidden' })),
  requireAction: (action: string) => (req: { session?: { sub: string } }, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) =>
    (action === 'InviteMeetingAssistant' && req.session && mockInviters.has(req.session.sub) ? next() : res.status(403).json({ error: 'Forbidden', action })),
}));

import express from 'express';
import request from '../../test-support/http.js';
import { InMemoryCallStateStore } from '@connorhoehn/realtime-modules/call';
import { InMemoryChatStore } from '@connorhoehn/realtime-modules/chat';
import type { RealtimeRouter } from '@connorhoehn/realtime-modules/server';
import { lobbyAgrees, meetingAssistantRouter, meetingsRouter } from '../meeting-assistant.js';
import { AppError, errorHandler } from '../../lib/async-handler.js';
import { CallChatRuntime, setCallChatRuntime } from '../../lib/call-chat.js';
import { MemoryCallChatStateStore } from '../../lib/call-chat-state.js';
import { observeCallPageLifecycle } from '../../lib/call-pages.js';
import { setNotificationSink } from '../../lib/social-notify.js';
import { assistantStore, assistantIntake, setAssistantStore, setAssistantIntake, LineIntake, MemoryAssistantStore, setTranscriptSource, MockTranscriptSource } from '../../lib/meeting-assistant/index.js';
import { AssistantRuntime, setAssistantRuntime, defaultRolesOf } from '../../lib/meeting-assistant/orchestrator.js';
import { policyFamilies } from '../../lib/meeting-assistant/policy.js';
import { ScriptedSession } from '../../lib/meeting-assistant/scripted-session.js';
import { setSessionFactory } from '../../lib/meeting-assistant/session-select.js';
import { setAssistantSpend, type ReserveInput } from '../../lib/meeting-assistant/spend.js';
import { INTERVIEW_FAMILY, LEAD_ONLY } from '../../lib/interviews/milo-policy.js';
import { fixtureRegistry } from '../../mock/core/index.js';
import { interviewOpeningsFixture } from '../../mock/interviews.js';
import { getUser } from '../../providers/identity.js';
import type { Session } from '../../lib/session.js';

const IV_CALL = 'call-iv'; const IV_LOBBY = 'interviews:interview:iv-nadia-leadership';
const WORK_CALL = 'call-work'; const WORK_LOBBY = 'orgiq:dm:u-alice:u-wen';
// The seeded round iv-nadia-leadership (op-em): lead u-wen, panel u-hugo, recruiter u-greta, hiring manager u-amara. u-otto is made
// hiring manager of another opening; u-alice is a Work member.
const PEOPLE: Record<string, [tenant: string, role: string]> = {
  'u-wen': ['interviews', 'interviewer'], 'u-hugo': ['interviews', 'interviewer'], 'u-greta': ['interviews', 'recruiter'],
  'u-amara': ['interviews', 'hiring-manager'], 'u-otto': ['interviews', 'hiring-manager'], 'u-alice': ['orgiq', 'member'],
};
const mk = (sub: string): Session => {
  const [tenant, role] = PEOPLE[sub]!;
  return { sub, name: sub, tenant, role, epoch: 0, grants: { [tenant]: [role] }, iat: 100 } as Session;
};
/**
 * The call chat's seat rule does not know an interview's lobby until lane SEAT's half is combined (lib/call-access.ts
 * `huddleLobbyTenant`), so this stand-in seats the interview's lead and panel by a plain list, interviews sessions only, the way
 * SEAT's rule will (a huddle belongs to its lobby's tenant). Work's calls keep the real rule.
 */
const IV_SEATED = ['u-wen', 'u-hugo'];
class SeatStandIn extends CallChatRuntime {
  override async assertMember(callId: string, session: Session, write = false): Promise<void> {
    if (callId !== IV_CALL) return super.assertMember(callId, session, write);
    if (session.tenant !== 'interviews' || !IV_SEATED.includes(session.sub)) throw new AppError(403, 'Join this call before opening its conversation');
  }
  override async seatedUsers(callId: string): Promise<{ userId: string; active: boolean }[]> {
    return callId === IV_CALL ? IV_SEATED.map((userId) => ({ userId, active: true })) : super.seatedUsers(callId);
  }
}
let sessions: Map<string, Session>; let contexts: Map<string, Record<string, unknown>>;
let calls: InMemoryCallStateStore; let rt: SeatStandIn; let clock: number; let reserved: ReserveInput[];
const app = express(); app.use(express.json());
app.use((req, _res, next) => { req.session = sessions.get(String(req.headers['x-user'])); next(); });
app.use('/api/calls/:callId/assistant', meetingAssistantRouter); app.use('/api/meetings', meetingsRouter); app.use(errorHandler);
const ctx = (s: Session) => ({ userId: s.sub, org: s.tenant, role: s.role, displayName: s.sub, epoch: s.epoch ?? 0, sessionIat: s.iat });
const send = (method: string, call: string, path: string, user: string | null, body: object = {}) => {
  const r = method === 'get' ? request(app).get(`/api/calls/${call}/assistant/${path}`) : method === 'delete' ? request(app).delete(`/api/calls/${call}/assistant/${path}`) : request(app).post(`/api/calls/${call}/assistant/${path}`).send(body);
  return user ? r.set('x-user', user) : r;
};

/** Every route of the meeting assistant, with a body that would pass its own validation. */
const ROUTES: Array<[string, string, object?]> = [
  ['post', 'invite'], ['post', 'pause'], ['post', 'resume'], ['post', 'dismiss'], ['post', 'ack'], ['post', 'voice', { on: true }],
  ['post', 'participant', { on: true }], ['post', 'extend'], ['post', 'actions/a1/decision', { decision: 'approve' }], ['get', 'turns'],
  ['post', 'turns/t1/claim'], ['post', 'turns/t1/result', { ok: true }], ['get', 'proposals'], ['post', 'proposals/p1/response', { response: 'consent' }],
  ['post', 'proposals/p1/raise-again'], ['get', 'state'], ['get', 'transcript'], ['get', 'minutes'], ['post', 'minutes/action-items/0/work-item'],
  ['post', 'minutes/rewrite'], ['delete', 'minutes'], ['delete', 'transcript'],
];

beforeEach(async () => {
  delete process.env['INTERVIEWS_ENABLED'];
  clock = Date.parse('2026-11-16T12:00:00.000Z');
  fixtureRegistry.resetAll('default');
  interviewOpeningsFixture.rows().find((o) => o.id === 'op-backend')!.hiringManagerId = 'u-otto';
  mockInviters.clear(); for (const u of ['u-wen', 'u-hugo', 'u-alice']) mockInviters.add(u);
  sessions = new Map(Object.keys(PEOPLE).map((u) => [u, mk(u)]));
  contexts = new Map(Object.keys(PEOPLE).map((u) => [u, ctx(mk(u))]));
  jest.mocked(getUser).mockImplementation(async (id: string) => ({ id, displayName: id, email: null, personId: null, epoch: 0, grants: mk(id).grants }) as never);
  calls = new InMemoryCallStateStore(); reserved = [];
  setNotificationSink({ notifyUser: async () => undefined });
  setAssistantSpend({ reserve: async (i) => { reserved.push(i); return { ok: true, holdId: `h${reserved.length}` }; }, release: async () => undefined, settle: async () => undefined });
  const router = { sendToClient: jest.fn(), sendToChannel: jest.fn(), isClientLive: (id: string) => contexts.has(id), getClientData: (id: string) => ({ userContext: contexts.get(id) }), unsubscribeFromChannel: jest.fn() } as unknown as RealtimeRouter;
  rt = new SeatStandIn({ calls, state: new MemoryCallChatStateStore(), messages: new InMemoryChatStore(), router, maintenanceIntervalMs: 0, now: () => clock, lobbyAllowed: () => true });
  setCallChatRuntime(rt);
  const observed = observeCallPageLifecycle(calls, () => null, () => rt);
  // The interview's call seats the lead and the panel; the Work call seats a Work member AND the lead (a seat alone must not let
  // anyone cross); the Work member is also seated in the interview's call for the same reason.
  contexts.set('u-alice-w', ctx(mk('u-alice'))); contexts.set('u-wen-w', ctx(mk('u-wen')));
  for (const u of ['u-wen', 'u-hugo', 'u-alice']) await observed.registerParticipant(IV_CALL, u, u, IV_LOBBY, ['u-wen', 'u-hugo', 'u-alice']);
  for (const u of ['u-alice', 'u-wen']) await observed.registerParticipant(WORK_CALL, `${u}-w`, u, WORK_LOBBY, ['u-alice', 'u-wen']);
  setAssistantStore(new MemoryAssistantStore());
  const source = new MockTranscriptSource(); setTranscriptSource(source);
  setAssistantIntake(new LineIntake(assistantStore(), { clock: () => clock, tickMs: 0, source: () => source }));
  setSessionFactory(() => new ScriptedSession(() => clock));
  setAssistantRuntime(new AssistantRuntime({ store: assistantStore, intake: assistantIntake, clock: () => clock, makeSession: () => new ScriptedSession(() => clock), rolesOf: defaultRolesOf }, { tickMs: 0 }));
});
afterEach(() => {
  setAssistantRuntime(null); setSessionFactory(null); setAssistantIntake(null); setAssistantStore(null); setTranscriptSource(null); setNotificationSink(null); setAssistantSpend(null);
  rt.dispose(); setCallChatRuntime(null);
  delete process.env['INTERVIEWS_ENABLED'];
});

it('the interview policy is registered by the routes while the tenant is on', () => {
  expect(policyFamilies()).toContain(INTERVIEW_FAMILY);
});

describe('who reaches which call', () => {
  it('a guest (no session) is refused on every route of both calls, and on the meetings list', async () => {
    for (const call of [IV_CALL, WORK_CALL]) {
      for (const [m, path, body] of ROUTES) expect([call, m, path, (await send(m, call, path, null, body)).status]).toEqual([call, m, path, 401]);
    }
    expect((await request(app).get('/api/meetings')).status).toBe(401);
  });

  it('a Work session never reaches an interview\'s call, seated or not: the same 404 as no call, on every route', async () => {
    expect((await send('post', IV_CALL, 'invite', 'u-wen')).status).toBe(201); // there is a record to protect
    for (const [m, path, body] of ROUTES) expect([m, path, (await send(m, IV_CALL, path, 'u-alice', body)).status]).toEqual([m, path, 404]);
    expect((await assistantStore().get(IV_CALL))!.attendees).not.toContain('u-alice');
  });

  it('an interviews session never reaches a Work call, seated or not, on every route', async () => {
    expect((await send('post', WORK_CALL, 'invite', 'u-alice')).status).toBe(201);
    for (const [m, path, body] of ROUTES) expect([m, path, (await send(m, WORK_CALL, path, 'u-wen', body)).status]).toEqual([m, path, 404]);
    expect((await assistantStore().get(WORK_CALL))!.attendees).not.toContain('u-wen');
  });

  it('an interviews session reaches no call at all while the tenant is off', async () => {
    process.env['INTERVIEWS_ENABLED'] = 'false';
    expect((await send('post', IV_CALL, 'invite', 'u-wen')).status).toBe(403);
    expect((await send('get', IV_CALL, 'state', 'u-wen')).status).toBe(403);
    expect((await request(app).get('/api/meetings').set('x-user', 'u-wen')).status).toBe(403);
  });

  it('the lobby rule: each tenant its own family, an unknown lobby is no interview', () => {
    expect(lobbyAgrees('interviews', IV_LOBBY)).toBe(true);
    expect(lobbyAgrees('interviews', WORK_LOBBY)).toBe(false);
    expect(lobbyAgrees('interviews', 'interviews:pad:iv-nadia-leadership')).toBe(false);
    expect(lobbyAgrees('interviews', null)).toBe(false);
    expect(lobbyAgrees('orgiq', IV_LOBBY)).toBe(false);
    expect(lobbyAgrees('orgiq', WORK_LOBBY)).toBe(true);
    expect(lobbyAgrees('orgiq', null)).toBe(true);
  });
});

describe('in the interview\'s call', () => {
  it('only the lead invites, turns the voice on and adds time; the panel gets the policy\'s sentence, the recruiter Cedar\'s refusal', async () => {
    const panel = await send('post', IV_CALL, 'invite', 'u-hugo');
    expect([panel.status, panel.body.error]).toEqual([403, LEAD_ONLY]);
    expect((await send('post', IV_CALL, 'invite', 'u-greta')).status).toBe(403);
    expect(reserved).toEqual([]);
    expect((await send('post', IV_CALL, 'invite', 'u-wen')).status).toBe(201);
    expect(reserved).toEqual([expect.objectContaining({ inviterId: 'u-wen', initiativeId: null, source: 'interviews', tenant: 'interviews' })]);
    expect((await send('post', IV_CALL, 'voice', 'u-hugo', { on: true })).body.error).toBe(LEAD_ONLY);
    expect((await send('post', IV_CALL, 'extend', 'u-hugo')).body.error).toBe(LEAD_ONLY);
    expect((await send('post', IV_CALL, 'voice', 'u-wen', { on: true })).status).toBe(200);
  });

  it('the panel side reads the words without a seat; another opening\'s hiring manager does not', async () => {
    expect((await send('post', IV_CALL, 'invite', 'u-wen')).status).toBe(201);
    for (const u of ['u-wen', 'u-hugo', 'u-greta', 'u-amara']) expect([u, (await send('get', IV_CALL, 'transcript', u)).status]).toEqual([u, 200]);
    expect((await send('get', IV_CALL, 'transcript', 'u-otto')).status).toBe(404);
    expect((await send('get', IV_CALL, 'proposals', 'u-otto')).status).toBe(404);
  });
});

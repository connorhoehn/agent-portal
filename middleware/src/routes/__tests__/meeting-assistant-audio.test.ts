// The PCM sink route and the participant binding route (docs/meeting-assistant-design.md, package 6a).
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
import { meetingAssistantSinkRouter } from '../meeting-assistant-sink.js';
import { AudioIntake } from '../../lib/meeting-assistant/audio-intake.js';
import { assistantIntake } from '../../lib/meeting-assistant/intake-select.js';
import { setAssistantAudio, assistantAudio } from '../../lib/meeting-assistant/audio-select.js';
import { ScriptedSession } from '../../lib/meeting-assistant/scripted-session.js';
import { AssistantRuntime, defaultRolesOf } from '../../lib/meeting-assistant/orchestrator.js';
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
const app = express();
// Mounted as in index.ts: the sink first, with no body parser or session middleware in front of it.
app.use('/api/internal/meeting-assistant', meetingAssistantSinkRouter);
app.use(express.json());
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

const ARN = 'arn:aws:ivs:us-east-1:000000000000:channel/room-1';
const pcm = (ms = 200, hz = 300) => { const b = Buffer.alloc(Math.round(ms * 16) * 2); for (let i = 0; i < b.length / 2; i += 1) b.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * hz * i) / 16000)), i * 2); return b; };
const sink = (token: string, body: Buffer, headers: Record<string, string> = {}) => request(app).post(`/api/internal/meeting-assistant/pcm/${token}`)
  .set({ 'content-type': 'application/octet-stream', 'x-channel-arn': ARN, 'x-participant-id': 'bob-lq1', 'x-sample-rate': '16000', 'x-encoding': 'pcm_s16le', 'x-channels': '1', ...headers }).send(body);

let audio: AudioIntake;
beforeEach(() => {
  audio = new AudioIntake(() => assistantStore(), { clock: () => clock, tickMs: 0 });
  setAssistantAudio(audio);
  setAssistantRuntime(new AssistantRuntime({ store: assistantStore, intake: assistantIntake,
    clock: () => clock, makeSession: () => new ScriptedSession(() => clock), rolesOf: defaultRolesOf, audio }, { tickMs: 0 }));
});
afterEach(() => { setAssistantAudio(null); });

describe('POST /api/calls/:callId/assistant/participant', () => {
  it('a person binds their own media participant id: <sub>-<base36>', async () => {
    await post('invite');
    const res = await post('participant', 'bob', { participantId: 'bob-lq1x2y' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ callId: CALL, participantId: 'bob-lq1x2y', bound: true });
    expect(assistantAudio().userOf(CALL, 'bob-lq1x2y')).toBe('bob');
    expect((await post('participant', 'bob', { participantId: 'bob-lq1x2y' })).status).toBe(200);
  });

  it('nobody can bind an id that is not theirs: another person\'s id, a malformed stamp, a bare name, a longer name that starts with theirs', async () => {
    await post('invite');
    for (const id of ['alice-lq1x2y', 'bob', 'bob-', 'bob-LQ1', 'bob-lq1-x', 'bob-lq1 x', 'bobby-lq1', 'bob-' + 'a'.repeat(17)]) {
      const res = await post('participant', 'bob', { participantId: id });
      expect([403, 400]).toContain(res.status);
    }
    expect((await post('participant', 'bob', { participantId: 5 })).status).toBe(400);
    expect((await post('participant', 'bob', {})).status).toBe(400);
    expect(assistantAudio().userOf(CALL, 'alice-lq1x2y')).toBeNull();
  });

  it('needs a seat, an assistant that is in the call and not under a masquerade; and the flag', async () => {
    expect((await post('participant', 'bob', { participantId: 'bob-lq1' })).status).toBe(404); // no assistant yet
    await post('invite');
    expect((await post('participant', 'dave', { participantId: 'dave-lq1' })).status).toBe(403);
    expect((await post('participant', 'masked', { participantId: 'alice-lq1' })).body.code).toBe('MASQUERADING');
    await post('dismiss');
    expect((await post('participant', 'bob', { participantId: 'bob-lq1' })).status).toBe(409);
    mockConfig.meetingAssistant.enabled = false;
    expect((await post('participant', 'bob', { participantId: 'bob-lq1' })).status).toBe(404);
  });
});

describe('POST /api/internal/meeting-assistant/pcm/:sinkToken', () => {
  async function armed(): Promise<string> {
    await post('invite');
    await post('ack', 'bob');
    await post('participant', 'bob', { participantId: 'bob-lq1' });
    return audio.arm(CALL, ARN);
  }

  it('takes a chunk with no cookie and no session, answers 204 with no body, and the audio is mixed', async () => {
    const token = await armed();
    const res = await sink(token, pcm());
    expect(res.status).toBe(204);
    expect(res.text ?? '').toBe('');
    expect(audio.countersOf(CALL)).toMatchObject({ chunks: 1, mixedChunks: 1 });
  });

  it('an unknown, malformed, wrong-channel or dead token is a 404 with an empty body, before the body is read', async () => {
    const token = await armed();
    for (const t of ['A'.repeat(43), 'nope', `${token}x`]) { const r = await sink(t, pcm()); expect(r.status).toBe(404); expect(r.text ?? '').toBe(''); }
    const wrong = await sink(token, pcm(), { 'x-channel-arn': `${ARN}2` });
    expect(wrong.status).toBe(404);
    const noHeader = await request(app).post(`/api/internal/meeting-assistant/pcm/${token}`).set('content-type', 'application/octet-stream').send(pcm());
    expect(noHeader.status).toBe(404);
    expect((await post('pause', 'bob')).status).toBe(200);
    const dead = await sink(token, pcm());
    expect(dead.status).toBe(404);
    expect(dead.text ?? '').toBe('');
  });

  it('with the flag off the sink does not exist', async () => {
    const token = await armed();
    mockConfig.meetingAssistant.enabled = false;
    expect((await sink(token, pcm())).status).toBe(404);
  });

  it('caps one chunk at 64 KB (413), refuses a wrong format (400), and a participant nobody bound is dropped quietly (204, counted)', async () => {
    const token = await armed();
    expect((await sink(token, Buffer.alloc(64 * 1024 + 2))).status).toBe(413);
    expect((await sink(token, pcm(), { 'x-sample-rate': '8000' })).status).toBe(400);
    expect((await sink(token, pcm(), { 'x-participant-id': 'stranger-1' })).status).toBe(204);
    expect(audio.countersOf(CALL)).toMatchObject({ unmappedChunks: 1 });
  });

  it('is rate limited per token (429) and answers every chunk without waiting on anything', async () => {
    const token = await armed();
    const statuses: number[] = [];
    for (let i = 0; i < 260; i += 1) statuses.push((await sink(token, pcm(20))).status);
    expect(statuses.filter((s) => s === 204).length).toBeGreaterThanOrEqual(200);
    expect(statuses).toContain(429);
  });

  it('a person who has not acknowledged is dropped (204, counted, nothing mixed)', async () => {
    await post('invite');
    await post('participant', 'bob', { participantId: 'bob-lq1' }); // bound but has not acknowledged
    const token = await audio.arm(CALL, ARN);
    expect((await sink(token, pcm())).status).toBe(204);
    expect(audio.countersOf(CALL)).toMatchObject({ unackedChunks: 1, mixedChunks: 0 });
  });
});

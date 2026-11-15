// Minutes when Nova is invited back into a call it left: what the later period hears is ADDED to the stored minutes (indices stay, work
// items and done marks survive, repeats are dropped, nothing new changes nothing), a failed addition keeps the minutes and is retried
// within the caps, and a leave during a running write waits for it. Harness: meeting-assistant-minutes.test.ts.
const mockConfig = { region: 'us-east-1', auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true },
  meetingAssistant: { enabled: true, transcriptRetentionDays: 30 } };
jest.mock('../../config.js', () => ({ config: mockConfig }));
jest.mock('../../providers/identity.js', () => ({ getUser: jest.fn() }));
jest.mock('../../providers/projects.js', () => ({ getProject: jest.fn() }));
const mockCreated: Array<{ projectId: string; title: string }> = [];
jest.mock('../../providers/work-items.js', () => ({ getWorkItem: jest.fn(), createWorkItem: jest.fn(async (input: { projectId: string; title: string }) => { mockCreated.push(input); return { id: `wi-${mockCreated.length}`, ...input }; }) }));
const mockStewards = new Set<string>();
jest.mock('../../lib/initiative-scope.js', () => ({ ...jest.requireActual('../../lib/initiative-scope.js'),
  requireInitiativeScope: async (req: { session?: { sub: string } }, res: { status: (n: number) => { json: (b: unknown) => void } }) => {
    if (req.session && mockStewards.has(req.session.sub)) return true; res.status(403).json({ code: 'NOT_ON_INITIATIVE' }); return false; } }));
jest.mock('../../lib/work-graph/live.js', () => ({ notifyWorkGraphChanged: jest.fn(async () => undefined) }));
const mockDispatchers = new Set<string>();
const mockInviters = new Set<string>();
jest.mock('../../lib/authz.js', () => ({
  resolveSession: (req: { session?: unknown }) => req.session,
  isAllowed: jest.fn(async () => true),
  requireTenant: (tenant: string) => (req: { session?: { tenant: string; role: string } }, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) =>
    (req.session?.tenant === tenant || req.session?.role === 'admin' ? next() : res.status(403).json({ error: 'Forbidden' })),
  requireAction: (action: string) => (req: { session?: { sub: string } }, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) =>
    ((action === 'InviteMeetingAssistant' ? mockInviters : action === 'DispatchAgentRun' ? mockDispatchers : new Set()).has(req.session?.sub ?? '') ? next() : res.status(403).json({ error: 'Forbidden', action })),
}));
const ledger: Array<Record<string, unknown>> = [];
const mockBell: Array<{ users: string[]; input: { type: string; title: string; action?: { href: string }; payload?: Record<string, unknown> } }> = [];
jest.mock('../../lib/social-notify.js', () => ({ ...jest.requireActual('../../lib/social-notify.js'), notify: async (users: string[], input: never) => { mockBell.push({ users, input }); return users; } }));
jest.mock('../../providers/spend-ledger.js', () => ({ recordSpend: jest.fn(async (e: Record<string, unknown>) => { ledger.push(e); }) }));

import express from 'express';
import request from '../../test-support/http.js';
import { InMemoryCallStateStore } from '@connorhoehn/realtime-modules/call';
import { InMemoryChatStore } from '@connorhoehn/realtime-modules/chat';
import { meetingAssistantRouter, meetingsRouter } from '../meeting-assistant.js';
import { setAssistantRuntime } from '../../lib/meeting-assistant/orchestrator.js';
import { meetingAssistantDevRouter } from '../meeting-assistant-dev.js';
import { errorHandler } from '../../lib/async-handler.js';
import { CallChatRuntime, callChatChannel, setCallChatRuntime } from '../../lib/call-chat.js';
import { MemoryCallChatStateStore } from '../../lib/call-chat-state.js';
import { observeCallPageLifecycle } from '../../lib/call-pages.js';
import { assistantStore, setAssistantStore, setAssistantIntake, LineIntake, MemoryAssistantStore, setTranscriptSource, MockTranscriptSource } from '../../lib/meeting-assistant/index.js';
import { AUTO_ATTEMPTS, MAX_ATTEMPTS, minutesIdle, retryFailedMinutes, setMinutesWriterFactory } from '../../lib/meeting-assistant/minutes-service.js';
import type { MinutesInput } from '../../lib/meeting-assistant/minutes.js';
import { chatSummary, MinutesWriterError, ScriptedMinutesWriter } from '../../lib/meeting-assistant/minutes.js';
import { setMinutesSpend } from '../../lib/meeting-assistant/spend.js';
import { DELETED_RECORD_LINE } from '../../lib/meeting-assistant/chat-types.js';
import { getUser } from '../../providers/identity.js';
import { getProject } from '../../providers/projects.js';
import type { Session } from '../../lib/session.js';
import { newAssistantSession, type Proposal } from '../../lib/meeting-assistant/types.js';

const CALL = 'call-m1'; const LOBBY = 'orgiq:dm:alice:bob:carol';
const mk = (sub: string, over: Partial<Session> = {}): Session => ({ sub, name: sub, tenant: 'orgiq', role: 'member', epoch: 0, grants: { orgiq: ['member'], social: ['participant'] }, iat: 100, ...over });
const NAMES: Record<string, string> = { alice: 'Alice Archer', bob: 'Bob Baker', carol: 'Carol Chen' };
let sessions: Map<string, Session>; let contexts: Map<string, Record<string, unknown>>;
let calls: InMemoryCallStateStore; let chatStore: InMemoryChatStore; let runtime: CallChatRuntime; let source: MockTranscriptSource; let clock: number;
const app = express(); app.use(express.json());
app.use((req, _res, next) => { req.session = sessions.get(String(req.headers['x-user'])); next(); });
app.use(meetingAssistantDevRouter);
app.use('/api/calls/:callId/assistant', meetingAssistantRouter); app.use('/api/meetings', meetingsRouter); app.use(errorHandler);
const ctx = (s: Session) => ({ userId: s.sub, org: s.tenant, role: s.role, displayName: NAMES[s.sub] ?? s.sub, epoch: s.epoch ?? 0, sessionIat: s.iat });
const url = (path: string, call = CALL) => `/api/calls/${call}/assistant/${path}`;
const post = (path: string, user = 'alice') => request(app).post(url(path)).set('x-user', user).send({});
const get = (path: string, user = 'alice') => request(app).get(url(path)).set('x-user', user);
const del = (path: string, user = 'alice') => request(app).delete(url(path)).set('x-user', user);
const meetings = (user: string, q = '') => request(app).get(`/api/meetings${q}`).set('x-user', user);
const inject = (body: object | object[]) => request(app).post(`/api/dev/calls/${CALL}/transcript-lines`).send(body);
const chat = async () => (await chatStore.listMessages(callChatChannel(CALL), 100)).map((m) => ({ text: m.message, kind: (m.metadata as { kind?: string } | undefined)?.kind, meetingCallId: (m.metadata as { meetingCallId?: string } | undefined)?.meetingCallId,
  minutes: (m.metadata as { minutes?: { decisions: number; actionItems: number; proposals: number } } | undefined)?.minutes }));
const minutesNotices = async () => (await chat()).filter((c) => c.kind === 'assistant-notice' && c.minutes);
const proposal = (id: string, over: Partial<Proposal>): Proposal => ({
  id, callId: CALL, tenant: 'orgiq', statement: `Proposal ${id}`, outcome: { kind: 'decision', initiativeId: null }, argsDigest: 'd', named: [], executor: 'alice',
  source: 'dev', evidence: [], state: 'open', responses: [], dismissedBy: null, createdAt: clock, updatedAt: clock, expiresAt: null, run: null, version: 1, ...over,
});

async function holdCall(lobby = LOBBY): Promise<void> {
  const observed = observeCallPageLifecycle(calls, () => null, () => runtime);
  await observed.registerParticipant(CALL, 'a', 'alice', lobby, ['alice', 'bob']);
  await observed.registerParticipant(CALL, 'b', 'bob', lobby, ['alice', 'bob']);
}

beforeEach(async () => {
  clock = Date.parse('2026-11-13T12:00:00.000Z'); ledger.length = 0; mockBell.length = 0;
  mockConfig.meetingAssistant.enabled = true; mockConfig.mock.aurora = true;
  mockInviters.clear(); mockInviters.add('alice'); mockInviters.add('bob');
  mockCreated.length = 0; mockDispatchers.clear(); mockStewards.clear();
  for (const u of ['alice', 'bob', 'carol']) { mockDispatchers.add(u); mockStewards.add(u); }
  const masked = mk('alice', { act: { sub: 'root', epoch: 0 } } as Partial<Session>);
  sessions = new Map([...['alice', 'bob', 'carol', 'dave'].map((u) => [u, mk(u)] as const), ['root', mk('root', { role: 'admin' })], ['masked', masked],
    ['eve', mk('eve', { tenant: 'assessment', role: 'assessor', grants: { assessment: ['assessor'] } })]]);
  contexts = new Map([['a', ctx(mk('alice'))], ['b', ctx(mk('bob'))]]);
  jest.mocked(getUser).mockImplementation(async (id: string) => ({ id, displayName: NAMES[id] ?? id, email: null, personId: null, epoch: 0, grants: mk(id).grants }) as never);
  jest.mocked(getProject).mockImplementation(async (id: string) => (id === 'p-auth' ? { id, name: 'Auth Migration' } : null) as never);
  calls = new InMemoryCallStateStore();
  const router = { sendToClient: jest.fn(), sendToChannel: jest.fn(), isClientLive: (id: string) => contexts.has(id), getClientData: (id: string) => ({ userContext: contexts.get(id) }), unsubscribeFromChannel: jest.fn() };
  runtime = new CallChatRuntime({ calls, state: new MemoryCallChatStateStore(), messages: (chatStore = new InMemoryChatStore()), router: router as never, maintenanceIntervalMs: 0, now: () => clock,
    lobbyAllowed: (_auth, lobby) => lobby.startsWith('orgiq:') });
  setCallChatRuntime(runtime);
  await holdCall();
  setAssistantStore(new MemoryAssistantStore());
  source = new MockTranscriptSource(); setTranscriptSource(source);
  setAssistantIntake(new LineIntake(assistantStore(), { clock: () => clock, tickMs: 0, source: () => source }));
  setMinutesWriterFactory(null); setMinutesSpend(null);
});
afterEach(async () => { await minutesIdle(); setAssistantRuntime(null); setAssistantIntake(null); setAssistantStore(null); setTranscriptSource(null); setMinutesWriterFactory(null); setMinutesSpend(null); runtime.dispose(); setCallChatRuntime(null); });

const talk = async () => {
  await post('invite'); await post('ack', 'bob');
  await inject([
    { userId: 'alice', text: 'Thanks for joining. We decided to cut over on Thursday.' },
    { userId: 'bob', text: 'Bob Baker will rehearse the rollback.' },
    { userId: 'alice', text: 'Action item: update the runbook.' },
  ]);
};
const finish = async () => { await post('dismiss', 'bob'); await minutesIdle(); };

const lines = async () => (await get('transcript?limit=500')).body.lines as Array<{ seq: number; userId: string; text: string }>;
const minutes = async (user = 'alice') => (await get('minutes', user)).body;
const cards = async () => (await chatStore.listMessages(callChatChannel(CALL), 200)).filter((m) => (m.metadata as { kind?: string } | undefined)?.kind === 'assistant-action')
  .map((m) => (m.metadata as { summary: string; askedBy: string }));
const backAndTalk = async (said: Array<{ userId: string; text: string }>, by = 'bob') => {
  expect((await post('invite', by)).status).toBe(200);
  await post('ack', 'alice');
  if (said.length) await inject(said);
};

describe('adding to the minutes after Nova was invited back', () => {
  it('adds the later period after the earlier one: indices, work items and done marks stay, repeats are dropped, the chat and the bell say it once, cards only for new items', async () => {
    await talk(); await finish();
    const first = await minutes();
    expect(first.actionItems.map((i: { text: string }) => i.text)).toEqual(['rehearse the rollback', 'update the runbook']);
    // A work item made from the meeting page for the earlier, unowned item (recorded the way that route records it).
    expect(await assistantStore().setActionItemWorkItem(CALL, 1, 'wi-1')).toBe(true);
    const cardsBefore = (await cards()).length;
    expect(mockBell).toHaveLength(1);

    clock += 60_000;
    expect((await post('invite', 'bob')).body).toMatchObject({ state: 'listening', invitedBy: 'bob', mustAck: ['alice'] });
    // Alice owes a new acknowledgement: what she says before giving it is not stored.
    await inject({ userId: 'alice', text: 'This is before I acknowledged again.' });
    expect((await lines()).some((l) => l.text.startsWith('This is before'))).toBe(false);
    // The meeting page says Nova is back and that what it hears is added.
    expect(await minutes()).toMatchObject({ backInCall: true, additions: 0 });
    await post('ack', 'alice');
    await inject([
      { userId: 'alice', text: 'Thanks for joining. We decided to cut over on Thursday.' },     // the same decision again
      { userId: 'bob', text: 'We decided to keep the feature flag on until Monday.' },
      { userId: 'alice', text: 'Alice Archer will write the release note.' },
    ]);
    clock += 60_000; await post('dismiss', 'alice'); await minutesIdle();

    const m = await minutes();
    expect(m.actionItems.map((i: { text: string }) => i.text)).toEqual(['rehearse the rollback', 'update the runbook', 'write the release note']);
    expect(m.actionItems[1]).toMatchObject({ workItemCreated: true });
    expect((await assistantStore().getMinutes(CALL))!.actionItems[1]!.workItemId).toBe('wi-1');
    expect(m.decisions).toEqual(['Thanks for joining. We decided to cut over on Thursday.', 'We decided to keep the feature flag on until Monday.']);
    expect(m).toMatchObject({ lineCount: 6, additions: 1, backInCall: false, additionOwed: false, youAreInviter: true });
    expect(m.summaryLead).toMatch(/^Two people met for under a minute\. After Nova was invited back, two people met for under a minute more\.$/);
    expect((await minutes('bob')).youAreInviter).toBe(true);
    // One more minutes card in the chat, marked as an addition, counting the whole minutes.
    const notices = await minutesNotices();
    expect(notices).toHaveLength(2);
    expect(notices[1]!.minutes).toEqual({ decisions: 2, actionItems: 3, proposals: 0, added: true });
    // The bell rings once more, saying the minutes changed.
    expect(mockBell.map((b) => b.input.title)).toEqual([expect.stringMatching(/ are ready$/), expect.stringMatching(/^Minutes from .* were updated$/)]);
    // A card only for the new item (alice's, she is still in the call); the earlier ones are not offered again.
    const after = await cards();
    expect(after.slice(cardsBefore).map((c) => [c.askedBy, c.summary])).toEqual([['alice', 'Create a work item: write the release note']]);
    // The cost of the addition is booked to the person who invited Nova back.
    expect(ledger.filter((e) => e['sourceId'] === `ma:${CALL}:minutes`).map((e) => e['actorId'])).toEqual(['alice', 'bob']);
    // A second report of the same leave (the call ending) changes nothing.
    await runtime.finish(CALL); await minutesIdle();
    expect(await minutesNotices()).toHaveLength(2);
    expect(mockBell).toHaveLength(2);
  });

  it('a done mark from the first period survives the addition, and the earlier done write is not listed again', async () => {
    await talk();
    await assistantStore().createTurn({ turnId: 't-done', callId: CALL, askedBy: 'alice', tool: { name: 'create', args: { kind: 'work-item', fields: { title: 'Draft the plan' } } },
      kind: 'write', status: 'done', createdAt: clock, expiresAt: clock + 60_000 });
    await finish();
    clock += 1000;
    await backAndTalk([{ userId: 'bob', text: 'Action item: book the room.' }]);
    clock += 1000; await post('dismiss', 'bob'); await minutesIdle();
    const m = (await assistantStore().getMinutes(CALL))!;
    expect(m.actionItems.map((i) => [i.text, i.done === true])).toEqual([
      ['rehearse the rollback', false], ['update the runbook', false], ['Created work item: Draft the plan', true], ['book the room', false]]);
  });

  it('nothing new heard: the minutes stay exactly as they were, and no bell or chat card follows', async () => {
    await talk(); await finish();
    const before = (await assistantStore().getMinutes(CALL))!;
    await backAndTalk([]);
    clock += 5000; await post('dismiss', 'bob'); await minutesIdle();
    const after = (await assistantStore().getMinutes(CALL))!;
    expect({ ...after, endedAt: before.endedAt }).toEqual(before);
    expect(after.endedAt).toBeGreaterThan(before.endedAt);
    expect(mockBell).toHaveLength(1);
    expect(await minutesNotices()).toHaveLength(1);
  });

  it('a failed addition keeps the minutes, says so, and is retried by the sweep (3 runs) and by an attendee (up to 5), counted apart from the first write', async () => {
    await talk(); await finish();
    let failing = true; let runs = 0;
    setMinutesWriterFactory(() => ({ kind: 'openai', write: async (input: MinutesInput) => { if (input.earlier) { runs += 1; if (failing) throw new MinutesWriterError('provider answered 500'); } return new ScriptedMinutesWriter().write(input); } }));
    setMinutesSpend({ reserve: async () => ({ ok: true, holdId: 'h1' }), release: async () => undefined, record: async () => undefined });
    const before = (await assistantStore().getMinutes(CALL))!;
    await backAndTalk([{ userId: 'bob', text: 'Action item: book the room.' }]);
    clock += 1000; await post('dismiss', 'bob'); await minutesIdle();
    expect(runs).toBe(1);
    const owed = await minutes();
    expect(owed).toMatchObject({ additionOwed: true, additions: 0, summary: before.summary, rewrite: { possible: true, attemptsLeft: MAX_ATTEMPTS - 1 } });
    expect(owed.actionItems).toHaveLength(2);
    expect((await chat()).some((c) => /could not add what it heard after it was invited back/.test(c.text))).toBe(true);
    for (let i = 0; i < 4; i += 1) await retryFailedMinutes();
    expect(runs).toBe(AUTO_ATTEMPTS);
    expect((await post('minutes/rewrite', 'alice')).status).toBe(202); await minutesIdle();
    expect((await post('minutes/rewrite', 'alice')).status).toBe(202); await minutesIdle();
    expect(runs).toBe(MAX_ATTEMPTS);
    expect((await post('minutes/rewrite', 'alice')).status).toBe(429);
    expect((await assistantStore().getMinutes(CALL))!.attempts).toBe(1);   // the first write's count is untouched
    expect(mockBell).toHaveLength(1);
  });

  it('a retried addition that succeeds adds the period once and rings the bell once', async () => {
    await talk(); await finish();
    let failing = true;
    setMinutesWriterFactory(() => ({ kind: 'openai', write: async (input: MinutesInput) => { if (input.earlier && failing) throw new MinutesWriterError('provider answered 500'); return new ScriptedMinutesWriter().write(input); } }));
    setMinutesSpend({ reserve: async () => ({ ok: true, holdId: 'h1' }), release: async () => undefined, record: async () => undefined });
    await backAndTalk([{ userId: 'bob', text: 'Action item: book the room.' }]);
    clock += 1000; await post('dismiss', 'bob'); await minutesIdle();
    failing = false;
    expect(await retryFailedMinutes()).toBe(1);
    expect(await retryFailedMinutes()).toBe(0);
    const m = await minutes();
    expect(m).toMatchObject({ additionOwed: false, additions: 1 });
    expect(m.actionItems.map((i: { text: string }) => i.text)).toEqual(['rehearse the rollback', 'update the runbook', 'book the room']);
    expect(mockBell.map((b) => b.input.title)).toEqual([expect.stringMatching(/are ready$/), expect.stringMatching(/were updated$/)]);
  });

  it('a budget that refuses the addition keeps the minutes and owes it', async () => {
    await talk(); await finish();
    setMinutesWriterFactory(() => ({ kind: 'openai', write: (input: MinutesInput) => new ScriptedMinutesWriter().write(input) }));
    setMinutesSpend({ reserve: async () => ({ ok: false, refusal: { status: 402, body: {} } }), release: async () => undefined, record: async () => undefined });
    await backAndTalk([{ userId: 'bob', text: 'Action item: book the room.' }]);
    clock += 1000; await post('dismiss', 'bob'); await minutesIdle();
    expect(await minutes()).toMatchObject({ additionOwed: true, additions: 0 });
  });

  it('a leave while the first write still runs waits for it: the first write covers the first period and the addition the second', async () => {
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    setMinutesWriterFactory(() => ({ kind: 'scripted', write: async (input: MinutesInput) => { if (!input.earlier) await gate; return new ScriptedMinutesWriter().write(input); } }));
    await talk(); await post('dismiss', 'bob');
    for (let i = 0; i < 5; i += 1) await new Promise<void>((r) => setImmediate(r));
    expect((await get('minutes')).body.code).toBe('MINUTES_WRITING');
    await backAndTalk([{ userId: 'bob', text: 'Action item: book the room.' }]);
    clock += 1000; await post('dismiss', 'alice');
    release(); await minutesIdle();
    const m = await minutes();
    expect(m.actionItems.map((i: { text: string }) => i.text)).toEqual(['rehearse the rollback', 'update the runbook', 'book the room']);
    expect(m).toMatchObject({ lineCount: 4, additions: 1 });
    expect(await minutesNotices()).toHaveLength(2);
  });

  it('nothing heard in the first period: the later leave writes the first minutes over the whole call', async () => {
    await post('invite'); await post('dismiss', 'bob'); await minutesIdle();
    expect((await get('minutes')).status).toBe(404);
    await backAndTalk([{ userId: 'bob', text: 'Action item: book the room.' }]);
    clock += 1000; await post('dismiss', 'alice'); await minutesIdle();
    const m = await minutes();
    expect(m).toMatchObject({ lineCount: 1, additions: 0 });
    expect(m.actionItems.map((i: { text: string }) => i.text)).toEqual(['book the room']);
  });

  it('first minutes that failed are written again over the whole call when Nova leaves again', async () => {
    let failing = true;
    setMinutesWriterFactory(() => ({ kind: 'openai', write: async (input: MinutesInput) => { if (failing) throw new MinutesWriterError('provider answered 500'); return new ScriptedMinutesWriter().write(input); } }));
    setMinutesSpend({ reserve: async () => ({ ok: true, holdId: 'h1' }), release: async () => undefined, record: async () => undefined });
    await talk(); await finish();
    expect((await minutes()).writer).toBe('none');
    failing = false;
    await backAndTalk([{ userId: 'bob', text: 'Action item: book the room.' }]);
    clock += 1000; await post('dismiss', 'alice'); await minutesIdle();
    const m = await minutes();
    expect(m).toMatchObject({ writer: 'openai', lineCount: 4 });
    expect(m.actionItems.map((i: { text: string }) => i.text)).toEqual(['rehearse the rollback', 'update the runbook', 'book the room']);
  });

});

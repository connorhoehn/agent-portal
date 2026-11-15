// The minutes (package 5): written once when the assistant leaves, read only by the people who were there, deleted only by the
// inviter, listed per person. Same harness as meeting-assistant.test.ts (real seats, in-memory stores, the scripted session).
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
import { minutesIdle, setMinutesWriterFactory } from '../../lib/meeting-assistant/minutes-service.js';
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

describe('writing the minutes', () => {
  it('a dismissal writes the minutes once and Nova leaves one message with the summary, the counts and the page link', async () => {
    await talk(); await finish();
    const m = (await get('minutes')).body;
    expect(m).toMatchObject({ callId: CALL, callName: expect.stringMatching(/^Call with Alice and Bob, \d{1,2} [A-Z][a-z]{2}$/), writer: 'scripted', lineCount: 3, youAreInviter: true });
    expect(m.decisions).toEqual(['Thanks for joining. We decided to cut over on Thursday.'].map((d) => d));
    expect(m.actionItems).toEqual(expect.arrayContaining([{ text: 'rehearse the rollback', ownerUserId: 'bob', ownerName: 'Bob Baker' }, { text: 'update the runbook' }]));
    const leaving = await minutesNotices();
    expect(leaving).toHaveLength(1);
    // The text is the summary's first sentences; the counts ride on the message for the chat's minutes card.
    expect(leaving[0]!.text).toBe(chatSummary(m.summary));
    expect(leaving[0]!.minutes).toEqual({ decisions: 1, actionItems: 2, proposals: 0 });
    // The page is a metadata field the portal links from, never a path in the text.
    expect(leaving[0]!.text).not.toContain('/iq/meetings');
    expect(leaving[0]!.meetingCallId).toBe(CALL);
    // A second finish (the call ending after the dismissal) writes nothing more.
    await runtime.finish(CALL); await minutesIdle();
    expect(await minutesNotices()).toHaveLength(1);
    expect(ledger.filter((e) => e['sourceId'] === `ma:${CALL}:minutes`)).toHaveLength(1);
    expect(ledger.find((e) => e['sourceId'] === `ma:${CALL}:minutes`)).toMatchObject({ source: 'meeting_assistant', actorId: 'alice', initiativeId: null, costBasis: 'estimated' });
  });

  it('the decisions count includes the decisions people consented to through the call\'s proposals, and the proposals are counted', async () => {
    await talk();
    const store = assistantStore();
    await store.createProposal(proposal('p-done', { statement: 'Ship the dashboard on Friday.', state: 'done' }));
    await store.createProposal(proposal('p-consented', { statement: 'Freeze the schema until March.', state: 'consented' }));
    await store.createProposal(proposal('p-objected', { statement: 'Drop the legacy importer.', state: 'objected' }));
    await store.createProposal(proposal('p-open', { statement: 'Move standup to ten.', state: 'open' }));
    await store.createProposal(proposal('p-tool', { statement: 'Create the audit work item.', state: 'done', outcome: { kind: 'tool', name: 'create', args: {} } }));
    await finish();
    const m = (await get('minutes')).body;
    // The minutes' own decision line stays one; the two consented decision proposals are added to it, nothing else is.
    expect(m.decisions).toHaveLength(1);
    expect((await minutesNotices())[0]!.minutes).toEqual({ decisions: 3, actionItems: 2, proposals: 5 });
  });

  it('a summary longer than the chat allows ends at a whole word with an ellipsis', () => {
    const long = `${'Vera Green said the migration plan holds and the rollback rehearsal is booked '.repeat(8)}.`;
    const head = chatSummary(long, 120);
    expect(head.length).toBeLessThanOrEqual(121);
    expect(head.endsWith('…')).toBe(true);
    expect(long).toContain(head.slice(0, -1));
    expect(long.charAt(head.length - 1)).toBe(' ');
    expect(chatSummary('One. Two. Three. Four.')).toBe('One. Two. Three.');
  });

  it('an action item whose owner is still in the call is offered to that owner as a "Create a work item" card they alone can decide', async () => {
    await talk(); await finish();
    const cards = (await chatStore.listMessages(callChatChannel(CALL), 100)).filter((m) => (m.metadata as { kind?: string } | undefined)?.kind === 'assistant-action');
    expect(cards).toHaveLength(1);
    const meta = cards[0]!.metadata as { summary: string; askedBy: string; actionId: string; tool: { name: string } };
    expect(meta).toMatchObject({ summary: 'Create a work item: rehearse the rollback', askedBy: 'bob', tool: { name: 'create' } });
    const turns = await assistantStore().listTurns(CALL, { askedBy: 'bob' });
    expect(turns[0]).toMatchObject({ kind: 'write', status: 'pending', tool: { name: 'create', args: { kind: 'work-item', fields: expect.objectContaining({ title: 'rehearse the rollback', initiative: null, type: null }) } } });
    // The card is decided after the assistant left: only by its owner.
    const decide = (user: string) => request(app).post(url(`actions/${meta.actionId}/decision`)).set('x-user', user).send({ decision: 'confirm' });
    expect((await decide('alice')).status).toBe(403);
    expect((await decide('bob')).status).toBe(200);
    expect((await get('turns?mine=1', 'bob')).body.turns).toHaveLength(1);
  });

  it('when the call has ended no cards are offered and the items are only on the page', async () => {
    await talk();
    const store = assistantStore();
    await runtime.finish(CALL); await minutesIdle();
    expect((await store.get(CALL))!.state).toBe('left');
    const m = await store.getMinutes(CALL);
    expect(m!.actionItems.length).toBe(2);
    expect((await chatStore.listMessages(callChatChannel(CALL), 100)).filter((x) => (x.metadata as { kind?: string } | undefined)?.kind === 'assistant-action')).toHaveLength(0);
  });

  it('no lines stored: no minutes, and the leave notice says nothing was recorded', async () => {
    await post('invite'); await post('dismiss', 'bob'); await minutesIdle();
    expect((await get('minutes')).status).toBe(404);
    expect((await chat()).some((c) => c.text.includes('Nothing was recorded'))).toBe(true);
    expect(await assistantStore().getMinutes(CALL)).toBeNull();
  });

  it('a writer that fails leaves a transcript-only record with a plain note', async () => {
    setMinutesWriterFactory(() => ({ kind: 'openai', write: async () => { throw new MinutesWriterError('provider answered 500'); } }));
    const released: string[][] = [];
    setMinutesSpend({ reserve: async () => ({ ok: true, holdId: 'h1' }), release: async (ids) => { released.push([...ids]); }, record: async () => undefined });
    await talk(); await finish();
    const m = (await get('minutes')).body;
    expect(m).toMatchObject({ writer: 'none', decisions: [], actionItems: [] });
    expect(m.summary).toMatch(/Nova could not write the minutes/);
    expect(m.rewrite).toEqual({ writing: false, possible: true, attemptsLeft: 4 });
    expect(released).toEqual([['h1']]);
    expect((await get('transcript')).body.lines).toHaveLength(3);
  });

  const failAfterSend = async (usage?: { inputTokens: number; outputTokens: number; cachedTokens: number }) => {
    setMinutesWriterFactory(() => ({ kind: 'openai', write: async () => { throw new MinutesWriterError('the minutes were not valid JSON', { requestSent: true, ...(usage ? { usage } : {}) }); } }));
    const released: string[][] = []; const booked: Array<Record<string, unknown>> = [];
    setMinutesSpend({ reserve: async () => ({ ok: true, holdId: 'h1' }), release: async (ids) => { released.push([...ids]); }, record: async (i) => { booked.push(i as unknown as Record<string, unknown>); } });
    await talk(); await finish();
    return { released, booked };
  };
  it('a failure after the request went out books the usage the provider reported, and releases the hold', async () => {
    const { released, booked } = await failAfterSend({ inputTokens: 1200, outputTokens: 300, cachedTokens: 0 });
    expect(booked).toHaveLength(1);
    expect(booked[0]).toMatchObject({ basis: 'reported', tokensIn: 1200, tokensOut: 300 });
    expect(released).toEqual([['h1']]);
  });

  it('a failure after the request went out with no usage reported books an estimate', async () => {
    const { released, booked } = await failAfterSend();
    expect(booked).toHaveLength(1);
    expect(booked[0]).toMatchObject({ basis: 'estimated' });
    expect(released).toEqual([['h1']]);
  });

  it('a failure before any request was sent releases the hold and books nothing', async () => {
    setMinutesWriterFactory(() => ({ kind: 'openai', write: async () => { throw new MinutesWriterError('no delegation model is configured'); } }));
    const released: string[][] = []; const booked: unknown[] = [];
    setMinutesSpend({ reserve: async () => ({ ok: true, holdId: 'h1' }), release: async (ids) => { released.push([...ids]); }, record: async (i) => { booked.push(i); } });
    await talk(); await finish();
    expect(booked).toEqual([]);
    expect(released).toEqual([['h1']]);
  });

  it('a refused spend hold means no model minutes, a plain note, and no model request', async () => {
    const write = jest.fn();
    setMinutesWriterFactory(() => ({ kind: 'openai', write }));
    setMinutesSpend({ reserve: async () => ({ ok: false, refusal: { status: 402, body: {} } }), release: async () => undefined, record: async () => undefined });
    await talk(); await finish();
    expect(write).not.toHaveBeenCalled();
    expect((await get('minutes')).body).toMatchObject({ writer: 'none', summary: expect.stringMatching(/budget/) });
  });
});

describe('who can read them', () => {
  beforeEach(async () => { await talk(); await finish(); });

  it('attendees read the minutes and the transcript; a same-tenant non-attendee, an admin, another tenant and a stranger get 404 on both', async () => {
    for (const user of ['alice', 'bob']) { expect((await get('minutes', user)).status).toBe(200); expect((await get('transcript', user)).status).toBe(200); }
    for (const user of ['carol', 'dave', 'root']) {
      for (const path of ['minutes', 'transcript']) {
        const r = await get(path, user);
        expect(r.status).toBe(404);
        expect(JSON.stringify(r.body)).not.toMatch(/cut over|rollback|runbook/);
      }
    }
    expect((await get('minutes', 'eve')).status).toBeGreaterThanOrEqual(403);
    expect((await get('minutes', 'nobody')).status).toBeGreaterThanOrEqual(401);
  });

  it('a masquerade cannot read them', async () => {
    expect((await get('minutes', 'masked')).body.code).toBe('MASQUERADING');
    expect((await meetings('masked')).body.code).toBe('MASQUERADING');
    expect((await del('minutes', 'masked')).body.code).toBe('MASQUERADING');
  });

  it('with the flag off every one of them is 404', async () => {
    mockConfig.meetingAssistant.enabled = false;
    expect((await get('minutes')).status).toBe(404);
    expect((await meetings('alice')).status).toBe(404);
    expect((await del('minutes')).status).toBe(404);
  });

  it('the list holds only the caller\'s own meetings, newest first, with names and counts, and pages by `before`', async () => {
    const mine = (await meetings('alice')).body;
    expect(mine.meetings).toHaveLength(1);
    expect(mine.meetings[0]).toMatchObject({ callId: CALL, callName: expect.stringMatching(/^Call with Alice and Bob, /), waitingOnYou: 0, initiativeId: null, lobby: LOBBY, attendees: ['Alice Archer', 'Bob Baker'], decisionCount: 1, actionItemCount: 2 });
    expect(mine.meetings[0].summary).toContain('Alice Archer said');
    for (const user of ['carol', 'dave', 'root']) expect((await meetings(user)).body.meetings).toEqual([]);
    expect((await meetings('alice', '?initiative=p-other')).body.meetings).toEqual([]);
    expect((await meetings('alice', `?before=${mine.meetings[0].endedAt}`)).body.meetings).toEqual([]);
    for (const q of ['?limit=0', '?limit=101', '?before=x', '?initiative=a%20b']) expect((await meetings('alice', q)).status).toBe(400);
  });
});

describe('deleting', () => {
  beforeEach(async () => { await talk(); await finish(); });

  it('only the inviter deletes: another attendee is refused, everyone else gets 404', async () => {
    expect((await del('minutes', 'bob')).status).toBe(403);
    for (const user of ['carol', 'root']) expect((await del('minutes', user)).status).toBe(404);
    expect((await get('minutes', 'alice')).status).toBe(200);
  });

  it('the inviter deletes minutes and transcript together; the people who were there are told it was deleted, everyone else gets 404, and nothing is written again', async () => {
    const out = await del('minutes', 'alice');
    expect(out.body).toMatchObject({ deleted: true, linesRemoved: 3 });
    for (const user of ['alice', 'bob']) {
      expect(await get('minutes', user)).toMatchObject({ status: 410, body: { code: 'MEETING_DELETED' } });
      expect((await get('transcript', user)).status).toBe(404);
    }
    for (const user of ['carol', 'dave', 'root']) expect((await get('minutes', user)).status).toBe(404);
    expect((await meetings('alice')).body.meetings).toEqual([]);
    expect(await assistantStore().lines(CALL, 0, 10)).toEqual([]);
    const tomb = await assistantStore().getMinutes(CALL);
    expect(tomb).toMatchObject({ deleted: { by: 'alice' }, summary: '', attendees: [], decisions: [] });
    await runtime.finish(CALL); await minutesIdle();
    expect((await assistantStore().getMinutes(CALL))!.deleted).toBeTruthy();
    for (const user of ['bob', 'carol', 'root']) expect((await del('minutes', user)).status).toBe(404);
  });

  it('a delete whose chat step failed can be repeated by the inviter, and blanks the messages the second time', async () => {
    const novaText = async () => (await chatStore.listMessages(callChatChannel(CALL), 100)).filter((m) => m.userId === 'agent:nova').map((m) => m.message);
    const before = await novaText();
    expect(before.length).toBeGreaterThan(0);
    const spy = jest.spyOn(chatStore, 'listMessages').mockRejectedValueOnce(new Error('chat unavailable'));
    expect((await del('minutes', 'alice')).status).toBe(500);
    spy.mockRestore();
    expect(await novaText()).toEqual(before);
    expect((await del('minutes', 'alice')).status).toBe(200);
    for (const text of await novaText()) expect(text).toBe(DELETED_RECORD_LINE);
    expect(await novaText()).not.toEqual(before);
    expect((await del('minutes', 'carol')).status).toBe(404);
  });

  it('DELETE transcript is the same delete', async () => {
    expect((await del('transcript', 'alice')).status).toBe(200);
    expect((await get('minutes', 'alice')).status).toBe(410);
  });

  it('a record whose assistant has not left cannot be deleted yet', async () => {
    await assistantStore().create({ callId: 'call-live', tenant: 'orgiq', lobby: LOBBY, initiativeId: 'p-auth', state: 'listening', invitedBy: 'alice', invitedAt: 1, pausedBy: null, leftAt: null, leftBy: null,
      acked: ['alice'], attendees: ['alice'], presentAtInvite: ['alice'], requests: 0, linesStored: 0, nextSeq: 1, pendingRequests: [] });
    expect((await request(app).delete(url('minutes', 'call-live')).set('x-user', 'alice')).status).toBe(409);
  });
});

describe('a call on an initiative page', () => {
  it('names the minutes for the initiative, books the minutes against it, and filters the list by it', async () => {
    const store = assistantStore();
    await store.create({ callId: 'call-init', tenant: 'orgiq', lobby: 'orgiq:initiative:p-auth', initiativeId: 'p-auth', state: 'listening', invitedBy: 'alice', invitedAt: clock - 60_000, pausedBy: null, leftAt: null,
      leftBy: null, acked: ['alice'], attendees: ['alice'], presentAtInvite: ['alice'], requests: 0, linesStored: 0, nextSeq: 1, pendingRequests: [] });
    await store.appendLine({ callId: 'call-init', userId: 'alice', participantId: 'p', speakerName: 'Alice Archer', text: 'We agreed to ship on Friday.', at: clock - 1000, captionId: 'c1' });
    await store.transition('call-init', { from: ['listening'], to: 'left', by: 'alice', at: clock });
    const { writeMinutes } = await import('../../lib/meeting-assistant/minutes-service.js');
    expect((await writeMinutes('call-init'))).toMatchObject({ callName: 'Auth Migration call', initiativeId: 'p-auth', decisions: ['We agreed to ship on Friday.'] });
    expect(ledger.find((e) => e['sourceId'] === 'ma:call-init:minutes')).toMatchObject({ initiativeId: 'p-auth', actorId: 'alice', source: 'meeting_assistant' });
    expect((await meetings('alice', '?initiative=p-auth')).body.meetings.map((m: { callId: string }) => m.callId)).toEqual(['call-init']);
    expect((await meetings('alice', '?initiative=p-other')).body.meetings).toEqual([]);
  });
});

describe('the scripted writer is the mock world default', () => {
  it('uses the scripted rules without any provider', async () => {
    setMinutesWriterFactory(() => new ScriptedMinutesWriter());
    await talk(); await finish();
    expect((await get('minutes')).body.writer).toBe('scripted');
  });
});

describe('the bell when the minutes are written', () => {
  it('each attendee gets one notification with the call name and the meeting page, and no content of the meeting', async () => {
    await talk(); await finish();
    expect(mockBell).toHaveLength(1);
    const [bell] = mockBell;
    expect(bell!.users.sort()).toEqual(['alice', 'bob']);
    expect(bell!.input).toMatchObject({ type: 'meeting-minutes-ready', title: expect.stringMatching(/^Minutes from Call with Alice and Bob, .+ are ready$/), action: { href: `/iq/meetings/${CALL}` }, payload: { tenant: 'orgiq', callId: CALL } });
    expect(JSON.stringify(bell!.input)).not.toMatch(/cut over|rollback|runbook/);
    // A second finish, and a fresh process reading the same store (the mark is stored), ring nothing more.
    await runtime.finish(CALL); await minutesIdle();
    const { notifyMinutesReady } = await import('../../lib/meeting-assistant/minutes-service.js');
    expect(await notifyMinutesReady((await assistantStore().getMinutes(CALL))!)).toEqual([]);
    expect(mockBell).toHaveLength(1);
  });

  it('a failed write rings nothing', async () => {
    setMinutesWriterFactory(() => ({ kind: 'openai', write: async () => { throw new MinutesWriterError('provider answered 500'); } }));
    setMinutesSpend({ reserve: async () => ({ ok: true, holdId: 'h1' }), release: async () => undefined, record: async () => undefined });
    await talk(); await finish();
    expect(mockBell).toEqual([]);
  });
});

describe('writing failed minutes again', () => {
  let runs: number; let failing: boolean;
  beforeEach(async () => {
    runs = 0; failing = true;
    setMinutesWriterFactory(() => ({ kind: 'openai', write: async (input) => { runs += 1; if (failing) throw new MinutesWriterError('provider answered 500'); return new ScriptedMinutesWriter().write(input); } }));
    setMinutesSpend({ reserve: async () => ({ ok: true, holdId: 'h1' }), release: async () => undefined, record: async () => undefined });
    await talk(); await finish();
  });
  const rewrite = (user = 'alice') => request(app).post(url('minutes/rewrite')).set('x-user', user).send({});

  it('the sweep tries again until three runs were made in all, then stops', async () => {
    const { retryFailedMinutes } = await import('../../lib/meeting-assistant/minutes-service.js');
    expect(runs).toBe(1);
    expect(await retryFailedMinutes()).toBe(1);
    expect(await retryFailedMinutes()).toBe(1);
    expect(await retryFailedMinutes()).toBe(0);
    expect(runs).toBe(3);
    expect((await assistantStore().getMinutes(CALL))!.attempts).toBe(3);
  });

  it('an attendee may press it until five runs were made in all; then it is refused with a plain sentence', async () => {
    for (let i = 0; i < 4; i += 1) { expect((await rewrite(i % 2 ? 'bob' : 'alice')).status).toBe(202); await minutesIdle(); }
    expect(runs).toBe(5);
    const refused = await rewrite();
    expect(refused).toMatchObject({ status: 429, body: { code: 'MINUTES_ATTEMPTS' } });
    expect(refused.body.error).toMatch(/^Nova has tried to write these minutes 5 times/);
    expect(runs).toBe(5);
    expect((await get('minutes')).body.rewrite).toEqual({ writing: false, possible: true, attemptsLeft: 0 });
  });

  it('one run at a time: a second press while one runs is refused and starts nothing', async () => {
    let release!: () => void;
    setMinutesWriterFactory(() => ({ kind: 'openai', write: async () => { runs += 1; await new Promise<void>((r) => { release = r; }); throw new MinutesWriterError('provider answered 500'); } }));
    expect((await rewrite()).status).toBe(202);
    expect(await rewrite('bob')).toMatchObject({ status: 409, body: { code: 'MINUTES_WRITING' } });
    expect((await get('minutes')).body.rewrite.writing).toBe(true);
    await new Promise((r) => setImmediate(r)); release(); await minutesIdle();
    expect(runs).toBe(2);
  });

  it('a run that succeeds replaces the note with the minutes, rings the bell once, and cannot be pressed again', async () => {
    failing = false;
    expect((await rewrite('bob')).status).toBe(202); await minutesIdle();
    const m = (await get('minutes')).body;
    expect(m).toMatchObject({ writer: 'openai', decisions: ['Thanks for joining. We decided to cut over on Thursday.'], rewrite: { possible: false } });
    expect(mockBell).toHaveLength(1);
    expect(await rewrite()).toMatchObject({ status: 409, body: { code: 'MINUTES_WRITTEN' } });
  });

  it('only the people who were there may press it, and not after a delete', async () => {
    for (const user of ['carol', 'root']) expect((await rewrite(user)).status).toBe(404);
    await del('minutes', 'alice');
    expect((await rewrite()).status).toBe(404);
    expect(runs).toBe(1);
  });
});

describe('what the meeting page is told', () => {
  it('when the record goes, and what Nova covered: its listening time, the rest, and how many were not transcribed (a count, no names)', async () => {
    const store = assistantStore();
    // Fifteen minutes from the invite to Nova leaving, ten of them listening; Carol held a seat and never acknowledged.
    await store.create({ callId: 'call-cov', tenant: 'orgiq', lobby: LOBBY, initiativeId: null, state: 'listening', invitedBy: 'alice', invitedAt: clock - 15 * 60_000, pausedBy: null, leftAt: null,
      leftBy: null, acked: ['alice', 'bob'], attendees: ['alice', 'bob', 'carol'], presentAtInvite: ['alice', 'bob', 'carol'], requests: 0, linesStored: 0, nextSeq: 1, pendingRequests: [],
      session: { ...newAssistantSession(3600), listeningSeconds: 600 } });
    await store.appendLine({ callId: 'call-cov', userId: 'alice', participantId: 'p', speakerName: 'Alice Archer', text: 'We agreed to ship on Friday.', at: clock - 1000, captionId: 'c1' });
    await store.transition('call-cov', { from: ['listening'], to: 'left', by: 'alice', at: clock });
    const { writeMinutes } = await import('../../lib/meeting-assistant/minutes-service.js');
    await writeMinutes('call-cov');
    const m = (await request(app).get(url('minutes', 'call-cov')).set('x-user', 'bob')).body;
    expect(m.keptUntil).toBe(clock + 30 * 86_400_000);
    expect(m.coverage).toEqual({ listenedSeconds: 600, pausedSeconds: 300, untranscribed: 1 });
    expect(JSON.stringify(m.coverage)).not.toMatch(/carol/i);
  });

  it('a record the retention sweep emptied tells the people who were there it was removed; others get 404', async () => {
    await talk(); await finish();
    await assistantStore().tombstoneMinutes(CALL, 'system', Date.now());
    expect(await get('minutes', 'bob')).toMatchObject({ status: 410, body: { code: 'MEETING_EXPIRED' } });
    expect((await get('minutes', 'carol')).status).toBe(404);
  });

  it('a Meetings row counts the proposals that wait on the viewer, for that viewer only', async () => {
    await talk();
    await assistantStore().createProposal(proposal('p-open', { named: ['bob'], executor: 'alice', responses: [{ userId: 'alice', response: 'consent', reason: null, at: clock } as never] }));
    await finish();
    const row = async (user: string) => (await meetings(user)).body.meetings[0];
    expect((await row('bob')).waitingOnYou).toBe(1);
    expect((await row('alice')).waitingOnYou).toBe(0);
  });
});

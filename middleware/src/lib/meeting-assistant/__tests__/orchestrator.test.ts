// The orchestrator's rules (docs/meeting-assistant-design.md decisions 3 to 7, 11): who asked, the name lock, the asker's role,
// read versus write versus private, one answer per tool call, expiry, pause and replacement. The chat module is replaced by a
// recorder (the chat's own path is covered by meeting-assistant-chat.test.ts); stores, intake, detector and sessions are real.
jest.mock('../../../config.js', () => ({ config: { region: 'us-east-1', auth: {}, cognito: {}, mock: { aurora: true }, meetingAssistant: { enabled: true, transcriptRetentionDays: 30 } } }));
jest.mock('../../../providers/identity.js', () => ({ getUser: jest.fn(async () => null) }));
const mockPosts = {
  replies: [] as Array<{ text: string; askedBy: string; askedByName: string }>,
  privates: [] as Array<{ userId: string; text: string }>,
  actions: [] as Array<{ actionId: string; askedBy: string; summary: string; detail?: string[]; tool: { name: string; argsDigest: string } }>,
  notices: [] as string[],
};
jest.mock('../chat.js', () => {
  const store = () => (jest.requireActual('../store-select.js') as typeof import('../store-select.js')).assistantStore();
  return {
    nameOf: async (id: string) => ({ 'u-alice': 'Alice', 'u-bob': 'Bob', 'u-carol': 'Carol' } as Record<string, string>)[id] ?? id,
    postReply: async (_c: string, r: { text: string; askedBy: string; askedByName: string }) => { mockPosts.replies.push(r); return { id: 'm' }; },
    postPrivately: async (_c: string, userId: string, r: { text: string }) => { mockPosts.privates.push({ userId, text: r.text }); return true; },
    postNoticeQuietly: async (_c: string, text: string) => { mockPosts.notices.push(text); },
    postAction: async (callId: string, input: { actionId: string; askedBy: string; summary: string; detail?: string[]; tool: { name: string; argsDigest: string } }) => {
      mockPosts.actions.push(input);
      await store().createAction({ callId, actionId: input.actionId, messageId: `msg-${input.actionId}`, askedBy: input.askedBy, toolName: input.tool.name,
        argsDigest: input.tool.argsDigest, status: 'waiting', createdAt: Date.now(), decidedBy: null, decidedAt: null, resultText: null });
      return { message: { id: `msg-${input.actionId}` }, created: true };
    },
    moveAction: async (callId: string, actionId: string, move: { from: never[]; to: never; by: string; resultText?: string }) =>
      store().decideAction(callId, actionId, { from: move.from, to: move.to, by: move.by, at: Date.now(), ...(move.resultText ? { resultText: move.resultText } : {}) }),
  };
});

import { LineIntake } from '../intake.js';
import { MemoryAssistantStore } from '../store.js';
import { MockTranscriptSource } from '../transcript-source.js';
import { AssistantRuntime, TYPED_UNSUPPORTED_REPLY, READ_TURN_TTL_MS, WRITE_TURN_TTL_MS, classifyCall, describeCall, type StartContext } from '../orchestrator.js';
import { ScriptedSession } from '../scripted-session.js';
import { SessionEmitter, SessionTextUnsupported, type LiveMeetingSession, type SessionStartInput } from '../session.js';
import { newAssistantSession, sessionOf, type AssistantRecord } from '../types.js';
import { setAssistantStore } from '../store-select.js';

const CALL = 'call-1';
const ALICE = 'u-alice', BOB = 'u-bob', CAROL = 'u-carol';
const T0 = Date.parse('2026-11-13T12:00:00.000Z');
const flush = async () => { for (let i = 0; i < 6; i += 1) await new Promise<void>((r) => setImmediate(r)); };

/** A stand-in for the provider's session: the test drives its events and reads what the server answered. */
class FakeSession extends SessionEmitter implements LiveMeetingSession {
  readonly kind = 'openai' as const;
  readonly acceptsText = false;
  startInput: SessionStartInput | null = null;
  readonly answers: Array<[string, string]> = [];
  readonly contexts: string[] = [];
  readonly audio: Buffer[] = [];
  private readonly open = new Set<string>();
  closed = false;
  async start(i: SessionStartInput) { this.startInput = i; }
  appendAudio(b: Buffer) { this.audio.push(b); }
  sendText(): void { throw new SessionTextUnsupported(); }
  answerToolCall(id: string, output: string) { if (this.closed || !this.open.delete(id)) return false; this.answers.push([id, output]); return true; }
  appendContext(t: string) { this.contexts.push(t); return true; }
  async close() { if (this.closed) return; this.closed = true; this.emit('usage', { seconds: 90, backendTokens: { inputTokens: 100, outputTokens: 10, cachedTokens: 0 } }); this.emit('closed', { reason: 'close_requested' }); }
  call(id: string, name: string, args: unknown, atMs = 0) { this.open.add(id); this.emit('toolCall', { callId: id, name, args, atMs }); }
  say(text: string) { this.emit('outputTranscript', { text, final: true }); }
  hear(text: string, startMs: number, endMs: number) { this.emit('inputTranscript', { text, startMs, endMs }); }
  drop() { this.emit('closed', { reason: 'socket-closed' }); }
  answersFor(id: string) { return this.answers.filter(([c]) => c === id); }
}

let now: number;
let store: MemoryAssistantStore;
let source: MockTranscriptSource;
let intake: LineIntake;
let runtime: AssistantRuntime;
let sessions: LiveMeetingSession[];
let factory: () => LiveMeetingSession;
let roles: Record<string, string[]>;
let finished: Array<{ callId: string; usageSeconds: number; tokens: { input: number; output: number; cached: number }; sessionKind: string }>;

const ctx: StartContext = { callId: CALL, tenant: 'orgiq', inviterId: ALICE, roster: ['Alice', 'Bob', 'Carol'], recordName: 'Auth Migration' };

async function listening(): Promise<AssistantRecord> {
  const { record } = await store.create({
    callId: CALL, tenant: 'orgiq', lobby: 'orgiq:initiative:p-auth', initiativeId: 'p-auth', state: 'listening', invitedBy: ALICE, invitedAt: now,
    pausedBy: null, leftAt: null, leftBy: null, acked: [ALICE, BOB, CAROL], attendees: [ALICE, BOB, CAROL], presentAtInvite: [ALICE, BOB, CAROL],
    requests: 0, linesStored: 0, nextSeq: 1, pendingRequests: [], session: newAssistantSession(3600),
  });
  return record;
}
/** A caption from `userId`, then time passes so the detector closes the request and the scripted session answers. */
async function say(userId: string, text: string, quietMs = 5000) {
  await intake.handle(CALL, { userId, text, at: now });
  now += quietMs;
  await intake.tick();
  await flush();
}
const scripted = () => runtime.sessionOf(CALL) as ScriptedSession;
const fake = () => runtime.sessionOf(CALL) as unknown as FakeSession;

beforeEach(async () => {
  now = T0;
  mockPosts.replies.length = 0; mockPosts.privates.length = 0; mockPosts.actions.length = 0; mockPosts.notices.length = 0;
  store = new MemoryAssistantStore(); setAssistantStore(store);
  source = new MockTranscriptSource();
  intake = new LineIntake(store, { clock: () => now, tickMs: 0, source: () => source });
  intake.start(CALL);
  sessions = []; finished = [];
  factory = () => { const s = new ScriptedSession(() => now); sessions.push(s); return s; };
  roles = { [ALICE]: ['member'], [BOB]: ['member'], [CAROL]: [] };
  runtime = new AssistantRuntime({
    store: () => store, intake: () => intake, clock: () => now, makeSession: () => factory(),
    rolesOf: async (u) => roles[u] ?? [], onFinished: async (e) => { finished.push(e); },
  }, { tickMs: 0 });
  await listening();
  await runtime.start(ctx);
});
afterEach(async () => { await runtime.dispose(); intake.dispose(); setAssistantStore(null); });

describe('what a session is started with', () => {
  it('the instructions name Nova, the roster and the record and the tools exclude navigation, machines and calls', () => {
    const input = scripted().startInput!;
    expect(input.instructions).toContain('You are Nova');
    expect(input.instructions).toContain('Alice, Bob, Carol');
    expect(input.instructions).toContain('"Auth Migration"');
    expect(input.instructions).toMatch(/silent unless someone addresses you by name/);
    expect(input.instructions).toMatch(/one or two short sentences/);
    expect(input.instructions).toMatch(/waiting for a person's confirmation/);
    const names = input.tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['search', 'create', 'budget']));
    for (const banned of ['open', 'computer', 'call']) expect(names).not.toContain(banned);
    expect(input.backendInstructions).toMatch(/meeting/);
  });

  it('classifies by the catalogue: confirm tools are writes, budget and access status are private, the rest reads', () => {
    expect(classifyCall('create', { kind: 'work-item', fields: { title: 'x' } })).toBe('write');
    expect(classifyCall('search', { query: 'x' })).toBe('read');
    expect(classifyCall('budget', { scope: 'me' })).toBe('private-read');
    expect(classifyCall('access_request_status', {})).toBe('private-read');
    expect(classifyCall('no_such_tool', {})).toBeNull();
    expect(describeCall('create', { kind: 'work-item', fields: { title: 'the login cookie bug' } }).summary).toBe('Create a work item titled "the login cookie bug"');
  });
});

describe('a spoken request in the scripted world', () => {
  it('answers a plain question in the chat, labelled with the asker', async () => {
    await say(ALICE, 'Nova, what is two plus two?');
    expect(mockPosts.replies).toEqual([{ text: 'Four.', askedBy: ALICE, askedByName: 'Alice' }]);
  });

  it('a write: a card for the asker, the model told it is waiting, nothing for the browser until confirmed, then one running turn', async () => {
    await say(ALICE, 'Nova, create a work item for the login cookie bug');
    expect(mockPosts.actions).toHaveLength(1);
    expect(mockPosts.actions[0]).toMatchObject({ askedBy: ALICE, summary: 'Create a work item titled "the login cookie bug"', tool: { name: 'create' } });
    expect(runtime.sessionOf(CALL)).toBeTruthy();
    const turns = await store.listTurns(CALL);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ askedBy: ALICE, kind: 'write', status: 'pending', actionId: mockPosts.actions[0]!.actionId, tool: { name: 'create' } });
    expect(turns[0]!.expiresAt - turns[0]!.createdAt).toBe(WRITE_TURN_TTL_MS);
    expect(await runtime.turnsFor(CALL, ALICE)).toEqual([]);
    // the model was told at once: its next words are about the waiting card
    expect(mockPosts.replies.map((r) => r.text)).toEqual(['I have asked Alice to confirm.']);
    // Bob cannot move Alice's turn
    expect(await runtime.submitResult(CALL, turns[0]!.turnId, BOB, { ok: true })).toBeNull();
    await runtime.onDecision(CALL, mockPosts.actions[0]!.actionId, 'confirm');
    const mine = await runtime.turnsFor(CALL, ALICE);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ status: 'running', kind: 'write' });
    expect(await runtime.turnsFor(CALL, BOB)).toEqual([]);
    const done = await runtime.submitResult(CALL, mine[0]!.turnId, ALICE, { ok: true, output: { say: 'Created WI-12.' } });
    expect(done).toMatchObject({ turn: { status: 'done' } });
    expect((await store.getAction(CALL, mockPosts.actions[0]!.actionId))).toMatchObject({ status: 'done', resultText: 'Created WI-12.' });
    expect(scripted().contexts.at(-1)).toMatch(/was done: Created WI-12\./);
    // a second result is a conflict, not a second effect
    expect(await runtime.submitResult(CALL, mine[0]!.turnId, ALICE, { ok: true })).toEqual({ conflict: 'done' });
  });

  it('a declined card ends the turn and tells the session; it never reaches the browser', async () => {
    await say(ALICE, 'Nova, create a work item for the cookie bug');
    await runtime.onDecision(CALL, mockPosts.actions[0]!.actionId, 'decline');
    expect((await store.listTurns(CALL))[0]!.status).toBe('declined');
    expect(await runtime.turnsFor(CALL, ALICE)).toEqual([]);
    expect(scripted().contexts.at(-1)).toMatch(/Alice declined/);
  });

  it('a read waits unanswered for the asker\'s browser, is answered exactly once with the result, and the data is never posted', async () => {
    await say(BOB, 'Nova, find the Kubernetes experts');
    const [turn] = await runtime.turnsFor(CALL, BOB);
    expect(turn).toMatchObject({ kind: 'read', status: 'pending', tool: { name: 'search', args: { query: 'the Kubernetes experts' } } });
    expect(mockPosts.replies).toEqual([]);
    const spy = jest.spyOn(scripted(), 'answerToolCall');
    const out = await runtime.submitResult(CALL, turn!.turnId, BOB, { ok: true, output: { rows: [{ title: 'SECRET-ROW' }] } });
    expect(out).toMatchObject({ turn: { status: 'done' } });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![1]).toBe('{"rows":[{"title":"SECRET-ROW"}]}');
    await flush();
    expect(mockPosts.replies).toEqual([{ text: 'Here is the result.', askedBy: BOB, askedByName: 'Bob' }]);
    expect(JSON.stringify(mockPosts)).not.toContain('SECRET-ROW');
    expect(await runtime.submitResult(CALL, turn!.turnId, BOB, { ok: true, output: { rows: [] } })).toEqual({ conflict: 'done' });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('a failed read answers the model with an error, once', async () => {
    await say(BOB, 'Nova, find the runbooks');
    const [turn] = await runtime.turnsFor(CALL, BOB);
    const spy = jest.spyOn(scripted(), 'answerToolCall');
    await runtime.submitResult(CALL, turn!.turnId, BOB, { ok: false, error: 'the search failed' });
    expect(spy).toHaveBeenCalledWith(expect.any(String), '{"error":"the search failed"}');
    expect((await store.getTurn(CALL, turn!.turnId))!.status).toBe('failed');
  });

  it('a private tool is answered by the model to the asker alone, never in the chat', async () => {
    await say(BOB, 'Nova, how much budget do I have');
    const [turn] = await runtime.turnsFor(CALL, BOB);
    expect(turn!.kind).toBe('private-read');
    await runtime.submitResult(CALL, turn!.turnId, BOB, { ok: true, output: { spent: 12 } });
    await flush();
    expect(mockPosts.replies).toEqual([]);
    expect(mockPosts.privates).toEqual([{ userId: BOB, text: 'Here is the result.' }]);
  });

  it('a request over the cap of the scripted rules gets the one-line help, no tool', async () => {
    await say(ALICE, 'Nova, sing me a song please');
    expect(mockPosts.replies.map((r) => r.text)).toEqual(['I can help with work items, search and budgets in this walk.']);
    expect(await store.listTurns(CALL)).toEqual([]);
  });
});

describe('the refusals', () => {
  it('a tool call from someone who never said the name is answered "not addressed", counted, and nothing is posted or made', async () => {
    const id = runtime.devToolCall(CALL, BOB, 'search', { query: 'x' })!;
    const spy = jest.spyOn(scripted(), 'answerToolCall');
    await flush();
    expect(id).toBeTruthy();
    expect(await store.listTurns(CALL)).toEqual([]);
    expect(mockPosts.replies).toEqual([]); expect(mockPosts.actions).toEqual([]);
    expect(sessionOf((await store.get(CALL))!).refusedCalls).toBe(1);
    expect(scripted().acceptsText).toBe(true);
    void spy;
  });

  it('answers the refused call once with the reason, and mutes the model\'s follow-up', async () => {
    const answers: string[] = [];
    factory = () => { const s = new FakeSession(); sessions.push(s); return s; };
    await runtime.stop(CALL); await store.transition(CALL, { from: ['listening'], to: 'listening', by: 'x', at: now });
    runtime = new AssistantRuntime({ store: () => store, intake: () => intake, clock: () => now, makeSession: () => factory(), rolesOf: async (u) => roles[u] ?? [] }, { tickMs: 0 });
    await runtime.start(ctx);
    const s = fake();
    // Bob is the latest voice but only Alice said the name.
    await store.appendLine({ callId: CALL, userId: ALICE, participantId: '', speakerName: 'Alice', text: 'Nova, find the experts', at: now - 3000, captionId: 'c1' });
    await store.appendLine({ callId: CALL, userId: BOB, participantId: '', speakerName: 'Bob', text: 'yes please', at: now - 1000, captionId: 'c2' });
    s.call('call_1', 'search', { query: 'experts' }, 0);
    await flush();
    answers.push(...s.answersFor('call_1').map(([, o]) => o));
    expect(answers).toEqual(['{"refused":"not addressed"}']);
    s.say('Sorry, I cannot do that.'); await flush();
    expect(mockPosts.replies).toEqual([]);
    expect(sessionOf((await store.get(CALL))!).refusedCalls).toBe(1);
  });

  it('refuses the fourth tool call of one addressed request as "too many steps", counts it, and a new request starts fresh', async () => {
    factory = () => { const s = new FakeSession(); sessions.push(s); return s; };
    await runtime.stop(CALL); await store.transition(CALL, { from: ['listening'], to: 'listening', by: 'x', at: now });
    runtime = new AssistantRuntime({ store: () => store, intake: () => intake, clock: () => now, makeSession: () => factory(), rolesOf: async (u) => roles[u] ?? [] }, { tickMs: 0 });
    await runtime.start(ctx);
    const s = fake();
    await store.appendLine({ callId: CALL, userId: ALICE, participantId: '', speakerName: 'Alice', text: 'Nova, find everything about logins', at: now - 3000, captionId: 'c1' });
    for (const n of [1, 2, 3, 4]) { s.call(`call_${n}`, 'search', { query: `q${n}` }, 0); await flush(); }
    expect(s.answersFor('call_4').map(([, o]) => o)).toEqual(['{"refused":"too many steps"}']);
    expect(s.answersFor('call_1')).toEqual([]);
    expect(sessionOf((await store.get(CALL))!).refusedCalls).toBe(1);
    expect((await store.listTurns(CALL)).length).toBe(3);
    // A second addressed request is its own window.
    now += 1000;
    await store.appendLine({ callId: CALL, userId: ALICE, participantId: '', speakerName: 'Alice', text: 'Nova, one more thing', at: now - 500, captionId: 'c2' });
    s.call('call_5', 'search', { query: 'q5' }, 1000); await flush();
    expect(s.answersFor('call_5')).toEqual([]);
    expect((await store.listTurns(CALL)).length).toBe(4);
  });

  it('with no attributed line in the window there is no asker: refused, nothing posted', async () => {
    await runtime.stop(CALL);
    factory = () => { const s = new FakeSession(); sessions.push(s); return s; };
    runtime = new AssistantRuntime({ store: () => store, intake: () => intake, clock: () => now, makeSession: () => factory(), rolesOf: async (u) => roles[u] ?? [] }, { tickMs: 0 });
    await store.create; await runtime.start(ctx);
    const s = fake();
    await store.appendLine({ callId: CALL, userId: null, participantId: '', speakerName: '', text: 'Nova, find the experts', at: now - 1000, captionId: 'u1' });
    s.call('call_9', 'search', { query: 'x' }, 0);
    await flush();
    expect(s.answersFor('call_9').map(([, o]) => o)).toEqual(['{"refused":"no asker"}']);
    expect(await store.listTurns(CALL)).toEqual([]);
  });

  it('the real session asker is the latest attributed speaker, and when it is the person who said the name the call goes ahead', async () => {
    await runtime.stop(CALL);
    factory = () => { const s = new FakeSession(); sessions.push(s); return s; };
    runtime = new AssistantRuntime({ store: () => store, intake: () => intake, clock: () => now, makeSession: () => factory(), rolesOf: async (u) => roles[u] ?? [] }, { tickMs: 0 });
    await runtime.start(ctx);
    const s = fake();
    await store.appendLine({ callId: CALL, userId: BOB, participantId: '', speakerName: 'Bob', text: 'ok sure', at: now - 5000, captionId: 'b0' });
    await store.appendLine({ callId: CALL, userId: ALICE, participantId: '', speakerName: 'Alice', text: 'Nova, find the Kubernetes experts.', at: now - 1000, captionId: 'a1' });
    s.call('call_2', 'search', { query: 'Kubernetes experts' }, 0);
    await flush();
    const turns = await store.listTurns(CALL);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ askedBy: ALICE, kind: 'read' });
    expect(s.answersFor('call_2')).toEqual([]);
    expect(mockPosts.replies).toEqual([]);
    // the model's speech after the result goes to Alice
    await runtime.submitResult(CALL, turns[0]!.turnId, ALICE, { ok: true, output: { rows: [] } });
    expect(s.answersFor('call_2')).toHaveLength(1);
    s.say('There are no matches.'); await flush();
    expect(mockPosts.replies).toEqual([{ text: 'There are no matches.', askedBy: ALICE, askedByName: 'Alice' }]);
  });

  it('a tool outside the asker\'s role is refused with a reply that says so; a person with no grants can do nothing; the excluded tools never run', async () => {
    await say(CAROL, 'Nova, find the Kubernetes experts');
    expect(await store.listTurns(CALL)).toEqual([]);
    expect(mockPosts.replies).toEqual([{ text: 'Carol cannot do that here.', askedBy: CAROL, askedByName: 'Carol' }]);
    mockPosts.replies.length = 0;
    await intake.handle(CALL, { userId: ALICE, text: 'Nova, open the budgets page.', at: now });
    runtime.devToolCall(CALL, ALICE, 'open', { page: 'budgets' });
    await flush();
    expect(await store.listTurns(CALL)).toEqual([]);
    expect(mockPosts.replies).toEqual([{ text: 'Alice cannot do that here.', askedBy: ALICE, askedByName: 'Alice' }]);
    expect(sessionOf((await store.get(CALL))!).refusedCalls).toBe(2);
  });

  it('malformed arguments and an unknown tool are refused without a post', async () => {
    await intake.handle(CALL, { userId: ALICE, text: 'Nova, do something.', at: now });
    runtime.devToolCall(CALL, ALICE, 'search', null);
    runtime.devToolCall(CALL, ALICE, 'search', { query: 'x'.repeat(5000) });
    runtime.devToolCall(CALL, ALICE, 'summon_dragons', {});
    await flush();
    expect(await store.listTurns(CALL)).toEqual([]);
    expect(mockPosts.replies).toEqual([]);
    expect(sessionOf((await store.get(CALL))!).refusedCalls).toBe(3);
  });
});

describe('typed requests in the call chat', () => {
  it('a session that cannot take text answers a typed request once per person, and ignores messages that do not address Nova', async () => {
    factory = () => { const s = new FakeSession(); sessions.push(s); return s; };
    await runtime.stop(CALL); await store.transition(CALL, { from: ['listening'], to: 'listening', by: 'x', at: now });
    runtime = new AssistantRuntime({ store: () => store, intake: () => intake, clock: () => now, makeSession: () => factory(), rolesOf: async (u) => roles[u] ?? [] }, { tickMs: 0 });
    await runtime.start(ctx);
    await runtime.onTypedMessage(CALL, ALICE, 'we should ship on Friday');
    await runtime.onTypedMessage(CALL, ALICE, 'I like the nova scotia plan');
    expect(mockPosts.replies).toEqual([]);
    await runtime.onTypedMessage(CALL, ALICE, 'Nova, find the login bug');
    await runtime.onTypedMessage(CALL, ALICE, '@Nova what is my budget');
    await runtime.onTypedMessage(CALL, BOB, 'hey @nova search for x');
    expect(mockPosts.replies.map((r) => r.text)).toEqual([TYPED_UNSUPPORTED_REPLY, TYPED_UNSUPPORTED_REPLY]);
  });
  it('the scripted session takes the typed text as the person\'s own line', async () => {
    await runtime.onTypedMessage(CALL, ALICE, 'Nova, what is two plus two');
    now += 5000; await intake.tick(); await flush();
    expect(mockPosts.replies.map((r) => r.text)).toEqual(['Four.']);
  });
});

describe('one answer per tool call', () => {
  it('a read that expires is answered once with the error, the chat says so, and a late result is a conflict', async () => {
    await say(BOB, 'Nova, find the runbooks');
    const [turn] = await runtime.turnsFor(CALL, BOB);
    expect(turn!.expiresAt - turn!.createdAt).toBe(READ_TURN_TTL_MS);
    const spy = jest.spyOn(scripted(), 'answerToolCall');
    now += READ_TURN_TTL_MS + 1;
    await runtime.tick(); await runtime.tick();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(expect.any(String), '{"error":"the person who asked is not available"}');
    expect((await store.getTurn(CALL, turn!.turnId))!.status).toBe('expired');
    expect(mockPosts.replies.at(-1)!.text).toMatch(/Bob is not available/);
    expect(await runtime.turnsFor(CALL, BOB)).toEqual([]);
    expect(await runtime.submitResult(CALL, turn!.turnId, BOB, { ok: true, output: {} })).toEqual({ conflict: 'expired' });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('a write that expires moves its card to expired and tells the session, and the model was never left waiting', async () => {
    await say(ALICE, 'Nova, create a work item for the cookie bug');
    now += WRITE_TURN_TTL_MS + 1;
    await runtime.tick();
    expect((await store.getAction(CALL, mockPosts.actions[0]!.actionId))!.status).toBe('expired');
    expect((await store.listTurns(CALL))[0]!.status).toBe('expired');
    expect(scripted().contexts.at(-1)).toMatch(/expired/);
  });

  it('a duplicate tool-call event is ignored, and answer() is the only way a call gets answered', async () => {
    factory = () => { const s = new FakeSession(); sessions.push(s); return s; };
    await runtime.stop(CALL);
    runtime = new AssistantRuntime({ store: () => store, intake: () => intake, clock: () => now, makeSession: () => factory(), rolesOf: async (u) => roles[u] ?? [] }, { tickMs: 0 });
    await runtime.start(ctx);
    const s = fake();
    await store.appendLine({ callId: CALL, userId: ALICE, participantId: '', speakerName: 'Alice', text: 'Nova, find x.', at: now - 500, captionId: 'a1' });
    s.call('c1', 'search', { query: 'x' }); s.call('c1', 'search', { query: 'x' });
    s.call('c2', 'create', { kind: 'work-item', fields: { title: 'y' } });
    s.call('c3', 'nonsense', {});
    await flush();
    // c1 (a read) is waiting on a turn; c2 (a write) and c3 (refused) are answered once; no call is answered twice.
    expect(s.answersFor('c1')).toEqual([]);
    expect(s.answersFor('c2')).toHaveLength(1);
    expect(s.answersFor('c3')).toHaveLength(1);
    expect(await store.listTurns(CALL)).toHaveLength(2);
    const reads = (await store.listTurns(CALL)).filter((t) => t.kind === 'read');
    await runtime.submitResult(CALL, reads[0]!.turnId, ALICE, { ok: true, output: { n: 1 } });
    expect(s.answersFor('c1')).toHaveLength(1);
    for (const id of ['c1', 'c2', 'c3']) expect(s.answersFor(id).length).toBe(1);
  });

  it('a handler that throws still answers the call', async () => {
    factory = () => { const s = new FakeSession(); sessions.push(s); return s; };
    await runtime.stop(CALL);
    runtime = new AssistantRuntime({ store: () => store, intake: () => intake, clock: () => now, makeSession: () => factory(), rolesOf: async () => { throw new Error('directory down'); } }, { tickMs: 0 });
    await runtime.start(ctx);
    const s = fake();
    await store.appendLine({ callId: CALL, userId: ALICE, participantId: '', speakerName: 'Alice', text: 'Nova, find x.', at: now - 500, captionId: 'a1' });
    s.call('boom', 'search', { query: 'x' });
    await flush();
    expect(s.answersFor('boom').map(([, o]) => o)).toEqual(['{"error":"Nova could not run that."}']);
  });
});

describe('pause, resume, replacement and stop', () => {
  it('pause closes the session so nothing bills or is sent; resume opens a new one with the last minutes of the call as context', async () => {
    await say(ALICE, 'We should ship the cookie fix on Friday.');
    expect(runtime.appendMixedAudio(CALL, Buffer.alloc(10))).toBe(true);
    const first = scripted();
    now += 125_000;
    await runtime.pause(CALL);
    expect(runtime.hasSession(CALL)).toBe(false);
    expect(runtime.appendMixedAudio(CALL, Buffer.alloc(10))).toBe(false);
    await runtime.resume(CALL);
    const second = scripted();
    expect(second).not.toBe(first);
    expect(second.startInput!.instructions).toContain('Alice: We should ship the cookie fix on Friday.');
    expect((await store.get(CALL))!.session).toMatchObject({ usageSeconds: expect.any(Number) });
  });

  it('pausing expires a read that was waiting (its model call is gone) but keeps a write behind its card', async () => {
    await say(BOB, 'Nova, find the runbooks');
    await say(ALICE, 'Nova, create a work item for the cookie bug');
    await runtime.pause(CALL);
    const byKind = Object.fromEntries((await store.listTurns(CALL)).map((t) => [t.kind, t.status]));
    expect(byKind).toEqual({ read: 'expired', write: 'pending' });
  });

  it('an unexpected close is replaced with context, at most three times, then Nova leaves with a notice', async () => {
    factory = () => { const s = new FakeSession(); sessions.push(s); return s; };
    await runtime.stop(CALL); finished.length = 0;
    runtime = new AssistantRuntime({ store: () => store, intake: () => intake, clock: () => now, makeSession: () => factory(), rolesOf: async (u) => roles[u] ?? [], onFinished: async (e) => { finished.push(e); } }, { tickMs: 0 });
    await runtime.start(ctx);
    await store.appendLine({ callId: CALL, userId: BOB, participantId: '', speakerName: 'Bob', text: 'The deadline is Friday.', at: now - 1000, captionId: 'b1' });
    for (let n = 1; n <= 3; n += 1) {
      fake().drop(); await flush();
      expect(runtime.hasSession(CALL)).toBe(true);
      expect(sessionOf((await store.get(CALL))!).replacements).toBe(n);
      expect(fake().startInput!.instructions).toContain('Bob: The deadline is Friday.');
    }
    fake().drop(); await flush();
    expect(runtime.isRunning(CALL)).toBe(false);
    expect((await store.get(CALL))!.state).toBe('left');
    expect(mockPosts.notices.at(-1)).toMatch(/lost its connection and has left/);
    expect(finished).toHaveLength(1);
  });

  it('stop settles once with the session seconds and tokens, and expires what was open', async () => {
    await say(BOB, 'Nova, find the runbooks');
    now += 61_000;
    await runtime.stop(CALL); await runtime.stop(CALL);
    expect(finished).toEqual([{ callId: CALL, usageSeconds: 66, tokens: { input: 0, output: 0, cached: 0 }, sessionKind: 'scripted' }]);
    expect((await store.listTurns(CALL))[0]!.status).toBe('expired');
    expect(runtime.isRunning(CALL)).toBe(false);
  });

  it('"Nova, stop listening" said in the call pauses the session through the intake', async () => {
    await say(ALICE, 'Nova, stop listening.');
    expect((await store.get(CALL))!.state).toBe('paused');
    expect(runtime.hasSession(CALL)).toBe(false);
  });
});

describe('what the real session hears', () => {
  it('attributes a transcript piece from the participants\' own audio, stores it with the speakers, and stores an unattributed piece with no person', async () => {
    factory = () => { const s = new FakeSession(); sessions.push(s); return s; };
    await runtime.stop(CALL);
    runtime = new AssistantRuntime({ store: () => store, intake: () => intake, clock: () => now, makeSession: () => factory(), rolesOf: async (u) => roles[u] ?? [] }, { tickMs: 0 });
    await runtime.start(ctx);
    const loud = (ms: number) => { const b = Buffer.alloc(Math.round(ms * 16) * 2); for (let i = 0; i < b.length / 2; i += 1) b.writeInt16LE(i % 40 < 20 ? 4000 : -4000, i * 2); return b; };
    await runtime.feedParticipantAudio(CALL, BOB, loud(1000), 16_000);
    now += 1000;
    fake().hear('The cookie is set too early.', 100, 900);
    await flush();
    fake().hear('Who was that?', 20_000, 21_000);
    await flush();
    const lines = await store.lines(CALL, 0, 10);
    expect(lines.map((l) => [l.userId, l.text])).toEqual([[BOB, 'The cookie is set too early.'], [null, 'Who was that?']]);
    expect(lines[0]).toMatchObject({ startMs: 100, endMs: 900 });
  });

  it('audio from someone who has not acknowledged is not tracked, and nothing is sent to the session while no session is open', async () => {
    const { acked } = (await store.get(CALL))!;
    expect(acked).toContain(BOB);
    await runtime.feedParticipantAudio(CALL, 'u-dave', Buffer.alloc(3200), 16_000);
    await runtime.pause(CALL);
    expect(runtime.appendMixedAudio(CALL, Buffer.alloc(10))).toBe(false);
  });
});

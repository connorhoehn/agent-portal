// The orchestrator's hands-free seam (lane B): MEETING_ASSISTANT_HANDSFREE read once as a run starts; under it the session hears only
// what the router feeds, heard lines come from the listening side with exact speakers, Milo's voice goes through the router, and a
// tool call's asker is only the routed person. Listening side and rules are fakes of lanes A and C (handsfree-fakes.ts). The chat
// module is the same recorder as orchestrator.test.ts.
jest.mock('../../../config.js', () => ({ config: { region: 'us-east-1', auth: {}, cognito: {}, mock: { aurora: true }, meetingAssistant: { enabled: true, transcriptRetentionDays: 30 } } }));
jest.mock('../../../providers/identity.js', () => ({ getUser: jest.fn(async () => null) }));
// Notifications go nowhere here (the absent-people step of a dismiss would otherwise reach for a real inbox).
jest.mock('../../social-notify.js', () => ({ notify: jest.fn(async () => []) }));
// The turn owner's voice (the last block): a tone that says the logged words, so nothing reaches a provider.
jest.mock('../../voice/speech.js', () => ({
  speechBackend: () => ({ id: 'tone', sampleRate: 24_000, speak: async (text: string, o: { onInput(t: string): void; onAudio(b: Buffer): void }) => { o.onInput(text); o.onAudio(Buffer.alloc(4800, 1)); return { firstAudioMs: 0, ms: 0, bytes: 4800 }; } }),
}));
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
    postApprovedAnswer: async (_c: string, text: string, _o: unknown, r: { askedBy: string; askedByName: string }) => { mockPosts.replies.push({ text, ...r }); return { id: 'm-approved' }; },
    noticeText: (jest.requireActual('../chat.js') as typeof import('../chat.js')).noticeText,
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
import { AssistantRuntime, type StartContext } from '../orchestrator.js';
import { SessionEmitter, SessionTextUnsupported, type LiveMeetingSession, type SessionEvents, type SessionStartInput } from '../session.js';
import { newAssistantSession } from '../types.js';
import { setAssistantStore } from '../store-select.js';
import { DEFAULT_POLICY, registerMeetingAssistantPolicy, type MeetingAssistantPolicy } from '../policy.js';
import type { AudioSink } from '../audio-intake.js';
import { HandsfreeTalking } from '../handsfree/talking.js';
import type { HandsfreeClock } from '../handsfree/types.js';
import { FakeListening, FakeRules, type FakeClock } from './handsfree-fakes.js';
import { TurnOwner } from '../turn/turn-owner.js';
import { _setTextFetch } from '../../voice/openai-text.js';
import type { SpokenLine } from '../turn/types.js';

const CALL = 'call-1';
const ALICE = 'u-alice', BOB = 'u-bob', CAROL = 'u-carol';
const T0 = Date.parse('2026-11-13T12:00:00.000Z');
const flush = async () => { for (let i = 0; i < 6; i += 1) await new Promise<void>((r) => setImmediate(r)); };

class FakeSession extends SessionEmitter implements LiveMeetingSession {
  readonly kind = 'openai' as const;
  readonly acceptsText = false;
  readonly answers: Array<[string, string]> = [];
  readonly audio: Buffer[] = [];
  private readonly open = new Set<string>();
  closed = false;
  async start(_i: SessionStartInput) { /* open */ }
  pendingInputText() { return ''; }
  appendAudio(b: Buffer) { this.audio.push(b); }
  sendText(): void { throw new SessionTextUnsupported(); }
  answerToolCall(id: string, output: string) { if (this.closed || !this.open.delete(id)) return false; this.answers.push([id, output]); return true; }
  appendContext() { return true; }
  /** Server lines asked for (`sayVerbatim`): sent at once; the test plays their frames and ends them. */
  readonly asked: Array<{ id: string; text: string; ended: (t: string | null) => void; answersTurn?: boolean }> = [];
  sayVerbatim(id: string, text: string, ended: (t: string | null) => void, sent?: () => void, opts?: { answersTurn?: boolean }) { this.asked.push({ id, text, ended, ...(opts?.answersTurn ? { answersTurn: true } : {}) }); sent?.(); return true; }
  cancelSay() { /* forgotten */ }
  async close() { if (this.closed) return; this.closed = true; this.emit('closed', { reason: 'close_requested' }); }
  call(id: string, name: string, args: unknown, askedBy?: string) { this.open.add(id); this.emit('toolCall', { callId: id, name, args, atMs: 0, ...(askedBy ? { askedBy } : {}) }); }
  fire<K extends keyof SessionEvents>(type: K, event: SessionEvents[K]) { this.emit(type, event); }
}

let now: number;
let store: MemoryAssistantStore;
let intake: LineIntake;
let runtime: AssistantRuntime;
let listening: FakeListening | null;
let rules: FakeRules;
let sent: number[];
/** The call's seats as the gateway reports them (null: the orchestrator's default roster). */
let seats: Array<{ userId: string; active: boolean }> | null = null;
const audioTap: { sink: AudioSink | null; attach(callId: string, sink: AudioSink): void; suspend(callId: string): void; detach(callId: string): void } = {
  sink: null, attach(_c, sink) { this.sink = sink; }, suspend() { this.sink = null; }, detach() { this.sink = null; },
};
const ctx: StartContext = { callId: CALL, tenant: 'orgiq', inviterId: ALICE, roster: ['Alice', 'Bob', 'Carol'], recordName: 'Auth Migration' };
const pcm = (tag: number) => Buffer.alloc(4800, tag);
const savedFlag = process.env['MEETING_ASSISTANT_HANDSFREE'];
let floors: Array<{ type: string; channel: string; handsfree: boolean; floor: { userId: string } | null }> = [];

async function boot(flag: string | undefined, withSides = true): Promise<void> {
  if (flag === undefined) delete process.env['MEETING_ASSISTANT_HANDSFREE']; else process.env['MEETING_ASSISTANT_HANDSFREE'] = flag;
  listening = null; rules = new FakeRules(); sent = []; floors = [];
  runtime = new AssistantRuntime({
    store: () => store, intake: () => intake, clock: () => now, makeSession: () => new FakeSession(),
    rolesOf: async () => ['member'], audio: audioTap, ...(seats ? { seats: async () => seats! } : {}), voiceSink: (_c, frame) => { sent.push(frame.data.seq); return true; }, floorSink: (_c, frame) => { floors.push(frame); return true; },
    ...(withSides ? { handsfree: (_call: unknown, clock: HandsfreeClock) => { listening = new FakeListening(clock as unknown as FakeClock); return { listening: listening as never, rules }; } } : {}),
  }, { tickMs: 0 });
  await runtime.start(ctx);
}
const talking = () => runtime.sessionOf(CALL) as unknown as HandsfreeTalking;
const inner = () => talking().inner as FakeSession;

beforeEach(async () => {
  now = T0;
  mockPosts.replies.length = 0; mockPosts.privates.length = 0; mockPosts.actions.length = 0; mockPosts.notices.length = 0;
  store = new MemoryAssistantStore(); setAssistantStore(store);
  intake = new LineIntake(store, { clock: () => now, tickMs: 0, source: () => new MockTranscriptSource() });
  intake.start(CALL);
  await store.create({
    callId: CALL, tenant: 'orgiq', lobby: 'orgiq:initiative:p-auth', initiativeId: 'p-auth', state: 'listening', invitedBy: ALICE, invitedAt: now,
    pausedBy: null, leftAt: null, leftBy: null, acked: [ALICE, BOB, CAROL], attendees: [ALICE, BOB, CAROL], presentAtInvite: [ALICE, BOB, CAROL],
    requests: 0, linesStored: 0, nextSeq: 1, pendingRequests: [], session: newAssistantSession(3600),
  });
});
afterEach(async () => {
  seats = null;
  await runtime.dispose(); intake.dispose(); setAssistantStore(null);
  if (savedFlag === undefined) delete process.env['MEETING_ASSISTANT_HANDSFREE']; else process.env['MEETING_ASSISTANT_HANDSFREE'] = savedFlag;
});

describe('the hands-free seam', () => {
  it('flag off: today\'s session, unwrapped, hears the room mix (the sides are never asked for)', async () => {
    await boot(undefined);
    expect(runtime.sessionOf(CALL)).toBeInstanceOf(FakeSession);
    audioTap.sink!.append(pcm(5));
    expect((runtime.sessionOf(CALL) as unknown as FakeSession).audio).toHaveLength(1);
    expect(listening).toBeNull();
    expect(runtime.handsfreeRun(CALL)).toBeNull();
  });

  it('flag on but no listening side in this process: today\'s path', async () => {
    await boot('1', false);
    expect(runtime.sessionOf(CALL)).toBeInstanceOf(FakeSession);
  });

  it('flag on: the room mix never reaches the session; a person\'s first audio opens their lane; heard lines are stored with their speaker', async () => {
    await boot('1');
    expect(runtime.sessionOf(CALL)).toBeInstanceOf(HandsfreeTalking);
    audioTap.sink!.placed(ALICE, pcm(1), 0);
    audioTap.sink!.append(pcm(5));
    await flush();
    expect(listening!.opened).toEqual([ALICE]);
    expect(inner().audio.every((b) => b[0] === 0)).toBe(true);
    listening!.emit('line', { callId: CALL, userId: BOB, participantId: 'p-bob', speakerName: 'Bob', text: 'the cookie bug is back', at: now, captionId: '', startMs: 100, endMs: 1500 });
    await flush();
    const lines = await store.lines(CALL, 0, 10);
    expect(lines.map((l) => [l.userId, l.text])).toEqual([[BOB, 'the cookie bug is back']]);
    // The session's own transcript of what it heard is not a line.
    inner().fire('inputTranscript', { text: 'Milo, hello', startMs: 0, endMs: 900, turnEnded: true });
    await flush();
    expect(await store.lines(CALL, 0, 10)).toHaveLength(1);
  });

  it('a tool call nobody was routed for is refused as unasked, whatever the session claims', async () => {
    await boot('1');
    inner().call('c-idle', 'search', { query: 'cookie' }, BOB);
    await flush();
    expect(inner().answers.find(([id]) => id === 'c-idle')?.[1]).toMatch(/refused|could not/);
    expect(await runtime.turnsFor(CALL, BOB)).toHaveLength(0);
  });

  it('a tool call while Alice is routed is Alice\'s (no name lock on the transcript needed)', async () => {
    await boot('1');
    listening!.emit('name', { userId: ALICE, sentenceId: 's1', sentenceStartMs: 0, nameEndMs: 300, textSoFar: 'Milo' });
    await flush();
    expect(runtime.handsfreeRun(CALL)!.state()).toMatchObject({ phase: 'routing', userId: ALICE });
    inner().call('c-1', 'search', { query: 'cookie' });
    await flush();
    // Held until the rules call it a request (the name alone is not one).
    expect(await runtime.turnsFor(CALL, ALICE)).toHaveLength(0);
    listening!.emit('sentence', { userId: ALICE, sentenceId: 's1', text: 'Milo, search for cookie', startMs: 0, endMs: 1200, named: true });
    await flush();
    const turns = await runtime.turnsFor(CALL, ALICE);
    expect(turns.map((t) => t.tool.name)).toEqual(['search']);
  });

  it('a write the model starts on the name delta never runs when the sentence turns out to be a mention (and posts nothing)', async () => {
    await boot('1');
    rules.verdictFor = () => ({ kind: 'mention' });
    listening!.emit('name', { userId: ALICE, sentenceId: 's1', sentenceStartMs: 0, nameEndMs: 300, textSoFar: "Milo's summary" });
    await flush();
    inner().call('c-w', 'create', { kind: 'work-item', fields: { title: 'delete that item' } });
    await flush();
    expect(inner().answers.find(([id]) => id === 'c-w')).toBeUndefined();
    listening!.emit('sentence', { userId: ALICE, sentenceId: 's1', text: "Milo's summary is wrong, delete that item", startMs: 0, endMs: 1800, named: true });
    await flush();
    expect(inner().answers.find(([id]) => id === 'c-w')?.[1]).toMatch(/refused|could not/);
    expect(await runtime.turnsFor(CALL, ALICE)).toHaveLength(0);
    expect(mockPosts.actions).toHaveLength(0);
    // Nobody asked, so nobody is told to ask again.
    expect(mockPosts.replies).toHaveLength(0);
  });

  it('Milo\'s voice goes through the router: nothing relayed while idle, the answer relayed once the request is judged', async () => {
    await boot('1');
    await store.setVoice(CALL, true); runtime.setVoice(CALL, true);
    inner().fire('outputAudio', { pcm: pcm(9), seq: 1, last: true });
    await flush();
    expect(sent).toEqual([]);
    listening!.emit('name', { userId: ALICE, sentenceId: 's1', sentenceStartMs: 0, nameEndMs: 300, textSoFar: 'Milo' });
    await flush();
    listening!.emit('sentence', { userId: ALICE, sentenceId: 's1', text: 'Milo, what is blocking auth?', startMs: 0, endMs: 1200, named: true });
    await flush();
    inner().fire('outputAudio', { pcm: pcm(9), seq: 2 });
    inner().fire('outputAudio', { pcm: pcm(9), seq: 3, last: true });
    await flush();
    expect(sent).toHaveLength(2);
    expect(runtime.handsfreeRun(CALL)!.state()).toMatchObject({ phase: 'follow-up', userId: ALICE });
  });

  it("the transcript's own request detector answers nothing under the flag (the rules' verdict is the only path: no second \"time left\", no fallback)", async () => {
    const asked: string[] = [];
    const HELD: MeetingAssistantPolicy = {
      ...DEFAULT_POLICY, id: 'hf-held',
      answerFromHeldText: async (_c, r) => { asked.push(r.text); return 'Ten minutes are left.'; },
      heldFallback: async (_c, r) => { asked.push(`fallback:${r.text}`); return 'I can only do a few things.'; },
    };
    const off = registerMeetingAssistantPolicy('orgiq:initiative', HELD);
    try {
      await boot('1');
      await store.setVoice(CALL, true); runtime.setVoice(CALL, true);
      listening!.emit('line', { callId: CALL, userId: ALICE, participantId: 'p-alice', speakerName: 'Alice', text: 'Milo, how much time is left?', at: now, captionId: '', startMs: 0, endMs: 1500 });
      await flush();
      now += 5000; await intake.tick(); await flush();
      now += 20_000; await intake.tick(); await flush();
      expect((await store.lines(CALL, 0, 10)).map((l) => l.text)).toEqual(['Milo, how much time is left?']);
      expect(asked).toEqual([]);
      expect(sent).toEqual([]);
      expect(mockPosts.replies).toEqual([]);
    } finally { off(); }
  });

  it('lines heard after a pause and resume are stored, though the new listening side numbers its sentences from 1 again', async () => {
    await boot('1');
    const line = (text: string) => ({ callId: CALL, userId: ALICE, participantId: 'p-alice', speakerName: 'Alice', text, at: now, captionId: `hf:${ALICE}:1:1`, startMs: 0, endMs: 900 });
    listening!.emit('line', line('before the pause'));
    await flush();
    const first = listening!;
    await runtime.pause(CALL); await runtime.resume(CALL); await flush();
    expect(listening).not.toBe(first);
    now += 1000;
    listening!.emit('line', line('after the resume'));
    await flush();
    expect((await store.lines(CALL, 0, 10)).map((l) => l.text)).toEqual(['before the pause', 'after the resume']);
  });

  it("Milo's own voice heard back in a person's mic is not stored as their line (the echo guard, as with the flag off)", async () => {
    await boot('1');
    await store.setVoice(CALL, true); runtime.setVoice(CALL, true);
    listening!.emit('name', { userId: ALICE, sentenceId: 's1', sentenceStartMs: 0, nameEndMs: 300, textSoFar: 'Milo' });
    await flush();
    listening!.emit('sentence', { userId: ALICE, sentenceId: 's1', text: 'Milo, what is blocking auth?', startMs: 0, endMs: 1200, named: true });
    await flush();
    inner().fire('outputTranscript', { text: 'The cookie bug is blocking auth.', final: false });
    for (let i = 1; i <= 10; i += 1) inner().fire('outputAudio', { pcm: pcm(9), seq: i, ...(i === 10 ? { last: true } : {}) });
    inner().fire('outputTranscript', { text: 'The cookie bug is blocking auth.', final: true });
    await flush();
    expect(sent).toHaveLength(10);
    const at = now - T0;
    listening!.emit('line', { callId: CALL, userId: BOB, participantId: 'p-bob', speakerName: 'Bob', text: 'the cookie bug is blocking auth', at: now + 900, captionId: 'hf:b:1', startMs: at + 100, endMs: at + 900 });
    await flush();
    expect(await store.lines(CALL, 0, 10)).toHaveLength(0);
    expect(runtime.callStats(CALL).echoLinesDropped).toBe(1);
  });

  it('a person who leaves the call is let go: their lane (and its transcription stream) closes and their floor frees, once', async () => {
    seats = [{ userId: ALICE, active: true }, { userId: BOB, active: true }];
    await boot('1');
    audioTap.sink!.placed(BOB, pcm(1), 0);
    await flush();
    listening!.emit('name', { userId: BOB, sentenceId: 's1', sentenceStartMs: 0, nameEndMs: 300, textSoFar: 'Milo' });
    await flush();
    expect(runtime.handsfreeRun(CALL)!.state()).toMatchObject({ phase: 'routing', userId: BOB });
    await runtime.tick();
    expect(listening!.closedLanes).toEqual([]);
    seats = [{ userId: ALICE, active: true }, { userId: BOB, active: false }];
    now += 5_000; await runtime.tick();
    expect(listening!.closedLanes).toEqual([BOB]);
    expect(runtime.handsfreeRun(CALL)!.state()).toMatchObject({ phase: 'idle' });
    now += 5_000; await runtime.tick();
    expect(listening!.closedLanes).toEqual([BOB]);
    // Back in the call: their next audio opens a lane again.
    seats = [{ userId: ALICE, active: true }, { userId: BOB, active: true }];
    now += 5_000; await runtime.tick();
    audioTap.sink!.placed(BOB, pcm(1), 100);
    await flush();
    expect(listening!.opened.filter((u) => u === BOB)).toHaveLength(2);
  });

  it('the floor is pushed on the call channel when it changes, once per change, and cleared at the stop', async () => {
    await boot('1');
    await flush();
    expect(floors.map((f) => [f.type, f.channel, f.handsfree, f.floor?.userId ?? null])).toEqual([['assistant-floor', `orgiq:huddle:${CALL}`, true, null]]);
    listening!.emit('name', { userId: ALICE, sentenceId: 's1', sentenceStartMs: 0, nameEndMs: 300, textSoFar: 'Milo' });
    await flush();
    expect(floors.at(-1)).toMatchObject({ handsfree: true, floor: { userId: ALICE } });
    const n = floors.length;
    await runtime.tick(); await flush();
    expect(floors).toHaveLength(n);
    await runtime.stop(CALL); await flush();
    expect(floors.at(-1)).toMatchObject({ handsfree: false, floor: null });
  });

  it('a stop closes the listening side with the session', async () => {
    await boot('true');
    const l = listening!;
    await runtime.stop(CALL);
    expect(l.closed).toBe(true);
    expect(runtime.handsfreeRun(CALL)).toBeNull();
  });

  it('a fixed verdict\'s server line (sayFixed) plays through the router: Milo is playing, words over it cut it, its asker gets the window', async () => {
    await boot('1');
    await store.setVoice(CALL, true); runtime.setVoice(CALL, true);
    const LINE = 'About twelve minutes are left in this round.';
    rules.verdictFor = () => ({ kind: 'fixed', line: LINE });
    const hf = runtime.handsfreeRun(CALL) as unknown as import('../handsfree/runtime.js').HandsfreeRuntime;
    const drops: string[] = [];
    hf.on('drop', (d) => drops.push(d.reason));
    listening!.emit('name', { userId: ALICE, sentenceId: 's1', sentenceStartMs: 0, nameEndMs: 300, textSoFar: 'Milo' });
    await flush();
    listening!.emit('sentence', { userId: ALICE, sentenceId: 's1', text: 'Milo, how long is left?', startMs: 0, endMs: 1200, named: true });
    await flush();
    const req = inner().asked[0]!;
    expect(req.text).toBe(LINE);
    expect(req.answersTurn).toBe(true); // it answers the routed turn: not held behind it or the session's reply
    inner().fire('outputTranscript', { text: LINE, final: true, say: req.id });
    for (let i = 0; i < 6; i++) inner().fire('outputAudio', { pcm: pcm(9), seq: i + 1, say: req.id, ...(i === 5 ? { last: true as const } : {}) });
    req.ended(LINE);
    await flush();
    expect(hf.router.playing()).toBe(true);
    listening!.emit('words', { userId: BOB, sentenceId: 'b1', delta: 'stop', atMs: 2_000 });
    expect(drops).toContain('barge-in');
  });

  it('a server tool\'s line coming mutes the session\'s own words until it plays (the preamble is not heard)', async () => {
    await boot('1');
    await store.setVoice(CALL, true); runtime.setVoice(CALL, true);
    const hf = runtime.handsfreeRun(CALL) as unknown as import('../handsfree/runtime.js').HandsfreeRuntime;
    const muted: boolean[] = [];
    const orig = hf.router.serverLine.bind(hf.router);
    hf.router.serverLine = (c: boolean) => { muted.push(c); orig(c); };
    hf.serverLine(true);
    expect(muted).toEqual([true]);
  });
});


// The turn owner's seam (Milo rebuild 1B): one switch, and only for a call whose policy has the turn contract.
describe('the turn owner seam (MILO_TURN_OWNER)', () => {
  const CAN_DO = 'I can repeat the question or tell you the time.';
  const logged: SpokenLine[] = [];
  const bodies: Array<{ store?: boolean; input: string }> = [];
  let pickTool = 'cannot_help';
  let off: (() => void) | null = null;
  const saved = { owner: process.env['MILO_TURN_OWNER'], key: process.env['OPENAI_API_KEY'] };
  const contract: MeetingAssistantPolicy = {
    ...DEFAULT_POLICY, id: 'turn-test',
    roleOf: async () => 'lead', toolsFor: async () => [], answersFreely: () => false, instructions: () => 'A test call.', cannotHelp: () => CAN_DO,
    context: async () => '', mayHold: () => true, logSpoken: async (_c, line) => { logged.push(line); return 'row'; },
  };
  /** Bounded: the owner runs on real timers here (one 100 ms frame per line). */
  const until = async (ok: () => boolean | Promise<boolean>) => { for (let i = 0; i < 100 && !(await ok()); i += 1) { await new Promise<void>((r) => setTimeout(r, 20)); await flush(); } };
  beforeEach(() => {
    logged.length = 0; bodies.length = 0; pickTool = 'cannot_help';
    process.env['OPENAI_API_KEY'] = 'test-key';
    _setTextFetch(async (_u, init) => { bodies.push(JSON.parse(init.body)); return { status: 200, text: async () => JSON.stringify({ output: [{ type: 'function_call', name: pickTool, arguments: '{}' }] }) }; });
  });
  afterEach(() => {
    off?.(); off = null; _setTextFetch(null);
    for (const [k, v] of [['MILO_TURN_OWNER', saved.owner], ['OPENAI_API_KEY', saved.key]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  it('switch off, or a policy without the turn contract: the hands-free runtime, as today', async () => {
    off = registerMeetingAssistantPolicy('orgiq:initiative', contract);
    delete process.env['MILO_TURN_OWNER'];
    await boot('1');
    expect(runtime.handsfreeRun(CALL)).not.toBeInstanceOf(TurnOwner);
    await runtime.dispose();
    off(); off = null;
    process.env['MILO_TURN_OWNER'] = '1';
    await boot('1');
    expect(runtime.handsfreeRun(CALL)).not.toBeNull();
    expect(runtime.handsfreeRun(CALL)).not.toBeInstanceOf(TurnOwner);
  });

  it('switch on with the contract: a named sentence is decided once (store: false), its fixed line is logged, posted and then said; the session hears and says nothing', async () => {
    off = registerMeetingAssistantPolicy('orgiq:initiative', contract);
    process.env['MILO_TURN_OWNER'] = '1';
    await boot('1');
    await store.setVoice(CALL, true); runtime.setVoice(CALL, true);
    expect(runtime.handsfreeRun(CALL)).toBeInstanceOf(TurnOwner);
    audioTap.sink!.append(pcm(1));
    inner().fire('outputAudio', { pcm: pcm(9), seq: 1, last: true });
    listening!.emit('sentence', { userId: BOB, sentenceId: 's0', text: 'I think the cache is fine.', startMs: 0, endMs: 900, named: false });
    listening!.emit('sentence', { userId: ALICE, sentenceId: 's1', text: 'Milo, is my approach right?', startMs: 1000, endMs: 2200, named: true });
    await until(() => sent.length === 1 && mockPosts.replies.length === 1);
    await new Promise<void>((r) => setTimeout(r, 150)); // the frame has played out
    expect(inner().audio).toEqual([]);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.store).toBe(false);
    expect(JSON.stringify(bodies[0]!.input)).toContain('Milo, is my approach right?');
    expect(logged.map((l) => [l.text, l.askedBy, l.tool])).toEqual([[CAN_DO, ALICE, 'cannot_help']]);
    expect(mockPosts.replies).toEqual([{ text: CAN_DO, askedBy: ALICE, askedByName: 'Alice' }]);
    expect(sent).toHaveLength(1);
    expect(floors.some((f) => f.handsfree && f.floor?.userId === ALICE)).toBe(true);
    // "Have Milo ask": the server's words go through the owner's mouth, not the session.
    expect(await runtime.sayHeldTextWhy(CALL, 'What is a hash map?', ALICE)).toEqual({ outcome: 'spoken', why: null });
    expect(inner().asked).toEqual([]);
    expect(sent).toHaveLength(2);
  });

  it('"Milo, stop listening" pauses the call through the same steps as the button', async () => {
    off = registerMeetingAssistantPolicy('orgiq:initiative', contract);
    process.env['MILO_TURN_OWNER'] = '1';
    await boot('1');
    pickTool = 'pause_listening';
    listening!.emit('sentence', { userId: ALICE, sentenceId: 's1', text: 'Milo, please stop listening for now.', startMs: 0, endMs: 1200, named: true });
    await until(async () => (await store.get(CALL))!.state === 'paused' && runtime.handsfreeRun(CALL) === null && mockPosts.notices.length > 0);
    expect((await store.get(CALL))!.state).toBe('paused');
    expect(mockPosts.notices.some((n) => n.includes('Alice'))).toBe(true);
    expect(runtime.handsfreeRun(CALL)).toBeNull();
  });
});

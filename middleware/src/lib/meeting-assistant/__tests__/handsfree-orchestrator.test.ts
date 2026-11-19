// The orchestrator's hands-free seam (lane B): MEETING_ASSISTANT_HANDSFREE read once as a run starts; under it the session hears only
// what the router feeds, heard lines come from the listening side with exact speakers, Milo's voice goes through the router, and a
// tool call's asker is only the routed person. Listening side and rules are fakes of lanes A and C (handsfree-fakes.ts). The chat
// module is the same recorder as orchestrator.test.ts.
jest.mock('../../../config.js', () => ({ config: { region: 'us-east-1', auth: {}, cognito: {}, mock: { aurora: true }, meetingAssistant: { enabled: true, transcriptRetentionDays: 30 } } }));
jest.mock('../../../providers/identity.js', () => ({ getUser: jest.fn(async () => null) }));
// Notifications go nowhere here (the absent-people step of a dismiss would otherwise reach for a real inbox).
jest.mock('../../social-notify.js', () => ({ notify: jest.fn(async () => []) }));
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
import type { AudioSink } from '../audio-intake.js';
import { HandsfreeTalking } from '../handsfree/talking.js';
import type { HandsfreeClock } from '../handsfree/types.js';
import { FakeListening, FakeRules, type FakeClock } from './handsfree-fakes.js';

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
const audioTap: { sink: AudioSink | null; attach(callId: string, sink: AudioSink): void; suspend(callId: string): void; detach(callId: string): void } = {
  sink: null, attach(_c, sink) { this.sink = sink; }, suspend() { this.sink = null; }, detach() { this.sink = null; },
};
const ctx: StartContext = { callId: CALL, tenant: 'orgiq', inviterId: ALICE, roster: ['Alice', 'Bob', 'Carol'], recordName: 'Auth Migration' };
const pcm = (tag: number) => Buffer.alloc(4800, tag);
const savedFlag = process.env['MEETING_ASSISTANT_HANDSFREE'];

async function boot(flag: string | undefined, withSides = true): Promise<void> {
  if (flag === undefined) delete process.env['MEETING_ASSISTANT_HANDSFREE']; else process.env['MEETING_ASSISTANT_HANDSFREE'] = flag;
  listening = null; rules = new FakeRules(); sent = [];
  runtime = new AssistantRuntime({
    store: () => store, intake: () => intake, clock: () => now, makeSession: () => new FakeSession(),
    rolesOf: async () => ['member'], audio: audioTap, voiceSink: (_c, frame) => { sent.push(frame.data.seq); return true; },
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
    const turns = await runtime.turnsFor(CALL, ALICE);
    expect(turns.map((t) => t.tool.name)).toEqual(['search']);
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

  it('a stop closes the listening side with the session', async () => {
    await boot('true');
    const l = listening!;
    await runtime.stop(CALL);
    expect(l.closed).toBe(true);
    expect(runtime.handsfreeRun(CALL)).toBeNull();
  });
});


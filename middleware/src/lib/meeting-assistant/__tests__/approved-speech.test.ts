// Approved speech on the call's one gate and relay (interviews decision 9; orchestrator.ts `sayHeldText`, approved-speech.ts).
// The bar: in a call whose policy relays nothing of the live model, nothing it says on its own is heard or posted; words the server
// holds are said only when the session's transcript of them is the same words, held whole until then; nothing else is relayed while
// one is outstanding; Work's default is untouched.
jest.mock('../../../config.js', () => ({ config: { region: 'us-east-1', auth: {}, cognito: {}, mock: { aurora: true }, meetingAssistant: { enabled: true, transcriptRetentionDays: 30 } } }));
jest.mock('../../../providers/identity.js', () => ({ getUser: jest.fn(async () => null) }));
jest.mock('../../social-notify.js', () => ({ notify: jest.fn(async () => []) }));
const mockPosts = { replies: [] as string[], notices: [] as string[], approved: [] as string[] };
const mockTrace: Array<{ ev: string; f: Record<string, unknown> }> = [];
jest.mock('../trace.js', () => ({ trace: (ev: string, f: Record<string, unknown> = {}) => { mockTrace.push({ ev, f }); } }));
jest.mock('../chat.js', () => ({
  nameOf: async (id: string) => id,
  postReply: async (_c: string, r: { text: string }) => { mockPosts.replies.push(r.text); return { id: 'm' }; },
  postApprovedAnswer: async (_c: string, text: string) => { mockPosts.approved.push(text); return { id: 'a' }; },
  postPrivately: async () => true,
  postNoticeQuietly: async (_c: string, text: string) => { mockPosts.notices.push(text); },
  noticeText: (jest.requireActual('../chat.js') as typeof import('../chat.js')).noticeText,
  postAction: async () => ({ message: { id: 'x' }, created: true }),
  moveAction: async () => null,
}));

import { LineIntake } from '../intake.js';
import { MemoryAssistantStore } from '../store.js';
import { MockTranscriptSource } from '../transcript-source.js';
import { AssistantRuntime, type StartContext } from '../orchestrator.js';
import { ScriptedSession, SCRIPT_TONE_FRAMES } from '../scripted-session.js';
import { OUTPUT_TAIL_FRAMES } from '../live-session.js';
import { SessionEmitter, SessionTextUnsupported, type LiveMeetingSession, type SessionEvents, type SessionStartInput } from '../session.js';
import { newAssistantSession } from '../types.js';
import { setAssistantStore } from '../store-select.js';
import { DEFAULT_POLICY, registerMeetingAssistantPolicy, type MeetingAssistantPolicy } from '../policy.js';
import { NOT_SAID_ALOUD, numberWords, ordinalWords, saidVerbatim, sayBoundMs, speakableText, spokenWords } from '../approved-speech.js';

const CALL = 'call-say';
const ALICE = 'u-alice', GUEST = 'guest:inv-1';
const T0 = Date.parse('2026-11-17T12:00:00.000Z');
const QUESTION = 'Walk me through how you would design a rate limiter for a public API.';
const flush = async () => { for (let i = 0; i < 8; i += 1) await new Promise<void>((r) => setImmediate(r)); };
const TONE = SCRIPT_TONE_FRAMES + OUTPUT_TAIL_FRAMES;

/** A provider-shaped session the test drives: it records `sayVerbatim` requests and the test finishes them. */
class FakeSession extends SessionEmitter implements LiveMeetingSession {
  readonly kind = 'openai' as const;
  readonly acceptsText = false;
  readonly asked: Array<{ id: string; text: string; ended: (t: string | null) => void }> = [];
  async start(_i: SessionStartInput) { /* nothing */ }
  pendingInputText() { return ''; }
  appendAudio() { /* nothing */ }
  sendText(): void { throw new SessionTextUnsupported(); }
  answerToolCall() { return false; }
  appendContext() { return true; }
  sayVerbatim(id: string, text: string, ended: (t: string | null) => void) { this.asked.push({ id, text, ended }); return true; }
  async close() { this.emit('closed', { reason: 'close_requested' }); }
  fire<K extends keyof SessionEvents>(type: K, event: SessionEvents[K]) { this.emit(type, event); }
  /** `n` voiced frames, tagged for a say request or not. */
  frames(n: number, say?: string) { for (let i = 0; i < n; i += 1) this.emit('outputAudio', { pcm: Buffer.alloc(4800, 9), seq: i + 1, ...(i === n - 1 ? { last: true as const } : {}), ...(say ? { say } : {}) }); }
}

const NO_RELAY: MeetingAssistantPolicy = { ...DEFAULT_POLICY, id: 'say-test', relaysLiveSpeech: () => false };
let unregister: (() => void) | null = null;
let now: number;
let store: MemoryAssistantStore;
let intake: LineIntake;
let runtime: AssistantRuntime;
let sent: Array<{ seq: number; last?: boolean }>;
let factory: () => LiveMeetingSession;

async function startCall(lobby: string): Promise<void> {
  await store.create({
    callId: CALL, tenant: 'orgiq', lobby, initiativeId: null, state: 'listening', invitedBy: ALICE, invitedAt: now,
    pausedBy: null, leftAt: null, leftBy: null, acked: [ALICE, GUEST], attendees: [ALICE, GUEST], presentAtInvite: [ALICE, GUEST],
    requests: 0, linesStored: 0, nextSeq: 1, pendingRequests: [], session: newAssistantSession(3600),
  });
  const ctx: StartContext = { callId: CALL, tenant: 'orgiq', inviterId: ALICE, roster: ['Alice'], recordName: 'Round' };
  runtime = new AssistantRuntime({
    store: () => store, intake: () => intake, clock: () => now, makeSession: () => factory(), rolesOf: async () => ['member'],
    voiceSink: (_ch, frame) => { sent.push({ seq: frame.data.seq, ...(frame.data.last ? { last: true } : {}) }); return true; },
  }, { tickMs: 0 });
  await runtime.start(ctx);
  await store.setVoice(CALL, true); runtime.setVoice(CALL, true);
}
const scripted = () => runtime.sessionOf(CALL) as ScriptedSession;
const fake = () => runtime.sessionOf(CALL) as unknown as FakeSession;
const voiceTrace = (): Array<Record<string, unknown>> => mockTrace.filter((t) => t.ev === 'voice' || t.ev === 'voice.approved').map((t) => ({ ev: t.ev, ...t.f }));

beforeAll(() => { unregister = registerMeetingAssistantPolicy('orgiq:saytest', NO_RELAY); });
afterAll(() => { unregister?.(); });
beforeEach(() => {
  now = T0; sent = []; mockTrace.length = 0;
  mockPosts.replies.length = 0; mockPosts.notices.length = 0; mockPosts.approved.length = 0;
  store = new MemoryAssistantStore(); setAssistantStore(store);
  const source = new MockTranscriptSource();
  intake = new LineIntake(store, { clock: () => now, tickMs: 0, source: () => source });
  intake.start(CALL);
  factory = () => new ScriptedSession(() => now);
});
afterEach(async () => { await runtime?.dispose(); intake.dispose(); setAssistantStore(null); });

describe('the words check (approved-speech.ts)', () => {
  it('compares words only: case, punctuation, curly quotes and spacing aside; anything else differs', () => {
    expect(spokenWords('  What’s   your  approach? ')).toBe('whats your approach');
    expect(saidVerbatim(QUESTION, QUESTION.toUpperCase().replace(/\./, ''))).toBe(true);
    expect(saidVerbatim(QUESTION, `${QUESTION} Take your time.`)).toBe(false);
    expect(saidVerbatim(QUESTION, 'How would you design a rate limiter?')).toBe(false);
    expect(saidVerbatim('', '')).toBe(false);
    expect(saidVerbatim(QUESTION, null)).toBe(false);
  });

  it('normalises how a provider says the words: numbers, ordinals, percent, compounds, contractions', () => {
    expect(numberWords('59')).toBe('fifty-nine');
    expect(numberWords('999')).toBe('nine hundred ninety-nine');
    expect(numberWords('1200')).toBe('one thousand two hundred');
    expect(ordinalWords('21')).toBe('twenty-first');
    expect(speakableText('About 59 minutes are left.')).toBe('About fifty-nine minutes are left.');
    expect(saidVerbatim('About 59 minutes are left in this round.', 'About fifty-nine minutes are left in this round.')).toBe(true);
    expect(saidVerbatim('About 59 minutes are left in this round.', 'About fifty nine minutes are left in this round')).toBe(true);
    expect(saidVerbatim('We have 105 rows.', 'We have one hundred and five rows.')).toBe(true);
    expect(saidVerbatim('Take the 1st and 3rd cases.', 'Take the first and third cases.')).toBe(true);
    expect(saidVerbatim('Cut latency by 40%.', 'Cut latency by forty percent.')).toBe(true);
    expect(saidVerbatim('A 2.5 second budget.', 'A two point five second budget.')).toBe(true);
    expect(saidVerbatim('It handles 1,000 writes.', 'It handles one thousand writes.')).toBe(true);
    expect(saidVerbatim('survives a region failover', 'survives a region fail over')).toBe(true);
    expect(saidVerbatim('a double-entry ledger', 'a double entry ledger')).toBe(true);
    expect(saidVerbatim('a write-ahead log', 'a writeahead log')).toBe(true);
    expect(saidVerbatim("Don't skip the edge cases; you're fine.", 'Do not skip the edge cases; you are fine.')).toBe(true);
    expect(saidVerbatim('You cannot retry it.', "You can't retry it.")).toBe(true);
  });

  it('still withholds a paraphrase or any word added, dropped or changed', () => {
    expect(saidVerbatim('About 59 minutes are left in this round.', 'About sixty minutes are left in this round.')).toBe(false);
    expect(saidVerbatim('About 59 minutes are left in this round.', 'About fifty-nine minutes left in this round.')).toBe(false);
    expect(saidVerbatim('About 59 minutes are left in this round.', 'About fifty-nine minutes are left in this round. Good luck.')).toBe(false);
    expect(saidVerbatim('Cut latency by 40%.', 'Cut latency by forty.')).toBe(false);
    expect(saidVerbatim('survives a region failover', 'survives a regional failover')).toBe(false);
    expect(saidVerbatim("Don't skip the edge cases.", 'Do skip the edge cases.')).toBe(false);
    expect(saidVerbatim('Take the 1st case.', 'Take the third case.')).toBe(false);
    expect(saidVerbatim(QUESTION, 'Walk me through how you would build a rate limiter for a public API.')).toBe(false);
  });
  it('the bound grows with the words and is capped', () => {
    expect(sayBoundMs('x')).toBeGreaterThanOrEqual(8000);
    expect(sayBoundMs('x'.repeat(5000))).toBe(45_000);
    expect(NOT_SAID_ALOUD).toBe('Milo could not say it aloud. The question is in the call chat.');
  });
});

describe('a call whose policy relays nothing of the live model (an interview)', () => {
  it('1. the live model speaks unprompted: no frame is relayed and nothing is posted', async () => {
    factory = () => new FakeSession();
    await startCall('orgiq:saytest:r1');
    const s = fake();
    s.frames(25);
    s.fire('outputTranscript', { text: 'I think the candidate is doing well.', final: true });
    await flush();
    expect(sent).toEqual([]);
    expect(mockPosts.replies).toEqual([]);
    expect(mockPosts.notices).toEqual([]);
  });

  it('2. approved words on the scripted session: its frames are relayed whole under the gate reason `approved`', async () => {
    await startCall('orgiq:saytest:r2');
    const out = await runtime.sayHeldText(CALL, QUESTION, ALICE);
    await flush();
    expect(out).toBe('spoken');
    expect(sent).toHaveLength(TONE);
    expect(sent.at(-1)!.last).toBe(true);
    expect(voiceTrace()).toEqual(expect.arrayContaining([
      expect.objectContaining({ ev: 'voice', decision: 'open', why: 'approved' }),
      expect.objectContaining({ ev: 'voice.approved', decision: 'relayed', why: 'relayed' }),
    ]));
    // The transcript of approved words is never posted again (the caller posted them first).
    expect(mockPosts.replies).toEqual([]);
  });

  it('then the scripted session says something of its own: nothing more is relayed or posted', async () => {
    await startCall('orgiq:saytest:r3');
    expect(await runtime.sayHeldText(CALL, QUESTION, ALICE)).toBe('spoken');
    const count = sent.length;
    scripted().speakUnprompted('Here is a hint: use a token bucket.');
    await flush();
    expect(sent).toHaveLength(count);
    expect(mockPosts.replies).toEqual([]);
  });

  it('3. a paraphrase is withheld whole: no frame relayed, the trace says mismatch in codes', async () => {
    await startCall('orgiq:saytest:r4');
    scripted().sayAs = (t) => `${t} Take your time.`;
    expect(await runtime.sayHeldText(CALL, QUESTION, ALICE)).toBe('posted');
    await flush();
    expect(sent).toEqual([]);
    expect(voiceTrace()).toEqual(expect.arrayContaining([expect.objectContaining({ ev: 'voice.approved', decision: 'withheld', why: 'mismatch' })]));
    expect(voiceTrace().some((t) => t.ev === 'voice' && t.decision === 'open')).toBe(false);
  });

  it('3. frames arrive but no transcript inside the bound: withheld whole, nothing relayed as it arrived', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'queueMicrotask', 'nextTick'] });
    try {
      factory = () => new FakeSession();
      await startCall('orgiq:saytest:r5');
      const s = fake();
      const pending = runtime.sayHeldText(CALL, QUESTION, ALICE);
      await flush();
      const req = s.asked[0]!;
      expect(req.text).toBe(QUESTION);
      s.frames(12, req.id);
      await flush();
      expect(sent).toEqual([]);
      jest.advanceTimersByTime(sayBoundMs(QUESTION) + 1);
      expect(await pending).toBe('posted');
      req.ended(QUESTION); // too late: it changes nothing
      await flush();
      expect(sent).toEqual([]);
      expect(voiceTrace()).toEqual(expect.arrayContaining([expect.objectContaining({ ev: 'voice.approved', decision: 'withheld', why: 'timeout' })]));
    } finally { jest.useRealTimers(); }
  });

  it('3. the transcript arrives with no words, or without audio: withheld', async () => {
    factory = () => new FakeSession();
    await startCall('orgiq:saytest:r6');
    const s = fake();
    let p = runtime.sayHeldText(CALL, QUESTION, ALICE);
    await flush();
    s.frames(5, s.asked[0]!.id); s.asked[0]!.ended(null);
    expect(await p).toBe('posted');
    p = runtime.sayHeldText(CALL, QUESTION, ALICE);
    await flush();
    s.asked[1]!.ended(QUESTION);
    expect(await p).toBe('posted');
    expect(sent).toEqual([]);
  });

  it('voice off, paused, or a second request while one is outstanding: chat only, and the session is not asked', async () => {
    factory = () => new FakeSession();
    await startCall('orgiq:saytest:r7');
    const s = fake();
    const first = runtime.sayHeldText(CALL, QUESTION, ALICE);
    await flush();
    expect(await runtime.sayHeldText(CALL, 'Another question?', ALICE)).toBe('posted');
    expect(s.asked).toHaveLength(1);
    runtime.setVoice(CALL, false);
    expect(await first).toBe('posted');
    expect(await runtime.sayHeldText(CALL, QUESTION, ALICE)).toBe('posted');
    expect(s.asked).toHaveLength(1);
    expect(await runtime.sayHeldText('no-such-call', QUESTION, ALICE)).toBe('no-call');
  });
});

describe('4. while an approved utterance is outstanding, no other response is relayed (even in a call that relays the live model)', () => {
  it('untagged frames and frames of another request are dropped; the approved frames go out once checked', async () => {
    factory = () => new FakeSession();
    await startCall('orgiq:initiative:p-1'); // Work's default policy: it relays the live model when asked
    const s = fake();
    const p = runtime.sayHeldText(CALL, QUESTION, ALICE);
    await flush();
    const req = s.asked[0]!;
    s.frames(10);              // another response of the model's
    s.frames(4, 'say_other');  // frames tagged for some other request
    s.frames(9, req.id);       // the approved utterance's own
    await flush();
    expect(sent).toEqual([]);  // held whole: nothing yet
    req.ended(QUESTION);
    expect(await p).toBe('spoken');
    expect(sent).toHaveLength(9);
  });
});

describe('5. Work is untouched', () => {
  it('the default policy relays the live model, and a request in a Work call is answered aloud as before', async () => {
    expect(DEFAULT_POLICY.relaysLiveSpeech({ callId: 'c', lobby: 'orgiq:initiative:p', tenant: 'orgiq' })).toBe(true);
    await startCall('orgiq:initiative:p-2');
    await intake.handle(CALL, { userId: ALICE, text: 'Milo, what is two plus two?', at: now });
    now += 5000; await intake.tick(); await flush();
    expect(sent).toHaveLength(TONE);
    expect(voiceTrace().filter((t) => t.ev === 'voice').map((t) => t.why)).toEqual(['addressed']);
  });
});

describe('6. a held answer (the policy\'s fixed requests) never reaches the model', () => {
  it('posted with the approved mark, said as approved words, noted for the policy; the session\'s sendText is not called', async () => {
    const noted: Array<{ text: string; spoken: boolean }> = [];
    const HELD: MeetingAssistantPolicy = {
      ...NO_RELAY, id: 'held-test',
      answerFromHeldText: async (_c, r) => (r.askedBy === GUEST ? 'About 20 minutes are left in this round.' : null),
      heldTextSaid: async (_c, said) => { noted.push({ text: said.text, spoken: said.spoken }); },
    };
    const off = registerMeetingAssistantPolicy('orgiq:heldtest', HELD);
    try {
      await startCall('orgiq:heldtest:r1');
      const s = scripted();
      const sendText = jest.spyOn(s, 'sendText');
      await intake.handle(CALL, { userId: GUEST, text: 'Milo, how much time is left?', at: now });
      now += 5000; await intake.tick(); await flush();
      expect(sendText).not.toHaveBeenCalled();
      expect(mockPosts.approved).toEqual(['About 20 minutes are left in this round.']);
      expect(mockPosts.replies).toEqual([]);
      expect(noted).toEqual([{ text: 'About 20 minutes are left in this round.', spoken: true }]);
      expect(sent).toHaveLength(TONE);
    } finally { off(); }
  });
});

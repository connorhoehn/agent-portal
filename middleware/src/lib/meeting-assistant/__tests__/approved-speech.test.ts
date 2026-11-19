// Approved speech on the call's one gate and relay (interviews decision 9; orchestrator.ts `sayHeldText`, approved-speech.ts).
// The bar: in a call whose policy relays nothing of the live model, nothing it says on its own is heard or posted; words the server
// holds are said only when the session's transcript of them is the same words, held whole until then; nothing else is relayed while
// one is outstanding; Work's default is untouched.
jest.mock('../../../config.js', () => ({ config: { region: 'us-east-1', auth: {}, cognito: {}, mock: { aurora: true }, meetingAssistant: { enabled: true, transcriptRetentionDays: 30 } } }));
jest.mock('../../../providers/identity.js', () => ({ getUser: jest.fn(async () => null) }));
jest.mock('../../social-notify.js', () => ({ notify: jest.fn(async () => []) }));
const mockPosts = { replies: [] as string[], notices: [] as string[], approved: [] as string[], approvedNames: [] as string[] };
const mockTrace: Array<{ ev: string; f: Record<string, unknown> }> = [];
jest.mock('../trace.js', () => ({ trace: (ev: string, f: Record<string, unknown> = {}) => { mockTrace.push({ ev, f }); } }));
jest.mock('../chat.js', () => ({
  nameOf: async (id: string) => id,
  postReply: async (_c: string, r: { text: string }) => { mockPosts.replies.push(r.text); return { id: 'm' }; },
  postApprovedAnswer: async (_c: string, text: string, _o?: unknown, by?: { askedByName?: string }) => { mockPosts.approved.push(text); mockPosts.approvedNames.push(by?.askedByName ?? ''); return { id: 'a' }; },
  postPrivately: async () => true,
  postNoticeQuietly: async (_c: string, text: string) => { mockPosts.notices.push(text); },
  noticeText: (jest.requireActual('../chat.js') as typeof import('../chat.js')).noticeText,
  postAction: async () => ({ message: { id: 'x' }, created: true }),
  moveAction: async () => null,
}));

import { LineIntake } from '../intake.js';
import { MemoryAssistantStore } from '../store.js';
import { MockTranscriptSource } from '../transcript-source.js';
import { AssistantRuntime, clearlyAsked, type StartContext } from '../orchestrator.js';
import { addScriptRules, ScriptedSession, SCRIPT_TONE_FRAMES } from '../scripted-session.js';
import { INTERVIEW_TOOLS, responsesFunctionTools } from '../../voice/catalogue.js';
import { OUTPUT_TAIL_FRAMES } from '../live-session.js';
import { READ_ALOUD_DELEGATE_RULE, READ_ALOUD_ONLY_RULE } from '../instructions.js';
import { SessionEmitter, SessionTextUnsupported, type LiveMeetingSession, type SessionEvents, type SessionStartInput } from '../session.js';
import { newAssistantSession } from '../types.js';
import { setAssistantStore } from '../store-select.js';
import { DEFAULT_POLICY, registerMeetingAssistantPolicy, type MeetingAssistantPolicy } from '../policy.js';
import { APPROVED_MS_PER_CHAR, APPROVED_STREAM_LAG_MS, heardPart, NOT_SAID_ALOUD, numberWords, ordinalWords, saidSoFar, saidVerbatim, sayBoundMs, SAY_QUIET_WAIT_MS, speakableText, spokenWords } from '../approved-speech.js';

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
  readonly asked: Array<{ id: string; text: string; ended: (t: string | null) => void; sent?: () => void }> = [];
  readonly cancelled: string[] = [];
  /** Busy (its own reply running): the line waits, unsent, until the test calls `sent` (as the live session does at quiet). */
  busy = false;
  startedWith: SessionStartInput | null = null;
  async start(i: SessionStartInput) { this.startedWith = i; }
  pendingInputText() { return ''; }
  appendAudio() { /* nothing */ }
  sendText(): void { throw new SessionTextUnsupported(); }
  answerToolCall() { return false; }
  contexts: string[] = [];
  appendContext(text: string) { this.contexts.push(text); return true; }
  sayVerbatim(id: string, text: string, ended: (t: string | null) => void, sent?: () => void) {
    this.asked.push({ id, text, ended, ...(sent ? { sent } : {}) });
    if (!this.busy) sent?.();
    return true;
  }
  cancelSay(id: string) { this.cancelled.push(id); }
  async close() { this.emit('closed', { reason: 'close_requested' }); }
  fire<K extends keyof SessionEvents>(type: K, event: SessionEvents[K]) { this.emit(type, event); }
  /** `n` voiced frames, tagged for a say request or not. */
  frames(n: number, say?: string, fill = 9) { for (let i = 0; i < n; i += 1) this.emit('outputAudio', { pcm: Buffer.alloc(4800, fill), seq: i + 1, ...(i === n - 1 ? { last: true as const } : {}), ...(say ? { say } : {}) }); }
}

const NO_RELAY: MeetingAssistantPolicy = { ...DEFAULT_POLICY, id: 'say-test', relaysLiveSpeech: () => false };
let unregister: (() => void) | null = null;
let now: number;
let store: MemoryAssistantStore;
let intake: LineIntake;
let runtime: AssistantRuntime;
let sent: Array<{ seq: number; last?: boolean }>;
/** The first byte of each relayed frame, in the order the relay sent them (the test fills each line's frames with its own byte). */
let sentBytes: number[];
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
    voiceSink: (_ch, frame) => { sent.push({ seq: frame.data.seq, ...(frame.data.last ? { last: true } : {}) }); sentBytes.push(Buffer.from(frame.data.pcm, 'base64')[0]!); return true; },
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
  now = T0; sent = []; sentBytes = []; mockTrace.length = 0;
  mockPosts.replies.length = 0; mockPosts.notices.length = 0; mockPosts.approved.length = 0; mockPosts.approvedNames.length = 0;
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
  it('the words so far: a start of the text counts (a word cut part way too); a changed, added or run-on word does not', () => {
    const T = 'About 59 minutes are left in this round.';
    for (const ok of ['About', 'about fif', 'About fifty-nine minutes', 'About fifty nine minutes are left in this round.']) expect(saidSoFar(T, ok)).toBe(true);
    for (const no of ['', 'Around', 'About sixty', 'About fifty-nine minutes are left in this round. Good luck', 'About fifty-nine hours']) expect(saidSoFar(T, no)).toBe(false);
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
      expect(s.cancelled).toEqual([req.id]);
    } finally { jest.useRealTimers(); }
  });

  it('3b. the line waits, unsent, until the session is quiet: the bound counts from when it is sent, and it is spoken', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'queueMicrotask', 'nextTick'] });
    try {
      factory = () => new FakeSession();
      await startCall('orgiq:saytest:r5b');
      const s = fake();
      s.busy = true; // someone is still speaking, or Milo's own words are still running
      const pending = runtime.sayHeldText(CALL, QUESTION, ALICE);
      await flush();
      const req = s.asked[0]!;
      jest.advanceTimersByTime(SAY_QUIET_WAIT_MS - 500);
      await flush();
      req.sent!(); // quiet: the session sends the line now
      jest.advanceTimersByTime(sayBoundMs(QUESTION) - 500); // longer than the wait: the bound counts from the send
      s.frames(12, req.id);
      req.ended(QUESTION);
      await jest.advanceTimersByTimeAsync(5000);
      expect(await pending).toBe('spoken');
      expect(sent.length).toBe(12);
      expect(s.cancelled).toEqual([]);
    } finally { jest.useRealTimers(); }
  });

  it('3b. a line never sent (no quiet within SAY_QUIET_WAIT_MS) stays in the chat only, and the session forgets it', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'queueMicrotask', 'nextTick'] });
    try {
      factory = () => new FakeSession();
      await startCall('orgiq:saytest:r5c');
      const s = fake();
      s.busy = true;
      const pending = runtime.sayHeldTextWhy(CALL, QUESTION, ALICE);
      await flush();
      jest.advanceTimersByTime(SAY_QUIET_WAIT_MS + 1);
      expect(await pending).toEqual({ outcome: 'posted', why: 'not-quiet' });
      expect(s.cancelled).toEqual([s.asked[0]!.id]);
      expect(voiceTrace()).toEqual(expect.arrayContaining([expect.objectContaining({ ev: 'voice.approved', decision: 'withheld', why: 'not-quiet' })]));
      expect(sent).toEqual([]);
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

  it('a second line while one is outstanding goes to the session\'s queue: said after the first, its quiet wait counted from then', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'queueMicrotask', 'nextTick'] });
    try {
      factory = () => new FakeSession();
      await startCall('orgiq:saytest:r7q');
      const s = fake();
      const first = runtime.sayHeldTextWhy(CALL, QUESTION, ALICE);
      await flush();
      s.busy = true; // the session holds the second line unsent until the first is over (one line at a time)
      const second = runtime.sayHeldTextWhy(CALL, 'Another question?', ALICE);
      await flush();
      expect(s.asked.map((a) => a.text)).toEqual([QUESTION, 'Another question?']);
      // The first line takes longer than the quiet wait; the second is still waiting for it, not withheld as not-quiet.
      jest.advanceTimersByTime(SAY_QUIET_WAIT_MS + 1000);
      s.frames(12, s.asked[0]!.id);
      s.asked[0]!.ended(QUESTION);
      await jest.advanceTimersByTimeAsync(3000);
      expect(await first).toEqual({ outcome: 'spoken', why: null });
      s.asked[1]!.sent!();
      s.frames(6, s.asked[1]!.id);
      s.asked[1]!.ended('Another question?');
      await jest.advanceTimersByTimeAsync(3000);
      expect(await second).toEqual({ outcome: 'spoken', why: null });
      expect(sent.length).toBe(18);
      expect(s.cancelled).toEqual([]);
    } finally { jest.useRealTimers(); }
  });

  it('two lines never play at once: the second is released only once the first one\'s frames have gone out', async () => {
    factory = () => new FakeSession();
    await startCall('orgiq:saytest:r7s');
    const s = fake();
    const first = runtime.sayHeldTextWhy(CALL, QUESTION, ALICE);
    const second = runtime.sayHeldTextWhy(CALL, 'Another question?', ALICE);
    await flush();
    // The first line's utterance ends; its release paces 40 frames at playout speed. The second's utterance ends meanwhile.
    s.frames(40, s.asked[0]!.id, 1);
    s.asked[0]!.ended(QUESTION);
    await flush();
    s.frames(6, s.asked[1]!.id, 2);
    s.asked[1]!.ended('Another question?');
    expect(await first).toEqual({ outcome: 'spoken', why: null });
    expect(await second).toEqual({ outcome: 'spoken', why: null });
    expect(sentBytes).toEqual([...Array(40).fill(1), ...Array(6).fill(2)]);
  }, 20_000);

  it('a queued line whose turn never comes within the quiet wait after the first is over stays in the chat', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'queueMicrotask', 'nextTick'] });
    try {
      factory = () => new FakeSession();
      await startCall('orgiq:saytest:r7r');
      const s = fake();
      const first = runtime.sayHeldTextWhy(CALL, QUESTION, ALICE);
      await flush();
      s.busy = true;
      const second = runtime.sayHeldTextWhy(CALL, 'Another question?', ALICE);
      await flush();
      s.asked[0]!.ended(null);
      expect(await first).toEqual({ outcome: 'posted', why: 'no-words' });
      jest.advanceTimersByTime(SAY_QUIET_WAIT_MS + 1);
      expect(await second).toEqual({ outcome: 'posted', why: 'not-quiet' });
      expect(s.cancelled).toEqual([s.asked[0]!.id, s.asked[1]!.id]);
    } finally { jest.useRealTimers(); }
  });

  it('voice off or paused: chat only, and the session is not asked; turning the voice off ends every line waiting', async () => {
    factory = () => new FakeSession();
    await startCall('orgiq:saytest:r7');
    const s = fake();
    const first = runtime.sayHeldText(CALL, QUESTION, ALICE);
    await flush();
    const second = runtime.sayHeldTextWhy(CALL, 'Another question?', ALICE);
    await flush();
    expect(s.asked).toHaveLength(2);
    runtime.setVoice(CALL, false);
    expect(await first).toBe('posted');
    expect(await second).toEqual({ outcome: 'posted', why: 'voice-off' });
    // The caller's receipt reads why (interviews' "Have Milo ask"): the voice turned off, here before and during the say.
    expect(await runtime.sayHeldTextWhy(CALL, QUESTION, ALICE)).toEqual({ outcome: 'posted', why: 'voice-off' });
    expect(s.asked).toHaveLength(2);
    expect(await runtime.sayHeldTextWhy('no-such-call', QUESTION, ALICE)).toEqual({ outcome: 'no-call', why: null });
  });
});

describe('the policy shapes the live model\'s instructions', () => {
  it('a call that relays nothing of the live model tells it to answer nobody and only read the lines it is handed', async () => {
    factory = () => new FakeSession();
    await startCall('orgiq:saytest:r9');
    // Offered tools (this test policy keeps Work's), it hands their requests to the backend and still says nothing itself.
    expect(fake().startedWith?.instructions).toContain(READ_ALOUD_DELEGATE_RULE);
    expect(fake().startedWith?.instructions).not.toContain('When you are addressed, answer');
  });
  it('offered no tools, it only reads the lines it is handed', async () => {
    const off = registerMeetingAssistantPolicy('orgiq:saytools', { ...NO_RELAY, id: 'say-no-tools', sessionTools: () => ({ tools: [], backendInstructions: '' }) });
    try {
      factory = () => new FakeSession();
      await startCall('orgiq:saytools:r1');
      expect(fake().startedWith?.instructions).toContain(READ_ALOUD_ONLY_RULE);
      expect(fake().startedWith?.instructions).not.toContain(READ_ALOUD_DELEGATE_RULE);
    } finally { off(); }
  });
  it('a call on the default policy (Work) keeps the answer-when-addressed rule', async () => {
    factory = () => new FakeSession();
    await startCall('orgiq:initiative:r9');
    expect(fake().startedWith?.instructions).toContain('When you are addressed, answer');
    expect(fake().startedWith?.instructions).not.toContain(READ_ALOUD_ONLY_RULE);
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

  // The voice starts as the words are checked, not once the whole utterance has streamed in (2 to 3 s in the 18 November film).
  const streamed = (s: FakeSession, say: string) => {
    let seq = 0;
    return {
      frames: (n: number, last = false) => { for (let i = 0; i < n; i += 1) s.fire('outputAudio', { pcm: Buffer.alloc(4800, 9), seq: ++seq, say, ...(last && i === n - 1 ? { last: true as const } : {}) }); },
      words: (text: string) => s.fire('outputTranscript', { text, final: false, say }),
    };
  };

  it('streams: frames go out once APPROVED_STREAM_LAG_MS old while the words so far are the start of the text; the rest once complete', async () => {
    factory = () => new FakeSession();
    await startCall('orgiq:saytest:stream');
    const s = fake();
    const p = runtime.sayHeldText(CALL, QUESTION, ALICE);
    await flush();
    const req = s.asked[0]!;
    const u = streamed(s, req.id);
    u.frames(4); u.words('Walk me through');
    await flush();
    expect(sent).toEqual([]); // too new to be covered by the words checked
    now += APPROVED_STREAM_LAG_MS;
    u.words('Walk me through how you would');
    await flush();
    expect(sent).toHaveLength(4); // heard before the utterance is complete
    u.frames(3); now += APPROVED_STREAM_LAG_MS; u.words('Walk me through how you would design a rate limiter for a public');
    await flush();
    expect(sent).toHaveLength(7);
    u.frames(2, true);
    req.ended(QUESTION);
    expect(await p).toBe('spoken');
    expect(sent).toHaveLength(9);
    expect(voiceTrace().at(-1)).toMatchObject({ ev: 'voice.approved', decision: 'relayed', frames: 9 });
  });

  it('a word that is not the text\'s stops the voice there: nothing more of the utterance goes out, and the line is chat only', async () => {
    factory = () => new FakeSession();
    await startCall('orgiq:saytest:runon');
    const s = fake();
    const p = runtime.sayHeldText(CALL, QUESTION, ALICE);
    await flush();
    const req = s.asked[0]!;
    const u = streamed(s, req.id);
    u.frames(4); now += APPROVED_STREAM_LAG_MS; u.words('Walk me through how you');
    await flush();
    expect(sent).toHaveLength(4);
    u.frames(3); u.words(`${QUESTION} Good luck`);
    now += 2 * APPROVED_STREAM_LAG_MS; u.frames(2, true);
    await flush();
    expect(sent).toHaveLength(4);
    req.ended(`${QUESTION} Good luck!`);
    expect(await p).toBe('posted');
    expect(sent).toHaveLength(4);
  });
});

describe('4b. the audio never runs ahead of the checked words (review 1, item 5)', () => {
  const streamed = (s: FakeSession, say: string) => {
    let seq = 0;
    return {
      frames: (n: number, last = false) => { for (let i = 0; i < n; i += 1) s.fire('outputAudio', { pcm: Buffer.alloc(4800, 9), seq: ++seq, say, ...(last && i === n - 1 ? { last: true as const } : {}) }); },
      words: (text: string) => s.fire('outputTranscript', { text, final: false, say }),
    };
  };

  it('a transcript that stalls mid-line releases nothing past what its words account for, and the audio resumes when it moves', async () => {
    factory = () => new FakeSession();
    await startCall('orgiq:saytest:stall');
    const s = fake();
    const p = runtime.sayHeldTextWhy(CALL, QUESTION, ALICE);
    await flush();
    const req = s.asked[0]!;
    const u = streamed(s, req.id);
    u.words('Walk me'); // 7 characters checked: 350 ms of audio at most, three 100 ms frames
    u.frames(12);
    now += 5 * APPROVED_STREAM_LAG_MS; // the transcript stalls while the frames age
    for (let k = 0; k < 4; k += 1) { await new Promise((r) => setTimeout(r, 110)); await flush(); }
    expect(sent).toHaveLength(Math.floor((7 * APPROVED_MS_PER_CHAR) / 100));
    u.words('Walk me through how you would'); // 29 characters: 1,450 ms
    await flush();
    expect(sent).toHaveLength(12);
    u.frames(1, true);
    req.ended(QUESTION);
    expect((await p).outcome).toBe('spoken');
  });

  it('a mismatch after some audio went out is recorded as partly spoken, with the words heard', async () => {
    factory = () => new FakeSession();
    await startCall('orgiq:saytest:cut');
    const s = fake();
    const p = runtime.sayHeldTextWhy(CALL, QUESTION, ALICE);
    await flush();
    const req = s.asked[0]!;
    const u = streamed(s, req.id);
    u.frames(4); now += APPROVED_STREAM_LAG_MS; u.words('Walk me through how you');
    await flush();
    expect(sent).toHaveLength(4);
    u.words(`${QUESTION} Good luck`);
    u.frames(2, true);
    req.ended(`${QUESTION} Good luck!`);
    const out = await p;
    expect(out).toMatchObject({ outcome: 'posted', why: 'mismatch', partly: 'Walk me' }); // 400 ms out: at most 8 characters' worth
    expect(voiceTrace().at(-1)).toMatchObject({ ev: 'voice.approved', decision: 'cut' });
  });

  it('heardPart: whole words only, as far as the audio can have carried', () => {
    expect(heardPart('Walk me through how you', 400)).toBe('Walk me');
    expect(heardPart('Walk me through how you', 10_000)).toBe('Walk me through how you');
    expect(heardPart('Walk', 100)).toBe('');
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

  it('a request on a line the provider ended is answered at once, with no wait for more words (its "?" never comes)', async () => {
    const HELD: MeetingAssistantPolicy = { ...NO_RELAY, id: 'held-turn', answerFromHeldText: async (_c, r) => (r.askedBy === GUEST ? 'About 20 minutes are left in this round.' : null) };
    const off = registerMeetingAssistantPolicy('orgiq:heldturn', HELD);
    try {
      await startCall('orgiq:heldturn:r1');
      await intake.handle(CALL, { userId: GUEST, text: 'Milo, how much time is left', at: now, turnEnded: true });
      await flush();
      expect(mockPosts.approved).toEqual(['About 20 minutes are left in this round.']);
    } finally { off(); }
  });
});

describe('7. the fixed refusal for a request heard again, and the asker\'s name', () => {
  const REFUSAL = 'I can repeat the question or tell you how much time is left.';
  const HELD: MeetingAssistantPolicy = {
    ...NO_RELAY, id: 'refusal-test', heldRefusal: REFUSAL,
    answerFromHeldText: async (_c, r) => (r.askedBy === GUEST ? (/time/.test(r.text) ? 'About 20 minutes are left in this round.' : REFUSAL) : null),
    displayName: async (_c, userId) => (userId === GUEST ? 'Jordan Lee' : null),
  };

  it('the same refusal for the same asker is posted once, however long after it is heard again; after another answer to them, again', async () => {
    const off = registerMeetingAssistantPolicy('orgiq:refusaltest', HELD);
    try {
      await startCall('orgiq:refusaltest:r1');
      const ask = async (text: string, by = GUEST) => { await intake.handle(CALL, { userId: by, text, at: now }); now += 5000; await intake.tick(); await flush(); };
      await ask('Milo, what is two plus two?');
      now += 25_000;
      await ask('Milo, what is two plus two?'); // the same audio, looped 30 s later
      now += 86_000;
      await ask('Milo, what is two plus two?'); // and again 91 s after the first (the live run on main 95dc9446)
      expect(mockPosts.approved).toEqual([REFUSAL]);
      expect(mockTrace.filter((t) => t.ev === 'held.repeat')).toHaveLength(2);
      await ask('Milo, how much time is left?');
      await ask('Milo, how much time is left?');
      expect(mockPosts.approved.filter((t) => t !== REFUSAL)).toHaveLength(2); // other answers are not held back
      await ask('Milo, what is two plus two?'); // Milo said something else in between: refused again, once
      await ask('Milo, what is two plus two?');
      expect(mockPosts.approved.filter((t) => t === REFUSAL)).toHaveLength(2);
    } finally { off(); }
  });

  it('the asker is named by the policy (the candidate\'s name), never by the raw guest id', async () => {
    const off = registerMeetingAssistantPolicy('orgiq:refusaltest', HELD);
    try {
      await startCall('orgiq:refusaltest:r2');
      await intake.handle(CALL, { userId: GUEST, text: 'Milo, what is two plus two?', at: now });
      now += 5000; await intake.tick(); await flush();
      expect(mockPosts.approvedNames).toEqual(['Jordan Lee']);
    } finally { off(); }
  });
});

describe('8. server tools (policy.ts runTool): no turn, no card, the line said as approved words', () => {
  const ran: Array<{ askedBy: string; name: string; bytes: number }> = [];
  const LINE = 'Added twelve test cases at the bottom of the pad.';
  const FALLBACK = 'I can add test cases, imports or a helper to the pad.';
  const TOOLS: MeetingAssistantPolicy = {
    ...NO_RELAY, id: 'server-tools',
    sessionTools: () => ({ tools: responsesFunctionTools(INTERVIEW_TOOLS), backendInstructions: 'interview' }),
    mayUseTool: async (_c, asker, tool) => asker.userId === ALICE && INTERVIEW_TOOLS.some((t) => t.name === tool),
    runTool: async (_c, r) => { ran.push({ askedBy: r.askedBy, name: r.name, bytes: JSON.stringify(r.args).length }); return LINE; },
    maxToolArgsBytes: (_c, tool) => (tool.startsWith('pad_') ? 12_288 : 4096),
    heldFallback: async () => FALLBACK,
    heldFallbackWait: { quietMs: 300, delegatedMs: 600 },
  };
  const big = (n: number) => ({ cases: Array.from({ length: n }, (_, i) => ({ args: `[[${'1, '.repeat(40)}${i}], 9]`, expected: '[0, 1]' })) });
  let rules: (() => void) | null = null;
  beforeEach(() => {
    ran.length = 0;
    rules = addScriptRules([
      { id: 't-tests', match: /dozen test cases/i, run: () => ({ call: { name: 'pad_add_tests', args: big(12) } }) },
      { id: 't-huge', match: /huge/i, run: () => ({ call: { name: 'pad_add_tests', args: big(200) } }) },
    ]);
  });
  afterEach(() => { rules?.(); });
  const ask = async (text: string, by = ALICE) => { await intake.handle(CALL, { userId: by, text, at: now }); now += 5000; await intake.tick(); await flush(); };

  it('the call runs on the server once, its arguments up to the family\'s cap, and its line is posted with the approved mark; no fallback', async () => {
    const off = registerMeetingAssistantPolicy('orgiq:servertools', TOOLS);
    try {
      await startCall('orgiq:servertools:r1');
      const answered = jest.spyOn(ScriptedSession.prototype, 'answerToolCall');
      expect(scripted().startInput?.tools.map((t) => t.name)).toContain('pad_add_tests');
      await ask('Milo, it would be helpful to have another dozen test cases');
      await new Promise((r) => setTimeout(r, 400)); await flush();
      expect(ran).toHaveLength(1);
      expect(ran[0]).toMatchObject({ askedBy: ALICE, name: 'pad_add_tests' });
      expect(ran[0]!.bytes).toBeGreaterThan(1500);
      expect(mockPosts.approved).toEqual([LINE]);
      expect(mockTrace.some((t) => t.ev === 'call.turn')).toBe(false);
      // Answered with no continuation: the model is not asked to go on after a server tool.
      expect(answered.mock.calls[0]?.[2]).toEqual({ continue: false });
      answered.mockRestore();
      await ask('Milo, a huge batch of test cases please');
      await new Promise((r) => setTimeout(r, 400)); await flush();
      expect(ran).toHaveLength(1); // over the family's cap: refused before it runs
      expect(mockTrace.some((t) => t.ev === 'call.refused' && t.f['why'] === 'invalid-arguments')).toBe(true);
    } finally { off(); }
  });

  it('a request no call answers gets the family\'s fallback line after the wait', async () => {
    const off = registerMeetingAssistantPolicy('orgiq:servertools', TOOLS);
    try {
      await startCall('orgiq:servertools:r2');
      await ask('Milo, what is the weather like');
      expect(mockPosts.approved).toEqual([]);
      await new Promise((r) => setTimeout(r, 500)); await flush();
      expect(mockPosts.approved).toEqual([FALLBACK]);
      expect(ran).toEqual([]);
    } finally { off(); }
  });

  it('a pad tool runs only when the request is the asker\'s alone: someone speaking after the name gets the fallback (review 1, item 1)', async () => {
    const off = registerMeetingAssistantPolicy('orgiq:servertools', TOOLS);
    try {
      factory = () => new FakeSession();
      await startCall('orgiq:servertools:r4');
      const t = now;
      await intake.handle(CALL, { userId: ALICE, text: 'Milo, how much time is left?', at: t });
      await intake.handle(CALL, { userId: GUEST, text: 'and add a helper that finds the two indices', at: t + 2000 });
      now = t + 3000; await flush();
      fake().fire('toolCall', { callId: 'call_r1', name: 'pad_add_helper', args: { what: 'x', code: 'y' }, atMs: now - T0 });
      await flush(); await new Promise((r) => setTimeout(r, 50)); await flush();
      expect(ran).toEqual([]);
      expect(mockTrace.some((x) => x.ev === 'call.refused' && x.f['why'] === 'not-clearly-asked')).toBe(true);
      expect(mockPosts.approved).toEqual([FALLBACK]);
    } finally { off(); }
  });

  it('a refused call is not the request answered: its asker hears the fallback at once (review 1, item 6)', async () => {
    const off = registerMeetingAssistantPolicy('orgiq:servertools', TOOLS);
    try {
      await startCall('orgiq:servertools:r6a');
      await ask('Milo, a huge batch of test cases please');
      await flush();
      expect(ran).toEqual([]);
      expect(mockTrace.some((t) => t.ev === 'call.refused' && t.f['why'] === 'invalid-arguments')).toBe(true);
      expect(mockPosts.approved).toEqual([FALLBACK]);
      await new Promise((r) => setTimeout(r, 700)); await flush();
      expect(mockPosts.approved).toEqual([FALLBACK]); // once: the wait does not say it again
    } finally { off(); }
  });

  it('a call that lands after the fallback was said does not write (review 1, item 6)', async () => {
    const off = registerMeetingAssistantPolicy('orgiq:servertools', TOOLS);
    try {
      factory = () => new FakeSession();
      await startCall('orgiq:servertools:r6b');
      await ask('Milo, add a helper please');
      await new Promise((r) => setTimeout(r, 800)); await flush();
      expect(mockPosts.approved).toEqual([FALLBACK]);
      fake().fire('toolCall', { callId: 'call_late', name: 'pad_add_helper', args: { what: 'x', code: 'y' }, atMs: now - T0 });
      await flush(); await new Promise((r) => setTimeout(r, 50)); await flush();
      expect(ran).toEqual([]);
      expect(mockTrace.some((t) => t.ev === 'call.refused' && t.f['why'] === 'after-fallback')).toBe(true);
    } finally { off(); }
  });

  it('the wait counts from when the words ended: a delegation before a slow store still gets the acknowledgement (review 1, item 6)', async () => {
    const off = registerMeetingAssistantPolicy('orgiq:servertools', { ...TOOLS, heldAcknowledgement: async () => 'On it.' });
    try {
      factory = () => new FakeSession();
      await startCall('orgiq:servertools:r6c');
      await intake.handle(CALL, { userId: ALICE, text: 'Milo, it would be helpful to have another dozen test cases', at: now });
      fake().fire('delegation', { atMs: now - T0 });
      now += 5000; // the request reaches the detector seconds after its words (the detector's quiet, a slow store)
      await intake.tick(); await flush();
      await new Promise((r) => setTimeout(r, 300)); await flush();
      expect(mockPosts.approved[0]).toBe('On it.');
    } finally { off(); }
  });

  it('a call refused for the pad\'s language does not use up the request\'s run, and the session is told the pad now (review 1, item 7)', async () => {
    let calls = 0;
    const off = registerMeetingAssistantPolicy('orgiq:servertools', {
      ...TOOLS,
      runTool: async (_c, r) => { calls += 1; ran.push({ askedBy: r.askedBy, name: r.name, bytes: 0 }); return calls === 1 ? { line: 'Not in the pad\'s language.', retry: true as const, note: 'The pad is now in javascript.' } : LINE; },
    });
    try {
      factory = () => new FakeSession();
      await startCall('orgiq:servertools:r7');
      await intake.handle(CALL, { userId: ALICE, text: 'Milo, add an LRU cache helper', at: now });
      now += 1000; await flush();
      fake().fire('toolCall', { callId: 'call_r7a', name: 'pad_add_helper', args: { what: 'x', code: 'y' }, atMs: now - T0 });
      await flush(); await new Promise((r) => setTimeout(r, 50)); await flush();
      expect(fake().contexts).toContain('The pad is now in javascript.');
      fake().fire('toolCall', { callId: 'call_r7b', name: 'pad_add_helper', args: { what: 'x', code: 'z' }, atMs: now - T0 });
      await flush(); await new Promise((r) => setTimeout(r, 50)); await flush();
      expect(calls).toBe(2); // the same request ran again
      expect(mockPosts.approved).toContain(LINE);
    } finally { off(); }
  });

  it('clearlyAsked: the asker alone, the name in the line, nobody after it', () => {
    const line = (seq: number, userId: string, text: string, at: number, speakers?: string[]) => ({ seq, userId, text, at, captionId: `c${seq}`, callId: CALL, participantId: userId, speakerName: userId, ...(speakers ? { speakers } : {}) });
    const req = line(1, ALICE, 'Milo, another dozen test cases', 1000);
    expect(clearlyAsked([req], req, ALICE, 2000)).toBe(true);
    expect(clearlyAsked([req, line(2, ALICE, 'thanks', 1500)], req, ALICE, 2000)).toBe(true);
    expect(clearlyAsked([req, line(2, GUEST, 'and a helper too', 1500)], req, ALICE, 2000)).toBe(false);
    expect(clearlyAsked([req, line(2, GUEST, 'later words', 2500)], req, ALICE, 2000)).toBe(true);
    const overlapped = line(1, ALICE, 'Milo, add a helper', 1000, [ALICE, GUEST]);
    expect(clearlyAsked([overlapped], overlapped, ALICE, 2000)).toBe(false);
    const noName = line(1, ALICE, 'add a helper', 1000);
    expect(clearlyAsked([noName], noName, ALICE, 2000)).toBe(false);
    expect(clearlyAsked([req], req, GUEST, 2000)).toBe(false);
    expect(clearlyAsked([], null, ALICE, 2000)).toBe(false);
  });

  it('a family without runTool never runs a server tool: the call is refused as unknown (Work)', async () => {
    const off = registerMeetingAssistantPolicy('orgiq:servertools', { ...TOOLS, runTool: undefined, mayUseTool: () => true });
    try {
      await startCall('orgiq:servertools:r3');
      await ask('Milo, another dozen test cases');
      expect(ran).toEqual([]);
      expect(mockTrace.some((t) => t.ev === 'call.refused' && t.f['why'] === 'unknown-tool')).toBe(true);
    } finally { off(); }
  });
});

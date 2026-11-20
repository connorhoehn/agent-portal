// The floor and the turn owner, by behaviour: given what a person said (and on whose lane), which action runs and which exact words
// are logged and said (docs/milo-rebuild/REBUILD-REVIEW.md "Amended phase 1", 1B). A test tenant shaped like interviews, a scripted
// Decide model, a tone voice and a fake clock: the floor, Decide's code, Act and Speak are the real ones.
jest.mock('../../../config.js', () => ({ config: { region: 'us-east-1', auth: {}, cognito: {}, mock: { aurora: true }, meetingAssistant: { enabled: true, transcriptRetentionDays: 30 } } }));
jest.mock('../../../providers/identity.js', () => ({ getUser: jest.fn(async () => null) }));
jest.mock('../../social-notify.js', () => ({ notify: jest.fn(async () => []) }));
import { TurnOwner, KEEP_LISTENING_MS, ONSET_WAIT_MS, type TurnRecord } from '../turn/turn-owner.js';
import { FOLLOW_UP_MS, Floor, asksToResume, hasName } from '../turn/floor.js';
import { creditedLane, isMiloEcho, sameSentence } from '../turn/barge.js';
import { _resetActed } from '../turn/act.js';
import type { TextToolReply, TextToolRequest } from '../../voice/openai-text.js';
import type { SpeechBackend } from '../../voice/speech.js';
import type { PolicyCall } from '../policy.js';
import type { MiloTool, SpokenLine, SpokenOutcome, TurnPolicy } from '../turn/types.js';
import type { HandsfreeClock, HeardLine } from '../handsfree/types.js';

const CALL = { tenant: 'test', callId: 'c1', lobby: 'test:lobby' } as unknown as PolicyCall;
const CAN_DO = 'I can tell you the time left or repeat the question.';
const TIME = 'About 12 minutes are left in this round.';
const obj = { type: 'object' as const, properties: {}, required: [], additionalProperties: false as const };
const tool = (name: string, writes = false): MiloTool => ({ name, description: name, parameters: writes ? { ...obj, properties: { text: { type: 'string' } } } : obj, kind: 'server', writes });
const ROLES: Record<string, string | null> = { lead: 'lead', pam: 'panel', cara: 'candidate', dee: null };

function fakeClock() {
  let t = 0; let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const flush = async (): Promise<void> => { for (let i = 0; i < 12; i++) await new Promise<void>((r) => setImmediate(r)); };
  const clock: HandsfreeClock = {
    nowMs: () => t,
    setTimeout: (fn, ms) => { seq += 1; timers.set(seq, { at: t + Math.max(0, ms), fn }); return seq; },
    clearTimeout: (h) => { timers.delete(h as number); },
  };
  const to = async (target: number): Promise<void> => {
    await flush();
    for (;;) {
      let id: number | null = null;
      for (const [k, tm] of timers) if (tm.at <= target && (id === null || tm.at < timers.get(id)!.at)) id = k;
      if (id === null) break;
      const tm = timers.get(id)!; timers.delete(id);
      t = Math.max(t, tm.at); tm.fn();
      await flush();
    }
    t = Math.max(t, target);
    await flush();
  };
  return { clock, to, by: (ms: number) => to(t + ms), flush };
}

/** A voice that says the logged words as 65 ms of tone per character. */
const tone: SpeechBackend = {
  id: 'tone', sampleRate: 24_000,
  async speak(text, o) {
    o.onInput(text);
    const frames = Math.max(1, Math.round((text.length * 65) / 100));
    for (let i = 0; i < frames; i++) o.onAudio(Buffer.alloc(4_800, 1));
    return { firstAudioMs: 0, ms: 0, bytes: frames * 4_800 };
  },
};

interface Rig {
  owner: TurnOwner; to: (ms: number) => Promise<void>; by: (ms: number) => Promise<void>; flush: () => Promise<void>;
  requests: TextToolRequest[]; turns: TurnRecord[]; logged: SpokenLine[]; marks: SpokenOutcome[]; stored: HeardLine[]; ran: Array<{ who: string; name: string; args: unknown }>;
  frames: number[]; cleared: number[]; paused: string[]; left: string[]; traces: Array<[string, Record<string, unknown>]>;
  /** The next Decide answers, in order; a function holds the reply until it is called. */
  answers: Array<Partial<TextToolReply> | (() => Promise<Partial<TextToolReply>>)>;
  say(who: string, text: string, opts?: { start?: number; id?: string }): Promise<void>;
  sentenceOf(req: TextToolRequest): string;
}
const pick = (name: string, args: object = {}): Partial<TextToolReply> => ({ call: { name, arguments: JSON.stringify(args) } });
let ids = 0;

function rig(over: Partial<TurnPolicy> = {}, voice: SpeechBackend = tone): Rig {
  const c = fakeClock();
  const r = { requests: [], turns: [], logged: [], marks: [], stored: [], ran: [], frames: [], cleared: [], paused: [], left: [], traces: [], answers: [] } as unknown as Rig;
  const policy: TurnPolicy = {
    roleOf: async (_c, u) => ROLES[u] ?? null,
    toolsFor: async (_c, p) => p.role === 'candidate' ? [tool('time_left'), tool('repeat_question')] : p.role === 'panel' ? [tool('time_left'), tool('repeat_question'), tool('pad_write', true)] : [tool('time_left'), tool('repeat_question'), tool('pad_write', true), tool('introduce')],
    answersFreely: () => false,
    instructions: (_c, role) => `Interview ${role}.`,
    cannotHelp: () => CAN_DO,
    context: async () => 'Round 2 of 3.',
    mayHold: (_c, role) => role !== 'candidate',
    logSpoken: async (_c, line) => { r.logged.push(line); return `row${r.logged.length}`; },
    markSpoken: async (_c, _id, _line, outcome) => { r.marks.push(outcome); },
    mayUseCore: (_c, role, t) => role !== 'candidate' || (t !== 'leave_call' && t !== 'pause_listening'),
    // This test tenant keeps a follow-up window (a tenant's own setting; interviews has none: the name is required).
    followUpMs: FOLLOW_UP_MS,
    ...over,
  };
  r.owner = new TurnOwner({
    call: CALL, policy, clock: c.clock, voice,
    relay: { push: () => { r.frames.push(c.clock.nowMs()); }, clear: () => { r.cleared.push(c.clock.nowMs()); } },
    decide: {
      modelReads: async () => () => true,
      request: async (req) => {
        r.requests.push(req);
        const a = r.answers.shift() ?? pick('stay_silent');
        return { call: null, text: '', usage: { input: 1, output: 1 }, ms: 1, ...(typeof a === 'function' ? await a() : a) };
      },
    },
    act: { runServer: async (_c, who, name, args) => { r.ran.push({ who, name, args }); return name === 'time_left' ? { line: TIME, retry: false } : name === 'pad_write' ? null : { line: `ran ${name}`, retry: false }; } },
    onLine: (l) => { r.stored.push(l); },
    onPause: (by) => { r.paused.push(by); },
    onLeave: (by) => { r.left.push(by); },
    onTurn: (t) => { r.turns.push(t); },
    trace: (event, data) => { r.traces.push([event, data]); },
  });
  r.to = c.to; r.by = c.by; r.flush = c.flush;
  r.say = async (who, text, opts = {}) => {
    const id = opts.id ?? `s${++ids}`;
    const endMs = c.clock.nowMs();
    void r.owner.sentence({ userId: who, sentenceId: id, text, startMs: opts.start ?? endMs - 1_500, endMs });
    // The listening side emits the stored line right after the sentence.
    (r.owner as unknown as { line(l: HeardLine): void }).line({ callId: 'c1', userId: who, text, at: 0, captionId: `hf:${id}`, startMs: opts.start ?? endMs - 1_500, endMs } as HeardLine);
    await c.flush();
  };
  r.sentenceOf = (req) => /Sentence: "(.*)"$/s.exec(req.input)?.[1] ?? '';
  return r;
}

beforeEach(() => { _resetActed(); });

describe('the gate: what reaches Decide', () => {
  it('any sentence with the name does, wherever the name is and however it was heard; one without it does not', async () => {
    const r = rig();
    await r.to(10_000);
    await r.say('cara', 'I asked Milo earlier.');
    await r.say('cara', 'How long do we have, Ilo?');
    await r.say('cara', 'How much time is left?');
    await r.say('pam', 'Let us ask mylo for the time');
    expect(r.requests.map(r.sentenceOf)).toEqual(['I asked Milo earlier.', 'How long do we have, Ilo?', 'Let us ask mylo for the time']);
    expect(r.logged).toEqual([]);
    expect(hasName('the milometer')).toBe(false);
  });

  it('a person the tenant gives no role never reaches a model', async () => {
    const r = rig();
    await r.to(10_000);
    await r.say('dee', 'Milo, how much time is left?');
    expect(r.requests).toEqual([]);
    expect(r.stored.map((l) => l.text)).toEqual(['Milo, how much time is left?']);
  });

  it('a candidate asking the time: time_left, logged before audio, said word for word', async () => {
    const r = rig();
    await r.to(10_000);
    r.answers.push(pick('time_left'));
    await r.say('cara', 'Milo, how many minutes do I have?');
    expect(r.ran).toEqual([{ who: 'cara', name: 'time_left', args: {} }]);
    expect(r.owner.state()).toMatchObject({ phase: 'answering', userId: 'cara', via: 'name' });
    await r.by(6_000);
    expect(r.turns[0]!.said).toMatchObject({ outcome: 'spoken' });
    expect(r.frames.length).toBe(Math.round((TIME.length * 65) / 100));
    expect(r.owner.state()).toMatchObject({ phase: 'follow-up', userId: 'cara' });
  });
});

describe('one turn: a pause mid-request', () => {
  it('a new onset before audio cancels the turn and merges the sentences into one decision', async () => {
    const r = rig();
    await r.to(10_000);
    let first!: (v: Partial<TextToolReply>) => void;
    r.answers.push(() => new Promise((res) => { first = res; }), pick('pad_write', { text: 'a test for empty input' }));
    await r.say('lead', 'Milo, add a test for');
    r.owner.onset('lead');
    first(pick('pad_write', { text: 'a test' })); // the model's answer to the half request arrives late
    await r.flush();
    expect(r.ran).toEqual([]);
    await r.by(1_200);
    await r.say('lead', 'empty input.');
    expect(r.requests.map(r.sentenceOf)).toEqual(['Milo, add a test for', 'Milo, add a test for empty input.']);
    expect(r.ran).toEqual([{ who: 'lead', name: 'pad_write', args: { text: 'a test for empty input' } }]);
  });

  it('an onset that never becomes a sentence lets the turn go on', async () => {
    const r = rig();
    await r.to(10_000);
    let first!: (v: Partial<TextToolReply>) => void;
    r.answers.push(() => new Promise((res) => { first = res; }));
    await r.say('cara', 'Milo, how much time is left?');
    r.owner.onset('cara');
    first(pick('time_left'));
    await r.flush();
    expect(r.ran).toEqual([]);
    await r.by(ONSET_WAIT_MS + 10);
    expect(r.ran.map((x) => x.name)).toEqual(['time_left']);
  });

  it('keep_listening waits for the rest and decides once on the whole request; with no rest it is silence', async () => {
    const r = rig();
    await r.to(10_000);
    r.answers.push(pick('keep_listening'), pick('time_left'));
    await r.say('cara', 'Milo, how much');
    await r.by(1_500);
    await r.say('cara', 'time is left?');
    expect(r.requests.map(r.sentenceOf)).toEqual(['Milo, how much', 'Milo, how much time is left?']);
    expect(r.ran.map((x) => x.name)).toEqual(['time_left']);
    await r.by(20_000);
    r.answers.push(pick('keep_listening'));
    await r.say('cara', 'Milo, can you');
    await r.by(KEEP_LISTENING_MS + 10);
    await r.say('cara', 'I think the loop is wrong.');
    expect(r.requests.length).toBe(3);
    expect(r.logged).toEqual([]);
  });
});

describe('silence unless named', () => {
  it('cannot_help says the fixed line for the name and nothing inside the follow-up window', async () => {
    const r = rig();
    await r.to(10_000);
    r.answers.push(pick('cannot_help'), pick('cannot_help'));
    await r.say('cara', 'Milo, is my approach right?');
    await r.by(9_000);
    expect(r.logged.map((l) => [l.text, l.askedBy, l.tool])).toEqual([[CAN_DO, 'cara', 'cannot_help']]);
    await r.say('cara', 'So should I use a heap?');
    await r.by(9_000);
    expect(r.requests.length).toBe(2);
    expect(r.requests[1]!.input).toContain('no name');
    expect(r.logged.length).toBe(1);
  });

  it('the name is required unless the tenant sets a follow-up window: after an answer, a sentence without the name is silence', async () => {
    for (const over of [{ followUpMs: 0 }, { followUpMs: undefined }] as Array<Partial<TurnPolicy>>) {
      const r = rig(over);
      await r.to(10_000);
      r.answers.push(pick('time_left'), pick('repeat_question'), pick('time_left'));
      await r.say('lead', 'Milo, how much time is left?');
      await r.by(3_000); // the line has played
      expect(r.turns.map((t) => [t.result.line, t.said?.outcome])).toEqual([[TIME, 'spoken']]);
      expect(r.owner.state()).toEqual({ phase: 'idle' });
      await r.say('lead', 'And what was the question?');
      await r.by(3_000);
      expect(r.requests.length).toBe(1); // no model was asked
      expect(r.ran.length).toBe(1);
      // A split request is still one request: the name was said in its first half.
      r.answers.unshift(pick('keep_listening'));
      await r.say('lead', 'Milo, can you');
      await r.by(1_000);
      await r.say('lead', 'tell me the time');
      await r.by(4_000);
      expect(r.ran.map((x) => x.name)).toEqual(['time_left', 'repeat_question']);
      expect(r.sentenceOf(r.requests.at(-1)!)).toBe('Milo, can you tell me the time');
      // The hold needs no name.
      expect(await r.owner.holdPress('lead')).toEqual({ ok: true });
      await r.by(2_000);
      r.owner.holdRelease('lead');
      await r.by(700);
      await r.say('lead', 'how long is left');
      await r.by(4_000);
      expect(r.ran.map((x) => x.name)).toEqual(['time_left', 'repeat_question', 'time_left']);
      expect(r.requests.at(-1)!.input).toContain('held the button');
      await r.owner.close();
    }
  });

  it('a floor with no follow-up window: an answer opens nothing, and only the name or the hold reaches Milo', () => {
    const now = 5_000;
    const f = new Floor(() => now);
    f.speaking('a', 'name'); f.answered('a', 1_000); f.free();
    expect(f.state()).toEqual({ phase: 'idle' });
    expect(f.route('a', 'and again', 2_000)).toBeNull();
    expect(f.route('a', 'Milo, again', 2_000)).toBe('name');
    f.hold('a');
    expect(f.route('a', 'and again', 5_000)).toBe('hold');
  });

  it('the follow-up window is the asker\'s alone and ends 10 s after the answer has played', async () => {
    const r = rig();
    await r.to(10_000);
    r.answers.push(pick('time_left'), pick('repeat_question'));
    await r.say('cara', 'Milo, how much time is left?');
    await r.by(3_000); // the line has played (about 2.6 s)
    await r.say('pam', 'And what was the question?');
    expect(r.requests.length).toBe(1);
    await r.by(4_000);
    await r.say('cara', 'And what was the question?');
    expect(r.requests.length).toBe(2);
    await r.by(FOLLOW_UP_MS + 3_000);
    expect(r.owner.state()).toEqual({ phase: 'idle' });
    await r.say('cara', 'And how long now?');
    expect(r.requests.length).toBe(2);
  });
});

describe('lanes: a mic does not hold only its owner', () => {
  it('Milo\'s own line heard back inside his playout plus 1.5 s is dropped: not judged, not stored', async () => {
    const r = rig();
    await r.to(10_000);
    r.answers.push(pick('time_left'));
    await r.say('cara', 'Milo, how much time is left?');
    await r.by(3_500);
    await r.say('cara', 'About 12 minutes are left in this round.', { start: 10_400 });
    await r.say('lead', 'minutes are left in this round', { start: 10_900 });
    expect(r.requests.length).toBe(1);
    expect(r.stored.map((l) => l.text)).toEqual(['Milo, how much time is left?']);
    // The same words long after he spoke are a person's.
    await r.by(20_000);
    await r.say('lead', 'About 12 minutes are left in this round.');
    expect(r.stored.length).toBe(2);
  });

  it('the same sentence on two lanes is one turn, credited to the lane where it began first', async () => {
    const r = rig();
    await r.to(10_000);
    r.answers.push(pick('cannot_help'));
    // The candidate speaks; the lead's open speaker carries it into the lead's mic 250 ms later.
    await r.say('cara', 'Milo, write the solution on the pad.', { start: 8_000 });
    await r.say('lead', 'Milo, write the solution on the pad', { start: 8_250 });
    expect(r.requests.length).toBe(1);
    expect(r.requests[0]!.input).toContain("Speaker's role: candidate");
    expect(r.requests[0]!.tools.map((t) => t.name)).not.toContain('pad_write');
    expect(r.stored.map((l) => l.userId)).toEqual(['cara']);
    expect(r.ran).toEqual([]);
  });

  it('the copy heard first loses the turn to the speaker, and starts too close to tell go to the person who may ask for less', async () => {
    const r = rig();
    await r.to(10_000);
    let leads!: (v: Partial<TextToolReply>) => void;
    r.answers.push(() => new Promise((res) => { leads = res; }), pick('cannot_help'));
    // The lead's lane finishes first with the candidate's words; the candidate's own lane began 300 ms earlier.
    await r.say('lead', 'Milo, write the solution on the pad', { start: 8_300 });
    await r.say('cara', 'Milo, write the solution on the pad.', { start: 8_000 });
    leads(pick('pad_write', { text: 'the solution' }));
    await r.by(6_000);
    expect(r.logged.map((l) => [l.text, l.askedBy])).toEqual([[CAN_DO, 'cara']]);
    expect(r.ran).toEqual([]);
    expect(r.turns.map((t) => t.sentence.who)).toEqual(['cara']);
    const a = { who: 'lead', text: 'x', startMs: 1_000, endMs: 2_000 }; const b = { who: 'cara', text: 'x', startMs: 1_050, endMs: 2_050 };
    expect(creditedLane(a, b, (who) => (who === 'lead' ? 4 : 2))).toBe(b);
    expect(creditedLane(a, { ...b, startMs: 1_300 }, (who) => (who === 'lead' ? 4 : 2))).toBe(a);
    expect(sameSentence('Milo, how much time is left?', 'milo how much time is left')).toBe(true);
    expect(sameSentence('Milo, how much time is left?', 'Milo, repeat the question.')).toBe(false);
    expect(isMiloEcho({ who: 'x', text: 'stop', startMs: 5, endMs: 6 }, [{ text: 'About 12 minutes', startMs: 0, endMs: null }])).toBe(false);
  });
});

describe('pause, leave, cancel and writing once', () => {
  it('"stop listening" pauses: nothing reaches Decide until a named request to listen again', async () => {
    const r = rig();
    await r.to(10_000);
    r.answers.push(pick('pause_listening'), pick('time_left'));
    await r.say('lead', 'Milo, stop listening.');
    expect(r.paused).toEqual(['lead']);
    expect(r.owner.paused).toBe(true);
    await r.by(5_000);
    await r.say('lead', 'Milo, are you there?');
    await r.say('pam', 'Milo, you can leave now.');
    expect(r.requests.length).toBe(1);
    expect((await r.owner.holdPress('lead')).ok).toBe(false);
    await r.say('lead', 'Milo, resume listening.');
    expect(r.owner.paused).toBe(false);
    await r.say('lead', 'Milo, how much time is left?');
    expect(r.requests.length).toBe(2);
    expect(asksToResume('resume listening')).toBe(false);
  });

  it('"leave the call" leaves for a role that may ask; a candidate gets the fixed line instead', async () => {
    const r = rig();
    await r.to(10_000);
    r.answers.push(pick('leave_call'), pick('leave_call'));
    await r.say('cara', 'Milo, leave the call.');
    await r.by(9_000);
    expect(r.left).toEqual([]);
    expect(r.logged.map((l) => l.text)).toEqual([CAN_DO]);
    await r.say('lead', 'Milo, leave the call.');
    expect(r.left).toEqual(['lead']);
  });

  it('"never mind" stops the line being said and ends the window', async () => {
    const r = rig();
    await r.to(10_000);
    r.answers.push(pick('time_left'), pick('cancel'));
    await r.say('cara', 'Milo, how much time is left?');
    await r.by(600);
    await r.say('cara', 'Milo, never mind.', { start: 10_300 });
    await r.by(3_000);
    expect(r.marks).toEqual(['partly']);
    expect(r.cleared.length).toBeGreaterThan(0);
    expect(r.turns.map((t) => t.result.effect)).toEqual([null, 'cancel']);
    expect(r.owner.state()).toEqual({ phase: 'idle' });
  });

  it('a write runs once: the same sentence handed over twice, and the same write asked again within 10 s', async () => {
    const r = rig();
    await r.to(10_000);
    r.answers.push(pick('pad_write', { text: 'a test' }), pick('pad_write', { text: 'a test' }), pick('pad_write', { text: 'a test' }), pick('pad_write', { text: 'a test' }));
    await r.say('lead', 'Milo, add a test to the pad.', { id: 'same' });
    await r.say('lead', 'Milo, add a test to the pad.', { id: 'same', start: 0 });
    expect(r.ran.length).toBe(1);
    await r.by(4_000);
    await r.say('lead', 'Milo, add a test to the pad please.');
    expect(r.ran.length).toBe(1);
    await r.by(11_000);
    await r.say('lead', 'Milo, add a test to the pad.');
    expect(r.ran.length).toBe(2);
  });
});

describe('talking over Milo, the hold button, a second asker', () => {
  it('words that are not his stop the line and mark it partly; his own words heard back do not', async () => {
    const r = rig();
    await r.to(10_000);
    r.answers.push(pick('cannot_help'));
    await r.say('cara', 'Milo, is my approach right?');
    await r.by(800);
    r.owner.words({ userId: 'lead', sentenceId: 'w1', delta: 'I can tell you the time', atMs: 10_700 });
    await r.by(300);
    expect(r.cleared).toEqual([]);
    r.owner.words({ userId: 'pam', sentenceId: 'w2', delta: 'okay wait', atMs: 11_000 });
    const sent = r.frames.length;
    await r.by(3_000);
    expect(r.marks).toEqual(['partly']);
    expect(r.frames.length).toBe(sent);
    expect(r.owner.state()).toMatchObject({ phase: 'follow-up', userId: 'cara' });
  });

  describe('a voiced onset pauses him at once; the words confirm (film 3: Hugo cut in and Milo ran on 2.0 s)', () => {
    const LOUD = Buffer.alloc(4_800); for (let i = 0; i < LOUD.length; i += 2) LOUD.writeInt16LE(i % 4 ? 3_000 : -3_000, i);
    const QUIET = Buffer.alloc(4_800);
    /** A voice as loud as speech, so his playout is something a mic could carry. */
    const spoken: SpeechBackend = { ...tone, async speak(text, o) { o.onInput(text); const n = Math.max(1, Math.round((text.length * 65) / 100)); for (let i = 0; i < n; i++) o.onAudio(Buffer.from(LOUD)); return { firstAudioMs: 0, ms: 0, bytes: n * 4_800 }; } };
    const LONG = 'I can tell you the time left or repeat the question, and I can say a good deal more than that if you let me.';
    async function playing(mic: (at: number) => Buffer) {
      const r = rig({ cannotHelp: () => LONG }, spoken);
      const mics = (r.owner as unknown as { mics: { trackMic(u: string, p: Buffer, at: number): void } }).mics;
      await r.to(10_000);
      r.answers.push(pick('cannot_help'));
      await r.say('cara', 'Milo, is my approach right?');
      const feed = async (who: string, pcm: (at: number) => Buffer, ms: number) => {
        for (let k = 0; k < ms; k += 100) { const at = (r.owner as unknown as { now(): number }).now(); mics.trackMic(who, pcm(at), at); await r.by(100); }
      };
      // His line is under way; pam's mic hears the room (quiet, or his voice when it leaks) for 2.5 s.
      await feed('pam', mic, 2_500);
      expect(r.frames.length).toBeGreaterThan(10);
      return { r, feed };
    }

    it('a clean mic: the relay is cleared within 0.7 s of the voice starting and nothing more plays; then the words stop him for good', async () => {
      const { r, feed } = await playing(() => QUIET);
      const voiceAt = (r.owner as unknown as { now(): number }).now();
      const before = r.frames.length;
      await feed('pam', () => LOUD, 400);
      expect(r.cleared.length).toBe(1);
      expect(r.cleared[0]! - voiceAt).toBeLessThanOrEqual(700);
      const atPause = r.frames.length;
      expect(atPause - before).toBeLessThanOrEqual(5);
      await feed('pam', () => LOUD, 500);
      expect(r.frames.length).toBe(atPause);
      r.owner.words({ userId: 'pam', sentenceId: 'w-stop', delta: 'okay thanks that is enough', atMs: voiceAt });
      await r.by(3_000);
      expect(r.marks).toEqual(['partly']);
      expect(r.frames.length).toBe(atPause);
    });

    it('a clean mic and no words (a cough): he goes on from where he stopped and the line is spoken whole', async () => {
      const { r, feed } = await playing(() => QUIET);
      await feed('pam', () => LOUD, 300);
      expect(r.cleared.length).toBe(1);
      await feed('pam', () => QUIET, 300);
      await r.by(20_000);
      expect(r.marks).toEqual(['spoken']);
      expect(r.traces.map(([e]) => e)).toEqual(expect.arrayContaining(['turn.paused', 'turn.resumed']));
    });

    it('a mic that carries his voice: its onset never pauses him', async () => {
      const { r, feed } = await playing(() => LOUD);
      await feed('pam', () => LOUD, 400);
      expect(r.cleared).toEqual([]);
      expect(r.traces.map(([e]) => e)).not.toContain('turn.paused');
    });
  });

  it('a hold routes the holder without the name; a candidate may not hold; a second holder is busy', async () => {
    const r = rig();
    await r.to(10_000);
    expect(await r.owner.holdPress('cara')).toEqual({ ok: false, reason: 'not-admitted' });
    expect(await r.owner.holdPress('lead')).toEqual({ ok: true });
    expect(await r.owner.holdPress('pam')).toEqual({ ok: false, reason: 'busy' });
    expect(r.owner.state()).toMatchObject({ phase: 'routing', userId: 'lead', via: 'hold' });
    await r.by(2_000);
    r.answers.push(pick('time_left'));
    r.owner.holdRelease('lead');
    await r.by(700);
    await r.say('lead', 'How much time is left?', { start: 10_500 });
    expect(r.requests[0]!.input).toContain('held the button');
    expect(r.ran.map((x) => x.name)).toEqual(['time_left']);
  });

  it('a hold ends at the release: a later sentence the lane dated from its previous one\'s end is not held (film, 20 November)', async () => {
    const r = rig();
    const mics = (r.owner as unknown as { mics: { trackMic(userId: string, pcm: Buffer, atMs: number): void } }).mics;
    const loud = Buffer.alloc(4_800); for (let i = 0; i < loud.length; i += 2) loud.writeInt16LE(i % 4 ? 3_000 : -3_000, i);
    const talk = (who: string, from: number, to: number): void => { for (let at = from; at < to; at += 100) mics.trackMic(who, loud, at); };
    await r.to(18_500);
    expect(await r.owner.holdPress('lead')).toEqual({ ok: true });
    talk('lead', 18_600, 20_600);
    await r.to(20_900);
    r.owner.holdRelease('lead');
    await r.to(22_100);
    r.answers.push(pick('time_left'));
    void r.owner.sentence({ userId: 'lead', sentenceId: 'h1', text: 'How much time is left?', startMs: 14_500, endMs: 20_600 });
    await r.flush();
    expect(r.ran.map((x) => x.name)).toEqual(['time_left']);
    // 13 s later he talks to the candidate. No audio came from his mic in between, so the lane missed the onset and dates the
    // sentence from the end of the one before it, which is before the release. His mic says where he really began.
    await r.to(53_400);
    talk('lead', 53_400, 56_400);
    await r.to(58_100);
    void r.owner.sentence({ userId: 'lead', sentenceId: 'h2', text: 'It is a classic: design a news feed.', startMs: 20_600, endMs: 56_400 });
    await r.flush();
    expect(r.requests.length).toBe(1);
    expect(r.ran.map((x) => x.name)).toEqual(['time_left']);
  });

  it('a second person\'s request waits for the floor and is taken next', async () => {
    const r = rig();
    await r.to(10_000);
    r.answers.push(pick('time_left'), pick('repeat_question'));
    await r.say('cara', 'Milo, how much time is left?');
    await r.by(300);
    await r.say('pam', 'Milo, repeat the question.', { start: 9_000 });
    expect(r.requests.length).toBe(1);
    await r.by(4_000);
    expect(r.turns.map((t) => [t.sentence.who, t.result.tool])).toEqual([['cara', 'time_left'], ['pam', 'repeat_question']]);
  });

  it('the floor view is today\'s RouteState', () => {
    let now = 0;
    const f = new Floor(() => now, undefined, FOLLOW_UP_MS);
    expect(f.state()).toEqual({ phase: 'idle' });
    f.deciding('a', 'name');
    expect(f.state()).toEqual({ phase: 'routing', userId: 'a', via: 'name', sinceMs: 0 });
    f.speaking('a', 'name'); f.answered('a', 1_000); f.free();
    expect(f.state()).toEqual({ phase: 'follow-up', userId: 'a', untilMs: 1_000 + FOLLOW_UP_MS });
    expect(f.route('a', 'and again', 2_000)).toBe('follow-up');
    expect(f.route('b', 'and again', 2_000)).toBeNull();
    now = 20_000;
    expect(f.route('a', 'and again', 20_000)).toBeNull();
    f.paused = true;
    expect(f.route('a', 'Milo, hello', 20_000)).toBeNull();
  });
});

// Milo never starts a line while a person is speaking (the film of 20 November: he began over the candidate at 0:37).
describe('never starting over someone: a line waits for a gap', () => {
  const loud = Buffer.alloc(4_800); for (let i = 0; i < loud.length; i += 2) loud.writeInt16LE(i % 4 ? 3_000 : -3_000, i);
  /** People talking, as their mics hear them: each stretch is fed frame by frame as the clock reaches it. */
  const talking = async (r: Rig, stretches: Array<[who: string, from: number, to: number]>, until: number): Promise<void> => {
    const mics = (r.owner as unknown as { mics: { trackMic(userId: string, pcm: Buffer, atMs: number): void } }).mics;
    const frames = stretches.flatMap(([who, from, to]) => { const out: Array<[number, string]> = []; for (let at = from; at < to; at += 100) out.push([at, who]); return out; }).sort((a, b) => a[0] - b[0]);
    for (const [at, who] of frames) { if (at >= until) break; await r.to(at); mics.trackMic(who, loud, at); }
    await r.to(until);
  };
  const tracesOf = (r: Rig, event: string): Array<Record<string, unknown>> => r.traces.filter(([e]) => e === event).map(([, d]) => d);

  it('with nobody speaking the line starts at once', async () => {
    const r = rig();
    await r.to(10_000);
    r.answers.push(pick('time_left'));
    await r.say('lead', 'Milo, how much time is left?');
    await r.by(50);
    expect(r.frames[0]).toBe(10_000);
    expect(tracesOf(r, 'turn.speak.wait')).toEqual([]);
  });

  it('the candidate is mid-sentence when the lead asks: the answer is logged at once and its first audio comes 400 ms after she stops', async () => {
    const r = rig();
    await talking(r, [['cara', 8_000, 10_000]], 10_000);
    r.answers.push(pick('time_left'));
    await r.say('lead', 'Milo, how much time is left?');
    expect(r.ran.map((x) => x.name)).toEqual(['time_left']); // the tool ran and logged its line; only the audio waits
    await talking(r, [['cara', 10_000, 12_000]], 12_300);
    expect(r.frames).toEqual([]); // she stopped at 12.0 s: 300 ms is not yet a gap
    await r.to(13_000);
    expect(r.frames[0]).toBeGreaterThanOrEqual(12_400);
    expect(r.frames[0]).toBeLessThanOrEqual(12_500);
    await r.to(20_000);
    expect(r.marks).toEqual(['spoken']);
    expect(r.turns[0]!.said).toMatchObject({ outcome: 'spoken', waitedMs: expect.any(Number) });
    expect(tracesOf(r, 'turn.speak.wait')).toEqual([{ tool: 'time_left', speakers: 1 }]);
    expect(tracesOf(r, 'turn.speak.waited')).toHaveLength(1);
  });

  it('two people trading sentences leave no gap between them: he waits for both', async () => {
    const r = rig();
    await talking(r, [['cara', 9_000, 10_000]], 10_000);
    r.answers.push(pick('time_left'));
    await r.say('lead', 'Milo, how much time is left?');
    // Cara to 11.0 s, Pam from 11.2 s to 12.5 s (a 200 ms change of speaker), then quiet.
    await talking(r, [['cara', 10_000, 11_000], ['pam', 11_200, 12_500]], 12_700);
    expect(r.frames).toEqual([]);
    await r.to(13_500);
    expect(r.frames[0]).toBeGreaterThanOrEqual(12_900);
    expect(r.frames[0]).toBeLessThanOrEqual(13_000);
  });

  it('no gap in 4 s: a line nobody asked for (the fixed cannot-help line) is dropped, logged as never said', async () => {
    const r = rig();
    await talking(r, [['pam', 9_000, 10_000]], 10_000);
    r.answers.push(pick('cannot_help'));
    await r.say('cara', 'Milo, what is the answer?');
    await talking(r, [['pam', 10_000, 16_000]], 16_000);
    await r.to(20_000);
    expect(r.logged.map((l) => [l.text, l.tool])).toEqual([[CAN_DO, 'cannot_help']]);
    expect(r.frames).toEqual([]);
    expect(r.marks).toEqual(['unspoken']);
    expect(r.turns[0]!.said).toMatchObject({ outcome: 'unspoken', why: 'no-gap' });
    expect(tracesOf(r, 'turn.speak.no-gap')).toEqual([{ tool: 'cannot_help', asked: false, waitedMs: 4_000 }]);
  });

  it('no gap in 4 s: the answer someone asked for stays queued and is said at the first gap', async () => {
    const r = rig();
    await talking(r, [['cara', 9_000, 10_000]], 10_000);
    r.answers.push(pick('time_left'));
    await r.say('lead', 'Milo, how much time is left?');
    await talking(r, [['cara', 10_000, 19_000]], 19_000);
    expect(r.frames).toEqual([]);
    expect(tracesOf(r, 'turn.speak.still-waiting')).toEqual([{ tool: 'time_left', waitedMs: 4_000 }]);
    await r.to(25_000);
    expect(r.frames[0]).toBeGreaterThanOrEqual(19_300);
    expect(r.frames[0]).toBeLessThanOrEqual(19_500);
    expect(r.marks).toEqual(['spoken']);
  });

  it('the asked answer is not kept for ever: after 30 s without a gap it stays in the log and the chat, unsaid', async () => {
    const r = rig();
    await talking(r, [['cara', 9_000, 10_000]], 10_000);
    r.answers.push(pick('time_left'));
    await r.say('lead', 'Milo, how much time is left?');
    await talking(r, [['cara', 10_000, 42_000]], 42_000);
    expect(r.frames).toEqual([]);
    expect(r.marks).toEqual(['unspoken']);
    expect(tracesOf(r, 'turn.speak.no-gap')).toEqual([{ tool: 'time_left', asked: true, waitedMs: 30_000 }]);
  });

  it('the asker asks for something else while the answer waits: the waiting answer is not said, the new request is', async () => {
    const r = rig();
    await talking(r, [['cara', 9_000, 10_000]], 10_000);
    r.answers.push(pick('time_left'), pick('repeat_question'));
    await r.say('lead', 'Milo, how much time is left?');
    await talking(r, [['cara', 10_000, 12_000]], 12_000);
    await r.say('lead', 'Milo, repeat the question instead.');
    await talking(r, [['cara', 12_000, 13_000]], 13_000);
    await r.to(20_000);
    expect(r.ran.map((x) => x.name)).toEqual(['time_left', 'repeat_question']);
    expect(r.marks).toEqual(['unspoken', 'spoken']);
    expect(r.turns.map((t) => [t.result.line, t.said?.outcome])).toEqual([[TIME, 'unspoken'], ['ran repeat_question', 'spoken']]);
    expect(r.frames[0]).toBeGreaterThanOrEqual(13_300);
  });

  it('a click is not speech, and his own voice heard back in a mic does not hold his next line', async () => {
    const r = rig();
    const mics = (r.owner as unknown as { mics: { trackMic(userId: string, pcm: Buffer, atMs: number): void; speakingAt(atMs: number, after?: number): string[] } }).mics;
    await r.to(10_000);
    mics.trackMic('cara', loud, 9_900); // 100 ms of noise
    expect(mics.speakingAt(10_000)).toEqual([]);
    mics.trackMic('cara', loud, 10_000); mics.trackMic('cara', loud, 10_100);
    expect(mics.speakingAt(10_200)).toEqual(['cara']);
    expect(mics.speakingAt(10_590)).toEqual(['cara']);
    expect(mics.speakingAt(10_600)).toEqual([]);
    expect(mics.speakingAt(10_200, 10_200)).toEqual([]); // nothing voiced after the mark (his echo tail)
  });
});

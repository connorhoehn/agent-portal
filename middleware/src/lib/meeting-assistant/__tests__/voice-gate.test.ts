// The voice gate: an utterance nobody asked for is held, then released in order or withheld whole (voice-gate.ts).
import { VOICE_GATE_HOLD_MS, VOICE_UTTERANCE_GAP_MS, VoiceGate, type VoiceGateDecision, type VoiceGateWhy } from '../voice-gate.js';

let now: number;
let why: VoiceGateWhy | null;
let sent: Array<{ n: number; last: boolean }>;
let decisions: Array<[VoiceGateDecision, number, string | null]>;
let timers: Array<{ at: number; fn: () => void; live: boolean }>;
let gate: VoiceGate;

const f = (n: number) => Buffer.from([n]);
const advance = (ms: number) => {
  now += ms;
  for (const t of timers) if (t.live && t.at <= now) { t.live = false; t.fn(); }
};
/** `n` frames 100 ms apart starting with frame number `from`, the last of them marked when `last`. */
const frames = (from: number, n: number, last = true) => {
  for (let i = 0; i < n; i += 1) { gate.frame(f(from + i), last && i === n - 1); if (i < n - 1) advance(100); }
};

beforeEach(() => {
  now = 1_000_000; why = null; sent = []; decisions = []; timers = [];
  gate = new VoiceGate({
    now: () => now,
    allowed: () => why,
    send: (pcm, last) => { sent.push({ n: pcm[0]!, last }); },
    decided: (d, heldMs, w) => { decisions.push([d, heldMs, w]); },
    schedule: (ms, fn) => { const t = { at: now + ms, fn, live: true }; timers.push(t); return () => { t.live = false; }; },
  });
});

describe('the voice gate', () => {
  it('opens at once when the voice is wanted at the first frame, and every frame goes out as it comes', () => {
    why = 'addressed';
    gate.frame(f(1), false);
    expect(sent).toEqual([{ n: 1, last: false }]);
    why = null; // the decision holds for the whole utterance
    advance(100); frames(2, 3);
    expect(sent.map((s) => s.n)).toEqual([1, 2, 3, 4]);
    expect(sent.at(-1)!.last).toBe(true);
    expect(decisions).toEqual([['open', 0, 'addressed']]);
    expect(gate.withheldUtterances).toBe(0);
  });

  it('holds an utterance nobody asked for, then releases the held frames in order once the reason arrives, and relays the rest', () => {
    frames(1, 5, false);
    expect(sent).toEqual([]);
    expect(gate.heldFrames()).toBe(5);
    why = 'hearing';
    gate.poke();
    expect(sent.map((s) => s.n)).toEqual([1, 2, 3, 4, 5]);
    advance(100); frames(6, 2);
    expect(sent.map((s) => s.n)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(sent.at(-1)!.last).toBe(true);
    expect(decisions.map((d) => d[0])).toEqual(['held', 'released']);
    expect(decisions[1]).toEqual(['released', 400, 'hearing']);
  });

  it('re-checks on every new frame while holding', () => {
    frames(1, 2, false);
    why = 'call';
    advance(100); gate.frame(f(3), false);
    expect(sent.map((s) => s.n)).toEqual([1, 2, 3]);
  });

  it('withholds the whole utterance when the hold runs out: nothing is sent, not even the last frame, and it is counted', () => {
    frames(1, 20, false);
    advance(100); frames(21, 10);
    expect(sent).toEqual([]);
    expect(gate.withheldFrames).toBe(30);
    expect(gate.withheldUtterances).toBe(1);
    expect(decisions.map((d) => d[0])).toEqual(['held', 'withheld']);
    expect(decisions[1]![1]).toBeGreaterThanOrEqual(VOICE_GATE_HOLD_MS);
    // A reason arriving after the drop does not bring the utterance back.
    why = 'addressed'; gate.poke();
    expect(sent).toEqual([]);
  });

  it('a short complete utterance waits out its hold on the timer, and the next utterance is decided afresh', () => {
    frames(1, 3);
    advance(VOICE_GATE_HOLD_MS);
    expect(gate.withheldUtterances).toBe(1);
    expect(gate.withheldFrames).toBe(3);
    why = 'reply';
    advance(500); frames(4, 2);
    expect(sent.map((s) => s.n)).toEqual([4, 5]);
  });

  it('a complete utterance released inside its hold goes out with its last frame', () => {
    frames(1, 3);
    advance(1000);
    why = 'message'; gate.poke();
    expect(sent).toEqual([{ n: 1, last: false }, { n: 2, last: false }, { n: 3, last: true }]);
  });

  it('recovers from an utterance whose last frame never came: a gap longer than the utterance gap starts a new one', () => {
    why = 'addressed';
    frames(1, 2, false); // no last frame
    why = null;
    advance(VOICE_UTTERANCE_GAP_MS + 1);
    gate.frame(f(3), false);
    expect(sent.map((s) => s.n)).toEqual([1, 2]); // the new utterance was decided again, and held
    expect(gate.heldFrames()).toBe(1);
  });

  it('a stuck dropped utterance does not swallow the next one', () => {
    frames(1, 25, false); // withheld at 2 s, never ends
    expect(gate.withheldUtterances).toBe(1);
    why = 'addressed';
    advance(VOICE_UTTERANCE_GAP_MS + 1);
    frames(26, 2);
    expect(sent.map((s) => s.n)).toEqual([26, 27]);
  });

  it('clear forgets what is held, sends nothing and counts nothing, and resets', () => {
    frames(1, 4, false);
    gate.clear();
    expect(gate.heldFrames()).toBe(0);
    advance(VOICE_GATE_HOLD_MS + 10);
    expect(sent).toEqual([]);
    expect(gate.withheldUtterances).toBe(0);
    why = 'addressed';
    gate.frame(f(9), true);
    expect(sent).toEqual([{ n: 9, last: true }]);
  });
});

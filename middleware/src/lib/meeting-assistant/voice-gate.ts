// Nova's voice gate (docs/meeting-assistant-design.md, decision 4): her voice goes out only for speech someone asked for.
//
// The live model is told to stay silent unless addressed, and the chat side already drops an unprompted remark, but its audio
// arrives frame by frame long before the utterance's transcript is final. This gate stands in front of the relay and decides once
// per UTTERANCE (the run of output frames from the first voiced frame after quiet up to and including the frame marked `last`):
//
//   open      someone asked for it at the first frame (the caller's `allowed()` names why): every frame goes out as it comes.
//   held      nobody had at the first frame: the frames are kept in memory, unsent, for at most VOICE_GATE_HOLD_MS from the first
//             frame. `allowed()` is asked again on every new frame and on every `poke()` (the caller pokes on each heard line).
//   released  it became true while held: the held frames go out in order and the rest of the utterance is relayed as it comes.
//   withheld  the hold ran out first: the held frames and every later frame of the utterance (through its `last`) are discarded.
//             Nothing of it is sent, not even the `last` frame.
//
// Held audio lives only in this object's memory: never on disk, never logged, gone when released, withheld or cleared. A provider
// that never sends the `last` frame cannot wedge the gate: a gap of more than VOICE_UTTERANCE_GAP_MS without frames starts a new
// utterance. Pure: the clock and the timer are injected; the caller does the sending (and notes when Nova was heard).

/** A heard line that addressed Nova opens the gate for an utterance that begins within this long after the line ended. */
export const VOICE_PROMPT_WINDOW_MS = 10_000;
/** How long an utterance nobody asked for is held, from its first frame, waiting for the reason to arrive. */
export const VOICE_GATE_HOLD_MS = 2000;
/** No frame for longer than this and the next frame begins a new utterance, even without a `last` frame before it. */
export const VOICE_UTTERANCE_GAP_MS = 1500;

export type VoiceGateDecision = 'open' | 'held' | 'released' | 'withheld';
/** Why the gate opened: a short code (never text). */
export type VoiceGateWhy = 'addressed' | 'hearing' | 'call' | 'reply' | 'message';

export interface VoiceGateOptions {
  now: () => number;
  /** Is the voice wanted at this moment, and why; null when nobody asked. */
  allowed: () => VoiceGateWhy | null;
  /** Relay one frame (the caller notes Nova as heard at this moment). */
  send: (pcm: Buffer, last: boolean) => void;
  /** Each decision, for the trace: numbers and codes only. */
  decided?: (decision: VoiceGateDecision, heldMs: number, why: VoiceGateWhy | 'timeout' | null) => void;
  /** A one-shot timer; returns its cancel. Default: an unref'd setTimeout. */
  schedule?: (ms: number, fn: () => void) => () => void;
}

type State = 'idle' | 'open' | 'held' | 'dropping';

export class VoiceGate {
  withheldFrames = 0;
  withheldUtterances = 0;
  private state: State = 'idle';
  private held: Array<{ pcm: Buffer; last: boolean }> = [];
  private firstAt = 0;
  private lastFrameAt = -Infinity;
  /** The held utterance already had its `last` frame: it is complete and only waits for the decision. */
  private complete = false;
  private cancelTimer: (() => void) | null = null;

  constructor(private readonly o: VoiceGateOptions) {}

  /** One output frame of Nova's voice, in order. */
  frame(pcm: Buffer, last: boolean): void {
    const now = this.o.now();
    // A new utterance: after quiet (the previous one ended or went silent too long), or after a completed held one.
    if (this.state !== 'idle' && (now - this.lastFrameAt > VOICE_UTTERANCE_GAP_MS || (this.state === 'held' && this.complete))) this.finish();
    this.lastFrameAt = now;
    if (this.state === 'idle') this.begin(now);
    if (this.state === 'open') this.o.send(pcm, last);
    else if (this.state === 'dropping') this.withheldFrames += 1;
    else {
      this.held.push({ pcm, last });
      if (last) this.complete = true;
      this.check();
      return;
    }
    if (last) this.reset();
  }

  /** Something changed that may open a held utterance (a heard line, a tool call). */
  poke(): void { if (this.state === 'held') this.check(); }

  /** Paused, left, voice off, or the session replaced: forget what is held (it was never anyone's audio) and start afresh. */
  clear(): void {
    this.held = [];
    this.reset();
    this.lastFrameAt = -Infinity;
  }

  /** Frames held right now (tests and counters). */
  heldFrames(): number { return this.held.length; }

  private begin(now: number): void {
    this.firstAt = now;
    this.complete = false;
    const why = this.o.allowed();
    if (why) { this.state = 'open'; this.o.decided?.('open', 0, why); return; }
    this.state = 'held';
    this.o.decided?.('held', 0, null);
    const schedule = this.o.schedule ?? ((ms, fn) => { const h = setTimeout(fn, ms); h.unref?.(); return () => clearTimeout(h); });
    this.cancelTimer = schedule(VOICE_GATE_HOLD_MS, () => { this.cancelTimer = null; if (this.state === 'held') this.check(true); });
  }

  /** Release when it is allowed now; withhold when the hold has run out (or `expired`). */
  private check(expired = false): void {
    const now = this.o.now();
    const why = this.o.allowed();
    if (why) { this.release(now, why); return; }
    if (expired || now - this.firstAt >= VOICE_GATE_HOLD_MS) this.withhold(now, 'timeout');
  }

  /** The held utterance must be decided now (a new one is starting): released if allowed, otherwise withheld. */
  private finish(): void {
    if (this.state === 'held') {
      const now = this.o.now();
      const why = this.o.allowed();
      if (why) this.release(now, why); else this.withhold(now, null);
    }
    this.reset();
  }

  private release(now: number, why: VoiceGateWhy): void {
    this.stopTimer();
    const frames = this.held; this.held = [];
    this.o.decided?.('released', now - this.firstAt, why);
    for (const f of frames) this.o.send(f.pcm, f.last);
    if (this.complete) this.reset(); else this.state = 'open';
  }

  private withhold(now: number, why: 'timeout' | null): void {
    this.stopTimer();
    this.withheldFrames += this.held.length;
    this.withheldUtterances += 1;
    this.held = [];
    this.o.decided?.('withheld', now - this.firstAt, why);
    if (this.complete) this.reset(); else this.state = 'dropping';
  }

  private stopTimer(): void { this.cancelTimer?.(); this.cancelTimer = null; }

  private reset(): void {
    this.stopTimer();
    this.state = 'idle';
    this.complete = false;
    this.held = [];
  }
}

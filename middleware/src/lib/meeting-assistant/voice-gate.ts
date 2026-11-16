// Milo's voice gate (docs/meeting-assistant-design.md, decision 4): its voice goes out only for speech someone asked for.
//
// The live model is told to stay silent unless addressed, and the chat side already drops an unprompted remark, but its audio
// arrives frame by frame long before the utterance's transcript is final. This gate stands in front of the relay and decides once
// per SPEAKING TURN: the run of output frames from the first voiced frame after quiet until no frame has come for longer than a gap.
// The provider marks a frame `last` after every 300 ms of silence (live-session.ts), so a spoken answer of several sentences is
// several such pieces; their `last` flags stay on their frames and go out in order (the browser uses them), but they do not end the
// decision, so no sentence of an answer is judged on its own.
//
//   open      someone asked for it at the first frame (the caller's `allowed()` names why): every frame goes out as it comes,
//             through the pauses between sentences, until no frame has come for VOICE_OPEN_TURN_GAP_MS.
//   held      nobody had at the first frame: the frames (every sentence that follows) are kept in memory, unsent, under ONE hold of at
//             most VOICE_GATE_HOLD_MS from the turn's first frame. `allowed()` is asked again on every new frame, on every `poke()`
//             (the caller pokes on each heard line) and when the hold runs out (a timer, so it runs out on time while frames keep
//             coming). A held turn is never ended by a pause: it is decided by its hold, once.
//   released  it became true while held: the held frames go out in order and the rest of the turn is relayed as it comes (open).
//   withheld  the hold ran out first: the held frames and every later frame of the turn are discarded, until no frame has come
//             for VOICE_UTTERANCE_GAP_MS. Nothing of it is sent, not even a `last` frame.
//
// Held audio lives only in this object's memory: never on disk, never logged, gone when released, withheld or cleared. Pure: the
// clock and the timer are injected; the caller does the sending (and notes when Milo was heard).

/**
 * How far back from a tool call or an answer its asker is looked for (decision 3; orchestrator.ts re-exports it). One constant
 * for the chat and the voice: an answer posted as "Asked by X" is never withheld from X's ears for being 10 to 20 s late.
 */
export const ASKER_WINDOW_MS = 20_000;
/** A heard line that addressed Milo opens the gate for a turn that begins within this long after the line ended (= ASKER_WINDOW_MS). */
export const VOICE_PROMPT_WINDOW_MS = ASKER_WINDOW_MS;
/** How long a turn nobody asked for is held, from its first frame, waiting for the reason to arrive. */
export const VOICE_GATE_HOLD_MS = 2000;
/** A withheld turn ends when no frame has come for longer than this: the next frame begins a new turn, decided afresh. */
export const VOICE_UTTERANCE_GAP_MS = 1500;
/** An open (relayed) turn ends when no frame has come for longer than this; the pauses between an answer's sentences stay inside it. */
export const VOICE_OPEN_TURN_GAP_MS = 3000;

export type VoiceGateDecision = 'open' | 'held' | 'released' | 'withheld';
/** Why the gate opened: a short code (never text). */
export type VoiceGateWhy = 'addressed' | 'hearing' | 'call' | 'reply' | 'message';
/** Where the current turn stands: `idle` between turns. */
export type VoiceGatePhase = 'idle' | 'open' | 'held' | 'dropping';

export interface VoiceGateOptions {
  now: () => number;
  /** Is the voice wanted at this moment, and why; null when nobody asked. */
  allowed: () => VoiceGateWhy | null;
  /** Relay one frame, in order, with its own `last` flag (the caller notes Milo as heard). */
  send: (pcm: Buffer, last: boolean) => void;
  /** Each decision, for the trace: numbers and codes only. A turn records `open`, or `held` and then `released` or `withheld`. */
  decided?: (decision: VoiceGateDecision, heldMs: number, why: VoiceGateWhy | 'timeout' | null) => void;
  /** A one-shot timer; returns its cancel. Default: an unref'd setTimeout. */
  schedule?: (ms: number, fn: () => void) => () => void;
}

export class VoiceGate {
  withheldFrames = 0;
  /** Turns withheld (the name the call's counters carry). */
  withheldUtterances = 0;
  private state: VoiceGatePhase = 'idle';
  private held: Array<{ pcm: Buffer; last: boolean }> = [];
  private firstAt = 0;
  private lastFrameAt = -Infinity;
  private cancelTimer: (() => void) | null = null;

  constructor(private readonly o: VoiceGateOptions) {}

  /** One output frame of Milo's voice, in order. */
  frame(pcm: Buffer, last: boolean): void {
    const now = this.o.now();
    // A held turn whose hold has run out (its timer not run yet) is decided first, as it stood.
    if (this.state === 'held' && now - this.firstAt >= VOICE_GATE_HOLD_MS) this.check(true);
    // The turn ended at a gap: this frame begins a new one.
    const gap = now - this.lastFrameAt;
    if ((this.state === 'open' && gap > VOICE_OPEN_TURN_GAP_MS) || (this.state === 'dropping' && gap > VOICE_UTTERANCE_GAP_MS)) this.reset();
    this.lastFrameAt = now;
    if (this.state === 'idle') this.begin(now);
    if (this.state === 'open') this.o.send(pcm, last);
    else if (this.state === 'dropping') this.withheldFrames += 1;
    else { this.held.push({ pcm, last }); this.check(); }
  }

  /** Something changed that may open a held turn (a heard line, a tool call). */
  poke(): void { if (this.state === 'held') this.check(); }

  /** Paused, left, voice off, or the session replaced: forget what is held (it was never anyone's audio) and start afresh. */
  clear(): void {
    this.reset();
    this.lastFrameAt = -Infinity;
  }

  /** Frames held right now (tests and counters). */
  heldFrames(): number { return this.held.length; }

  /** Where the current turn stands (the caller keeps Milo's words for a held turn aside, and drops them for a withheld one). */
  phase(): VoiceGatePhase { return this.state; }

  private begin(now: number): void {
    this.firstAt = now;
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
    if (expired || now - this.firstAt >= VOICE_GATE_HOLD_MS) this.withhold(now);
  }

  private release(now: number, why: VoiceGateWhy): void {
    this.stopTimer();
    const frames = this.held; this.held = [];
    this.state = 'open';
    this.o.decided?.('released', now - this.firstAt, why);
    for (const f of frames) this.o.send(f.pcm, f.last);
  }

  private withhold(now: number): void {
    this.stopTimer();
    this.withheldFrames += this.held.length;
    this.withheldUtterances += 1;
    this.held = [];
    this.state = 'dropping';
    this.o.decided?.('withheld', now - this.firstAt, 'timeout');
  }

  private stopTimer(): void { this.cancelTimer?.(); this.cancelTimer = null; }

  private reset(): void {
    this.stopTimer();
    this.state = 'idle';
    this.held = [];
  }
}

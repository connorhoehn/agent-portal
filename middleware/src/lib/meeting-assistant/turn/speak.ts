// Speak: one line Milo says, in order (docs/milo-rebuild/REBUILD-PLAN.md section 1, REBUILD-REVIEW.md risks 3 and 10).
//
//   money hold -> the tenant's log (awaited; a throw means neither posted nor said) -> chat post -> TTS of exactly the logged
//   text -> paced playout -> how it ended in the log.
//
// Pacing is owned here: frames go out at real time and at most 300 ms ahead of what has played, so a long line is never dropped
// by the relay's 3 s queue, and a stop (talked over, cancelled) can end it within one frame. A line whose hold is refused, or
// whose TTS fails before any audio, stays posted and is marked unspoken. One line at a time per call: `Mouth` queues them.
//
// The voice is a SpeechBackend (voice/speech.ts), chosen by config. Spoken equals logged is checked here, not trusted: audio is
// played only after the backend has reported the exact text it sent and that text is the logged line, character for character.
// A backend that changed the words, reported nothing, or runs at another sample rate plays nothing (`not-the-logged-words`,
// `tts-failed`): the line stays logged and posted, marked unspoken.
import type { PolicyCall } from '../policy.js';
import { trace } from '../trace.js';
import { VOICE_FRAME_BYTES, VOICE_FRAME_MS, VOICE_SAMPLE_RATE } from '../voice.js';
import { speechBackend, type SpeechBackend, type SpeechResult } from '../../voice/speech.js';
import type { SpokenLine, SpokenOutcome, TurnPolicy } from './types.js';

/** How far ahead of real playout frames may be sent. */
export const PLAYOUT_LEAD_MS = 300;

export interface SpeakRequest {
  call: PolicyCall;
  policy: Pick<TurnPolicy, 'logSpoken' | 'markSpoken' | 'holdSpeech'>;
  line: SpokenLine;
  /** The line was already logged by whoever produced it (a server tool's family log): the row id, or null when it gave none. */
  logged?: { rowId: string | null };
}

export interface SpeakResult {
  outcome: SpokenOutcome | 'not-logged';
  rowId: string | null;
  /** Why it was not heard whole: the hold was refused, TTS failed, the voice would have said other words, or it was stopped. */
  why?: 'no-hold' | 'tts-failed' | 'not-the-logged-words' | 'stopped';
  /** Ms on `now()`: the first frame sent, and when the last frame has played out. */
  playStartMs: number | null;
  playEndMs: number | null;
  tts: SpeechResult | null;
}

export interface SpeakDeps {
  /** One relay frame (at most 100 ms of PCM16 24 kHz); `last` on the line's final frame. */
  push(pcm: Buffer, last: boolean): void;
  /** Forget frames the relay still holds (a stop). */
  clear(): void;
  /** Post the line to the call's chat (awaited before any audio). A failure is traced and the line is still said. */
  post?(line: SpokenLine): Promise<void>;
  /** The voice. Absent: the configured backend (MILO_TTS_BACKEND, MILO_TTS_MODEL, MILO_TTS_VOICE). */
  voice?: SpeechBackend;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onPlay?(ev: { kind: 'start' | 'end'; line: SpokenLine; atMs: number }): void;
}

export interface Speaking {
  done: Promise<SpeakResult>;
  /** Stop it now (talked over, cancelled): no more frames, queued frames cleared; heard in part if any frame went out. */
  stop(): void;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, Math.max(0, ms)));

/** Say one line now (callers queue through `Mouth`). */
export function speakLine(req: SpeakRequest, deps: SpeakDeps): Speaking {
  const controller = new AbortController();
  const stopped = (): boolean => controller.signal.aborted;
  const stop = (): void => { if (!stopped()) { controller.abort(); deps.clear(); } };
  return { done: run(req, deps, controller.signal), stop };
}

async function run(req: SpeakRequest, deps: SpeakDeps, stopSignal: AbortSignal): Promise<SpeakResult> {
  const { call, policy, line } = req;
  const now = deps.now ?? (() => performance.now());
  const sleep = deps.sleep ?? realSleep;
  const result: SpeakResult = { outcome: 'unspoken', rowId: null, playStartMs: null, playEndMs: null, tts: null };

  const hold = policy.holdSpeech ? await policy.holdSpeech(call, line).catch(() => null) : { release: async () => {} };
  try {
    if (req.logged) result.rowId = req.logged.rowId;
    else {
      try { result.rowId = await policy.logSpoken(call, line); } catch {
        trace('turn.speak', { outcome: 'not-logged', tool: line.tool });
        return { ...result, outcome: 'not-logged' };
      }
    }
    if (deps.post) await deps.post(line).catch(() => trace('turn.speak', { outcome: 'post-failed', tool: line.tool }));
    if (!hold) return await finish(req, { ...result, why: 'no-hold' }, 'unspoken');
    if (stopSignal.aborted) return await finish(req, { ...result, why: 'stopped' }, 'unspoken');

    // `signal` ends the voice request and the playout: a stop from outside, or the guard below refusing the backend's words.
    const guard = new AbortController();
    const signal = AbortSignal.any([stopSignal, guard.signal]);
    let confirmed = false;
    let otherWords = false;
    const refuse = (): void => { otherWords = true; guard.abort(); };

    // Paced playout: frame i is sent no earlier than start + i * 100 ms - 300 ms.
    let pending = Buffer.alloc(0);
    let ended = false;
    let wake: (() => void) | null = null;
    const nudge = (): void => { const w = wake; wake = null; w?.(); };
    let sent = 0;
    const pump = (async () => {
      for (;;) {
        if (signal.aborted) return;
        if (pending.length <= VOICE_FRAME_BYTES && !ended) { await new Promise<void>((r) => { wake = r; }); continue; }
        if (!pending.length) return;
        const frame = pending.subarray(0, Math.min(VOICE_FRAME_BYTES, pending.length));
        pending = pending.subarray(frame.length);
        const last = ended && pending.length === 0;
        if (result.playStartMs === null) {
          result.playStartMs = now();
          deps.onPlay?.({ kind: 'start', line, atMs: result.playStartMs });
        } else {
          const due = result.playStartMs + sent * VOICE_FRAME_MS - PLAYOUT_LEAD_MS;
          const wait = due - now();
          if (wait > 0) await sleep(wait);
          if (signal.aborted) return;
        }
        deps.push(Buffer.from(frame), last);
        sent += 1;
        if (last) return;
      }
    })();
    let ttsFailed = false;
    try {
      const voice = deps.voice ?? speechBackend();
      if (voice.sampleRate !== VOICE_SAMPLE_RATE) throw new Error('the voice backend is not at the relay sample rate');
      result.tts = await voice.speak(line.text, {
        signal, now,
        onInput: (input) => { if (input === line.text && !otherWords) confirmed = true; else refuse(); },
        onAudio: (pcm) => { if (!confirmed) { refuse(); return; } pending = Buffer.concat([pending, pcm]); nudge(); },
      });
      if (!confirmed) refuse();
    } catch {
      ttsFailed = !signal.aborted;
    }
    ended = true;
    if (ttsFailed || otherWords) pending = Buffer.alloc(0);
    nudge();
    await pump;
    if (otherWords && !stopSignal.aborted) {
      // Audio is accepted only once the words are confirmed, so nothing has played unless the backend confirmed the logged words
      // and then reported others: that line is cut where it is and marked partly.
      const heard = result.playStartMs !== null;
      if (heard) deps.clear();
      return await finish(req, { ...result, tts: null, why: 'not-the-logged-words' }, heard ? 'partly' : 'unspoken');
    }
    if (result.playStartMs !== null && !signal.aborted && !ttsFailed) {
      // The line has played out once its last frame's audio has: wait for that before the next line or the follow-up window.
      const end = result.playStartMs + sent * VOICE_FRAME_MS;
      const wait = end - now();
      if (wait > 0) await sleep(wait);
    }
    const heard = result.playStartMs !== null;
    if (signal.aborted) return await finish(req, { ...result, why: 'stopped' }, heard ? 'partly' : 'unspoken');
    if (ttsFailed) return await finish(req, { ...result, why: 'tts-failed' }, heard ? 'partly' : 'unspoken');
    result.playEndMs = now();
    deps.onPlay?.({ kind: 'end', line, atMs: result.playEndMs });
    return await finish(req, result, heard ? 'spoken' : 'unspoken');
  } finally {
    await hold?.release().catch(() => {});
  }
}

async function finish(req: SpeakRequest, result: SpeakResult, outcome: SpokenOutcome): Promise<SpeakResult> {
  await req.policy.markSpoken?.(req.call, result.rowId, req.line, outcome).catch(() => {});
  trace('turn.speak', { outcome, why: result.why, tool: req.line.tool, first: result.tts?.firstAudioMs ?? null });
  return { ...result, outcome };
}

/** One call's mouth: lines are said one at a time, in the order handed over; `stopAll` stops the current one and drops the queue. */
export class Mouth {
  private chain: Promise<unknown> = Promise.resolve();
  private current: Speaking | null = null;
  private epoch = 0;
  constructor(private readonly deps: SpeakDeps) {}

  say(req: SpeakRequest): Promise<SpeakResult> {
    const epoch = this.epoch;
    const next = this.chain.then(async (): Promise<SpeakResult> => {
      // Dropped by stopAll before its turn: still logged (the log is the record of what Milo was about to say), never played.
      if (epoch !== this.epoch) {
        const s = speakLine(req, this.deps);
        s.stop();
        return s.done;
      }
      this.current = speakLine(req, this.deps);
      try { return await this.current.done; } finally { this.current = null; }
    });
    this.chain = next.catch(() => {});
    return next;
  }

  /** Talked over, cancelled, paused or left: the line playing stops (partly) and queued lines are not played. */
  stopAll(): void { this.epoch += 1; this.current?.stop(); }

  get speaking(): boolean { return this.current !== null; }
}

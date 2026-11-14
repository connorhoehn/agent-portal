// The call's audio mixer (docs/meeting-assistant-design.md, decisions 1 and 8; package 6a).
//
// Each participant's own audio arrives as 16 kHz mono s16le chunks from the media server's taps. The mixer
//   * resamples a participant's stream to 24 kHz (linear interpolation; the fractional position and the last sample are
//     carried across chunks, so a stream cut into chunks resamples to exactly what the whole stream would),
//   * places each chunk on ONE output timeline, sums the participants there (hard-clamped, so a sum can never wrap), and
//   * emits one 100 ms 24 kHz frame for every 100 ms of wall time, silence included, so the provider's timeline stays
//     aligned with wall time (the probe, scripts/voice/probe-realtime.mjs, streams silence between utterances too).
//
// The output timeline is the live session's own: session millisecond 0 is the moment the mixer was created (the session
// opened) and frame k covers [k*100, (k+1)*100). `onPlaced` reports each placed piece with that same millisecond, which
// is how the voiced timeline (attribution.ts) is fed on the SAME clock base as the audio the provider hears.
//
// Pure and synchronous: an injected clock, no timers of its own (the owner calls `tick`), no I/O, and audio only ever
// lives in the ring below. Nothing here writes audio anywhere.

export const IN_RATE = 16_000;
export const OUT_RATE = 24_000;
export const FRAME_MS = 100;
const OUT_PER_MS = OUT_RATE / 1000;

/** Linear-interpolation resampler for one continuous stream. Chunk boundaries leave no trace in the output. */
export class LinearResampler {
  private readonly step: number;
  /** Position of the next output sample in input coordinates; 0 is the first sample of the NEXT chunk, negative is between the last sample (-1) and it. */
  private pos = 0;
  private last = 0;
  private primed = false;

  constructor(inRate = IN_RATE, outRate = OUT_RATE) { this.step = inRate / outRate; }

  /** The next chunk of the stream. Output samples that need the sample after this chunk wait for the next call. */
  process(input: Int16Array): Int16Array {
    const n = input.length;
    if (!n) return new Int16Array(0);
    const out: number[] = [];
    let x = this.pos;
    while (x <= n - 1) {
      let v: number;
      if (x < 0) {
        // Between the previous chunk's last sample and this chunk's first. Only reachable after a first chunk (pos starts at 0).
        const f = x + 1; // 0..1 from `last` to input[0]
        v = this.last * (1 - f) + input[0]! * f;
      } else {
        const i = Math.floor(x), f = x - i;
        v = f === 0 ? input[i]! : input[i]! * (1 - f) + input[i + 1]! * f;
      }
      out.push(Math.round(v));
      x += this.step;
    }
    this.pos = x - n;
    this.last = input[n - 1]!;
    this.primed = true;
    return Int16Array.from(out);
  }

  /** A gap in the stream: the next chunk starts a new run and nothing is interpolated across the silence. */
  reset(): void { this.pos = 0; this.last = 0; this.primed = false; }
  get isPrimed(): boolean { return this.primed; }
}

export function pcmToInt16(buf: Buffer): Int16Array {
  const n = Math.floor(buf.length / 2);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i += 1) out[i] = buf.readInt16LE(i * 2);
  return out;
}
export function int16ToPcm(samples: Int16Array): Buffer {
  const b = Buffer.allocUnsafe(samples.length * 2);
  for (let i = 0; i < samples.length; i += 1) b.writeInt16LE(samples[i]!, i * 2);
  return b;
}

export interface MixerOptions {
  clock: () => number;
  /** One 100 ms frame of 24 kHz mono s16le PCM (4800 bytes). Never awaited. */
  onFrame: (pcm24k: Buffer) => void;
  /** A piece of one participant's own audio (24 kHz) that went into the mix, with its start on the session timeline. */
  onPlaced?: (userId: string, pcm24k: Buffer, atMs: number) => void;
  /** Playout delay: how far ahead of the arrival of a chunk's last sample its first sample is scheduled. */
  playoutDelayMs?: number;
  /** A chunk whose slot is already this far in the past is dropped (and counted); a smaller lag is trimmed. */
  lateMs?: number;
  /** A gap between a participant's chunks bigger than this is silence; smaller is jitter and keeps the stream contiguous. */
  gapMs?: number;
  /** The ring's length, which is also the most audio that can wait ahead of the output. */
  aheadMs?: number;
  /** The most participants mixed at once; a chunk from one more is dropped and counted. */
  maxParticipants?: number;
}

export interface MixerStats {
  frames: number;
  chunks: number;
  lateChunks: number;
  overrunChunks: number;
  tooManyParticipants: number;
}

interface Lane { resampler: LinearResampler; /** Output sample (24 kHz, session timeline) where this participant's next chunk continues. */ nextSample: number | null }

export class CallMixer {
  readonly stats: MixerStats = { frames: 0, chunks: 0, lateChunks: 0, overrunChunks: 0, tooManyParticipants: 0 };
  private readonly startWall: number;
  private readonly ring: Int32Array;
  private readonly ringLen: number;
  private emitted = 0; // frames emitted
  private readonly lanes = new Map<string, Lane>();
  private readonly playoutDelayMs: number;
  private readonly lateMs: number;
  private readonly gapMs: number;
  private readonly maxParticipants: number;
  private closed = false;

  constructor(private readonly opts: MixerOptions) {
    this.startWall = opts.clock();
    this.playoutDelayMs = opts.playoutDelayMs ?? 300;
    this.lateMs = opts.lateMs ?? 400;
    this.gapMs = opts.gapMs ?? 150;
    this.maxParticipants = opts.maxParticipants ?? 16;
    this.ringLen = Math.round((opts.aheadMs ?? 2000) * OUT_PER_MS);
    this.ring = new Int32Array(this.ringLen);
  }

  /** The session timeline's "now" in ms, from the injected clock. */
  nowMs(): number { return this.opts.clock() - this.startWall; }
  /** Session ms up to which frames have been emitted. */
  get cursorMs(): number { return this.emitted * FRAME_MS; }
  get participants(): number { return this.lanes.size; }

  /**
   * One chunk of `userId`'s own 16 kHz mono s16le audio, which arrived at session ms `arrivalMs` (default: now). Returns
   * what became of it. The chunk is a few milliseconds of work and is never awaited by the caller.
   */
  push(userId: string, pcm16k: Buffer, arrivalMs: number = this.nowMs()): 'placed' | 'late' | 'overrun' | 'rejected' {
    if (this.closed) return 'rejected';
    const input = pcmToInt16(pcm16k);
    if (!input.length) return 'rejected';
    let lane = this.lanes.get(userId);
    if (!lane) {
      if (this.lanes.size >= this.maxParticipants) { this.stats.tooManyParticipants += 1; return 'rejected'; }
      lane = { resampler: new LinearResampler(), nextSample: null };
      this.lanes.set(userId, lane);
    }
    this.stats.chunks += 1;
    const durMs = (input.length / IN_RATE) * 1000;
    // The chunk holds the audio of the `durMs` before it arrived; it plays `playoutDelayMs` after that audio would have.
    const byArrival = arrivalMs - durMs + this.playoutDelayMs;
    const arrivalSample = Math.round(byArrival * OUT_PER_MS);
    let startSample = arrivalSample;
    // Jitter (either way) keeps the stream contiguous, to the sample; a real gap is silence and starts a new run.
    if (lane.nextSample !== null) {
      if ((arrivalSample - lane.nextSample) / OUT_PER_MS > this.gapMs) lane.resampler.reset(); else startSample = lane.nextSample;
    }
    const out = lane.resampler.process(input);
    lane.nextSample = startSample + out.length;
    const cursorSample = this.emitted * FRAME_MS * OUT_PER_MS;
    let from = 0;
    if (startSample < cursorSample) {
      const behindMs = (cursorSample - startSample) / OUT_PER_MS;
      if (behindMs > this.lateMs) { this.stats.lateChunks += 1; return 'late'; }
      from = cursorSample - startSample;
      startSample = cursorSample;
    }
    if (from >= out.length) { this.stats.lateChunks += 1; return 'late'; }
    const count = out.length - from;
    if (startSample + count > cursorSample + this.ringLen) { this.stats.overrunChunks += 1; return 'overrun'; }
    for (let i = 0; i < count; i += 1) this.ring[(startSample + i) % this.ringLen]! += out[from + i]!;
    if (this.opts.onPlaced) this.opts.onPlaced(userId, int16ToPcm(out.subarray(from)), startSample / OUT_PER_MS);
    return 'placed';
  }

  /** Emit every frame that is due. Returns how many. The owner calls this on a timer (about every 50 ms). */
  tick(): number {
    if (this.closed) return 0;
    const due = Math.floor(this.nowMs() / FRAME_MS);
    let n = 0;
    while (this.emitted < due) { this.emitFrame(); n += 1; }
    return n;
  }

  private emitFrame(): void {
    const per = FRAME_MS * OUT_PER_MS;
    const base = this.emitted * per;
    const frame = Buffer.allocUnsafe(per * 2);
    for (let i = 0; i < per; i += 1) {
      const idx = (base + i) % this.ringLen;
      const v = this.ring[idx]!;
      this.ring[idx] = 0;
      frame.writeInt16LE(v > 32767 ? 32767 : v < -32768 ? -32768 : v, i * 2);
    }
    this.emitted += 1; this.stats.frames += 1;
    try { this.opts.onFrame(frame); } catch (e) { console.warn('[meeting-assistant] audio frame sink failed', (e as Error).message); }
  }

  /** After this nothing is accepted or emitted, and what was waiting is dropped. */
  close(): void { this.closed = true; this.ring.fill(0); this.lanes.clear(); }
}

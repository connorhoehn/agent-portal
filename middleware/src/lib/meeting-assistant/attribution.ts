// Who spoke (docs/meeting-assistant-design.md, decision 2). The live model's transcript has no speaker, so the server
// keeps, per participant, when that participant's own audio was voiced, and matches each transcript piece to it.
// Pure: no I/O, no clock. The audio sink that feeds `VoicedTimeline` is package 6; the parts here are tested without audio.
//
// Times are milliseconds on ONE timeline, the live session's (0 at `start`), for the intervals and the pieces alike.

export interface VoicedInterval { userId: string; startMs: number; endMs: number }
export interface TranscriptSpan { startMs: number; endMs: number }
export interface Attribution {
  /** The participant voiced for most of the span; null when nobody was voiced (unattributed: never used for the name lock). */
  userId: string | null;
  /** Everyone voiced for at least `min(30% of the span, 400 ms)`, the primary first. Empty when unattributed. */
  speakers: string[];
}

/** The probe measured `end_ms` lagging real speech by up to about 600 ms in 200 ms steps (design doc, probe result). */
export const LAG_TOLERANCE_MS = 600;
export const SPEAKER_SHARE = 0.3;
export const SPEAKER_MIN_MS = 400;
export const TIMELINE_RETAIN_MS = 10 * 60_000;

/** Total length of the union of the intervals clipped to [from, to]. */
function coverage(spans: readonly VoicedInterval[], from: number, to: number): number {
  const clipped = spans
    .map((s) => [Math.max(s.startMs, from), Math.min(s.endMs, to)] as const)
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  let total = 0, curStart = 0, curEnd = -Infinity;
  for (const [a, b] of clipped) {
    if (a > curEnd) { if (curEnd > -Infinity) total += curEnd - curStart; curStart = a; curEnd = b; }
    else if (b > curEnd) curEnd = b;
  }
  if (curEnd > -Infinity) total += curEnd - curStart;
  return total;
}

/**
 * Attribute one transcript piece. The piece's stamps run late (up to LAG_TOLERANCE_MS) against the audio, so the
 * audio window starts that much before `startMs` and ends at `endMs`. A speaker needs overlap of at least
 * min(30% of the piece's length, 400 ms) and more than zero; the primary is the one with the most overlap (a tie goes
 * to whoever started first).
 */
export function attribute(intervals: readonly VoicedInterval[], piece: TranscriptSpan, lagMs = LAG_TOLERANCE_MS): Attribution {
  const from = piece.startMs - lagMs, to = piece.endMs;
  const span = Math.max(0, piece.endMs - piece.startMs);
  const need = Math.min(span * SPEAKER_SHARE, SPEAKER_MIN_MS);
  const byUser = new Map<string, VoicedInterval[]>();
  for (const i of intervals) {
    if (i.endMs <= from || i.startMs >= to) continue;
    (byUser.get(i.userId) ?? byUser.set(i.userId, []).get(i.userId)!).push(i);
  }
  const scored = [...byUser].map(([userId, list]) => ({ userId, overlap: coverage(list, from, to), first: Math.min(...list.map((s) => s.startMs)) }))
    .filter((s) => s.overlap > 0 && s.overlap >= need)
    .sort((a, b) => b.overlap - a.overlap || a.first - b.first || a.userId.localeCompare(b.userId));
  if (!scored.length) return { userId: null, speakers: [] };
  return { userId: scored[0]!.userId, speakers: scored.map((s) => s.userId) };
}

export interface TimelineOptions {
  /** 16-bit sample magnitude (0..32768) an RMS must reach for a frame to count as voiced. */
  rmsThreshold?: number;
  /** Pauses up to this long inside one person's speech do not split the interval. */
  hangoverMs?: number;
  retainMs?: number;
  /** Analysis frame length. */
  frameMs?: number;
}

interface PerUser { closed: VoicedInterval[]; open: VoicedInterval | null }

/** Maintains each participant's voiced intervals from their own PCM, trimmed to the last `retainMs`. */
export class VoicedTimeline {
  private readonly users = new Map<string, PerUser>();
  private latestMs = 0;
  private readonly rmsThreshold: number;
  private readonly hangoverMs: number;
  private readonly retainMs: number;
  private readonly frameMs: number;

  constructor(opts: TimelineOptions = {}) {
    this.rmsThreshold = opts.rmsThreshold ?? 500;
    this.hangoverMs = opts.hangoverMs ?? 300;
    this.retainMs = opts.retainMs ?? TIMELINE_RETAIN_MS;
    this.frameMs = opts.frameMs ?? 20;
  }

  /**
   * One chunk of `userId`'s own audio: 16-bit little-endian mono PCM at `sampleRate`, whose first sample is at
   * `atMs` on the timeline. Frames at or above the RMS threshold are voiced; voiced frames closer together than the
   * hangover form one interval.
   */
  feed(userId: string, pcm: Buffer, sampleRate: number, atMs: number): void {
    if (!userId || !Number.isFinite(sampleRate) || sampleRate < 8000 || !Number.isFinite(atMs)) return;
    const frame = Math.max(1, Math.round((sampleRate * this.frameMs) / 1000));
    const samples = Math.floor(pcm.length / 2);
    const u = this.users.get(userId) ?? { closed: [], open: null };
    this.users.set(userId, u);
    for (let at = 0; at < samples; at += frame) {
      const n = Math.min(frame, samples - at);
      let sum = 0;
      for (let i = 0; i < n; i += 1) { const v = pcm.readInt16LE((at + i) * 2); sum += v * v; }
      const t0 = atMs + (at / sampleRate) * 1000, t1 = atMs + ((at + n) / sampleRate) * 1000;
      this.latestMs = Math.max(this.latestMs, t1);
      if (Math.sqrt(sum / n) < this.rmsThreshold) continue;
      if (u.open && t0 - u.open.endMs <= this.hangoverMs) u.open.endMs = t1;
      else { if (u.open) u.closed.push(u.open); u.open = { userId, startMs: t0, endMs: t1 }; }
    }
    this.trim();
  }

  /** Everyone's intervals (the open ones included), oldest first. */
  intervals(): VoicedInterval[] {
    const out: VoicedInterval[] = [];
    for (const u of this.users.values()) { out.push(...u.closed); if (u.open) out.push({ ...u.open }); }
    return out.sort((a, b) => a.startMs - b.startMs);
  }

  attribute(piece: TranscriptSpan): Attribution { return attribute(this.intervals(), piece); }

  /** Drop what ended more than `retainMs` before the newest audio seen. */
  private trim(): void {
    const floor = this.latestMs - this.retainMs;
    for (const u of this.users.values()) u.closed = u.closed.filter((i) => i.endMs >= floor);
  }
}

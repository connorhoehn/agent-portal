// Who spoke (docs/meeting-assistant-design.md, decision 2). The live model's transcript has no speaker, so the server
// keeps, per participant, when that participant's own audio was voiced, and matches each transcript piece to it.
// Pure: no I/O, no clock. The audio sink that feeds `VoicedTimeline` is package 6; the parts here are tested without audio.
//
// Times are milliseconds on ONE timeline, the live session's (0 at `start`), for the intervals and the pieces alike.

export interface VoicedInterval {
  userId: string; startMs: number; endMs: number;
  /** Mean RMS (16-bit magnitude) of the voiced frames in the interval. Absent means unknown, and counts as equal for everyone. */
  level?: number;
  /** Total length of the voiced frames, the weight behind `level` while the interval is still growing. */
  voicedMs?: number;
  /** Mean of the participant's own noise floor while the interval ran; the level is judged against it. Absent means unknown. */
  noiseFloor?: number;
}
export interface TranscriptSpan { startMs: number; endMs: number }
export interface Attribution {
  /**
   * The primary speaker: the one participant who covers at least `PRIMARY_SHARE` of the voiced time inside the line's own span.
   * Null when nobody was voiced, and also when nobody dominates (two people starting together): such a line names nobody.
   */
  userId: string | null;
  /** Everyone voiced for at least `min(30% of the span, 400 ms)` and with at least a quarter of the loudest's normalised energy in the span, the one with most voiced time first. Empty when unattributed. */
  speakers: string[];
}

/** The probe measured `end_ms` lagging real speech by up to about 600 ms in 200 ms steps (design doc, probe result). */
export const LAG_TOLERANCE_MS = 600;
export const SPEAKER_SHARE = 0.3;
export const SPEAKER_MIN_MS = 400;
/** A participant whose voiced energy in the span is under this share of the loudest participant's is not a speaker. */
export const ENERGY_SHARE_MIN = 0.25;
/**
 * One participant is the line's primary speaker when they hold this share of all the speakers' voiced time in the line's own span.
 * A request spoken over someone else for a third to a half of its length leaves the speaker with 2/3 to 3/4; two people who start
 * together leave each with about a half. 0.6 sits between the two, with room for frame jitter on either side.
 */
export const PRIMARY_SHARE = 0.6;
/** A noise-normalised level (level over the participant's own floor) counts for at most this much, so one very loud microphone cannot outweigh a person. */
const NORMALISED_LEVEL_CAP = 10;
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

interface Scored { userId: string; voiced: number; energy: number; first: number }

/** Each participant's voiced time and energy inside [from, to]. An interval joined across pauses counts only its voiced density (sparse clicks do not fill it). */
function score(byUser: ReadonlyMap<string, VoicedInterval[]>, from: number, to: number, fallbackLevel: number): Scored[] {
  const out: Scored[] = [];
  for (const [userId, list] of byUser) {
    const covered = coverage(list, from, to);
    if (covered <= 0) continue;
    let len = 0, dens = 0, norm = 0;
    for (const i of list) {
      const w = Math.min(i.endMs, to) - Math.max(i.startMs, from);
      if (w <= 0) continue;
      const dur = i.endMs - i.startMs;
      const density = typeof i.voicedMs === 'number' && dur > 0 ? Math.min(1, i.voicedMs / dur) : 1;
      const level = typeof i.level === 'number' && i.level > 0 ? i.level : fallbackLevel;
      const floor = typeof i.noiseFloor === 'number' && i.noiseFloor > 0 ? i.noiseFloor : 0;
      len += w; dens += w * density; norm += w * (floor ? Math.min(NORMALISED_LEVEL_CAP, level / floor) : level);
    }
    const voiced = covered * (len ? dens / len : 1);
    out.push({ userId, voiced, energy: voiced * (len ? norm / len : 1), first: Math.min(...list.map((s) => s.startMs)) });
  }
  return out;
}

/**
 * Attribute one transcript piece by who was voiced inside the piece's own span. Each participant is weighed by their voiced time
 * (sparse noise inside a joined stretch counts only its voiced part); a speaker needs at least min(30% of the span, 400 ms), and
 * anyone under a quarter of the loudest's energy (level taken against the participant's own noise floor) is left out. The primary
 * is the one holding `PRIMARY_SHARE` of the speakers' voiced time; with nobody dominating, the line has no primary and names
 * nobody. The stamps run late against the audio by up to `lagMs`, so only when nobody qualifies inside the span is the window
 * widened that far back.
 */
export function attribute(intervals: readonly VoicedInterval[], piece: TranscriptSpan, lagMs = LAG_TOLERANCE_MS): Attribution {
  const span = Math.max(0, piece.endMs - piece.startMs);
  const need = Math.min(span * SPEAKER_SHARE, SPEAKER_MIN_MS);
  const byUser = new Map<string, VoicedInterval[]>();
  for (const i of intervals) (byUser.get(i.userId) ?? byUser.set(i.userId, []).get(i.userId)!).push(i);
  const levels = intervals.map((i) => i.level).filter((l): l is number => typeof l === 'number' && l > 0);
  const fallbackLevel = levels.length ? levels.reduce((a, b) => a + b, 0) / levels.length : 1;
  const pick = (from: number): Scored[] => {
    const scored = score(byUser, from, piece.endMs, fallbackLevel).filter((s) => s.voiced >= need);
    if (scored.length && levels.length) {
      const top = Math.max(...scored.map((s) => s.energy));
      return scored.filter((s) => s.energy >= top * ENERGY_SHARE_MIN);
    }
    return scored;
  };
  let kept = pick(piece.startMs);
  if (!kept.length && lagMs > 0) kept = pick(piece.startMs - lagMs);
  if (!kept.length) return { userId: null, speakers: [] };
  kept.sort((a, b) => b.voiced - a.voiced || a.first - b.first || a.userId.localeCompare(b.userId));
  const total = kept.reduce((n, s) => n + s.voiced, 0);
  const primary = kept[0]!.voiced >= total * PRIMARY_SHARE ? kept[0]!.userId : null;
  return { userId: primary, speakers: kept.map((s) => s.userId) };
}

export interface TimelineOptions {
  /** Absolute minimum 16-bit sample magnitude (0..32768) an RMS must reach for a frame to count as voiced. */
  rmsThreshold?: number;
  /** A frame must also be this many times above the participant's own noise floor. */
  floorRatio?: number;
  /** Pauses up to this long inside one person's speech do not split the interval. */
  hangoverMs?: number;
  retainMs?: number;
  /** Analysis frame length. */
  frameMs?: number;
}

interface PerUser { closed: VoicedInterval[]; open: VoicedInterval | null; floor: number }

/** Noise floor start, bounds and how fast it moves: down quickly (pauses between words reveal the true floor), up slowly. */
const FLOOR_START = 100, FLOOR_MAX = 2000, FLOOR_UP_TAU_MS = 10_000, FLOOR_DOWN_TAU_MS = 1000;

/** Attach the level fields as non-enumerable properties, so interval objects still compare and print as {userId, startMs, endMs}. */
function measured(iv: VoicedInterval, level: number, voicedMs: number, noiseFloor: number): VoicedInterval {
  Object.defineProperty(iv, 'noiseFloor', { value: noiseFloor, writable: true, enumerable: false, configurable: true });
  Object.defineProperty(iv, 'level', { value: level, writable: true, enumerable: false, configurable: true });
  Object.defineProperty(iv, 'voicedMs', { value: voicedMs, writable: true, enumerable: false, configurable: true });
  return iv;
}

/** Maintains each participant's voiced intervals from their own PCM, trimmed to the last `retainMs`. */
export class VoicedTimeline {
  private readonly users = new Map<string, PerUser>();
  private latestMs = 0;
  private readonly rmsThreshold: number;
  private readonly floorRatio: number;
  private readonly hangoverMs: number;
  private readonly retainMs: number;
  private readonly frameMs: number;

  constructor(opts: TimelineOptions = {}) {
    this.rmsThreshold = opts.rmsThreshold ?? 500;
    this.floorRatio = opts.floorRatio ?? 1.8;
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
    const u = this.users.get(userId) ?? { closed: [], open: null, floor: FLOOR_START };
    this.users.set(userId, u);
    for (let at = 0; at < samples; at += frame) {
      const n = Math.min(frame, samples - at);
      let sum = 0;
      for (let i = 0; i < n; i += 1) { const v = pcm.readInt16LE((at + i) * 2); sum += v * v; }
      const t0 = atMs + (at / sampleRate) * 1000, t1 = atMs + ((at + n) / sampleRate) * 1000;
      this.latestMs = Math.max(this.latestMs, t1);
      const rms = Math.sqrt(sum / n), dt = t1 - t0;
      const floorNow = u.floor;
      const voiced = rms >= Math.max(this.rmsThreshold, u.floor * this.floorRatio);
      const tau = rms < u.floor ? FLOOR_DOWN_TAU_MS : FLOOR_UP_TAU_MS;
      u.floor = Math.min(FLOOR_MAX, Math.max(FLOOR_START, u.floor + (rms - u.floor) * (1 - Math.exp(-dt / tau))));
      if (!voiced) continue;
      if (u.open && t0 - u.open.endMs <= this.hangoverMs) {
        u.open.endMs = t1;
        const was = u.open.voicedMs ?? 0, all = was + dt;
        u.open.level = ((u.open.level ?? rms) * was + rms * dt) / all; u.open.voicedMs = all;
        u.open.noiseFloor = ((u.open.noiseFloor ?? floorNow) * was + floorNow * dt) / all;
      } else { if (u.open) u.closed.push(u.open); u.open = measured({ userId, startMs: t0, endMs: t1 }, rms, dt, floorNow); }
    }
    this.trim();
  }

  /** Everyone's intervals (the open ones included), oldest first. */
  intervals(): VoicedInterval[] {
    const out: VoicedInterval[] = [];
    for (const u of this.users.values()) { out.push(...u.closed); if (u.open) out.push(measured({ ...u.open }, u.open.level ?? 0, u.open.voicedMs ?? 0, u.open.noiseFloor ?? 0)); }
    return out.sort((a, b) => a.startMs - b.startMs);
  }

  attribute(piece: TranscriptSpan): Attribution { return attribute(this.intervals(), piece); }

  /** Drop what ended more than `retainMs` before the newest audio seen. */
  private trim(): void {
    const floor = this.latestMs - this.retainMs;
    for (const u of this.users.values()) u.closed = u.closed.filter((i) => i.endMs >= floor);
  }
}

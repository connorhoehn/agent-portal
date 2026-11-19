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
   * Null when nobody was voiced, when nobody dominates (two people starting together), and when anyone else was voiced for
   * `SECONDARY_MAX_MS` or more inside the span (the words cannot be told apart): such a line names nobody.
   */
  userId: string | null;
  /** Everyone voiced for at least `min(30% of the span, 400 ms)` and with at least a quarter of the loudest's normalised energy in the span, the one with most voiced time first. Empty when unattributed. */
  speakers: string[];
}

/**
 * When nobody's voice lies inside a span, how far back it is widened. The probe measured `end_ms` lagging real speech by up to about
 * 600 ms; the paid scenario runs of 14 November saw single lines 1 to 2 s off the lag estimate (the provider's word times are noisy).
 */
export const LAG_TOLERANCE_MS = 2_000;
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
/**
 * Nobody is the primary speaker of a line in which anyone else was voiced for this long: a mixed transcript cannot say whose words
 * are whose, and a whole sentence of one person's must never be credited to another (a live interview, 17 November: the lead's
 * question, spoken over the candidate, was stored as the candidate's). A short interjection under a long line ("Right.") or the tail
 * of a sentence a request was spoken over stays under it.
 */
export const SECONDARY_MAX_MS = 2_000;
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
  const others = kept.slice(1).reduce((n, s) => Math.max(n, s.voiced), 0);
  const primary = kept[0]!.voiced >= total * PRIMARY_SHARE && others < SECONDARY_MAX_MS ? kept[0]!.userId : null;
  return { userId: primary, speakers: kept.map((s) => s.userId) };
}

/**
 * How late the provider's transcript times run behind the voiced timeline. The probe saw up to 600 ms; the paid scenario runs of
 * 14 November saw a turn's reported start about 1 s after its speaker's voice began, and the gap GROWING by about 1.3 s a minute
 * (2.6 s two minutes in; a ten-minute run lost almost every line). Each whole turn one person clearly spoke gives a sample near the
 * current estimate; the lag used is the median of the latest few, so it follows the drift. Spans are moved back by it before they
 * are attributed, so short lines ("Milo?") and the edges of a split land on the right voice.
 */
export const LAG_SAMPLES = 3;
/** A sample may be this much negative: in one paid session the provider's times ran slightly EARLY of the voices. */
export const LAG_MIN_MS = -1_000;
/** Before any estimate: the most a first sample may be. After it: how far a sample may stray from the estimate. */
export const LAG_FIRST_MAX_MS = 3_000;
export const LAG_STEP_MAX_MS = 2_000;
export function transcriptLag(samples: readonly number[]): number {
  if (samples.length === 0) return 0;
  const s = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

/**
 * One sample: the reported start minus the start of that person's voiced interval that the turn, moved back by the current
 * estimate, overlaps most. Null when the turn is short, no interval fits, or the result strays too far from the estimate.
 */
export function lagSample(intervals: readonly VoicedInterval[], userId: string, span: TranscriptSpan, current = 0): number | null {
  if (span.endMs - span.startMs < 1_000) return null;
  const reach = current > 0 ? LAG_STEP_MAX_MS : LAG_FIRST_MAX_MS;
  let best: VoicedInterval | null = null, bestOverlap = 0;
  for (const i of intervals) {
    if (i.userId !== userId || i.endMs - i.startMs < 800) continue;
    const overlap = Math.min(i.endMs, span.endMs - current) - Math.max(i.startMs, span.startMs - current - reach);
    if (overlap > bestOverlap) { bestOverlap = overlap; best = i; }
  }
  if (!best) return null;
  const d = span.startMs - best.startMs;
  return d >= LAG_MIN_MS && Math.abs(d - current) <= reach ? d : null;
}

/**
 * The lag measured without knowing who spoke. A transcript stamp is put on the words when the provider emits them, not when they
 * were spoken: in a paid interview take of 18 November the stamps ran 1.3 s behind the voices at the start and almost 5 s behind
 * nine minutes in (the stamps drift against the session clock by about 0.4 s a minute; the voiced timeline does not). The per-turn
 * sample above needs a turn already credited to one person, so a wrong first sample is never corrected once people alternate quickly
 * (that take: one sample of -0.56 s, then none, every turn holding two voices). Here every stamp of the last `LAG_WINDOW_MS`, moved
 * back by a candidate lag, should land on someone's voice: the lag is the middle of the run of candidates that puts the most stamps on
 * a voice. Pauses decide it: too small a lag puts the last words of a turn in the silence after it, too large puts the first in the
 * silence before. Null when there are too few stamps, the best fit is poor, two separate runs fit equally well (no previous
 * estimate to choose by), or the run is wider than `LAG_RUN_MAX_MS`: with no pause in the window (people answering each other
 * within 0.3 s, one microphone voiced throughout, one person talking a minute) every lag puts the stamps on a voice, and the middle
 * of that run (about 10 s) is a guess that credits a request to whoever spoke 10 s before it.
 */
export const LAG_WINDOW_MS = 60_000;
export const LAG_MIN_STAMPS = 12;
/** The largest lag searched. The 14 November runs saw the drift reach 1.3 s a minute. */
export const LAG_SEARCH_MAX_MS = 20_000;
export const LAG_SEARCH_STEP_MS = 100;
/** The share of stamps the best lag must put on a voice. */
export const LAG_FIT_MIN = 0.8;
/** A stamp this close to a voice counts as on it (a word's stamp step is 200 ms; the gap between two speakers can be 0.2 s). */
const LAG_EDGE_MS = 100;
/** Candidates within this share of the best fit are as good as it. */
const LAG_FIT_TIE = 0.02;
/** The widest run of equally good lags that still pins the lag down (the 18 November take's runs were 0 to 0.2 s wide). */
export const LAG_RUN_MAX_MS = 2_000;
export function estimateLag(intervals: readonly VoicedInterval[], stamps: readonly TranscriptSpan[], previous: number | null = null): number | null {
  if (stamps.length < LAG_MIN_STAMPS) return null;
  const latest = Math.max(...stamps.map((s) => s.endMs));
  const mids = stamps.filter((s) => s.endMs >= latest - LAG_WINDOW_MS).map((s) => (s.startMs + s.endMs) / 2);
  if (mids.length < LAG_MIN_STAMPS) return null;
  // Everyone's voice as one sorted list of disjoint stretches, each widened by the edge allowance.
  const union: Array<[number, number]> = [];
  for (const i of [...intervals].sort((a, b) => a.startMs - b.startMs)) {
    const a = i.startMs - LAG_EDGE_MS, b = i.endMs + LAG_EDGE_MS, last = union[union.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b); else union.push([a, b]);
  }
  if (!union.length) return null;
  const onVoice = (t: number): boolean => {
    let lo = 0, hi = union.length - 1, at = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (union[m]![0] <= t) { at = m; lo = m + 1; } else hi = m - 1; }
    return at >= 0 && union[at]![1] >= t;
  };
  const fits: Array<{ lag: number; fit: number }> = [];
  for (let lag = LAG_MIN_MS; lag <= LAG_SEARCH_MAX_MS; lag += LAG_SEARCH_STEP_MS) {
    let n = 0;
    for (const m of mids) if (onVoice(m - lag)) n += 1;
    fits.push({ lag, fit: n / mids.length });
  }
  const best = Math.max(...fits.map((f) => f.fit));
  if (best < LAG_FIT_MIN) return null;
  // The runs of consecutive candidates that fit as well as the best; the estimate is the middle of one.
  const runs: Array<{ from: number; to: number }> = [];
  fits.forEach((f, i) => {
    if (f.fit < best - LAG_FIT_TIE) return;
    const r = runs[runs.length - 1];
    if (r && fits[i - 1] && r.to === fits[i - 1]!.lag) r.to = f.lag; else runs.push({ from: f.lag, to: f.lag });
  });
  const mid = (r: { from: number; to: number }) => Math.round((r.from + r.to) / 2 / 10) * 10;
  const chosen = runs.length === 1 ? runs[0]! : previous === null ? null : runs.reduce((a, b) => (Math.abs(mid(b) - previous) < Math.abs(mid(a) - previous) ? b : a));
  return chosen && chosen.to - chosen.from <= LAG_RUN_MAX_MS ? mid(chosen) : null;
}

/**
 * The most a new estimate may differ from the one in use while that one is under a window old. The stamps drift against the voices
 * by at most about 1.3 s a minute (the 14 November runs), so a bigger step inside a minute is the fit fooled, not the lag moving;
 * an estimate older than the window no longer vouches for anything, and the next one is taken whatever it is.
 */
export const LAG_JUMP_MAX_MS = 2_000;

/**
 * The lag the attribution uses, per live session: the stamps of the heard turns, the estimate from them (`estimateLag`), and, before
 * there is one, the median of the per-turn samples (`lagSample`).
 */
export class TranscriptLag {
  private stamps: TranscriptSpan[] = [];
  private samples: number[] = [];
  private estimate: number | null = null;
  /** The latest stamp's end when the estimate in use was taken. */
  private estimateAt = -Infinity;

  /** The stamps of one heard turn (each of the provider's pieces, or the turn's own span). */
  heard(spans: readonly TranscriptSpan[]): void {
    for (const s of spans) if (Number.isFinite(s.startMs) && Number.isFinite(s.endMs)) this.stamps.push({ startMs: s.startMs, endMs: s.endMs });
    const latest = this.stamps.reduce((m, s) => Math.max(m, s.endMs), -Infinity);
    this.stamps = this.stamps.filter((s) => s.endMs >= latest - LAG_WINDOW_MS);
  }

  /** Measure again against the voices; the lag to use now. */
  update(intervals: readonly VoicedInterval[]): number {
    const e = estimateLag(intervals, this.stamps, this.estimate);
    const latest = this.stamps.reduce((m, s) => Math.max(m, s.endMs), -Infinity);
    const vouches = this.estimate !== null && latest - this.estimateAt <= LAG_WINDOW_MS;
    if (e !== null && (!vouches || Math.abs(e - this.estimate!) <= LAG_JUMP_MAX_MS)) { this.estimate = e; this.estimateAt = latest; }
    return this.current();
  }

  current(): number { return this.estimate ?? transcriptLag(this.samples); }

  /** A whole turn one person clearly spoke: a per-turn sample, which counts only until the first estimate. */
  sample(intervals: readonly VoicedInterval[], userId: string, span: TranscriptSpan): void {
    if (this.estimate !== null) return;
    const s = lagSample(intervals, userId, span, this.current());
    if (s !== null) { this.samples.push(s); if (this.samples.length > LAG_SAMPLES) this.samples.shift(); }
  }
}

/** One of the provider's pieces of a heard turn, with its times on the audio timeline. */
export interface TranscriptPart { text: string; startMs: number; endMs: number }

/**
 * Split one heard turn where the voice changes. The provider groups everything said without a long pause into one turn, so a
 * request spoken right after someone else's sentence arrives joined to it, and the whole turn then has no single speaker. Each
 * part is attributed on its own; a part one person alone voiced that is not the current group's person starts a new group, a part
 * several people voiced at once belongs to a group of its own (overlapped speech: credited to nobody when it is stored, never folded
 * into one speaker's line), and a part nobody voiced stays with the group it follows. Text is joined as the provider sent it.
 */
export const SPLIT_MIN_MS = 1_200;
/** A stretch several people voiced at once that is at least this long is a line of its own, credited to nobody. */
export const MIXED_MIN_MS = 600;
/** The owner of a group of parts several people voiced at once. */
const MIXED = '\u0000mixed';
/** A piece of a split turn; `mixed` when several people were voiced through it (stored naming nobody). */
export interface SplitPiece extends TranscriptPart { mixed?: true }
export function splitBySpeaker(intervals: readonly VoicedInterval[], parts: readonly TranscriptPart[]): SplitPiece[] {
  const groups: Array<{ owner: string | null; parts: TranscriptPart[] }> = [];
  for (const p of parts) {
    const a = attribute(intervals, p);
    const owner = a.speakers.length > 1 ? MIXED : a.userId !== null && a.speakers.length === 1 ? a.userId : null;
    const g = groups[groups.length - 1];
    if (!g || (owner !== null && g.owner !== null && owner !== g.owner)) { groups.push({ owner, parts: [p] }); continue; }
    g.parts.push(p);
    if (g.owner === null) g.owner = owner;
  }
  // A sentence mark the provider put at the head of the next piece belongs to the line before; it is dropped from the new one.
  // A group shorter than SPLIT_MIN_MS is a word or two at the edge of someone's turn that the noisy word times put on the neighbouring
  // voice (paid run: "Milo, what is" went to the person who had just stopped); it stays with the group before it (or after, first).
  for (let i = 0; i < groups.length && groups.length > 1;) {
    const g = groups[i]!;
    // Overlapped speech is kept apart from MIXED_MIN_MS on. Shorter is a word or two where one voice takes over from another: it goes
    // with the voice that carries on after it (someone starting over the end of a sentence: "Milo," said as Vera finishes is Mia's),
    // and the line it joins names nobody when the other voice in it reaches SECONDARY_MAX_MS.
    if (g.parts[g.parts.length - 1]!.endMs - g.parts[0]!.startMs >= (g.owner === MIXED ? MIXED_MIN_MS : SPLIT_MIN_MS)) { i += 1; continue; }
    const forward = i === 0 || (g.owner === MIXED && i + 1 < groups.length);
    const into = forward ? groups[i + 1]! : groups[i - 1]!;
    if (forward) into.parts.unshift(...g.parts); else into.parts.push(...g.parts);
    groups.splice(i, 1);
    if (!forward) i -= 1;
  }
  for (let i = 1; i < groups.length;) { if (groups[i]!.owner === groups[i - 1]!.owner) { groups[i - 1]!.parts.push(...groups[i]!.parts); groups.splice(i, 1); } else i += 1; }
  return groups.map((g, i): SplitPiece => ({
    text: g.parts.map((p) => p.text).join('').replace(/\s+/g, ' ').trim().replace(i > 0 ? /^[.!?…]+\s*/ : /^$/, ''), startMs: g.parts[0]!.startMs, endMs: g.parts[g.parts.length - 1]!.endMs,
    ...(g.owner === MIXED ? { mixed: true as const } : {}),
  })).filter((g) => g.text);
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

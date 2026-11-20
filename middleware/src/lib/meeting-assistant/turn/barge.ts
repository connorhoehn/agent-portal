// Echo and barge-in: what a microphone heard while Milo speaks (docs/milo-rebuild/REBUILD-REVIEW.md risk 4).
//
// MOVED, not rewritten, from the hands-free router and rules (handsfree/router.ts, handsfree/rules.ts), which now import it from
// here: the word check (`overlapOf`: his own voice coming back, someone talking over him, or too little to tell), each mic's
// loudness against his playout (`MicWatch`: a mic that follows his voice is an open speaker), voiced onsets and where a sentence's
// speech began.
//
// NEW, two code rules for mics that do not hold only their owner (the bottom of the file):
//   echo      a sentence that began inside Milo's playout plus 1.5 s and matches the line he said is his voice heard back: it is
//             dropped, never judged and never stored as that person's words;
//   two-lane  the same sentence on two lanes is one turn. It is credited to the lane where it began first and, when the starts are
//             too close to tell, to the person who may ask for less, so a candidate heard through the lead's open speaker never
//             gets the lead's tools.
import { HANDSFREE, type OverlapVerdict } from '../handsfree/types.js';

const TICK_MS = HANDSFREE.frameMs;

// ── Words: echo vs barge-in (from handsfree/rules.ts) ───────────────────────────────────────────────────────────────────

export const wordsOf = (s: string): string[] => s.toLowerCase().replace(/['’]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);
const words = wordsOf;

/** A one-word interruption that is never Milo's echo when he did not say it. */
const STOP_WORDS: ReadonlySet<string> = new Set(['stop', 'wait', 'hold', 'enough', 'no', 'quiet', 'shush', 'cancel', 'pause', 'thanks']);

/**
 * Is what a mic heard while Milo speaks his own voice coming back (`echo`), someone talking over him (`barge-in`), or too little
 * to tell (`unclear`)? Words only. Milo's output transcript can lag his audio, so heard words that match his words first and only
 * run past them at the end are still `unclear` (his next words may not have arrived yet).
 */
export function overlapOf(heard: string, saying: string): OverlapVerdict {
  const mine = words(heard);
  if (!mine.length) return 'unclear';
  const spoken = words(saying);
  const said = new Set(spoken);
  if (mine.length === 1) return !said.has(mine[0]!) && STOP_WORDS.has(mine[0]!) ? 'barge-in' : 'unclear';
  if (!spoken.length) return mine.length >= 4 ? 'barge-in' : 'unclear';
  const joined = ` ${spoken.join(' ')} `;
  if (joined.includes(` ${mine.join(' ')} `)) return 'echo';
  // A stop word he has not said ("Milo, stop", "okay wait") is someone talking over him, however few the words.
  if (mine.some((x) => STOP_WORDS.has(x) && !said.has(x))) return 'barge-in';
  const hits = mine.map((x) => said.has(x));
  const share = hits.filter(Boolean).length / mine.length;
  if (mine.length >= 3 && share >= 0.8) return 'echo';
  // Milo's words first, then words he has not been transcribed saying yet: wait for the output transcript to catch up.
  const firstMiss = hits.indexOf(false);
  if (firstMiss >= 2 && hits.slice(firstMiss).every((h) => !h) && mine.length - firstMiss <= 3) return 'unclear';
  if (mine.length === 2) return share === 0 ? 'barge-in' : 'unclear';
  if (share <= 0.5) return 'barge-in';
  return mine.length >= 5 ? 'barge-in' : 'unclear';
}

// ── Loudness: does a mic carry his playout (from handsfree/router.ts) ───────────────────────────────────────────────────

// Barge-in by voice (review 1, item 8). Words confirm a barge-in about a second after it starts; a voiced onset in a mic that does
// not carry Milo's playout pauses the relay at once (what has not played is kept), and the words then confirm it (cleared) or not
// (resumed). A mic is judged on its earlier loudness against his earlier playout: one that follows it is leaky (an open speaker:
// its onsets are his echo), and stays words-only. A mic heard during too little of his playout to correlate (his first line) is
// judged on the bins it has: quiet through at least 300 ms of his voice before the onset, it pauses like a clean one (an echo
// would have been loud there); loud through most of them, it is leaky; less heard than that, or a mic whose words have already
// echoed him, stays words-only. A pause is bounded and his own words heard back resume it, so his echo never stops him (gate
// fixed-barge, 19 November: "Milo, stop" 600 ms into his first line went 1 s unheeded).
/** This much voice (20 ms windows over ONSET_RMS, gaps under 60 ms bridged) is an onset; 300 ms of quiet re-arms it. */
export const PAUSE_ONSET_MS = 200;
const ONSET_RMS = 300;
const ONSET_GAP_MS = 60;
const ONSET_REARM_MS = 300;
/** Loudness history kept per mic and for Milo's playout, in 100 ms bins (30 s). */
const LEAK_BINS = 300;
/** At least this many voiced bins of his playout heard in a mic before it can be judged clean. */
const LEAK_MIN_BINS = 15;
/** Echo lags tried (bins: up to 600 ms after he played). */
const LEAK_MAX_LAG = 6;
/** A mic whose loudness correlates with his playout below this at every lag is clean. */
const LEAK_CLEAN_CORR = 0.3;
/** The newest bins are left out of the judgement (the onset being judged is not history). */
const LEAK_SKIP_BINS = 5;
/** Too little history to correlate: at least this many voiced bins of his heard in the mic before the onset to judge it at all. */
const LEAK_EARLY_MIN_BINS = 3;
/** The onset's own bins left out of that early judgement (its 200 ms of voice and a bridged gap). */
const LEAK_EARLY_SKIP_BINS = 3;
/** A voiced stretch after this much quiet is a new stretch of speech (where a sentence heard later probably began). */
const SPEECH_GAP_MS = 600;
/** A stretch of speech that ends within this of a sentence's start is the tail of the sentence before it. */
const SENTENCE_TAIL_MS = 200;

/** RMS of 16-bit LE samples in [from, to) bytes. */
function rmsOf(pcm: Buffer, from = 0, to = pcm.length): number {
  let sum = 0; let n = 0;
  for (let i = from; i + 1 < to; i += 2) { const v = pcm.readInt16LE(i); sum += v * v; n += 1; }
  return n ? Math.sqrt(sum / n) : 0;
}
/** A frame's loudness on a log scale (what the echo check correlates). */
const loudness = (pcm: Buffer): number => Math.log10(1 + rmsOf(pcm));
const VOICED_LOUDNESS = Math.log10(1 + ONSET_RMS);
/** Pearson correlation; 0 when either side does not vary (a silent mic carries nothing of his). */
function pearson(xs: readonly number[], ys: readonly number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  let mx = 0; let my = 0;
  for (let i = 0; i < n; i++) { mx += xs[i]!; my += ys[i]!; }
  mx /= n; my /= n;
  let sxy = 0; let sxx = 0; let syy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i]! - mx; const dy = ys[i]! - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  return sxx > 1e-9 && syy > 1e-9 ? sxy / Math.sqrt(sxx * syy) : 0;
}

/**
 * Every mic's loudness and Milo's playout, per 100 ms bin, with each mic's voiced onsets and where its stretches of speech began.
 * `onOnset` is called for every onset (200 ms of voice after 300 ms of quiet), whoever is playing.
 */
export class MicWatch {
  private readonly miloBins = new Map<number, number>();
  private readonly micBins = new Map<string, Map<number, number>>();
  private readonly onsets = new Map<string, { voicedMs: number; quietMs: number; fired: boolean }>();
  private readonly speechStarts = new Map<string, number[]>();
  /** Where each stretch in `speechStarts` ends so far (its last voiced window's end), index for index. */
  private readonly speechEnds = new Map<string, number[]>();
  private readonly lastVoiced = new Map<string, number>();
  constructor(private readonly onOnset: (userId: string, bin: number) => void) {}

  /** One frame of his playout, in the bin it plays in. */
  notePlayout(bin: number, pcm: Buffer): void {
    this.miloBins.set(bin, loudness(pcm));
    for (const b of this.miloBins.keys()) { if (b > bin - LEAK_BINS) break; this.miloBins.delete(b); }
  }

  /** The relay was cleared: his playout from bin `from` on never happened. */
  forgetPlayoutFrom(from: number): void {
    for (const b of [...this.miloBins.keys()]) if (b >= from) this.miloBins.delete(b);
  }

  /** A person left: their history goes. */
  forget(userId: string): void {
    this.micBins.delete(userId); this.onsets.delete(userId); this.speechStarts.delete(userId); this.speechEnds.delete(userId); this.lastVoiced.delete(userId);
  }

  /** How a mic with a voiced onset at `bin` stands against his playout; `echoed`: its words have already echoed him in this call. */
  leakAtOnset(userId: string, bin: number, echoed: boolean): 'clean' | 'leaky' | 'unknown' | 'early-clean' {
    let mic: 'clean' | 'leaky' | 'unknown' | 'early-clean' = this.micLeak(userId, bin - LEAK_SKIP_BINS);
    if (mic === 'unknown' && !echoed) mic = this.micLeakEarly(userId, bin - LEAK_EARLY_SKIP_BINS);
    return mic;
  }

  trackMic(userId: string, pcm: Buffer, atMs: number): void {
    const bin = Math.floor(atMs / TICK_MS);
    const bins = this.micBins.get(userId) ?? new Map<number, number>();
    bins.delete(bin); bins.set(bin, loudness(pcm));
    for (const b of bins.keys()) { if (bins.size <= LEAK_BINS) break; bins.delete(b); }
    this.micBins.set(userId, bins);
    const o = this.onsets.get(userId) ?? { voicedMs: 0, quietMs: ONSET_REARM_MS, fired: false };
    this.onsets.set(userId, o);
    const win = (HANDSFREE.sampleRate * 2) / 50; // 20 ms
    const starts = this.speechStarts.get(userId) ?? [];
    this.speechStarts.set(userId, starts);
    const ends = this.speechEnds.get(userId) ?? [];
    this.speechEnds.set(userId, ends);
    for (let at = 0, ms = atMs; at + win <= pcm.length; at += win, ms += 20) {
      if (rmsOf(pcm, at, at + win) > ONSET_RMS) {
        o.voicedMs += 20; o.quietMs = 0;
        const lv = this.lastVoiced.get(userId);
        if (lv === undefined || ms - lv >= SPEECH_GAP_MS) { starts.push(ms); ends.push(ms + 20); if (starts.length > 16) { starts.shift(); ends.shift(); } }
        else if (ends.length) ends[ends.length - 1] = ms + 20;
        this.lastVoiced.set(userId, ms);
      }
      else {
        o.quietMs += 20;
        if (o.quietMs >= ONSET_GAP_MS) o.voicedMs = 0;
        if (o.quietMs >= ONSET_REARM_MS) o.fired = false;
      }
      if (!o.fired && o.voicedMs >= PAUSE_ONSET_MS) { o.fired = true; this.onOnset(userId, bin); }
    }
  }

  /** Does this mic carry Milo's playout? Its loudness against his, at the best echo lag, up to bin `before`. */
  micLeak(userId: string, before: number): 'clean' | 'leaky' | 'unknown' {
    const mic = this.micBins.get(userId);
    if (!mic) return 'unknown';
    let voiced = 0;
    for (const [b, e] of this.miloBins) if (b < before && mic.has(b) && e > VOICED_LOUDNESS) voiced += 1;
    if (voiced < LEAK_MIN_BINS) return 'unknown';
    let best = -1;
    for (let lag = 0; lag <= LEAK_MAX_LAG; lag++) {
      const xs: number[] = []; const ys: number[] = [];
      for (const [b, e] of this.miloBins) {
        const y = mic.get(b + lag);
        if (b + lag < before && y !== undefined) { xs.push(e); ys.push(y); }
      }
      best = Math.max(best, pearson(xs, ys));
    }
    return best < LEAK_CLEAN_CORR ? 'clean' : 'leaky';
  }

  /**
   * Too little of his playout heard in this mic to correlate: its voiced bins of his before the onset, each loud in the mic (at any
   * echo lag) or not. Quiet through at least `LEAK_EARLY_MIN_BINS` of them is early-clean; loud through half or more is leaky.
   */
  micLeakEarly(userId: string, before: number): 'early-clean' | 'leaky' | 'unknown' {
    const mic = this.micBins.get(userId);
    if (!mic) return 'unknown';
    let voiced = 0; let loud = 0;
    for (const [b, e] of this.miloBins) {
      if (b >= before || !mic.has(b) || e <= VOICED_LOUDNESS) continue;
      voiced += 1;
      for (let lag = 0; lag <= LEAK_MAX_LAG && b + lag < before; lag++) if ((mic.get(b + lag) ?? 0) > VOICED_LOUDNESS) { loud += 1; break; }
    }
    if (voiced < LEAK_EARLY_MIN_BINS) return 'unknown';
    return loud * 2 >= voiced ? 'leaky' : 'early-clean';
  }

  /**
   * Where a sentence the lane dated `fromMs` to `toMs` really began. A lane that missed the onset (no audio came from the mic
   * while the person was quiet) dates a sentence from the end of the one before it, seconds or minutes early. The mic knows: the
   * first stretch of speech that is not the earlier sentence's tail. It began inside the sentence: there. It was already running at
   * `fromMs` (the person never stopped), or the mic shows nothing: the lane's own start.
   */
  sentenceStart(userId: string, fromMs: number, toMs: number): number {
    const starts = this.speechStarts.get(userId) ?? [];
    const ends = this.speechEnds.get(userId) ?? [];
    for (let i = 0; i < starts.length; i++) {
      if (ends[i]! <= fromMs + SENTENCE_TAIL_MS) continue;
      return starts[i]! > fromMs && starts[i]! < toMs ? starts[i]! : fromMs;
    }
    return fromMs;
  }

  /** Where the speech heard at `atMs` probably began: the start of the mic's voiced stretch (voiced in the last 2 s), else unknown. */
  speechStartBefore(userId: string, atMs: number): number | null {
    const last = this.lastVoiced.get(userId);
    if (last === undefined || last < atMs - 2_000) return null;
    let start: number | null = null;
    for (const s of this.speechStarts.get(userId) ?? []) if (s <= atMs) start = s;
    return start !== null && start >= atMs - HANDSFREE.ringMs ? start : null;
  }
}

// ── Whose sentence is it: Milo's own line, or one sentence on two lanes (new, review risk 4) ────────────────────────────

/** Milo's voice is still heard back this long after his last frame played. */
export const ECHO_TAIL_MS = HANDSFREE.echoGraceMs;
/** Copies of one sentence on two lanes begin within this of each other. */
export const TWO_LANE_WINDOW_MS = 2_000;
/** Starts closer than this cannot say which lane was first: the person who may ask for less is credited. */
export const TWO_LANE_UNCLEAR_MS = 100;

/** A line Milo played: `endMs` null while it is still playing. */
export interface PlayedLine { text: string; startMs: number; endMs: number | null }
/** One lane's finished sentence. */
export interface LaneSentence { who: string; text: string; startMs: number; endMs: number }

/** Is this sentence Milo's own line heard back: it began inside his playout plus the tail and its words are his? */
export function isMiloEcho(s: LaneSentence, played: readonly PlayedLine[]): boolean {
  return played.some((p) => s.endMs > p.startMs && s.startMs < (p.endMs ?? Infinity) + ECHO_TAIL_MS && overlapOf(s.text, p.text) === 'echo');
}

/** Are two lanes' texts one sentence: the same words, one inside the other, or nearly all words shared both ways (two transcriptions of one voice)? */
export function sameSentence(a: string, b: string): boolean {
  const x = wordsOf(a); const y = wordsOf(b);
  if (!x.length || !y.length) return false;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short.join(' ') === long.join(' ')) return true;
  if (short.length < 3) return false;
  if (` ${long.join(' ')} `.includes(` ${short.join(' ')} `)) return short.length * 2 >= long.length;
  const inLong = new Set(long); const inShort = new Set(short);
  return short.filter((w) => inLong.has(w)).length / short.length >= 0.8 && long.filter((w) => inShort.has(w)).length / long.length >= 0.8;
}

/** Could two lanes' sentences be one voice: the same words, begun within the window? */
export const onTwoLanes = (a: LaneSentence, b: LaneSentence): boolean =>
  a.who !== b.who && Math.abs(a.startMs - b.startMs) <= TWO_LANE_WINDOW_MS && sameSentence(a.text, b.text);

/**
 * Which copy of one sentence is the speaker's. The lane where it began first (a voice through a speaker arrives later); starts too
 * close to tell, the person who may ask for less (`authority`: how many tools they have, -1 for nobody Milo serves); still equal,
 * the earlier start, then the lower user id, so both copies always name the same one.
 */
export function creditedLane<T extends LaneSentence>(a: T, b: T, authority: (who: string) => number): T {
  if (Math.abs(a.startMs - b.startMs) > TWO_LANE_UNCLEAR_MS) return a.startMs < b.startMs ? a : b;
  const ra = authority(a.who); const rb = authority(b.who);
  if (ra !== rb) return ra < rb ? a : b;
  if (a.startMs !== b.startMs) return a.startMs < b.startMs ? a : b;
  return a.who <= b.who ? a : b;
}

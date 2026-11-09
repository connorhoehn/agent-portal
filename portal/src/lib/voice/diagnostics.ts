// G63 (docs/voice-navigator-gaps.md, "Real sessions, 9 November 2026
// 13:47–14:01"): the session log explains a silent session without a word.
// vs_89fba6d6 ran 4.5 minutes with the owner talking, the voice speaking four
// times and nothing delegated, and the log could not say why: the dock's
// phase flips were all there was. These rows say what each utterance led to.
//
//   heard    one finished user utterance: `wordCount`, `ms` (its audio, from the
//            transcript's start_ms/end_ms; the wall clock when those are
//            missing), `outcome`, `afterMs` (last word to the outcome) and
//            `delegations` (how many the voice opened while it was current).
//            The outcome is the first of: `card` (the utterance resolved a
//            pending confirm or choice card), `delegated` (the voice opened a
//            delegation); else, when the utterance is over (HEARD_WAIT_MS after
//            its last word, the next utterance, or the session's end),
//            `answered` (the voice began speaking after it began) or `ignored`.
//   spoke    one voice utterance (ends VOICE_APART_MS after its last word):
//            `wordCount`, `ms`, `after` (the latest of a delegation result, the
//            dock's commentary or the user's words since the voice last spoke,
//            else `unprompted`).
//   context  the voice's context_window.usage_ratio, at most every
//            CONTEXT_EVERY_MS and only when it moved (the last value at the end).
//   frames   the frame types the dock drops (`other`), counted per
//            FRAMES_WINDOW_MS under their known names (sessionEvents.ts
//            LIVE_FRAME_TYPES), only in a minute that had any.
//   mic      a mute or unmute: the user's toggle, or the provider's frame when
//            it disagrees with the dock.
//   level    the microphone meter over LEVEL_WINDOW_MS: min, avg, max (0..1)
//            and the share of samples taken muted.
//
// The 500-row cap (middleware providers/voice-sessions.ts): the periodic rows
// are one `level` per 30 s, at most one `context` per 30 s and one `frames` per
// minute, so a 30-minute session spends at most 150 rows on them; the rest are
// per utterance. Words never leave this module: a transcript delta is counted
// (countWords) and dropped. Every row is a `client` event the middleware checks
// field by field (session-log.ts DIAGNOSTIC_SCHEMAS).

import { countWords, frameKey, type HeardOutcome, type SpokeAfter } from './sessionEvents.ts';

/** Nothing from the voice this long after the user's last word: the utterance is over, `ignored` unless it was answered. */
export const HEARD_WAIT_MS = 8000;
/** User words this far apart (wall clock) begin a new utterance (the controller's UTTERANCE_APART_MS). */
export const HEARD_APART_MS = 1500;
/** Voice words this far apart begin a new voice utterance; the last one ends this long after its last word. */
export const VOICE_APART_MS = 1500;
export const CONTEXT_EVERY_MS = 30_000;
export const FRAMES_WINDOW_MS = 60_000;
export const LEVEL_WINDOW_MS = 30_000;

type Timer = unknown;
type Emit = (data: Record<string, string | number | boolean | null | Record<string, number>>) => void;

interface Utterance {
  n: number; startAt: number; lastAt: number; words: number; lastChar: string | null;
  firstStartMs: number | null; lastEndMs: number | null; timer: Timer | null;
}
interface HeardUtterance extends Utterance { outcome: HeardOutcome | null; outcomeAt: number | null; voiceSpoke: boolean; delegations: number }
interface SpokeUtterance extends Utterance { after: SpokeAfter }

export interface DiagnosticsOptions {
  emit: Emit;
  now(): number;
  setTimer(fn: () => void, ms: number): Timer;
  clearTimer(t: Timer): void;
  /** The epoch milliseconds of `now()` (the dock's clock may be virtual): what `atMs` carries. Default: Date.now() at now(). */
  epoch?(at: number): number;
}

const r3 = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 1000) / 1000;
const ms = (v: number) => Math.max(0, Math.round(v));

export class SessionDiagnostics {
  private heardSeq = 0;
  private spokeSeq = 0;
  private user: HeardUtterance | null = null;
  private voice: SpokeUtterance | null = null;
  /** When the voice last finished an utterance, and the latest thing it could be answering since. */
  private voiceEndedAt = Number.NEGATIVE_INFINITY;
  private lastResultAt = Number.NEGATIVE_INFINITY;
  private lastCommentaryAt = Number.NEGATIVE_INFINITY;
  private lastUserAt = Number.NEGATIVE_INFINITY;
  private context: { loggedAt: number | null; logged: number | null; latest: number | null; seconds: number | null } = { loggedAt: null, logged: null, latest: null, seconds: null };
  private frames: { since: number; counts: Map<string, number>; timer: Timer | null } | null = null;
  private level: { since: number; samples: number; min: number; max: number; sum: number; muted: number } | null = null;
  private readonly opts: DiagnosticsOptions;

  constructor(opts: DiagnosticsOptions) {
    this.opts = opts;
  }

  // ── the user's words ─────────────────────────────────────────────────────

  /** A user transcript delta: counted, never kept. */
  userWords(text: string, startMs: number | null, endMs: number | null): void {
    const at = this.opts.now();
    let u = this.user;
    if (u && at - u.lastAt >= HEARD_APART_MS) { this.endHeard(u); u = null; }
    if (!u) {
      u = { n: ++this.heardSeq, startAt: at, lastAt: at, words: 0, lastChar: null, firstStartMs: startMs, lastEndMs: endMs, timer: null,
        outcome: null, outcomeAt: null, voiceSpoke: false, delegations: 0 };
      this.user = u;
    }
    const c = countWords(text, u.lastChar);
    u.words += c.words;
    u.lastChar = c.last;
    u.lastAt = at;
    u.firstStartMs ??= startMs;
    if (endMs != null) u.lastEndMs = endMs;
    this.lastUserAt = at;
    const cur = u;
    if (cur.timer != null) this.opts.clearTimer(cur.timer);
    cur.timer = this.opts.setTimer(() => { cur.timer = null; if (this.user === cur) this.endHeard(cur); }, HEARD_WAIT_MS);
  }

  /** The voice opened a delegation: the current utterance (if any) was delegated, unless a card already took it. */
  delegated(): void {
    const u = this.user;
    if (!u) return;
    u.delegations += 1;
    this.decide(u, 'delegated');
  }

  /** The user's words resolved a confirm or choice card (by voice). */
  cardResolved(): void {
    const u = this.user;
    if (u) this.decide(u, 'card');
  }

  private decide(u: HeardUtterance, outcome: HeardOutcome): void {
    if (u.outcome) return;
    u.outcome = outcome;
    u.outcomeAt = this.opts.now();
  }

  private endHeard(u: HeardUtterance): void {
    if (u.timer != null) { this.opts.clearTimer(u.timer); u.timer = null; }
    if (this.user === u) this.user = null;
    const outcome: HeardOutcome = u.outcome ?? (u.voiceSpoke ? 'answered' : 'ignored');
    const audio = u.firstStartMs != null && u.lastEndMs != null && u.lastEndMs >= u.firstStartMs ? u.lastEndMs - u.firstStartMs : null;
    this.opts.emit({
      event: 'heard', n: u.n, wordCount: u.words, ms: ms(audio ?? u.lastAt - u.startAt), outcome,
      afterMs: u.outcomeAt != null ? ms(u.outcomeAt - u.lastAt) : null, delegations: u.delegations, atMs: this.epoch(u.startAt),
    });
  }

  // ── the voice's words ────────────────────────────────────────────────────

  /** A voice transcript delta: counted, never kept. */
  voiceWords(text: string, startMs: number | null, endMs: number | null): void {
    const at = this.opts.now();
    let v = this.voice;
    if (v && at - v.lastAt >= VOICE_APART_MS) { this.endSpoke(v); v = null; }
    if (!v) {
      v = { n: ++this.spokeSeq, startAt: at, lastAt: at, words: 0, lastChar: null, firstStartMs: startMs, lastEndMs: endMs, timer: null, after: this.afterNow() };
      this.voice = v;
      // The voice began speaking after the user's utterance began: it answered that utterance (or delegated first).
      if (this.user) this.user.voiceSpoke = true;
    }
    const c = countWords(text, v.lastChar);
    v.words += c.words;
    v.lastChar = c.last;
    v.lastAt = at;
    v.firstStartMs ??= startMs;
    if (endMs != null) v.lastEndMs = endMs;
    const cur = v;
    if (cur.timer != null) this.opts.clearTimer(cur.timer);
    cur.timer = this.opts.setTimer(() => { cur.timer = null; if (this.voice === cur) this.endSpoke(cur); }, VOICE_APART_MS);
  }

  /** A tool result went to the delegation (response.item.create). */
  resultSent(): void { this.lastResultAt = this.opts.now(); }
  /** The dock appended commentary the voice speaks (a card line, the budget, an inbound line, a job's end). */
  commentarySent(): void { this.lastCommentaryAt = this.opts.now(); }

  /** The latest of a result, commentary or the user's words since the voice last finished speaking; else unprompted. */
  private afterNow(): SpokeAfter {
    const since = this.voiceEndedAt;
    const options: Array<[SpokeAfter, number]> = [['result', this.lastResultAt], ['commentary', this.lastCommentaryAt], ['user', this.lastUserAt]];
    const live = options.filter(([, t]) => t > since).sort((a, b) => b[1] - a[1]);
    return live[0]?.[0] ?? 'unprompted';
  }

  private endSpoke(v: SpokeUtterance): void {
    if (v.timer != null) { this.opts.clearTimer(v.timer); v.timer = null; }
    if (this.voice === v) this.voice = null;
    this.voiceEndedAt = v.lastAt;
    const audio = v.firstStartMs != null && v.lastEndMs != null && v.lastEndMs >= v.firstStartMs ? v.lastEndMs - v.firstStartMs : null;
    this.opts.emit({ event: 'spoke', n: v.n, wordCount: v.words, ms: ms(audio ?? v.lastAt - v.startAt), after: v.after, atMs: this.epoch(v.startAt) });
  }

  // ── context, frames, microphone ──────────────────────────────────────────

  /** session.usage.updated's context_window.usage_ratio: logged at most every CONTEXT_EVERY_MS, and only when it moved. */
  contextRatio(ratio: number, seconds: number | null): void {
    const at = this.opts.now();
    const c = this.context;
    c.latest = ratio;
    c.seconds = seconds;
    if (c.loggedAt != null && at - c.loggedAt < CONTEXT_EVERY_MS) return;
    this.logContext(at);
  }

  private logContext(at: number): void {
    const c = this.context;
    if (c.latest == null || c.latest === c.logged) return;
    c.loggedAt = at;
    c.logged = c.latest;
    this.opts.emit({ event: 'context', ratio: Math.round(c.latest * 10_000) / 10_000, seconds: c.seconds == null ? null : ms(c.seconds) });
  }

  /** A frame the dock does not use: counted under its known name (or `unknown`), one `frames` row per minute that had any. */
  droppedFrame(type: string): void {
    const key = frameKey(type);
    if (!this.frames) {
      const w: { since: number; counts: Map<string, number>; timer: Timer | null } = { since: this.opts.now(), counts: new Map(), timer: null };
      w.timer = this.opts.setTimer(() => { w.timer = null; if (this.frames === w) this.endFrames(); }, FRAMES_WINDOW_MS);
      this.frames = w;
    }
    this.frames.counts.set(key, (this.frames.counts.get(key) ?? 0) + 1);
  }

  private endFrames(): void {
    const w = this.frames;
    if (!w) return;
    if (w.timer != null) this.opts.clearTimer(w.timer);
    this.frames = null;
    if (!w.counts.size) return;
    this.opts.emit({ event: 'frames', windowS: Math.max(1, Math.round((this.opts.now() - w.since) / 1000)), counts: Object.fromEntries(w.counts) });
  }

  /** A mute or unmute: the user's toggle, or the provider's frame (the controller passes it only when it disagrees). */
  mic(muted: boolean, by: 'user' | 'provider'): void {
    this.opts.emit({ event: 'mic', muted, by });
  }

  /** One meter sample (the controller's tick): one `level` row per LEVEL_WINDOW_MS. */
  levelSample(input: number, muted: boolean): void {
    const at = this.opts.now();
    const v = Number.isFinite(input) ? Math.min(1, Math.max(0, input)) : 0;
    const l = this.level ??= { since: at, samples: 0, min: 1, max: 0, sum: 0, muted: 0 };
    l.samples += 1;
    l.min = Math.min(l.min, v);
    l.max = Math.max(l.max, v);
    l.sum += v;
    if (muted) l.muted += 1;
    if (at - l.since >= LEVEL_WINDOW_MS) this.endLevel(at);
  }

  private endLevel(at: number): void {
    const l = this.level;
    this.level = null;
    if (!l || !l.samples) return;
    this.opts.emit({
      event: 'level', windowS: Math.max(1, Math.round((at - l.since) / 1000)), samples: l.samples,
      min: r3(l.min), avg: r3(l.sum / l.samples), max: r3(l.max), mutedPct: Math.round((l.muted / l.samples) * 100),
    });
  }

  // ── the session's end ────────────────────────────────────────────────────

  /** The session is ending: every open utterance and window is written now (idempotent). */
  flush(): void {
    const at = this.opts.now();
    if (this.user) this.endHeard(this.user);
    if (this.voice) this.endSpoke(this.voice);
    this.logContext(at);
    this.endFrames();
    this.endLevel(at);
  }

  /** A new session: everything forgotten, nothing written. */
  reset(): void {
    for (const t of [this.user?.timer, this.voice?.timer, this.frames?.timer]) if (t != null) this.opts.clearTimer(t);
    this.user = null;
    this.voice = null;
    this.frames = null;
    this.level = null;
    this.heardSeq = 0;
    this.spokeSeq = 0;
    this.voiceEndedAt = this.lastResultAt = this.lastCommentaryAt = this.lastUserAt = Number.NEGATIVE_INFINITY;
    this.context = { loggedAt: null, logged: null, latest: null, seconds: null };
  }

  private epoch(at: number): number {
    return Math.max(0, Math.round(this.opts.epoch ? this.opts.epoch(at) : Date.now() - (this.opts.now() - at)));
  }
}

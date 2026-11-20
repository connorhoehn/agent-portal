// The floor: who has Milo's ear, and how a sentence reaches him (docs/milo-rebuild/REBUILD-PLAN.md section 1, REBUILD-REVIEW.md
// risks 5, 7 and 8). State only: no model, no audio, no timers of its own; the turn owner drives it and reads it.
//
//   idle ──a sentence with the name / a hold──► hearing ──► deciding ──► speaking ──► follow-up (10 s) ──► idle
//
// How a sentence reaches Decide, in this order: the speaker holds the button (`hold`); the sentence holds a spelling of the name
// anywhere (`name`: the grammar that used to judge "addressed" is gone, Decide tells a mention from a request); the speaker is
// inside their follow-up window (`follow-up`). Anything else is not for Milo and is never sent to a model. While Milo is paused
// nothing reaches Decide; only a sentence with the name that asks him to listen again ends the pause.
// One person has the floor; one more may wait (the latest sentence wins). The view is today's `RouteState`, so the portal bar is
// unchanged: hearing and deciding show as `routing`, speaking as `answering`.
import { NAME_SPELLINGS } from '../detector.js';
import { HANDSFREE, type RouteState } from '../handsfree/types.js';
import { MISHEARD_FORMS } from '../handsfree/listening.js';
import type { TurnSentence } from './types.js';

/** After Milo's answer has played, the asker's sentences reach Decide without the name for this long. */
export const FOLLOW_UP_MS = HANDSFREE.followUpMs;
/** A second person's sentence waits this long at most for the floor. */
export const QUEUE_KEEP_MS = HANDSFREE.queueKeepMs;
/** A held button lets go by itself after this long. */
export const HOLD_MAX_MS = HANDSFREE.holdMaxMs;

/** Every way the name is written: the spellings, the misheard forms the listening side knows, and the one the probe heard ("Ilo"). */
export const NAME_HEARD: readonly string[] = [...new Set([...NAME_SPELLINGS, ...MISHEARD_FORMS, 'ilo'])];
const NAME_WORD = new RegExp(`(^|[^\\p{L}\\p{N}_])(${NAME_HEARD.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?:['’]s)?(?![\\p{L}\\p{N}_])`, 'iu');
/** Does the sentence hold a spelling of the name, as a whole word, anywhere? */
export const hasName = (text: string): boolean => NAME_WORD.test(text);

const RESUME = /\b(?:resume|unpause|un-pause|(?:start|begin|keep) listening|listen(?:ing)? again|you can listen|come back|wake up)\b/i;
/** While paused: does a sentence with the name ask Milo to listen again? */
export const asksToResume = (text: string): boolean => hasName(text) && RESUME.test(text);

export type FloorPhase = 'idle' | 'hearing' | 'deciding' | 'speaking' | 'follow-up';
type Via = TurnSentence['via'];

export class Floor {
  private phase: FloorPhase = 'idle';
  private who: string | null = null;
  private via: Via = 'name';
  private sinceMs = 0;
  /** The asker's follow-up window: it outlives the phase (a silent turn of theirs does not end it). */
  private window: { who: string; untilMs: number } | null = null;
  private holder: { who: string; releasedMs: number | null } | null = null;
  private shown = '';
  paused = false;

  constructor(private readonly nowMs: () => number, private readonly onChange: (s: RouteState) => void = () => {}) {}

  /** Today's view for the bar and the tile ring. */
  state(): RouteState {
    if (this.who && (this.phase === 'hearing' || this.phase === 'deciding')) return { phase: 'routing', userId: this.who, via: this.via, sinceMs: this.sinceMs };
    if (this.who && this.phase === 'speaking') return { phase: 'answering', userId: this.who, via: this.via, sinceMs: this.sinceMs };
    const w = this.windowOf();
    if (w) return { phase: 'follow-up', userId: w.who, untilMs: w.untilMs };
    return { phase: 'idle' };
  }

  private windowOf(): { who: string; untilMs: number } | null {
    if (this.window && this.window.untilMs <= this.nowMs()) this.window = null;
    return this.window;
  }

  /** How a sentence from `who` that began at `startMs` reaches Milo, or null: it is not for him. */
  route(who: string, text: string, startMs: number): Via | null {
    if (this.paused) return null;
    if (this.holding(who, startMs)) return 'hold';
    if (hasName(text)) return 'name';
    const w = this.windowOf();
    return w && w.who === who ? 'follow-up' : null;
  }

  /** Is this person holding the button, or were they when a sentence that began at `startMs` started (its final comes a second or two after the release)? */
  holding(who: string, startMs = this.nowMs()): boolean {
    const h = this.holder;
    if (!h || h.who !== who) return false;
    return h.releasedMs === null || startMs < h.releasedMs;
  }

  get holderId(): string | null { return this.holder && this.holder.releasedMs === null ? this.holder.who : null; }
  /** Who has the floor now (hearing, deciding or speaking), or null. */
  get busyWith(): string | null { return this.phase === 'idle' || this.phase === 'follow-up' ? null : this.who; }

  hold(who: string): void { this.holder = { who, releasedMs: null }; if (!this.busyWith) this.set('hearing', who, 'hold'); }
  release(who: string): void {
    if (this.holder?.who !== who || this.holder.releasedMs !== null) return;
    this.holder.releasedMs = this.nowMs();
    if (this.phase === 'hearing' && this.who === who) this.free();
  }
  dropHold(who: string): void { if (this.holder?.who === who) this.holder = null; if (this.phase === 'hearing' && this.who === who) this.free(); }

  deciding(who: string, via: Via): void { this.set('deciding', who, via); }
  speaking(who: string, via: Via): void { this.set('speaking', who, via); }
  /** Milo answered `who`: their follow-up window runs from the end of the answer. */
  answered(who: string, endMs: number): void { this.window = { who, untilMs: endMs + FOLLOW_UP_MS }; }
  endWindow(who?: string): void { if (!who || this.window?.who === who) this.window = null; this.tell(); }
  /** The turn is over: the floor goes back to the holder (still pressing), the window, or nobody. */
  free(): void {
    const h = this.holderId;
    if (h) this.set('hearing', h, 'hold'); else { this.phase = this.windowOf() ? 'follow-up' : 'idle'; this.who = null; this.tell(); }
  }
  /** The window's end, a pause, a resume: tell the view when it changed. */
  tell(): void {
    const s = this.state();
    const key = JSON.stringify(s);
    if (key === this.shown) return;
    this.shown = key;
    this.onChange(s);
  }

  private set(phase: FloorPhase, who: string, via: Via): void {
    if (this.phase !== phase || this.who !== who) this.sinceMs = this.nowMs();
    this.phase = phase; this.who = who; this.via = via;
    this.tell();
  }
}

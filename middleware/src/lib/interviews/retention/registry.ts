// What retention erases (docs/interviews-tenant-plan.md row I6.3; contract D6 between the round-4 lanes).
//
// Each module that keeps something about an interview registers one eraser for it: its kind (what the deletion log
// names), its class (rules.ts: `media` goes after the media period and on a candidate's request; `record` after the
// record period), and `erase(interviewIds)`, which removes everything of that kind for those interviews and answers
// how many things it removed. An eraser is safe to call again: a second call removes nothing and answers 0.
//
// This module registers its own (erasers.ts): the recording, the transcript and minutes, the consents and the
// scorecards. The log of Milo's suggestions is the coach's (lib/interviews/coach), registered with one line by the
// integrator; this file does not import it. Registering a kind again replaces the one before (tests use that).
//
// Two errors an eraser may throw that are not failures of the deletion:
//   EraserSkipped  there was nothing to call here (no recording service is configured, as in the mock world): the
//                  log says so and the sweep does not try again.
//   EraserBusy     the thing cannot be erased yet (the call is running): the log says so and the next sweep retries.
// Anything else is a failure: the log names the kind (never the message, which may carry data) and the sweep retries.

import type { RetentionClass } from './rules.js';

export interface Eraser {
  kind: string;
  class: RetentionClass;
  erase(interviewIds: readonly string[]): Promise<number>;
}

export class EraserSkipped extends Error {
  constructor(readonly why: 'no-service') { super(why); this.name = 'EraserSkipped'; }
}
/** `removed`: what this run did remove before it met the busy part (counted in the log). */
export class EraserBusy extends Error {
  constructor(readonly why: 'call-running', readonly removed = 0) { super(why); this.name = 'EraserBusy'; }
}

const erasers = new Map<string, Eraser>();

export function registerEraser(e: Eraser): void {
  if (!e || typeof e.kind !== 'string' || !e.kind || (e.class !== 'media' && e.class !== 'record') || typeof e.erase !== 'function') {
    throw new TypeError('An eraser needs a kind, a class (media or record) and an erase function.');
  }
  erasers.set(e.kind, e);
}

/** The registered erasers of a class, in the order they were first registered. */
export function erasersOf(cls: RetentionClass): Eraser[] { return [...erasers.values()].filter((e) => e.class === cls); }
export function eraserFor(kind: string): Eraser | undefined { return erasers.get(kind); }
/** Test seam. */
export function unregisterEraser(kind: string): void { erasers.delete(kind); }

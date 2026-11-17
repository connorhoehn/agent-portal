// The consent rules (docs/interviews-tenant-plan.md decision 5, row I2.3). Pure: no store, no clock but the
// one passed in. A consent is a record about a person who is not a user and cannot ask anyone here what a
// word meant, so wherever a rule could be read two ways it takes the stricter reading.
//
//   Three answers     recording, transcription and Milo's assistance are each a real boolean. A missing
//                     answer, `null`, "yes", 1 or anything else that is not `true`/`false` refuses the whole
//                     set: nothing is ever defaulted, and nothing is coerced to yes.
//   Milo needs the    declining transcription stores Milo as declined whatever was sent (`miloForcedOff`
//   transcript        says so, and the page shows it as it happens).
//   The notice        an answer names the notice version it was given under; any other version is refused
//                     (`stale-notice`) so the page shows the current text again.
//   Until the call    answers can be given or changed while the interview is assigned, accepted or ready;
//                     from `live` on (and on a declined or cancelled one) never. One exception (contract U7):
//                     a candidate who arrives after the lead has joined, with nothing stored for the current
//                     notice, may give a first answer while the interview is `live`; a stored answer still
//                     cannot change then, and `ended` and later stay closed for everyone.
//   Each its own time a change stamps only the answers whose value changed; the set's `changedAt` is the
//                     write's time. Every write appends one entry to the history (store.ts).

import type { InterviewState } from '../types.js';

export type ConsentPart = 'recording' | 'transcription' | 'milo';
export const CONSENT_PARTS: readonly ConsentPart[] = ['recording', 'transcription', 'milo'];

export interface ConsentAnswers { recording: boolean; transcription: boolean; milo: boolean }

/** What the guest sent, checked. */
export type CheckedAnswers =
  | { ok: true; noticeVersion: string; answers: ConsentAnswers; miloForcedOff: boolean }
  | { ok: false; reason: 'incomplete' | 'stale-notice' | 'closed' };

/** The states in which the candidate may still give or change an answer. */
const OPEN_STATES: ReadonlySet<InterviewState> = new Set<InterviewState>(['assigned', 'accepted', 'ready']);

export function consentsChangeable(state: InterviewState): boolean {
  return OPEN_STATES.has(state);
}

/** A first answer after the start (U7): live, and nothing stored for the current notice. */
export function firstAnswerWhileLive(state: InterviewState, stored: { noticeVersion: string } | null, currentVersion: string): boolean {
  return state === 'live' && (stored === null || stored.noticeVersion !== currentVersion);
}

/**
 * Check a guest's answers against the current notice and the interview's state. The order of the refusals is
 * the order the page can act on them: a closed interview first (nothing to do), then a stale notice (show it
 * again), then an incomplete set.
 */
export function checkAnswers(
  body: unknown, currentVersion: string, state: InterviewState, stored: { noticeVersion: string } | null,
): CheckedAnswers {
  if (!consentsChangeable(state) && !firstAnswerWhileLive(state, stored, currentVersion)) return { ok: false, reason: 'closed' };
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  if (b['noticeVersion'] !== currentVersion) return { ok: false, reason: 'stale-notice' };
  const { recording, transcription, milo } = b;
  if (typeof recording !== 'boolean' || typeof transcription !== 'boolean' || typeof milo !== 'boolean') {
    return { ok: false, reason: 'incomplete' };
  }
  const miloForcedOff = !transcription && milo;
  return { ok: true, noticeVersion: currentVersion, answers: { recording, transcription, milo: transcription && milo }, miloForcedOff };
}

/** The parts that are off: every part when nothing usable was answered (nothing runs before consent). */
export function partsOff(answers: ConsentAnswers | null): ConsentPart[] {
  if (!answers) return [...CONSENT_PARTS];
  return CONSENT_PARTS.filter((p) => !answers[p]);
}

/** One answer's value and when it was last given a different value (or first given). */
export interface TimedAnswer { value: boolean; at: string }

/** Stamp each answer: keep the old time for an answer whose value did not change. */
export function stampAnswers(
  next: ConsentAnswers,
  before: Record<ConsentPart, TimedAnswer> | null,
  at: string,
): Record<ConsentPart, TimedAnswer> {
  const out = {} as Record<ConsentPart, TimedAnswer>;
  for (const p of CONSENT_PARTS) {
    const prev = before?.[p];
    out[p] = prev && prev.value === next[p] ? { value: prev.value, at: prev.at } : { value: next[p], at };
  }
  return out;
}

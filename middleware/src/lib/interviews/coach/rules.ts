// When the coach may think (docs/interviews-tenant-plan.md decisions 8 and 20, row I3.3). Pure: the service gathers the
// facts, this decides, a test walks every branch.
//
// In order, the first that applies:
//   not-found   the viewer is not the interview's lead (decision 20: only the lead gets Milo's prompts);
//   none        the interview is not `live`;
//   none        the candidate's consents do not say yes to Milo (D4: `coach` is true exactly when the transcript and Milo
//               were both accepted; `consentsFor` already holds Milo to the transcript). No answers at all is a no;
//   show        a suggestion is waiting for the lead's answer: the same one again, never a new one beside it;
//   none        the interview has had MAX_ATTEMPTS_PER_INTERVIEW attempts (dropped ones count: each cost a call);
//   none        the last attempt was less than SUGGESTION_GAP_MS ago (dropped ones count, so a failing model is not asked
//               again on every read);
//   none        no transcript line was added since the last attempt read it;
//   none        another read of this interview is already thinking (one call in flight per interview);
//   think       otherwise.
import type { SuggestionRecord } from './store.js';

/** Decision 8: at most one new suggestion every 90 seconds per interview. */
export const SUGGESTION_GAP_MS = 90_000;
/**
 * The most times the coach is asked in one interview. A 60-minute round at one every 90 seconds could reach 40; half of
 * that leaves room for every competency in a kit and its follow-ups, and bounds the spend (about 20 calls).
 */
export const MAX_ATTEMPTS_PER_INTERVIEW = 20;
/** How soon the room should ask again in each case (the page's poll; D7 `retryAfterMs`). */
export const RETRY_NOT_LIVE_MS = 30_000;
export const RETRY_NO_CONSENT_MS = 120_000;
export const RETRY_WAITING_MS = 15_000;
export const RETRY_NO_LINES_MS = 15_000;
export const RETRY_IN_FLIGHT_MS = 5_000;
export const RETRY_AT_MAX_MS = 600_000;

export interface CoachFacts {
  viewerId: string;
  interview: { leadId: string; state: string };
  /** `consentsFor`: null when the candidate has answered nothing. */
  consent: { transcription: boolean; milo: boolean } | null;
  /** The interview's log, oldest first. */
  log: readonly SuggestionRecord[];
  /** The transcript now: the call it is from and its last line's seq; null when there is no call transcript. */
  transcript: { callId: string; lastSeq: number } | null;
  inFlight: boolean;
  nowMs: number;
}

export type CoachDecision =
  | { kind: 'not-found' }
  | { kind: 'none'; reason: 'not-live' | 'no-consent' | 'at-max' | 'too-soon' | 'no-new-lines' | 'in-flight'; retryAfterMs: number }
  | { kind: 'show'; suggestion: SuggestionRecord }
  | { kind: 'think' };

/** The waiting suggestion: the latest one that was not dropped and has no answer. */
export const waitingSuggestion = (log: readonly SuggestionRecord[]): SuggestionRecord | null =>
  [...log].reverse().find((r) => r.dropped === null && r.answer === null) ?? null;

/** Is there a transcript line the last attempt did not read? */
export function hasNewLines(log: readonly SuggestionRecord[], transcript: CoachFacts['transcript']): boolean {
  if (!transcript || transcript.lastSeq < 1) return false;
  const last = log.at(-1);
  if (!last) return true;
  return last.callId !== transcript.callId || transcript.lastSeq > last.throughSeq;
}

export function decideCoach(f: CoachFacts): CoachDecision {
  if (f.viewerId !== f.interview.leadId) return { kind: 'not-found' };
  if (f.interview.state !== 'live') return { kind: 'none', reason: 'not-live', retryAfterMs: RETRY_NOT_LIVE_MS };
  if (!(f.consent?.transcription && f.consent.milo)) return { kind: 'none', reason: 'no-consent', retryAfterMs: RETRY_NO_CONSENT_MS };
  const waiting = waitingSuggestion(f.log);
  if (waiting) return { kind: 'show', suggestion: waiting };
  if (f.log.length >= MAX_ATTEMPTS_PER_INTERVIEW) return { kind: 'none', reason: 'at-max', retryAfterMs: RETRY_AT_MAX_MS };
  const last = f.log.at(-1);
  const since = last ? f.nowMs - Date.parse(last.madeAt) : Infinity;
  if (since < SUGGESTION_GAP_MS) return { kind: 'none', reason: 'too-soon', retryAfterMs: Math.max(1000, SUGGESTION_GAP_MS - since) };
  if (!hasNewLines(f.log, f.transcript)) return { kind: 'none', reason: 'no-new-lines', retryAfterMs: RETRY_NO_LINES_MS };
  if (f.inFlight) return { kind: 'none', reason: 'in-flight', retryAfterMs: RETRY_IN_FLIGHT_MS };
  return { kind: 'think' };
}

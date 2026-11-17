// When Milo may answer the lead's private question (docs/interviews-tenant-plan.md decisions 6, 8, 18, 20; row I3.6).
// Pure: the service gathers the facts, this decides, a test walks every branch.
//
// In order, the first that applies:
//   not-found   the viewer is not the interview's lead (decision 20: Milo's private help is the lead's alone);
//   not-live    the interview is not `live`;
//   no-consent  the candidate's answers do not say yes to the transcript AND Milo (the coach's own rule, `coachConsents`);
//   fixed       the question asks for a judgement of the candidate or about a personal trait: answered with FIXED_ANSWER,
//               no model call, no charge (logged with its code, `refused-judgement` or `refused-personal`);
//   at-max      MAX_ASKS_PER_INTERVIEW model calls were made in this interview (dropped and failed ones count: each cost one);
//   too-soon    the last model call was less than ASK_GAP_MS ago;
//   in-flight   another of this interview's questions is being answered (one at a time);
//   no-lines    nothing attributed has been said yet: there is nothing to search, so no call;
//   think       otherwise.
//
// The pre-check is the first line, the answer's guard (parse.ts, the coach's JUDGES and PERSONAL) the second. What the
// pre-check catches: the English patterns below and the coach's JUDGES and PERSONAL lists, as whole words, any case.
// What it cannot catch, said plainly: a judgement asked in other words ("anything I should worry about?", "convince
// me"), a judgement wrapped in a fair-looking search ("find where she was weakest"), any other language, and a question
// that is fair in words but leading in what it picks out. The model is told to answer those with NOT_SAID and its
// answer is guarded; neither is proof. The person decides (decision 6).
import { JUDGES, PERSONAL } from '../coach/parse.js';
import type { CoachLogRecord } from './store.js';
import { MAX_QUESTION_CHARS } from './prompt.js';

/** One private question every 20 seconds per interview: room for a quick follow-up, not a stream. */
export const ASK_GAP_MS = 20_000;
/** Model calls per interview: about one every four minutes of an hour's round, and a bound on the spend. */
export const MAX_ASKS_PER_INTERVIEW = 15;

/** The one fixed sentence for a question that asks for a judgement or about the person. */
export const FIXED_ANSWER = 'Milo can only find what was said in this interview and where it was said; it does not judge, rate or describe the candidate.';

const WHO = String.raw`(?:she|he|they|the candidate|this candidate|this person|the applicant)`;

/** Asking Milo to judge the candidate. Narrow where the work has its own words ("rate limiter", "score function"). */
export const ASK_JUDGES: readonly RegExp[] = [
  new RegExp(String.raw`\b(?:is|was|are|were|seems?)\s+${WHO}\s+(?:a\s+|an\s+|any\s+|really\s+|very\s+|good\s+)?(?:good|great|strong|weak|bad|poor|qualified|competent|capable|smart|bright|senior|junior|ready|right|suitable|fit|hireable|worth)\b`, 'i'),
  new RegExp(String.raw`\bhow\s+(?:did|does|do|is|was|are|were)\s+${WHO}\s+(?:do|doing|did|perform\w*|go|going|come across|compare|measure up|stack up)\b`, 'i'),
  /\bhow (?:good|strong|weak|well|badly)\b/i,
  /\bshould\s+(?:we|i|you)\s+(?:hire|advance|reject|pass on|move (?:her|him|them) (?:forward|on)|make (?:her|him|them)? ?an offer)\b/i,
  /\b(?:would|do|did|will)\s+you\s+(?:hire|recommend|advance|reject|pick|choose)\b/i,
  new RegExp(String.raw`\b(?:rate|score|rank|grade|assess|evaluate|judge)\s+(?:${WHO}|her|him|them|their|his|this answer|that answer|the answer)\b`, 'i'),
  /\bwhat (?:would|do|should) (?:you|i|we) (?:rate|score|give)\b/i,
  /\bwhat do you (?:think|make) of\b|\byour (?:opinion|impression|view|take|verdict)\b|\bverdict\b/i,
  /\b(?:better|worse|stronger|weaker) than\b|\bcompared? (?:to|with) (?:the )?other\b/i,
  /\b(?:pass|fail)(?:ed|es)? the (?:bar|round|interview)\b|\bhire or not\b|\bgo or no\b|\bthumbs (?:up|down)\b/i,
  ...JUDGES,
];

/** Asking Milo about the person rather than their words. */
export const ASK_PERSONAL: readonly RegExp[] = [
  new RegExp(String.raw`\b(?:does|did|do|is|was)\s+${WHO}\s+(?:seem|look|sound|appear)\b`, 'i'),
  new RegExp(String.raw`\bwhere (?:is|are|was|were) ${WHO} (?:originally )?from\b`, 'i'),
  /\bwhat is (?:her|his|their) (?:background|nationality|religion|ethnicity|age)\b/i,
  ...PERSONAL,
];

export type PrecheckCode = 'refused-judgement' | 'refused-personal';

/** The question's refusal before any model, or null when it may be searched. */
export function precheckQuestion(question: string): PrecheckCode | null {
  if (ASK_JUDGES.some((r) => r.test(question))) return 'refused-judgement';
  if (ASK_PERSONAL.some((r) => r.test(question))) return 'refused-personal';
  return null;
}

/** The body's question, squashed; null when it is missing, empty or over MAX_QUESTION_CHARS. */
export function checkQuestion(body: unknown): string | null {
  const q = (body && typeof body === 'object' && !Array.isArray(body)) ? (body as Record<string, unknown>)['question'] : undefined;
  if (typeof q !== 'string') return null;
  const t = q.replace(/\s+/g, ' ').trim();
  return t.length > 0 && t.length <= MAX_QUESTION_CHARS ? t : null;
}

/** A row that asked a model (refusals before the model do not count toward the gap or the maximum). */
export const askedModel = (r: Pick<CoachLogRecord, 'modelId'>): boolean => r.modelId !== 'none';

export interface AskFacts {
  viewerId: string;
  interview: { leadId: string; state: string };
  consent: { transcription: boolean; milo: boolean } | null;
  question: string;
  /** This interview's `answer` rows, oldest first. */
  log: readonly CoachLogRecord[];
  inFlight: boolean;
  /** Attributed transcript lines there are to search. */
  lineCount: number;
  nowMs: number;
}

export type AskRefusal = 'not-live' | 'no-consent' | 'at-max' | 'too-soon' | 'in-flight' | 'no-lines';
export type AskDecision =
  | { kind: 'not-found' }
  | { kind: 'refuse'; reason: AskRefusal; retryAfterMs: number | null }
  | { kind: 'fixed'; code: PrecheckCode }
  | { kind: 'think'; n: number };

export function decideAsk(f: AskFacts): AskDecision {
  if (f.viewerId !== f.interview.leadId) return { kind: 'not-found' };
  if (f.interview.state !== 'live') return { kind: 'refuse', reason: 'not-live', retryAfterMs: null };
  if (!(f.consent?.transcription && f.consent.milo)) return { kind: 'refuse', reason: 'no-consent', retryAfterMs: null };
  const pre = precheckQuestion(f.question);
  if (pre) return { kind: 'fixed', code: pre };
  const calls = f.log.filter(askedModel);
  if (calls.length >= MAX_ASKS_PER_INTERVIEW) return { kind: 'refuse', reason: 'at-max', retryAfterMs: null };
  const last = calls.at(-1);
  const since = last ? f.nowMs - Date.parse(last.askedAt) : Infinity;
  if (since < ASK_GAP_MS) return { kind: 'refuse', reason: 'too-soon', retryAfterMs: Math.max(1000, ASK_GAP_MS - since) };
  if (f.inFlight) return { kind: 'refuse', reason: 'in-flight', retryAfterMs: 5_000 };
  if (f.lineCount < 1) return { kind: 'refuse', reason: 'no-lines', retryAfterMs: null };
  return { kind: 'think', n: calls.length + 1 };
}

/** The one plain line the lead reads for each refusal (third person for Milo, never blaming the person). */
export const REFUSAL_LINES: Record<AskRefusal, string> = {
  'not-live': 'The interview is not running, so Milo cannot answer questions about it.',
  'no-consent': 'Milo is off for this interview, so it cannot answer questions about it.',
  'at-max': 'Milo has answered as many questions as it can in this interview.',
  'too-soon': 'Milo needs a few seconds between questions. Ask again in a moment.',
  'in-flight': 'Milo is still answering the last question.',
  'no-lines': 'Nothing has been said in the transcript yet.',
};

/** When the answer was dropped or the call failed: Milo showed nothing. */
export const DROPPED_LINE = 'Milo could not find an answer it could point to in the transcript. Try asking about something that was said.';
export const FAILED_LINE = 'Milo could not answer just now. Try again in a moment.';

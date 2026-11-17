// The hiring manager's stage decision (docs/interviews-tenant-plan.md decision 15, row I5.5; contract E4).
//
// The one place the product records who decided a person's outcome and why. Pure rules here; the route decides who
// may write (DecideCandidate plus being the opening's hiring manager) and the store only appends.
//
// What each decision moves the stage to, from each stage (the stricter reading wherever the plan is open):
//
//   from            advance              hold                 reject
//   interviewing    offer (*)            on-hold              rejected
//   debrief         offer (*)            on-hold              rejected
//   on-hold         offer (*)            refused (already)    rejected
//   applied,        refused: nobody has interviewed them yet; the recruiter moves them until then
//   screening
//   offer, hired,   refused: the decision is made or the application is closed; what follows is the recruiter's
//   rejected,
//   withdrawn
//
//   (*) advance also needs every round to have been held: none still assigned, accepted, ready or live.
//   Every decision needs at least one submitted scorecard on the application: a decision is made on what people wrote.
//
// A decision while a scorecard is still due (a round has ended and a seat's scorecard is not in) is allowed: the
// hiring manager may need to move without a panel member who is away. The write records how many were missing
// (`scorecardsMissing`), the debrief shows it on the history, and the page asks once more before it is sent.
//
// A reason is required, 10 to 1000 characters. A decision is never edited: a later decision is a new entry in the
// history. The write is against `basedOn`, the length of the history the page read; anything else is stale.

import type { Application, ApplicationStage, Interview, InterviewState, Scorecard, StageChange } from '../types.js';
import { seatedOf } from '../scorecard.js';

export type Decision = 'advance' | 'hold' | 'reject';
export const DECISIONS: readonly Decision[] = ['advance', 'hold', 'reject'];

/** Where each decision moves the stage. */
export const DECISION_TARGET: Readonly<Record<Decision, ApplicationStage>> = { advance: 'offer', hold: 'on-hold', reject: 'rejected' };

export const DECISION_LIMITS = { reasonMin: 10, reasonMax: 1000 } as const;

/** A history entry that is a hiring manager's decision: a StageChange with what was decided and what was missing. */
export interface DecisionChange extends StageChange {
  decision: Decision;
  /** How many seats' scorecards were still due on rounds that had ended when the decision was made. */
  scorecardsMissing: number;
}

export const isDecisionChange = (h: StageChange): h is DecisionChange =>
  DECISIONS.includes((h as Partial<DecisionChange>).decision as Decision) && typeof (h as Partial<DecisionChange>).scorecardsMissing === 'number';

/** Stages a hiring manager decides from. */
const DECIDABLE: ReadonlySet<ApplicationStage> = new Set(['interviewing', 'debrief', 'on-hold']);
const NOT_YET: ReadonlySet<ApplicationStage> = new Set(['applied', 'screening']);
/** Rounds still to run: advance waits for them. */
const STILL_TO_RUN: ReadonlySet<InterviewState> = new Set(['assigned', 'accepted', 'ready', 'live']);
/** Rounds that have been held, so their seats owe a scorecard. */
const HELD: ReadonlySet<InterviewState> = new Set(['ended', 'scored', 'reviewed']);

export const ONLY_THE_HIRING_MANAGER = 'Only the hiring manager of this opening records a decision. You can read the debrief; the decision is theirs.';
export const NO_DEBRIEF_HERE = 'There is no candidate here whose debrief you can open.';
export const STALE_DECISION = 'The stage changed while you were reading. The page now shows what was recorded; read it before you decide.';

/** The seats whose scorecard is still due on the held rounds of an application. */
export function scorecardsMissing(interviews: readonly Interview[], cards: readonly Scorecard[]): number {
  return interviews.filter((i) => HELD.has(i.state)).reduce((n, i) => {
    const authors = new Set(cards.filter((s) => s.interviewId === i.id).map((s) => s.interviewerId));
    return n + seatedOf(i).filter((p) => !authors.has(p)).length;
  }, 0);
}

export type DecisionMove = { ok: true; to: ApplicationStage } | { ok: false; message: string };

/** May `decision` be made on an application at `stage` with these rounds and scorecards, and where does it move it? */
export function decisionMove(stage: ApplicationStage, decision: Decision, interviews: readonly Interview[], cards: readonly Scorecard[]): DecisionMove {
  if (NOT_YET.has(stage)) return { ok: false, message: 'Nobody has interviewed this candidate yet. The recruiter moves them until the first round is in.' };
  if (!DECIDABLE.has(stage)) {
    return { ok: false, message: stage === 'offer'
      ? 'This candidate has already been advanced to an offer. What follows is the recruiter\'s.'
      : 'This application is closed, so its stage does not change any more.' };
  }
  if (decision === 'hold' && stage === 'on-hold') return { ok: false, message: 'This candidate is already on hold.' };
  const ids = new Set(interviews.map((i) => i.id));
  if (!cards.some((s) => ids.has(s.interviewId))) return { ok: false, message: 'No scorecard is in yet. Decide once at least one interviewer has written theirs.' };
  if (decision === 'advance' && interviews.some((i) => STILL_TO_RUN.has(i.state))) {
    return { ok: false, message: 'A round is still to run. Advance once every round has been held, or hold or reject now.' };
  }
  return { ok: true, to: DECISION_TARGET[decision] };
}

export interface DecisionInput { decision: Decision; reason: string; basedOn: number }
export type FieldProblem = { field: string; message: string };
export type CheckedDecision = { ok: true; value: DecisionInput } | { ok: false; fields: FieldProblem[] };

const BODY_KEYS: ReadonlySet<string> = new Set(['decision', 'reason', 'basedOn']);

/** The body of POST /applications/:id/stage, checked. Nothing names who decided: it is always the signed-in person. */
export function checkDecision(body: unknown): CheckedDecision {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, fields: [{ field: 'body', message: 'Send the decision as a form.' }] };
  const b = body as Record<string, unknown>;
  const fields: FieldProblem[] = [];
  const extra = Object.keys(b).filter((k) => !BODY_KEYS.has(k));
  if (extra.length) fields.push({ field: extra[0]!, message: 'A decision carries only what you decided, why, and what you read.' });
  const decision = b['decision'];
  if (typeof decision !== 'string' || !DECISIONS.includes(decision as Decision)) fields.push({ field: 'decision', message: 'Choose advance, hold or reject.' });
  const reason = typeof b['reason'] === 'string' ? b['reason'].trim() : '';
  if (reason.length < DECISION_LIMITS.reasonMin) fields.push({ field: 'reason', message: 'Say why in a sentence. Your reason is recorded with the decision.' });
  else if (reason.length > DECISION_LIMITS.reasonMax) fields.push({ field: 'reason', message: `Keep the reason under ${DECISION_LIMITS.reasonMax} characters.` });
  const basedOn = b['basedOn'];
  if (typeof basedOn !== 'number' || !Number.isInteger(basedOn) || basedOn < 1) fields.push({ field: 'basedOn', message: 'This page is out of date. Reload it and try again.' });
  if (fields.length) return { ok: false, fields };
  return { ok: true, value: { decision: decision as Decision, reason, basedOn: basedOn as number } };
}

/** The entry the write appends. */
export function decisionChange(args: { to: ApplicationStage; decision: Decision; reason: string; by: string; at: string; missing: number }): DecisionChange {
  return { stage: args.to, at: args.at, by: args.by, reason: args.reason, decision: args.decision, scorecardsMissing: args.missing };
}

/** The application's held rounds still at `scored`: the decision marks them `reviewed`. */
export const toReview = (app: Pick<Application, 'id'>, interviews: readonly Interview[]): Interview[] =>
  interviews.filter((i) => i.applicationId === app.id && i.state === 'scored');

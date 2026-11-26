// Cancelling a round, marking it as not having taken place, and withdrawing an application (gap audit 2026-11-20,
// section 1). Pure rules; the routes (routes/interviews/cancel.ts, routes/interviews/room.ts for End) decide who is
// asking and the store (InterviewWrites cancelInterview, ApplicationWrites decideStage) only writes.
//
//   cancel        the recruiter, on a round not yet live (assigned, accepted or ready) → `cancelled`, with one of the
//                 five cancel reasons and an optional note.
//   not held      the lead or the recruiter, on a LIVE round, or on a not-yet-live round whose scheduled start has
//                 passed → `cancelled`, reason `no_show` or `did_not_take_place`. A live round's room closes the way
//                 End closes it, but nobody owes a scorecard.
//   recruiter end the recruiter, on a live round the lead left: the ordinary End (`live` → `ended`, scorecards owed).
//   withdraw      the recruiter marks the application `withdrawn`; each of its not-yet-live rounds is cancelled with
//                 reason `candidate_withdrew`. Refused while one of its rounds is live: end that round first.
//
// A cancelled round is vacant (assign.ts VACANT_STATES: it may be assigned again), owes no scorecard (scorecard.ts
// stateRefusal, debrief/rules.ts HELD), does not block Advance (debrief/rules.ts STILL_TO_RUN) and its invite is dead
// (invite/rules.ts OPEN_INTERVIEW_STATES). Those rules already read the state; this file only moves it there.

import { seatOf } from './assign.js';
import type { Checked, FieldProblem } from './kit.js';
import type { Application, ApplicationStage, CancelReason, Cancellation, Interview, InterviewState } from './types.js';

export const CANCEL_NOTE_MAX = 280;

/** The reasons the recruiter picks from on Cancel. */
export const CANCEL_PICKS: readonly CancelReason[] = ['candidate_unavailable', 'interviewer_unavailable', 'rescheduling', 'opening_closed', 'other'];
/** The reasons "Did not take place" picks from. */
export const NOT_HELD_PICKS: readonly CancelReason[] = ['no_show', 'did_not_take_place'];

/** The states a round is in before it goes live. */
const NOT_YET_LIVE: ReadonlySet<InterviewState> = new Set(['assigned', 'accepted', 'ready']);
/** The stages that take no withdrawal: the application is already closed. */
const CLOSED_STAGES: ReadonlySet<ApplicationStage> = new Set(['rejected', 'withdrawn', 'hired']);

export const isNotYetLive = (state: InterviewState): boolean => NOT_YET_LIVE.has(state);

export interface CancelInput { reason: CancelReason; note: string | null }

const record = (v: unknown): Record<string, unknown> => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});

function checkNote(raw: unknown, problems: FieldProblem[]): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') { problems.push({ path: 'note', message: 'The note must be text.' }); return null; }
  const note = raw.trim().replace(/\s+/g, ' ');
  if (note.length > CANCEL_NOTE_MAX) problems.push({ path: 'note', message: `Keep the note under ${CANCEL_NOTE_MAX} characters.` });
  return note || null;
}

function checkReasonOf(input: unknown, picks: readonly CancelReason[], ask: string): Checked<CancelInput> {
  const body = record(input);
  const problems: FieldProblem[] = [];
  const reason = body['reason'];
  if (typeof reason !== 'string' || !picks.includes(reason as CancelReason)) problems.push({ path: 'reason', message: ask });
  const note = checkNote(body['note'], problems);
  if (problems.length) return { ok: false, problems };
  return { ok: true, value: { reason: reason as CancelReason, note } };
}

/** The body of POST /interviews/:id/cancel: `{ revision, reason, note? }`. */
export const checkCancel = (input: unknown): Checked<CancelInput> => checkReasonOf(input, CANCEL_PICKS, 'Choose why the round is cancelled.');
/** The body of POST /interviews/:id/not-held: `{ revision, reason, note? }`. */
export const checkNotHeld = (input: unknown): Checked<CancelInput> => checkReasonOf(input, NOT_HELD_PICKS, 'Choose whether the candidate did not show up or the interview did not take place.');

/** The body of POST /applications/:id/withdraw: `{ basedOn, note? }`. */
export function checkWithdraw(input: unknown): Checked<{ basedOn: number; note: string | null }> {
  const body = record(input);
  const problems: FieldProblem[] = [];
  const basedOn = body['basedOn'];
  if (typeof basedOn !== 'number' || !Number.isInteger(basedOn) || basedOn < 1) problems.push({ path: 'basedOn', message: 'This page is out of date. Reload it and try again.' });
  const note = checkNote(body['note'], problems);
  if (problems.length) return { ok: false, problems };
  return { ok: true, value: { basedOn: basedOn as number, note } };
}

export type CancelMove =
  | { ok: true; closesRoom: boolean }
  | { ok: false; reason: 'no-seat' | 'not-lead' | 'state'; message: string };

function stateRefusal(state: InterviewState): string {
  switch (state) {
    case 'live': return 'This round is live. End it, or mark it as not having taken place.';
    case 'cancelled': return 'This round is already cancelled.';
    case 'declined': return 'This round was declined and is not going ahead. Change who sits on it, or assign it again.';
    default: return 'This round has already been held, so it can no longer be cancelled.';
  }
}

/** The recruiter's Cancel: only before the round goes live. */
export function cancelMove(i: Pick<Interview, 'state'>): CancelMove {
  if (NOT_YET_LIVE.has(i.state)) return { ok: true, closesRoom: false };
  return { ok: false, reason: 'state', message: stateRefusal(i.state) };
}

/**
 * "Did not take place": the lead, or a recruiter (`asRecruiter`, the AssignInterviews holder). A live round always; a
 * not-yet-live round only once its scheduled start has passed (a round with no time has no start to pass).
 */
export function notHeldMove(i: Pick<Interview, 'leadId' | 'panelIds' | 'state' | 'scheduledAt'>, userId: string, asRecruiter: boolean, now: Date): CancelMove {
  if (!asRecruiter) {
    const seat = seatOf(i, userId);
    if (!seat) return { ok: false, reason: 'no-seat', message: 'There is no interview here that you can open.' };
    if (seat !== 'lead') return { ok: false, reason: 'not-lead', message: 'Only the lead interviewer or the recruiter can say this interview did not take place.' };
  }
  if (i.state === 'live') return { ok: true, closesRoom: true };
  if (NOT_YET_LIVE.has(i.state)) {
    if (i.scheduledAt !== null && Date.parse(i.scheduledAt) <= now.getTime()) return { ok: true, closesRoom: false };
    return { ok: false, reason: 'state', message: 'This round\'s start time has not passed yet. Cancel it instead if it will not go ahead.' };
  }
  return { ok: false, reason: 'state', message: i.state === 'cancelled' ? 'This round is already cancelled.' : 'This round has already been held.' };
}

/** The recruiter's End on a live round the lead abandoned: the same answers as the lead's End (room.ts endMove). */
export function recruiterEndMove(i: Pick<Interview, 'state'>): { ok: true; write: boolean } | { ok: false; reason: 'state'; message: string } {
  if (i.state === 'ended') return { ok: true, write: false };
  if (i.state === 'live') return { ok: true, write: true };
  return { ok: false, reason: 'state', message: i.state === 'scored' || i.state === 'reviewed' ? 'This interview has already ended.' : 'This interview has not started, so there is nothing to end.' };
}

export type WithdrawMove = { ok: true; toCancel: Interview[] } | { ok: false; message: string };

/** May the application be withdrawn, and which of its rounds does that cancel? */
export function withdrawMove(app: Pick<Application, 'id' | 'stage'>, interviews: readonly Interview[]): WithdrawMove {
  if (CLOSED_STAGES.has(app.stage)) {
    return { ok: false, message: app.stage === 'withdrawn' ? 'This candidate has already withdrawn.' : 'This application is closed, so its stage does not change any more.' };
  }
  const mine = interviews.filter((i) => i.applicationId === app.id);
  if (mine.some((i) => i.state === 'live')) return { ok: false, message: 'A round is live right now. End it, or mark it as not having taken place, before marking the candidate withdrawn.' };
  return { ok: true, toCancel: mine.filter((i) => NOT_YET_LIVE.has(i.state)) };
}

export const cancellationOf = (input: CancelInput, by: string, at: string): Cancellation => ({ reason: input.reason, note: input.note, by, at });

/** The words a list or a bell uses for a reason. */
export const CANCEL_REASON_LABEL: Record<CancelReason, string> = {
  candidate_unavailable: 'Candidate unavailable',
  interviewer_unavailable: 'Interviewer unavailable',
  rescheduling: 'Rescheduling',
  opening_closed: 'Opening closed',
  other: 'Other',
  no_show: 'Candidate did not show up',
  did_not_take_place: 'Did not take place',
  candidate_withdrew: 'Candidate withdrew',
};

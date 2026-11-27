// The recruiter's stage moves (gap audit 2026-11-20, section 2). Pure rules; the route (routes/interviews/stage-moves.ts)
// decides who is asking (ManageCandidates, the recruiter's) and the store (ApplicationWrites decideStage) only appends,
// against `basedOn`, the length of the history the page read, exactly as withdraw and the hiring manager's decision do.
//
//   move       from                          to                                         reason
//   screen     applied                       screening                                  none (the recruiter has started looking)
//   hire       offer                         hired                                      optional note (the offer was accepted)
//   decline    offer                         rejected                                   required (the offer was declined or pulled)
//   reopen     rejected, withdrawn, on-hold  interviewing when a round was held or is   required
//                                            still to run, otherwise screening
//
// Every other move is refused with a sentence. `hired` is final. The hiring manager's decision (debrief/rules.ts) is
// untouched: they still move interviewing, debrief and on-hold to offer, on-hold or rejected; the recruiter's moves
// are the ones that copy hands to "the recruiter".

import type { Checked, FieldProblem } from './kit.js';
import type { Application, ApplicationStage, Interview, InterviewState, StageChange } from './types.js';

export type StageMoveKind = 'screen' | 'hire' | 'decline' | 'reopen';
export const STAGE_MOVES: readonly StageMoveKind[] = ['screen', 'hire', 'decline', 'reopen'];

export const STAGE_MOVE_LIMITS = { reasonMin: 10, reasonMax: 1000 } as const;

/** The words the page and the refusals use for each move: the profile's "Move stage" menu names them the same way. */
export const STAGE_MOVE_LABEL: Readonly<Record<StageMoveKind, string>> = {
  screen: 'Start screening',
  hire: 'Mark hired',
  decline: 'Offer declined',
  reopen: 'Reopen',
};

/** Whether the move needs a reason (true), takes an optional note (false), or takes nothing (null). */
export const STAGE_MOVE_REASON: Readonly<Record<StageMoveKind, boolean | null>> = { screen: null, hire: false, decline: true, reopen: true };

/** What the history records when the recruiter gives no note. */
const DEFAULT_REASON: Readonly<Record<StageMoveKind, string>> = {
  screen: 'Screening started.',
  hire: 'The offer was accepted.',
  decline: 'The offer was declined.',
  reopen: 'Reopened.',
};

const REOPENABLE: ReadonlySet<ApplicationStage> = new Set(['rejected', 'withdrawn', 'on-hold']);
/** Rounds that were held or are still to run: a reopened application with one goes back to `interviewing`. */
const IN_THE_LOOP: ReadonlySet<InterviewState> = new Set(['assigned', 'accepted', 'ready', 'live', 'ended', 'scored', 'reviewed']);

export type StageMoveOutcome = { ok: true; to: ApplicationStage } | { ok: false; message: string };

/** Where reopening an application goes: back to interviewing when it has a round that was held or is still to run. */
export const reopenTarget = (interviews: readonly Pick<Interview, 'state'>[]): ApplicationStage =>
  (interviews.some((i) => IN_THE_LOOP.has(i.state)) ? 'interviewing' : 'screening');

/** May the recruiter make `move` on an application at `stage` with these rounds (its own), and where does it go? */
export function stageMove(stage: ApplicationStage, move: StageMoveKind, interviews: readonly Pick<Interview, 'state'>[]): StageMoveOutcome {
  switch (move) {
    case 'screen':
      if (stage === 'applied') return { ok: true, to: 'screening' };
      return { ok: false, message: stage === 'screening' ? 'This candidate is already in screening.' : 'Only a new application moves to screening; this one is past it.' };
    case 'hire':
      if (stage === 'offer') return { ok: true, to: 'hired' };
      return { ok: false, message: stage === 'hired' ? 'This candidate is already hired.' : 'Only a candidate with an offer can be marked hired. The hiring manager advances them to an offer on the debrief.' };
    case 'decline':
      if (stage === 'offer') return { ok: true, to: 'rejected' };
      return { ok: false, message: 'Only a candidate with an offer can have it declined. Before an offer, the hiring manager rejects on the debrief.' };
    case 'reopen':
      if (REOPENABLE.has(stage)) return { ok: true, to: reopenTarget(interviews) };
      return { ok: false, message: stage === 'hired' ? 'This candidate was hired, so the application cannot be reopened.' : 'This application is open, so there is nothing to reopen.' };
  }
}

/** The moves the recruiter may make on an application now: what the page's "Move stage" menu offers. */
export function allowedStageMoves(stage: ApplicationStage, interviews: readonly Pick<Interview, 'state'>[]): Array<{ move: StageMoveKind; to: ApplicationStage }> {
  return STAGE_MOVES.flatMap((move) => {
    const out = stageMove(stage, move, interviews);
    return out.ok ? [{ move, to: out.to }] : [];
  });
}

export interface StageMoveInput { move: StageMoveKind; basedOn: number; reason: string | null }

const BODY_KEYS: ReadonlySet<string> = new Set(['move', 'basedOn', 'reason']);

/** The body of POST /applications/:id/move: `{ move, basedOn, reason? }`. Nothing names who moved it: the signed-in person. */
export function checkStageMove(input: unknown): Checked<StageMoveInput> {
  const body = input !== null && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const problems: FieldProblem[] = [];
  const extra = Object.keys(body).filter((k) => !BODY_KEYS.has(k));
  if (extra.length) problems.push({ path: extra[0]!, message: 'A stage move carries only the move, why, and what you read.' });
  const move = body['move'];
  const known = typeof move === 'string' && STAGE_MOVES.includes(move as StageMoveKind);
  if (!known) problems.push({ path: 'move', message: 'Choose a stage move.' });
  const basedOn = body['basedOn'];
  if (typeof basedOn !== 'number' || !Number.isInteger(basedOn) || basedOn < 1) problems.push({ path: 'basedOn', message: 'This page is out of date. Reload it and try again.' });
  const raw = body['reason'];
  if (raw !== undefined && raw !== null && typeof raw !== 'string') problems.push({ path: 'reason', message: 'The reason must be text.' });
  const reason = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
  if (known) {
    const needs = STAGE_MOVE_REASON[move as StageMoveKind];
    if (needs === true && reason.length < STAGE_MOVE_LIMITS.reasonMin) problems.push({ path: 'reason', message: 'Say why in a sentence. Your reason is recorded with the move.' });
    if (needs === null && reason) problems.push({ path: 'reason', message: 'Starting screening takes no reason.' });
  }
  if (reason.length > STAGE_MOVE_LIMITS.reasonMax) problems.push({ path: 'reason', message: `Keep the reason under ${STAGE_MOVE_LIMITS.reasonMax} characters.` });
  if (problems.length) return { ok: false, problems };
  return { ok: true, value: { move: move as StageMoveKind, basedOn: basedOn as number, reason: reason || null } };
}

/** The entry the write appends: who moved it and why (the recruiter's words, or the move's plain default). */
export const stageMoveChange = (args: { to: ApplicationStage; move: StageMoveKind; reason: string | null; by: string; at: string }): StageChange =>
  ({ stage: args.to, at: args.at, by: args.by, reason: args.reason ?? DEFAULT_REASON[args.move] });

/** The application's own rounds. */
export const roundsOf = (app: Pick<Application, 'id'>, interviews: readonly Interview[]): Interview[] => interviews.filter((i) => i.applicationId === app.id);

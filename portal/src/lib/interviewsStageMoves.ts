// The recruiter's stage moves: the portal's pure helpers and the write (middleware lib/interviews/stage-moves.ts and
// routes/interviews/stage-moves.ts hold the rules; gap audit 2026-11-20 §2). The profile's "Move stage" menu offers only
// what the server would allow; the server still decides.
import { INTERVIEWS_API, type ApplicationStage, type InterviewState } from './interviews.ts';
import { writeJson } from './writeJson.ts';

export type StageMoveKind = 'screen' | 'hire' | 'decline' | 'reopen';

export const STAGE_MOVE_LIMITS = { reasonMin: 10, reasonMax: 1000 } as const;

/** The same words the server's refusals and the debrief's copy use (middleware stage-moves.ts STAGE_MOVE_LABEL). */
export const STAGE_MOVE_LABEL: Readonly<Record<StageMoveKind, string>> = {
  screen: 'Start screening',
  hire: 'Mark hired',
  decline: 'Offer declined',
  reopen: 'Reopen',
};

/** true: a reason is required; false: an optional note; null: nothing to say. */
export const STAGE_MOVE_REASON: Readonly<Record<StageMoveKind, boolean | null>> = { screen: null, hire: false, decline: true, reopen: true };

/** What the dialog says each move does. */
export const STAGE_MOVE_BODY: Readonly<Record<StageMoveKind, string>> = {
  screen: 'The candidate moves to screening: you have started looking at them.',
  hire: 'The offer was accepted. The candidate moves to hired, and the application is closed for good.',
  decline: 'The offer was declined or pulled. The candidate moves to rejected. Say what happened; it is recorded with the move.',
  reopen: 'The application comes back into the loop. Say why; it is recorded with the move.',
};

const REOPENABLE: ReadonlySet<ApplicationStage> = new Set(['rejected', 'withdrawn', 'on-hold']);
const IN_THE_LOOP: ReadonlySet<InterviewState> = new Set(['assigned', 'accepted', 'ready', 'live', 'ended', 'scored', 'reviewed']);

/** Where Reopen goes: interviewing when a round was held or is still to run, otherwise screening. */
export const reopenTarget = (rounds: ReadonlyArray<{ state: InterviewState }>): ApplicationStage =>
  (rounds.some((r) => IN_THE_LOOP.has(r.state)) ? 'interviewing' : 'screening');

/** The moves the recruiter may make now, with where each goes. */
export function stageMovesFor(stage: ApplicationStage, rounds: ReadonlyArray<{ state: InterviewState }>): Array<{ move: StageMoveKind; to: ApplicationStage }> {
  if (stage === 'applied') return [{ move: 'screen', to: 'screening' }];
  if (stage === 'offer') return [{ move: 'hire', to: 'hired' }, { move: 'decline', to: 'rejected' }];
  if (REOPENABLE.has(stage)) return [{ move: 'reopen', to: reopenTarget(rounds) }];
  return [];
}

/** The reason as typed, in words when it does not do; null when it does. */
export function stageMoveReasonProblem(move: StageMoveKind, reason: string): string | null {
  const r = reason.trim();
  if (r.length > STAGE_MOVE_LIMITS.reasonMax) return `Keep the reason under ${STAGE_MOVE_LIMITS.reasonMax} characters.`;
  if (STAGE_MOVE_REASON[move] === true && r.length < STAGE_MOVE_LIMITS.reasonMin) return 'Say why in a sentence. Your reason is recorded with the move.';
  return null;
}

/** Make the move; `basedOn` is the stage history's length as the page read it. */
export async function moveStage(applicationId: string, move: StageMoveKind, basedOn: number, reason: string): Promise<{ ok: true; stage: ApplicationStage } | { ok: false; error: string }> {
  const r = reason.trim();
  const body = STAGE_MOVE_REASON[move] === null || !r ? { move, basedOn } : { move, basedOn, reason: r };
  const out = await writeJson<{ application?: { stage: ApplicationStage } }>(`${INTERVIEWS_API}/applications/${encodeURIComponent(applicationId)}/move`, 'POST', body);
  if (out.ok && out.data?.application) return { ok: true, stage: out.data.application.stage };
  return { ok: false, error: out.error ?? 'The stage could not be moved. Try again.' };
}

/** The opening names no hiring manager: nobody can decide on its candidates (the same sentence on the opening and the assign form). */
export const NO_HIRING_MANAGER_WARNING = 'Nobody can decide on this opening\'s candidates until a hiring manager is set.';
/** How to set one: the recruiter, on the Details tab of the opening's editor; anyone else is told who does. */
export const noHiringManagerFix = (canEdit: boolean): string =>
  (canEdit ? 'Set one on the Details tab of the opening\'s editor.' : 'The recruiter sets one in the opening\'s details.');
export const openingEditHref = (openingId: string): string => `/interviews/openings/${encodeURIComponent(openingId)}/edit`;

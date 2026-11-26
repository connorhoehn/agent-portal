// Cancelling a round, "did not take place", the recruiter's End, and withdrawing an application: the portal's pure
// helpers and writes (middleware lib/interviews/cancel.ts and routes/interviews/cancel.ts hold the rules; gap audit
// 2026-11-20 §1). The pages only offer what the server would allow; the server still decides.
import { INTERVIEWS_API, type InterviewRow, type InterviewState } from './interviews.ts';
import { writeJson } from './writeJson.ts';

export type CancelPick = 'candidate_unavailable' | 'interviewer_unavailable' | 'rescheduling' | 'opening_closed' | 'other';
export type NotHeldPick = 'no_show' | 'did_not_take_place';

export const CANCEL_NOTE_MAX = 280;

export const CANCEL_OPTIONS: ReadonlyArray<{ value: CancelPick; label: string }> = [
  { value: 'candidate_unavailable', label: 'Candidate unavailable' },
  { value: 'interviewer_unavailable', label: 'Interviewer unavailable' },
  { value: 'rescheduling', label: 'Rescheduling' },
  { value: 'opening_closed', label: 'Opening closed' },
  { value: 'other', label: 'Other' },
];

export const NOT_HELD_OPTIONS: ReadonlyArray<{ value: NotHeldPick; label: string }> = [
  { value: 'no_show', label: 'The candidate did not show up' },
  { value: 'did_not_take_place', label: 'The interview did not take place' },
];

const NOT_YET_LIVE: ReadonlySet<InterviewState> = new Set(['assigned', 'accepted', 'ready']);

/** The recruiter may cancel a round that is not yet live. */
export const canCancel = (state: InterviewState): boolean => NOT_YET_LIVE.has(state);

/** "Did not take place": a live round, or a not-yet-live round whose start has passed. Who may is the page's (lead or recruiter). */
export function canMarkNotHeld(r: Pick<InterviewRow, 'state' | 'scheduledAt'>, nowMs: number = Date.now()): boolean {
  if (r.state === 'live') return true;
  return NOT_YET_LIVE.has(r.state) && r.scheduledAt !== null && Date.parse(r.scheduledAt) <= nowMs;
}

/** The recruiter's End: a live round the lead left. */
export const canEndAsRecruiter = (state: InterviewState): boolean => state === 'live';

/** A cancelled round is free: the same round may be assigned again. */
export const canAssignAgain = (state: InterviewState): boolean => state === 'cancelled';

/** The stages a withdrawal is refused on. */
const CLOSED_STAGES = new Set(['rejected', 'withdrawn', 'hired']);
export const canWithdraw = (stage: string, rounds: ReadonlyArray<Pick<InterviewRow, 'state'>>): boolean =>
  !CLOSED_STAGES.has(stage) && !rounds.some((r) => r.state === 'live');

/** The cancelled status line: "Cancelled: Rescheduling", with the note when there is one. */
export function cancelledLine(r: Pick<InterviewRow, 'state' | 'cancellation'>): string | null {
  if (r.state !== 'cancelled' || !r.cancellation) return null;
  return r.cancellation.note ? `${r.cancellation.label}: ${r.cancellation.note}` : r.cancellation.label;
}

/** A note over the limit, in words; null when it fits. */
export const noteProblem = (note: string): string | null =>
  note.trim().length > CANCEL_NOTE_MAX ? `Keep the note under ${CANCEL_NOTE_MAX} characters.` : null;

export type CancelOutcome = { ok: true; interview: InterviewRow | null } | { ok: false; error: string; interview: InterviewRow | null };

async function send(path: string, body: unknown, fallback: string): Promise<CancelOutcome> {
  const r = await writeJson<{ interview?: InterviewRow | null }>(`${INTERVIEWS_API}${path}`, 'POST', body);
  if (r.ok) return { ok: true, interview: r.data?.interview ?? null };
  return { ok: false, error: r.error ?? fallback, interview: r.data?.interview ?? null };
}

const noteOf = (note: string): string | undefined => (note.trim() ? note.trim() : undefined);

export const cancelRound = (id: string, revision: number, reason: CancelPick, note: string): Promise<CancelOutcome> =>
  send(`/interviews/${encodeURIComponent(id)}/cancel`, { revision, reason, note: noteOf(note) }, 'The round could not be cancelled. Try again.');

export const markNotHeld = (id: string, revision: number, reason: NotHeldPick, note: string): Promise<CancelOutcome> =>
  send(`/interviews/${encodeURIComponent(id)}/not-held`, { revision, reason, note: noteOf(note) }, 'The round could not be marked. Try again.');

export const endRound = (id: string, revision: number): Promise<CancelOutcome> =>
  send(`/interviews/${encodeURIComponent(id)}/end`, { revision }, 'The interview could not be ended. Try again.');

/** Mark the application withdrawn; `basedOn` is the stage history's length as the page read it. */
export async function withdrawApplication(applicationId: string, basedOn: number, note: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const r = await writeJson<unknown>(`${INTERVIEWS_API}/applications/${encodeURIComponent(applicationId)}/withdraw`, 'POST', { basedOn, note: noteOf(note) });
  return r.ok ? { ok: true } : { ok: false, error: r.error ?? 'The candidate could not be marked withdrawn. Try again.' };
}

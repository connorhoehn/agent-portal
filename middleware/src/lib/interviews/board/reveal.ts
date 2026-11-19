// The lead's reveal of a question's provided design (the master template's part C; routes/interviews/board.ts), recorded in
// the interview's pad log as one `reveal` row per question (pad/log/rules.ts). Two steps, so the record never claims a
// reveal the shared board does not hold: the ask (`revealStatus`) logs nothing and hands the lead's room the design; the
// room puts it on the board and acks (`recordReveal`), which logs it once. A question already revealed says so on both;
// a log at its event cap says so too (`full`), before anything is shown, since the reveal could not be recorded.
import { padLogStore } from '../pad/log/store.js';
import { appendPadEvents, type PadWriter } from '../pad/log/service.js';
import { MAX_EVENTS_PER_INTERVIEW } from '../pad/log/rules.js';
import { interviewsNowMs } from '../clock.js';
import { runWithDbTenant } from '../../../providers/db-tenant.js';
import { INTERVIEWS_TENANT } from '../types.js';

export const REVEAL_NOT_RECORDED = 'The interview’s log is full, so the reveal could not be recorded. Nothing was shown to the candidate.';

const inTenant = <T>(fn: () => Promise<T>): Promise<T> => runWithDbTenant(INTERVIEWS_TENANT, fn);

/** The questions whose provided design is on the shared board, first revealed first. */
export function revealedQuestionIds(interviewId: string): Promise<string[]> {
  return inTenant(() => padLogStore().postedQuestionIds(interviewId, 'reveal'));
}

/** Before the board changes: `already` (shown before), `full` (the log could not record it) or `new`. Logs nothing. */
export async function revealStatus(interviewId: string, questionId: string): Promise<'new' | 'already' | 'full'> {
  if ((await revealedQuestionIds(interviewId)).includes(questionId)) return 'already';
  const counts = await inTenant(() => padLogStore().counts(interviewId));
  return counts.events >= MAX_EVENTS_PER_INTERVIEW ? 'full' : 'new';
}

/** Once the board holds it: log the reveal, once per question. */
export async function recordReveal(interviewId: string, writer: PadWriter, questionId: string): Promise<'logged' | 'already' | 'full'> {
  const status = await revealStatus(interviewId, questionId);
  if (status !== 'new') return status;
  const kept = await inTenant(() => appendPadEvents(interviewId, writer,
    [{ kind: 'reveal', clientAt: new Date(interviewsNowMs()).toISOString(), questionId }], new Date(interviewsNowMs())));
  return kept > 0 ? 'logged' : 'full';
}

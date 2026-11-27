// Add a candidate (UI round 2, lane DESK-B; POST /api/interviews/candidates): the form's fields and the one write.
import { INTERVIEWS_API } from './interviews.ts';
import type { FieldProblem } from './interviewsKit.ts';
import { writeJson } from './writeJson.ts';

export interface NewCandidate { name: string; email: string; headline: string; location: string; source: string; openingId: string }
export const BLANK_CANDIDATE: NewCandidate = { name: '', email: '', headline: '', location: '', source: '', openingId: '' };

/** Only an open opening takes a new candidate; the server refuses a paused or closed one with a sentence on the opening. */
export const openToCandidates = (o: { state: string }): boolean => o.state === 'open';

/** Whether the form holds anything a person typed or chose (the opening they were sent from does not count on its own). */
export const candidateChanged = (d: NewCandidate): boolean => (Object.keys(BLANK_CANDIDATE) as Array<keyof NewCandidate>).some((k) => d[k].trim() !== '');

export type CandidateOutcome =
  | { ok: true; candidateId: string }
  | { ok: false; error: string; fields: FieldProblem[]; duplicate: boolean };

export async function createCandidate(d: NewCandidate): Promise<CandidateOutcome> {
  const r = await writeJson<{ candidate?: { id: string }; fields?: FieldProblem[] }>(`${INTERVIEWS_API}/candidates`, 'POST', d);
  if (r.ok && r.data?.candidate) return { ok: true, candidateId: r.data.candidate.id };
  return { ok: false, error: r.error ?? 'The candidate could not be added. Try again.', fields: r.data?.fields ?? [], duplicate: r.status === 409 };
}

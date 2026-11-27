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

// ── The recruiter's edit (gap audit 2026-11-20 §6; PATCH /api/interviews/candidates/:id) ─────────────────────────────────
// Name, email, headline and location, against the version the profile read. The server checks as the create does, and
// refuses an address another candidate holds, an erased candidate, and a stale version, each in one sentence.

export interface CandidateDetails { name: string; email: string; headline: string; location: string }

/** The form's starting values, from the profile's record. */
export const detailsOf = (c: { name: string; email?: string; headline: string; location: string }): CandidateDetails =>
  ({ name: c.name, email: c.email ?? '', headline: c.headline, location: c.location });

/** Whether the form differs from the record (spaces at the ends aside). */
export const detailsChanged = (was: CandidateDetails, now: CandidateDetails): boolean =>
  (Object.keys(was) as Array<keyof CandidateDetails>).some((k) => was[k].trim() !== now[k].trim());

export type EditOutcome =
  | { ok: true }
  | { ok: false; error: string; fields: FieldProblem[]; stale: boolean };

export async function editCandidate(id: string, version: string, d: CandidateDetails): Promise<EditOutcome> {
  const r = await writeJson<{ fields?: FieldProblem[]; candidate?: unknown }>(`${INTERVIEWS_API}/candidates/${encodeURIComponent(id)}`, 'PATCH', { version, ...d });
  if (r.ok) return { ok: true };
  return { ok: false, error: r.error ?? 'The details could not be saved. Try again.', fields: r.data?.fields ?? [], stale: r.status === 409 && !!r.data?.candidate };
}

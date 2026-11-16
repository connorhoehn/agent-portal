// The interviews tenant's store (docs/interviews-tenant-plan.md, "The model"; row I0.3).
//
// Two implementations behind one interface, chosen the way the meeting
// assistant chooses (store-select.ts): the in-memory store over the registered
// fixtures under the mock providers (dev:mock, the journeys, tests), the SQL
// store over schema/interviews_schema.sql otherwise. Both return the same
// rows in the same order; __tests__/store.test.ts runs one contract over both.
//
// Phase 0 is reads only, and every read is a whole table: the tenant is one
// hiring desk, and who may see which row is decided above the store, in one
// pure place (scope.ts), so the two stores cannot disagree about it. When a
// table outgrows a whole read the scope moves into the statement, not into
// two copies of the rule.

import { interviewApplicationsFixture, interviewCandidatesFixture, interviewOpeningsFixture, interviewScorecardsFixture, interviewsFixture } from '../../mock/interviews.js';
import type { Application, Candidate, Interview, InterviewsWorld, Opening, Scorecard } from './types.js';

export interface InterviewsStore {
  listOpenings(): Promise<Opening[]>;
  listCandidates(): Promise<Candidate[]>;
  listApplications(): Promise<Application[]>;
  listInterviews(): Promise<Interview[]>;
  listScorecards(): Promise<Scorecard[]>;
}

/** The order every store returns: the SQL statements' ORDER BY clauses, in code. */
export const ORDER = {
  openings: (a: Opening, b: Opening) => b.openedAt.localeCompare(a.openedAt) || a.id.localeCompare(b.id),
  candidates: (a: Candidate, b: Candidate) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  applications: (a: Application, b: Application) => a.appliedAt.localeCompare(b.appliedAt) || a.id.localeCompare(b.id),
  // NULLS LAST, then by id.
  interviews: (a: Interview, b: Interview) => (a.scheduledAt === null ? 1 : 0) - (b.scheduledAt === null ? 1 : 0)
    || (a.scheduledAt ?? '').localeCompare(b.scheduledAt ?? '') || a.id.localeCompare(b.id),
  scorecards: (a: Scorecard, b: Scorecard) => a.submittedAt.localeCompare(b.submittedAt) || a.id.localeCompare(b.id),
} as const;

const copy = <T>(rows: readonly T[]): T[] => rows.map((r) => structuredClone(r));

/** Reads the registered fixtures, so `POST /api/__mock/reset` and the scenarios apply. */
export class MemoryInterviewsStore implements InterviewsStore {
  async listOpenings(): Promise<Opening[]> { return copy(interviewOpeningsFixture.rows()).sort(ORDER.openings); }
  async listCandidates(): Promise<Candidate[]> { return copy(interviewCandidatesFixture.rows()).sort(ORDER.candidates); }
  async listApplications(): Promise<Application[]> { return copy(interviewApplicationsFixture.rows()).sort(ORDER.applications); }
  async listInterviews(): Promise<Interview[]> { return copy(interviewsFixture.rows()).sort(ORDER.interviews); }
  async listScorecards(): Promise<Scorecard[]> { return copy(interviewScorecardsFixture.rows()).sort(ORDER.scorecards); }
}

/** One snapshot of everything a phase 0 read looks at. */
export async function loadWorld(store: InterviewsStore): Promise<InterviewsWorld> {
  const [openings, candidates, applications, interviews, scorecards] = await Promise.all([
    store.listOpenings(), store.listCandidates(), store.listApplications(), store.listInterviews(), store.listScorecards(),
  ]);
  return { openings, candidates, applications, interviews, scorecards };
}

// The interviews tenant's store (docs/interviews-tenant-plan.md, "The model"; row I0.3).
//
// Two implementations behind one interface, chosen the way the meeting
// assistant chooses (store-select.ts): the in-memory store over the registered
// fixtures under the mock providers (dev:mock, the journeys, tests), the SQL
// store over schema/interviews_schema.sql otherwise. Both return the same
// rows in the same order; __tests__/store.test.ts runs one contract over both.
//
// Every read is a whole table: the tenant is one hiring desk, and who may see
// which row is decided above the store, in one pure place (scope.ts), so the
// two stores cannot disagree about it. When a table outgrows a whole read the
// scope moves into the statement, not into two copies of the rule.
//
// Writes (row I1.3 is the first: OpeningWrites) follow one pattern later rows
// copy. The store only writes: who may write and whether the input is good are
// decided before it is called (the route, then kit.ts). Each write that
// changes a row names the revision it was made against and is a
// compare-and-set: it applies only while the row is still at that revision
// and bumps it, so two editors never overwrite each other unseen. The answer
// says which of the three things happened (written, no such row, or someone
// saved first, with the row as it now is).

import { interviewApplicationsFixture, interviewCandidatesFixture, interviewOpeningsFixture, interviewScorecardsFixture, interviewsFixture } from '../../mock/interviews.js';
import type { Application, Cancellation, Candidate, Interview, InterviewState, InterviewsWorld, Opening, OpeningDetails, OpeningKit, Scorecard, StageChange } from './types.js';
import type { Reassignment, SeatAnswerChange } from './assign.js';

/** What a compare-and-set write did. `stale` carries the row as it now is, so the editor can say who won. */
/** The opening already holds a candidate with this address (case aside): the route answers 409 with its duplicate line. */
export class DuplicateCandidateError extends Error {
  constructor() { super('This person is already a candidate for this opening.'); this.name = 'DuplicateCandidateError'; }
}

export type WriteResult<T> = { ok: true; row: T } | { ok: false; reason: 'not-found' } | { ok: false; reason: 'stale'; row: T };

/** A new opening, checked (kit.ts) and given its id, recruiter and time by the route. */
export type NewOpening = OpeningDetails & Pick<Opening, 'id' | 'recruiterId' | 'openedAt' | 'kit'>;

/** The recruiter's writes on openings (row I1.3; decision 2). */
export interface OpeningWrites {
  /** Insert at revision 1. Ids are chosen by the caller (kit.ts openingIdFor) and never reused; a taken id is `null`. */
  createOpening(input: NewOpening): Promise<Opening | null>;
  /** Replace the details (everything but the kit), against `revision`. */
  updateOpeningDetails(id: string, details: OpeningDetails, revision: number): Promise<WriteResult<Opening>>;
  /** Replace the kit as a whole, against `revision`. */
  replaceOpeningKit(id: string, kit: OpeningKit, revision: number): Promise<WriteResult<Opening>>;
}

/**
 * The writes on an interview (row I1.4): create a round, answer a seat, reassign it. Who may write and what
 * the write becomes are decided first (the route, then assign.ts); these only write, compare-and-set on the
 * interview's revision. Row I1.5 adds the time here; later rows add theirs the same way.
 */
export interface InterviewWrites {
  /** Insert as given (assign.ts newInterview, revision 1). Ids are chosen by the route and never reused; a taken id is `null`. */
  createInterview(input: Interview): Promise<Interview | null>;
  /** The room (row I2.4): the state to `live`, against `revision`. Whether it may move is room.ts startMove. */
  /** Live from now; `startedAt` is when it actually started (the record's clock and header). */
  startInterview(id: string, revision: number, startedAt?: string): Promise<WriteResult<Interview>>;
  /** The room (row I2.4): the state to `ended` with `endedAt`, against `revision`. Whether it may move is room.ts endMove. */
  endInterview(id: string, endedAt: string, revision: number): Promise<WriteResult<Interview>>;
  /** Any state → `cancelled` with its cancellation (lib/interviews/cancel.ts decides when). A live round also gets `endedAt`. */
  cancelInterview(id: string, cancellation: Cancellation, revision: number): Promise<WriteResult<Interview>>;
  /** A seat's answer: the state, the panel, the acceptances and the declines, against `revision`. */
  answerSeat(id: string, change: SeatAnswerChange, revision: number): Promise<WriteResult<Interview>>;
  /** New seats: the lead, the panel, the state and the acceptances that still hold, against `revision`. */
  reassign(id: string, change: Reassignment, revision: number): Promise<WriteResult<Interview>>;
  /** Set (an ISO instant, UTC) or clear (`null`) the time, against `revision`. The state is not touched. */
  setTime(id: string, scheduledAt: string | null, revision: number): Promise<WriteResult<Interview>>;
  /** The lead's chosen questions in order and the state they leave (prepare.ts readyState), against `revision`. */
  setQuestions(id: string, questionIds: string[], state: InterviewState, revision: number): Promise<WriteResult<Interview>>;
  /** The scorecard (row I5.3): `ended` → `scored` once every seated person's is in (scorecard.ts isScoredNow), against `revision`. */
  markScored(id: string, revision: number): Promise<WriteResult<Interview>>;
  /** The stage decision (row I5.5): `scored` → `reviewed` once the hiring manager has decided on the application, against `revision`. */
  markReviewed(id: string, revision: number): Promise<WriteResult<Interview>>;
}

/**
 * The scorecard's one write (row I5.3; decision 14). A submitted scorecard is never edited: every submit inserts a
 * new version. Who may submit and what the version is are decided first (the route, then scorecard.ts submitMove);
 * this only writes. The compare-and-set is on the author's latest version: the row inserts only while the latest
 * version of (interview, interviewer) is `row.version - 1` (none, for version 1). Otherwise it is `stale` with that
 * latest version as it now is (`not-found` when there is none, which only a forged version number reaches).
 */
/**
 * The hiring manager's stage decision (row I5.5; decision 15). The history is append-only: a decision is never
 * edited, a later one is a new entry. Who may decide and where it moves are decided first (the route, then
 * debrief/rules.ts); this only writes. The compare-and-set is on the history's length: the entry appends, and the
 * stage becomes its stage, only while the history still has `basedOn` entries; otherwise it is `stale` with the
 * application as it now is.
 */
export interface ApplicationWrites {
  decideStage(id: string, change: StageChange, basedOn: number): Promise<WriteResult<Application>>;
}

export interface ScorecardWrites {
  addScorecardVersion(row: Scorecard): Promise<WriteResult<Scorecard>>;
}

export interface InterviewsStore extends OpeningWrites, InterviewWrites, ScorecardWrites, ApplicationWrites {
  listOpenings(): Promise<Opening[]>;
  listCandidates(): Promise<Candidate[]>;
  listApplications(): Promise<Application[]>;
  listInterviews(): Promise<Interview[]>;
  /** One interview by id, or null: the gateway's per-delivery seat checks (the pad, the lobby) read this, not the whole table. */
  getInterview(id: string): Promise<Interview | null>;
  listScorecards(): Promise<Scorecard[]>;
  /**
   * Add a candidate and their application to an opening together (UI round 2, DESK-B). Ids are chosen by the route and never reused; a taken id is `null`.
   * The SQL store throws DuplicateCandidateError when the opening already holds this address (case aside), which the schema's unique rule enforces.
   */
  createCandidate(candidate: Candidate, application: Application): Promise<{ candidate: Candidate; application: Application } | null>;
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
  async getInterview(id: string): Promise<Interview | null> {
    const row = interviewsFixture.rows().find((i) => i.id === id);
    return row ? structuredClone(row) : null;
  }
  async listScorecards(): Promise<Scorecard[]> { return copy(interviewScorecardsFixture.rows()).sort(ORDER.scorecards); }

  async createOpening(input: NewOpening): Promise<Opening | null> {
    const rows = interviewOpeningsFixture.rows();
    if (rows.some((o) => o.id === input.id)) return null;
    const row: Opening = { ...structuredClone(input), revision: 1 };
    rows.push(row);
    return structuredClone(row);
  }

  async updateOpeningDetails(id: string, details: OpeningDetails, revision: number): Promise<WriteResult<Opening>> {
    return casOpening(id, revision, (o) => Object.assign(o, structuredClone(details)));
  }

  async replaceOpeningKit(id: string, kit: OpeningKit, revision: number): Promise<WriteResult<Opening>> {
    return casOpening(id, revision, (o) => { o.kit = structuredClone(kit); });
  }

  async startInterview(id: string, revision: number, startedAt?: string): Promise<WriteResult<Interview>> {
    return casInterview(id, revision, (i) => { i.state = 'live'; if (startedAt) i.startedAt = startedAt; });
  }

  async endInterview(id: string, endedAt: string, revision: number): Promise<WriteResult<Interview>> {
    return casInterview(id, revision, (i) => { i.state = 'ended'; i.endedAt = endedAt; });
  }

  async cancelInterview(id: string, cancellation: Cancellation, revision: number): Promise<WriteResult<Interview>> {
    return casInterview(id, revision, (i) => {
      if (i.state === 'live') i.endedAt = cancellation.at;
      i.state = 'cancelled';
      i.cancellation = structuredClone(cancellation);
    });
  }

  async createInterview(input: Interview): Promise<Interview | null> {
    const rows = interviewsFixture.rows();
    if (rows.some((i) => i.id === input.id)) return null;
    const row: Interview = { ...structuredClone(input), revision: 1 };
    rows.push(row);
    return structuredClone(row);
  }

  async answerSeat(id: string, change: SeatAnswerChange, revision: number): Promise<WriteResult<Interview>> {
    return casInterview(id, revision, (i) => Object.assign(i, structuredClone(change)));
  }

  async reassign(id: string, change: Reassignment, revision: number): Promise<WriteResult<Interview>> {
    return casInterview(id, revision, (i) => Object.assign(i, structuredClone(change)));
  }

  async setTime(id: string, scheduledAt: string | null, revision: number): Promise<WriteResult<Interview>> {
    return casInterview(id, revision, (i) => { i.scheduledAt = scheduledAt; });
  }

  async setQuestions(id: string, questionIds: string[], state: InterviewState, revision: number): Promise<WriteResult<Interview>> {
    return casInterview(id, revision, (i) => { i.questionIds = [...questionIds]; i.state = state; });
  }

  async markScored(id: string, revision: number): Promise<WriteResult<Interview>> {
    return casInterview(id, revision, (i) => { i.state = 'scored'; });
  }

  async addScorecardVersion(row: Scorecard): Promise<WriteResult<Scorecard>> {
    const rows = interviewScorecardsFixture.rows();
    const mine = rows.filter((s) => s.interviewId === row.interviewId && s.interviewerId === row.interviewerId);
    const latest = mine.reduce<Scorecard | null>((l, s) => (!l || s.version > l.version ? s : l), null);
    if ((latest?.version ?? 0) !== row.version - 1 || rows.some((s) => s.id === row.id)) {
      return latest ? { ok: false, reason: 'stale', row: structuredClone(latest) } : { ok: false, reason: 'not-found' };
    }
    rows.push(structuredClone(row));
    return { ok: true, row: structuredClone(row) };
  }

  async markReviewed(id: string, revision: number): Promise<WriteResult<Interview>> {
    return casInterview(id, revision, (i) => { i.state = 'reviewed'; });
  }

  async decideStage(id: string, change: StageChange, basedOn: number): Promise<WriteResult<Application>> {
    const row = interviewApplicationsFixture.rows().find((a) => a.id === id);
    if (!row) return { ok: false, reason: 'not-found' };
    if (row.history.length !== basedOn) return { ok: false, reason: 'stale', row: structuredClone(row) };
    row.history.push(structuredClone(change));
    row.stage = change.stage;
    return { ok: true, row: structuredClone(row) };
  }

  async createCandidate(candidate: Candidate, application: Application): Promise<{ candidate: Candidate; application: Application } | null> {
    if (interviewCandidatesFixture.rows().some((c) => c.id === candidate.id) || interviewApplicationsFixture.rows().some((a) => a.id === application.id)) return null;
    interviewCandidatesFixture.rows().push(structuredClone(candidate));
    interviewApplicationsFixture.rows().push(structuredClone(application));
    return { candidate: structuredClone(candidate), application: structuredClone(application) };
  }
}

/** casOpening's twin for interviews. */
function casInterview(id: string, revision: number, change: (i: Interview) => void): WriteResult<Interview> {
  const row = interviewsFixture.rows().find((i) => i.id === id);
  if (!row) return { ok: false, reason: 'not-found' };
  if (row.revision !== revision) return { ok: false, reason: 'stale', row: structuredClone(row) };
  change(row);
  row.revision += 1;
  return { ok: true, row: structuredClone(row) };
}

/** The SQL statements' `WHERE id = :id AND revision = :revision`, in one tick. */
function casOpening(id: string, revision: number, change: (o: Opening) => void): WriteResult<Opening> {
  const row = interviewOpeningsFixture.rows().find((o) => o.id === id);
  if (!row) return { ok: false, reason: 'not-found' };
  if (row.revision !== revision) return { ok: false, reason: 'stale', row: structuredClone(row) };
  change(row);
  row.revision += 1;
  return { ok: true, row: structuredClone(row) };
}

/** One snapshot of everything a phase 0 read looks at. */
export async function loadWorld(store: InterviewsStore): Promise<InterviewsWorld> {
  const [openings, candidates, applications, interviews, scorecards] = await Promise.all([
    store.listOpenings(), store.listCandidates(), store.listApplications(), store.listInterviews(), store.listScorecards(),
  ]);
  return { openings, candidates, applications, interviews, scorecards };
}

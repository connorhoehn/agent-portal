// The interviews SQL store (schema/interviews_schema.sql), over the RDS Data API's `exec` shape.
// The executor is injected so unit tests run the statements against canned rows
// (__tests__/store.test.ts); production passes providers/aurora.ts `exec`. Each
// statement's ORDER BY is store.ts ORDER, so both stores hand back the same order.
//
// Writes are compare-and-set statements (store.ts, "Writes"): the WHERE names the
// revision the write was made against, so PostgreSQL decides a race and the loser
// gets no row back; one read by id then tells "no such row" from "someone saved
// first". Parameters use the Data API's `:name` binding; timestamps travel as ISO
// text and JSONB as JSON text, each CAST in the statement; an absent value is NULL.
import type { SqlParameter } from '@aws-sdk/client-rds-data';
import type {
  Application, ApplicationStage, Candidate, CompetencyRating, Interview, InterviewState, Opening, OpeningKit, OpeningState,
  OpeningDetails, Recommendation, RoundType, Scorecard, SeatAcceptance, SeatDecline, StageChange,
} from './types.js';
import type { InterviewsStore, NewOpening, WriteResult } from './store.js';
import type { Reassignment, SeatAnswerChange } from './assign.js';

export type SqlExec = (sql: string, params?: SqlParameter[]) => Promise<Record<string, unknown>[]>;

const OPENING_COLUMNS = 'id, title, level, team, location, hiring_manager_id, recruiter_id, state, opened_at, kit, budget_cap_usd, revision, interview_cap_usd';

export const LIST_OPENINGS_SQL = `SELECT ${OPENING_COLUMNS}
  FROM interview_openings ORDER BY opened_at DESC, id`;
export const LIST_CANDIDATES_SQL = `SELECT id, name, email, headline, location, source, resume_file_id, notes, created_at
  FROM interview_candidates ORDER BY name, id`;
export const LIST_APPLICATIONS_SQL = `SELECT id, candidate_id, opening_id, stage, applied_at, history
  FROM interview_applications ORDER BY applied_at, id`;
const INTERVIEW_COLUMNS = `id, application_id, round_id, type, lead_id, panel_ids, scheduled_at, minutes, state, question_ids,
  assigned_by, assigned_at, call_id, ended_at, acceptances, declines, revision`;
export const LIST_INTERVIEWS_SQL = `SELECT ${INTERVIEW_COLUMNS}
  FROM interviews ORDER BY scheduled_at NULLS LAST, id`;
export const LIST_SCORECARDS_SQL = `SELECT id, interview_id, interviewer_id, ratings, recommendation, summary, submitted_at, version, changed_after_recap, correction_reason
  FROM interview_scorecards ORDER BY submitted_at, id`;

export const INTERVIEWS_STATEMENTS = [LIST_OPENINGS_SQL, LIST_CANDIDATES_SQL, LIST_APPLICATIONS_SQL, LIST_INTERVIEWS_SQL, LIST_SCORECARDS_SQL] as const;

// ── the openings writes (row I1.3) ──────────────────────────────────────────
export const GET_OPENING_SQL = `SELECT ${OPENING_COLUMNS}
  FROM interview_openings WHERE id = :id`;
/** A taken id inserts nothing and returns no row. */
export const INSERT_OPENING_SQL = `INSERT INTO interview_openings (${OPENING_COLUMNS})
  VALUES (:id, :title, :level, :team, :location, :hiring_manager_id, :recruiter_id, :state, CAST(:opened_at AS TIMESTAMPTZ), CAST(:kit AS JSONB),
    CAST(:budget_cap_usd AS NUMERIC), 1, CAST(:interview_cap_usd AS NUMERIC))
  ON CONFLICT (id) DO NOTHING
  RETURNING ${OPENING_COLUMNS}`;
export const UPDATE_OPENING_DETAILS_SQL = `UPDATE interview_openings
  SET title = :title, level = :level, team = :team, location = :location, hiring_manager_id = :hiring_manager_id, state = :state,
    budget_cap_usd = CAST(:budget_cap_usd AS NUMERIC), interview_cap_usd = CAST(:interview_cap_usd AS NUMERIC), revision = revision + 1
  WHERE id = :id AND revision = :revision
  RETURNING ${OPENING_COLUMNS}`;
export const REPLACE_OPENING_KIT_SQL = `UPDATE interview_openings
  SET kit = CAST(:kit AS JSONB), revision = revision + 1
  WHERE id = :id AND revision = :revision
  RETURNING ${OPENING_COLUMNS}`;

export const OPENING_WRITE_STATEMENTS = [GET_OPENING_SQL, INSERT_OPENING_SQL, UPDATE_OPENING_DETAILS_SQL, REPLACE_OPENING_KIT_SQL] as const;

// ── the interview writes (row I1.4) ─────────────────────────────────────────
export const GET_INTERVIEW_SQL = `SELECT ${INTERVIEW_COLUMNS}
  FROM interviews WHERE id = :id`;
/** A taken id inserts nothing and returns no row. TEXT[] travels as JSON text and is turned into an array in the statement. */
export const INSERT_INTERVIEW_SQL = `INSERT INTO interviews (${INTERVIEW_COLUMNS})
  VALUES (:id, :application_id, :round_id, :type, :lead_id, ARRAY(SELECT jsonb_array_elements_text(CAST(:panel_ids AS JSONB))),
    CAST(:scheduled_at AS TIMESTAMPTZ), :minutes, :state, ARRAY(SELECT jsonb_array_elements_text(CAST(:question_ids AS JSONB))),
    :assigned_by, CAST(:assigned_at AS TIMESTAMPTZ), :call_id, CAST(:ended_at AS TIMESTAMPTZ),
    CAST(:acceptances AS JSONB), CAST(:declines AS JSONB), 1)
  ON CONFLICT (id) DO NOTHING
  RETURNING ${INTERVIEW_COLUMNS}`;
export const ANSWER_SEAT_SQL = `UPDATE interviews
  SET state = :state, panel_ids = ARRAY(SELECT jsonb_array_elements_text(CAST(:panel_ids AS JSONB))),
    acceptances = CAST(:acceptances AS JSONB), declines = CAST(:declines AS JSONB), revision = revision + 1
  WHERE id = :id AND revision = :revision
  RETURNING ${INTERVIEW_COLUMNS}`;
export const REASSIGN_SQL = `UPDATE interviews
  SET lead_id = :lead_id, panel_ids = ARRAY(SELECT jsonb_array_elements_text(CAST(:panel_ids AS JSONB))), state = :state,
    acceptances = CAST(:acceptances AS JSONB), revision = revision + 1
  WHERE id = :id AND revision = :revision
  RETURNING ${INTERVIEW_COLUMNS}`;

export const SET_TIME_SQL = `UPDATE interviews
  SET scheduled_at = CAST(:scheduled_at AS TIMESTAMPTZ), revision = revision + 1
  WHERE id = :id AND revision = :revision
  RETURNING ${INTERVIEW_COLUMNS}`;

export const SET_QUESTIONS_SQL = `UPDATE interviews
  SET question_ids = ARRAY(SELECT jsonb_array_elements_text(CAST(:question_ids AS JSONB))), state = :state, revision = revision + 1
  WHERE id = :id AND revision = :revision
  RETURNING ${INTERVIEW_COLUMNS}`;

export const INTERVIEW_WRITE_STATEMENTS = [GET_INTERVIEW_SQL, INSERT_INTERVIEW_SQL, ANSWER_SEAT_SQL, REASSIGN_SQL, SET_TIME_SQL, SET_QUESTIONS_SQL] as const;

const textParam = (name: string, value: string | null): SqlParameter =>
  (value === null ? { name, value: { isNull: true } } : { name, value: { stringValue: value } });
const intParam = (name: string, value: number): SqlParameter => ({ name, value: { longValue: value } });
const capParam = (value: number | null, name = 'budget_cap_usd'): SqlParameter => textParam(name, value === null ? null : value.toFixed(2));

function detailParams(d: OpeningDetails): SqlParameter[] {
  return [
    textParam('title', d.title), textParam('level', d.level), textParam('team', d.team), textParam('location', d.location),
    textParam('hiring_manager_id', d.hiringManagerId), textParam('state', d.state), capParam(d.budgetCapUsd), capParam(d.interviewCapUsd ?? null, 'interview_cap_usd'),
  ];
}

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const num = (v: unknown): number => Number(v ?? 0);
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const bool = (v: unknown): boolean => v === true || v === 't' || v === 'true';

/** A TIMESTAMPTZ as the Data API returns it ('2026-11-16 10:00:00' or with an offset) → ISO. */
export function isoOf(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  const s = String(v);
  const withT = s.replace(' ', 'T');
  // Postgres writes an offset as +01 or +0100; Date wants +01:00.
  const offset = /([+-]\d\d)(:?(\d\d))?$/.exec(withT);
  const zoned = /[zZ]$/.test(withT) ? withT
    : offset && withT.indexOf('T') < offset.index ? `${withT.slice(0, offset.index)}${offset[1]}:${offset[3] ?? '00'}`
      : `${withT}Z`;
  return new Date(zoned).toISOString();
}
const isoOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : isoOf(v));

/** JSONB arrives as a string over the Data API, already parsed from `pg`. */
function json<T>(v: unknown, fallback: T): T {
  if (v !== null && typeof v === 'object') return v as T;
  if (typeof v === 'string' && v) { try { return JSON.parse(v) as T; } catch { return fallback; } }
  return fallback;
}
/** A TEXT[] column: an array from `pg`, a JSON string from the Data API (`array_to_json`), or `{a,b}` text. */
function textArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v !== 'string' || !v) return [];
  if (v.startsWith('[')) return json<string[]>(v, []);
  if (v.startsWith('{')) return v.slice(1, -1).split(',').map((x) => x.trim().replace(/^"|"$/g, '')).filter(Boolean);
  return [];
}

export function openingFromRow(r: Record<string, unknown>): Opening {
  return {
    id: str(r['id']), title: str(r['title']), level: str(r['level']), team: str(r['team']), location: str(r['location']),
    hiringManagerId: strOrNull(r['hiring_manager_id']), recruiterId: str(r['recruiter_id']), state: str(r['state']) as OpeningState,
    openedAt: isoOf(r['opened_at']), kit: json<OpeningKit>(r['kit'], { rounds: [], competencies: [], questions: [] }),
    budgetCapUsd: numOrNull(r['budget_cap_usd']), interviewCapUsd: numOrNull(r['interview_cap_usd']), revision: num(r['revision']),
  };
}

export function candidateFromRow(r: Record<string, unknown>): Candidate {
  return {
    id: str(r['id']), name: str(r['name']), email: str(r['email']), headline: str(r['headline']), location: str(r['location']),
    source: str(r['source']), resumeFileId: strOrNull(r['resume_file_id']), notes: str(r['notes']), createdAt: isoOf(r['created_at']),
  };
}

export function applicationFromRow(r: Record<string, unknown>): Application {
  return {
    id: str(r['id']), candidateId: str(r['candidate_id']), openingId: str(r['opening_id']), stage: str(r['stage']) as ApplicationStage,
    appliedAt: isoOf(r['applied_at']), history: json<StageChange[]>(r['history'], []),
  };
}

export function interviewFromRow(r: Record<string, unknown>): Interview {
  return {
    id: str(r['id']), applicationId: str(r['application_id']), roundId: str(r['round_id']), type: str(r['type']) as RoundType,
    leadId: str(r['lead_id']), panelIds: textArray(r['panel_ids']), scheduledAt: isoOrNull(r['scheduled_at']), minutes: num(r['minutes']),
    state: str(r['state']) as InterviewState, questionIds: textArray(r['question_ids']), assignedBy: str(r['assigned_by']),
    assignedAt: isoOf(r['assigned_at']), callId: strOrNull(r['call_id']),
    endedAt: isoOrNull(r['ended_at']), acceptances: json<SeatAcceptance[]>(r['acceptances'], []), declines: json<SeatDecline[]>(r['declines'], []),
    revision: num(r['revision']),
  };
}

export function scorecardFromRow(r: Record<string, unknown>): Scorecard {
  return {
    id: str(r['id']), interviewId: str(r['interview_id']), interviewerId: str(r['interviewer_id']),
    ratings: json<CompetencyRating[]>(r['ratings'], []), recommendation: str(r['recommendation']) as Recommendation,
    summary: str(r['summary']), submittedAt: isoOf(r['submitted_at']), version: num(r['version']), changedAfterRecap: bool(r['changed_after_recap']),
    correctionReason: strOrNull(r['correction_reason']),
  };
}

export class SqlInterviewsStore implements InterviewsStore {
  constructor(private readonly exec: SqlExec) {}
  async listOpenings(): Promise<Opening[]> { return (await this.exec(LIST_OPENINGS_SQL)).map(openingFromRow); }
  async listCandidates(): Promise<Candidate[]> { return (await this.exec(LIST_CANDIDATES_SQL)).map(candidateFromRow); }
  async listApplications(): Promise<Application[]> { return (await this.exec(LIST_APPLICATIONS_SQL)).map(applicationFromRow); }
  async listInterviews(): Promise<Interview[]> { return (await this.exec(LIST_INTERVIEWS_SQL)).map(interviewFromRow); }
  async getInterview(id: string): Promise<Interview | null> {
    const row = (await this.exec(GET_INTERVIEW_SQL, [textParam('id', id)]))[0];
    return row ? interviewFromRow(row) : null;
  }
  async listScorecards(): Promise<Scorecard[]> { return (await this.exec(LIST_SCORECARDS_SQL)).map(scorecardFromRow); }

  async createOpening(input: NewOpening): Promise<Opening | null> {
    const rows = await this.exec(INSERT_OPENING_SQL, [
      textParam('id', input.id), ...detailParams(input), textParam('recruiter_id', input.recruiterId),
      textParam('opened_at', input.openedAt), textParam('kit', JSON.stringify(input.kit)),
    ]);
    return rows[0] ? openingFromRow(rows[0]) : null;
  }

  async updateOpeningDetails(id: string, details: OpeningDetails, revision: number): Promise<WriteResult<Opening>> {
    return this.cas(id, await this.exec(UPDATE_OPENING_DETAILS_SQL, [textParam('id', id), intParam('revision', revision), ...detailParams(details)]));
  }

  async replaceOpeningKit(id: string, kit: OpeningKit, revision: number): Promise<WriteResult<Opening>> {
    return this.cas(id, await this.exec(REPLACE_OPENING_KIT_SQL, [textParam('id', id), intParam('revision', revision), textParam('kit', JSON.stringify(kit))]));
  }

  /** A compare-and-set's answer: its returned row, else why there was none. */
  private async cas(id: string, written: Record<string, unknown>[]): Promise<WriteResult<Opening>> {
    if (written[0]) return { ok: true, row: openingFromRow(written[0]) };
    const now = (await this.exec(GET_OPENING_SQL, [textParam('id', id)]))[0];
    return now ? { ok: false, reason: 'stale', row: openingFromRow(now) } : { ok: false, reason: 'not-found' };
  }

  /** The room's two writes (row I2.4), compare-and-set like the rest. */
  static readonly START_INTERVIEW_SQL = `UPDATE interviews
  SET state = 'live', revision = revision + 1
  WHERE id = :id AND revision = :revision
  RETURNING ${INTERVIEW_COLUMNS}`;
  static readonly END_INTERVIEW_SQL = `UPDATE interviews
  SET state = 'ended', ended_at = CAST(:ended_at AS TIMESTAMPTZ), revision = revision + 1
  WHERE id = :id AND revision = :revision
  RETURNING ${INTERVIEW_COLUMNS}`;

  async startInterview(id: string, revision: number): Promise<WriteResult<Interview>> {
    return this.casInterview(id, await this.exec(SqlInterviewsStore.START_INTERVIEW_SQL, [textParam('id', id), intParam('revision', revision)]));
  }

  async endInterview(id: string, endedAt: string, revision: number): Promise<WriteResult<Interview>> {
    return this.casInterview(id, await this.exec(SqlInterviewsStore.END_INTERVIEW_SQL, [textParam('id', id), intParam('revision', revision), textParam('ended_at', endedAt)]));
  }

  async createInterview(input: Interview): Promise<Interview | null> {
    const rows = await this.exec(INSERT_INTERVIEW_SQL, [
      textParam('id', input.id), textParam('application_id', input.applicationId), textParam('round_id', input.roundId), textParam('type', input.type),
      textParam('lead_id', input.leadId), textParam('panel_ids', JSON.stringify(input.panelIds)), textParam('scheduled_at', input.scheduledAt),
      intParam('minutes', input.minutes), textParam('state', input.state), textParam('question_ids', JSON.stringify(input.questionIds)),
      textParam('assigned_by', input.assignedBy), textParam('assigned_at', input.assignedAt),
      textParam('call_id', input.callId), textParam('ended_at', input.endedAt),
      textParam('acceptances', JSON.stringify(input.acceptances)), textParam('declines', JSON.stringify(input.declines)),
    ]);
    return rows[0] ? interviewFromRow(rows[0]) : null;
  }

  async answerSeat(id: string, change: SeatAnswerChange, revision: number): Promise<WriteResult<Interview>> {
    return this.casInterview(id, await this.exec(ANSWER_SEAT_SQL, [
      textParam('id', id), intParam('revision', revision), textParam('state', change.state), textParam('panel_ids', JSON.stringify(change.panelIds)),
      textParam('acceptances', JSON.stringify(change.acceptances)), textParam('declines', JSON.stringify(change.declines)),
    ]));
  }

  async reassign(id: string, change: Reassignment, revision: number): Promise<WriteResult<Interview>> {
    return this.casInterview(id, await this.exec(REASSIGN_SQL, [
      textParam('id', id), intParam('revision', revision), textParam('lead_id', change.leadId), textParam('panel_ids', JSON.stringify(change.panelIds)),
      textParam('state', change.state), textParam('acceptances', JSON.stringify(change.acceptances)),
    ]));
  }

  async setTime(id: string, scheduledAt: string | null, revision: number): Promise<WriteResult<Interview>> {
    return this.casInterview(id, await this.exec(SET_TIME_SQL, [textParam('id', id), intParam('revision', revision), textParam('scheduled_at', scheduledAt)]));
  }

  async setQuestions(id: string, questionIds: string[], state: InterviewState, revision: number): Promise<WriteResult<Interview>> {
    return this.casInterview(id, await this.exec(SET_QUESTIONS_SQL, [
      textParam('id', id), intParam('revision', revision), textParam('question_ids', JSON.stringify(questionIds)), textParam('state', state),
    ]));
  }

  /** The scorecard's writes (row I5.3; store.ts ScorecardWrites), compare-and-set like the rest. */
  static readonly MARK_SCORED_SQL = `UPDATE interviews
  SET state = 'scored', revision = revision + 1
  WHERE id = :id AND revision = :revision
  RETURNING ${INTERVIEW_COLUMNS}`;
  static readonly SCORECARD_COLUMNS = 'id, interview_id, interviewer_id, ratings, recommendation, summary, submitted_at, version, changed_after_recap, correction_reason';
  /**
   * Inserts only while the author's latest version is `:version - 1`; two submits racing on the same version meet
   * the table's UNIQUE (interview_id, interviewer_id, version) and the loser inserts nothing.
   */
  static readonly INSERT_SCORECARD_VERSION_SQL = `INSERT INTO interview_scorecards (${SqlInterviewsStore.SCORECARD_COLUMNS})
  SELECT :id, :interview_id, :interviewer_id, CAST(:ratings AS JSONB), :recommendation, :summary, CAST(:submitted_at AS TIMESTAMPTZ), :version,
    :changed_after_recap, :correction_reason
  WHERE (SELECT COALESCE(MAX(version), 0) FROM interview_scorecards WHERE interview_id = :interview_id AND interviewer_id = :interviewer_id) = :version - 1
  ON CONFLICT DO NOTHING
  RETURNING ${SqlInterviewsStore.SCORECARD_COLUMNS}`;
  static readonly LATEST_SCORECARD_SQL = `SELECT ${SqlInterviewsStore.SCORECARD_COLUMNS}
  FROM interview_scorecards WHERE interview_id = :interview_id AND interviewer_id = :interviewer_id
  ORDER BY version DESC LIMIT 1`;

  async markScored(id: string, revision: number): Promise<WriteResult<Interview>> {
    return this.casInterview(id, await this.exec(SqlInterviewsStore.MARK_SCORED_SQL, [textParam('id', id), intParam('revision', revision)]));
  }

  async addScorecardVersion(row: Scorecard): Promise<WriteResult<Scorecard>> {
    const written = await this.exec(SqlInterviewsStore.INSERT_SCORECARD_VERSION_SQL, [
      textParam('id', row.id), textParam('interview_id', row.interviewId), textParam('interviewer_id', row.interviewerId),
      textParam('ratings', JSON.stringify(row.ratings)), textParam('recommendation', row.recommendation), textParam('summary', row.summary),
      textParam('submitted_at', row.submittedAt), intParam('version', row.version), { name: 'changed_after_recap', value: { booleanValue: row.changedAfterRecap } },
      textParam('correction_reason', row.correctionReason),
    ]);
    if (written[0]) return { ok: true, row: scorecardFromRow(written[0]) };
    const latest = (await this.exec(SqlInterviewsStore.LATEST_SCORECARD_SQL, [textParam('interview_id', row.interviewId), textParam('interviewer_id', row.interviewerId)]))[0];
    return latest ? { ok: false, reason: 'stale', row: scorecardFromRow(latest) } : { ok: false, reason: 'not-found' };
  }

  /** The stage decision's writes (row I5.5; store.ts ApplicationWrites, InterviewWrites markReviewed). */
  static readonly MARK_REVIEWED_SQL = `UPDATE interviews
  SET state = 'reviewed', revision = revision + 1
  WHERE id = :id AND revision = :revision
  RETURNING ${INTERVIEW_COLUMNS}`;
  static readonly APPLICATION_COLUMNS = 'id, candidate_id, opening_id, stage, applied_at, history';
  /** Appends `:change` (a one-entry JSON array) only while the history still has `:based_on` entries; the stage becomes the entry's. */
  static readonly DECIDE_STAGE_SQL = `UPDATE interview_applications
  SET stage = :stage, history = history || CAST(:change AS JSONB)
  WHERE id = :id AND jsonb_array_length(history) = :based_on
  RETURNING ${SqlInterviewsStore.APPLICATION_COLUMNS}`;
  static readonly GET_APPLICATION_SQL = `SELECT ${SqlInterviewsStore.APPLICATION_COLUMNS}
  FROM interview_applications WHERE id = :id`;

  async markReviewed(id: string, revision: number): Promise<WriteResult<Interview>> {
    return this.casInterview(id, await this.exec(SqlInterviewsStore.MARK_REVIEWED_SQL, [textParam('id', id), intParam('revision', revision)]));
  }

  async decideStage(id: string, change: StageChange, basedOn: number): Promise<WriteResult<Application>> {
    const written = await this.exec(SqlInterviewsStore.DECIDE_STAGE_SQL, [
      textParam('id', id), textParam('stage', change.stage), textParam('change', JSON.stringify([change])), intParam('based_on', basedOn),
    ]);
    if (written[0]) return { ok: true, row: applicationFromRow(written[0]) };
    const now = (await this.exec(SqlInterviewsStore.GET_APPLICATION_SQL, [textParam('id', id)]))[0];
    return now ? { ok: false, reason: 'stale', row: applicationFromRow(now) } : { ok: false, reason: 'not-found' };
  }

  /** The candidate and their application in one statement, so neither is written alone; a taken id inserts nothing and returns no row. */
  static readonly CREATE_CANDIDATE_SQL = `WITH c AS (
    INSERT INTO interview_candidates (id, name, email, headline, location, source, resume_file_id, notes, created_at)
    VALUES (:candidate_id, :name, :email, :headline, :location, :source, NULL, '', CAST(:created_at AS TIMESTAMPTZ))
    ON CONFLICT (id) DO NOTHING
    RETURNING id)
  INSERT INTO interview_applications (id, candidate_id, opening_id, stage, applied_at, history)
  SELECT :application_id, c.id, :opening_id, :stage, CAST(:applied_at AS TIMESTAMPTZ), CAST(:history AS JSONB) FROM c
  ON CONFLICT (id) DO NOTHING
  RETURNING ${SqlInterviewsStore.APPLICATION_COLUMNS}`;

  async createCandidate(candidate: Candidate, application: Application): Promise<{ candidate: Candidate; application: Application } | null> {
    const rows = await this.exec(SqlInterviewsStore.CREATE_CANDIDATE_SQL, [
      textParam('candidate_id', candidate.id), textParam('name', candidate.name), textParam('email', candidate.email), textParam('headline', candidate.headline),
      textParam('location', candidate.location), textParam('source', candidate.source), textParam('created_at', candidate.createdAt),
      textParam('application_id', application.id), textParam('opening_id', application.openingId), textParam('stage', application.stage),
      textParam('applied_at', application.appliedAt), textParam('history', JSON.stringify(application.history)),
    ]);
    return rows[0] ? { candidate: structuredClone(candidate), application: applicationFromRow(rows[0]) } : null;
  }

  /** cas() for an interview. */
  private async casInterview(id: string, written: Record<string, unknown>[]): Promise<WriteResult<Interview>> {
    if (written[0]) return { ok: true, row: interviewFromRow(written[0]) };
    const now = (await this.exec(GET_INTERVIEW_SQL, [textParam('id', id)]))[0];
    return now ? { ok: false, reason: 'stale', row: interviewFromRow(now) } : { ok: false, reason: 'not-found' };
  }
}

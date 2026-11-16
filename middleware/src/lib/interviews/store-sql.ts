// The interviews SQL store (schema/interviews_schema.sql), over the RDS Data API's `exec` shape.
// The executor is injected so unit tests run the statements against canned rows
// (__tests__/store.test.ts); production passes providers/aurora.ts `exec`. Each
// statement's ORDER BY is store.ts ORDER, so both stores hand back the same order.
import type { SqlParameter } from '@aws-sdk/client-rds-data';
import type {
  Application, ApplicationStage, Candidate, CompetencyRating, Interview, InterviewState, Opening, OpeningKit, OpeningState,
  Recommendation, RoundType, Scorecard, StageChange,
} from './types.js';
import type { InterviewsStore } from './store.js';

export type SqlExec = (sql: string, params?: SqlParameter[]) => Promise<Record<string, unknown>[]>;

export const LIST_OPENINGS_SQL = `SELECT id, title, level, team, location, hiring_manager_id, recruiter_id, state, opened_at, kit, budget_cap_usd
  FROM interview_openings ORDER BY opened_at DESC, id`;
export const LIST_CANDIDATES_SQL = `SELECT id, name, email, headline, location, source, resume_file_id, notes, created_at
  FROM interview_candidates ORDER BY name, id`;
export const LIST_APPLICATIONS_SQL = `SELECT id, candidate_id, opening_id, stage, applied_at, history
  FROM interview_applications ORDER BY applied_at, id`;
export const LIST_INTERVIEWS_SQL = `SELECT id, application_id, round_id, type, lead_id, panel_ids, scheduled_at, minutes, state, question_ids,
  assigned_by, assigned_at, invite_token_hash, call_id, ended_at
  FROM interviews ORDER BY scheduled_at NULLS LAST, id`;
export const LIST_SCORECARDS_SQL = `SELECT id, interview_id, interviewer_id, ratings, recommendation, summary, submitted_at, version, changed_after_recap
  FROM interview_scorecards ORDER BY submitted_at, id`;

export const INTERVIEWS_STATEMENTS = [LIST_OPENINGS_SQL, LIST_CANDIDATES_SQL, LIST_APPLICATIONS_SQL, LIST_INTERVIEWS_SQL, LIST_SCORECARDS_SQL] as const;

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
    budgetCapUsd: numOrNull(r['budget_cap_usd']),
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
    assignedAt: isoOf(r['assigned_at']), inviteTokenHash: strOrNull(r['invite_token_hash']), callId: strOrNull(r['call_id']),
    endedAt: isoOrNull(r['ended_at']),
  };
}

export function scorecardFromRow(r: Record<string, unknown>): Scorecard {
  return {
    id: str(r['id']), interviewId: str(r['interview_id']), interviewerId: str(r['interviewer_id']),
    ratings: json<CompetencyRating[]>(r['ratings'], []), recommendation: str(r['recommendation']) as Recommendation,
    summary: str(r['summary']), submittedAt: isoOf(r['submitted_at']), version: num(r['version']), changedAfterRecap: bool(r['changed_after_recap']),
  };
}

export class SqlInterviewsStore implements InterviewsStore {
  constructor(private readonly exec: SqlExec) {}
  async listOpenings(): Promise<Opening[]> { return (await this.exec(LIST_OPENINGS_SQL)).map(openingFromRow); }
  async listCandidates(): Promise<Candidate[]> { return (await this.exec(LIST_CANDIDATES_SQL)).map(candidateFromRow); }
  async listApplications(): Promise<Application[]> { return (await this.exec(LIST_APPLICATIONS_SQL)).map(applicationFromRow); }
  async listInterviews(): Promise<Interview[]> { return (await this.exec(LIST_INTERVIEWS_SQL)).map(interviewFromRow); }
  async listScorecards(): Promise<Scorecard[]> { return (await this.exec(LIST_SCORECARDS_SQL)).map(scorecardFromRow); }
}

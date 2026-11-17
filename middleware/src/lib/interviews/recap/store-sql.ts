// The recap's SQL store (schema/interviews_schema.sql `interview_recaps`, `interview_recap_opens`,
// `interview_recap_attempts`), over the RDS Data API's
// `exec` shape, injected as the coach's store-sql.ts injects it so the contract test runs the statements against canned
// rows. Timestamps travel as ISO text, CAST in the statement; the content and the ratings as JSON text, CAST to JSONB.
//
// Written once in the statements themselves: each INSERT is `ON CONFLICT DO NOTHING`, and an insert that wrote nothing
// reads the row that was there. Nothing updates the recaps or the opens. An attempt is claimed by its own
// `ON CONFLICT DO NOTHING` insert (the primary key is the interview and the attempt number, so two opens cannot both
// take attempt 2), given its code by the one UPDATE in this file, and deleted once the recap row holds its facts; rows
// otherwise leave only by the retention DELETE by interview.
import type { SqlParameter } from '@aws-sdk/client-rds-data';
import { isoOf, type SqlExec } from '../store-sql.js';
import type { RecapContent } from './parse.js';
import type { OpenRating, RecapAttempt, RecapAttemptCode, RecapOpen, RecapRecord, RecapStore } from './store.js';

const RECAP_COLUMNS = 'interview_id, state, content, written_at, model_id, prompt_version, attempts, dropped_codes, dropped_claims';
const OPEN_COLUMNS = 'interview_id, interviewer_id, ratings, opened_at';
const ATTEMPT_COLUMNS = 'interview_id, attempt, code, made_at';

export const GET_RECAP_SQL = `SELECT ${RECAP_COLUMNS} FROM interview_recaps WHERE interview_id = :interview_id`;
export const INSERT_RECAP_SQL = `INSERT INTO interview_recaps (${RECAP_COLUMNS})
  VALUES (:interview_id, :state, CAST(:content AS JSONB), CAST(:written_at AS TIMESTAMPTZ), :model_id, :prompt_version, :attempts,
    ARRAY(SELECT jsonb_array_elements_text(CAST(:dropped_codes AS JSONB))), :dropped_claims)
  ON CONFLICT (interview_id) DO NOTHING
  RETURNING ${RECAP_COLUMNS}`;
export const GET_RECAP_OPEN_SQL = `SELECT ${OPEN_COLUMNS} FROM interview_recap_opens WHERE interview_id = :interview_id AND interviewer_id = :interviewer_id`;
export const LIST_RECAP_OPENS_SQL = `SELECT ${OPEN_COLUMNS} FROM interview_recap_opens WHERE interview_id = :interview_id ORDER BY opened_at, interviewer_id`;
export const INSERT_RECAP_OPEN_SQL = `INSERT INTO interview_recap_opens (${OPEN_COLUMNS})
  VALUES (:interview_id, :interviewer_id, CAST(:ratings AS JSONB), CAST(:opened_at AS TIMESTAMPTZ))
  ON CONFLICT (interview_id, interviewer_id) DO NOTHING
  RETURNING ${OPEN_COLUMNS}`;
export const ERASE_RECAPS_SQL = `DELETE FROM interview_recaps WHERE interview_id = ANY(string_to_array(:interview_ids, ',')) RETURNING interview_id`;
export const ERASE_RECAP_OPENS_SQL = `DELETE FROM interview_recap_opens WHERE interview_id = ANY(string_to_array(:interview_ids, ',')) RETURNING interview_id`;

export const LIST_RECAP_ATTEMPTS_SQL = `SELECT ${ATTEMPT_COLUMNS} FROM interview_recap_attempts WHERE interview_id = :interview_id ORDER BY attempt`;
export const INSERT_RECAP_ATTEMPT_SQL = `INSERT INTO interview_recap_attempts (${ATTEMPT_COLUMNS})
  VALUES (:interview_id, :attempt, NULL, CAST(:made_at AS TIMESTAMPTZ))
  ON CONFLICT (interview_id, attempt) DO NOTHING
  RETURNING interview_id`;
export const SET_RECAP_ATTEMPT_CODE_SQL = `UPDATE interview_recap_attempts SET code = :code WHERE interview_id = :interview_id AND attempt = :attempt`;
export const CLEAR_RECAP_ATTEMPTS_SQL = `DELETE FROM interview_recap_attempts WHERE interview_id = :interview_id`;
export const ERASE_RECAP_ATTEMPTS_SQL = `DELETE FROM interview_recap_attempts WHERE interview_id = ANY(string_to_array(:interview_ids, ',')) RETURNING interview_id`;

export const RECAP_STATEMENTS = [GET_RECAP_SQL, INSERT_RECAP_SQL, GET_RECAP_OPEN_SQL, LIST_RECAP_OPENS_SQL, INSERT_RECAP_OPEN_SQL, ERASE_RECAPS_SQL, ERASE_RECAP_OPENS_SQL,
  LIST_RECAP_ATTEMPTS_SQL, INSERT_RECAP_ATTEMPT_SQL, SET_RECAP_ATTEMPT_CODE_SQL, CLEAR_RECAP_ATTEMPTS_SQL, ERASE_RECAP_ATTEMPTS_SQL] as const;

const text = (name: string, value: string): SqlParameter => ({ name, value: { stringValue: value } });
const int = (name: string, value: number): SqlParameter => ({ name, value: { longValue: value } });

function json<T>(v: unknown, fallback: T): T {
  if (v === null || v === undefined) return fallback;
  if (typeof v !== 'string') return v as T;
  try { return JSON.parse(v) as T; } catch { return fallback; }
}

/** A TEXT[] as the Data API answers it: an array, JSON text, or Postgres's `{a,b}`. */
function textArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v !== 'string' || !v) return [];
  if (v.startsWith('[')) return json<string[]>(v, []);
  if (v.startsWith('{')) return v.slice(1, -1).split(',').map((x) => x.trim().replace(/^"|"$/g, '')).filter(Boolean);
  return [];
}

const EMPTY: RecapContent = { competencies: [], notCovered: [] };

export function recapFromRow(r: Record<string, unknown>): RecapRecord {
  return {
    interviewId: String(r['interview_id']), state: String(r['state']) === 'ready' ? 'ready' : 'failed',
    content: json<RecapContent>(r['content'], EMPTY), writtenAt: isoOf(r['written_at']),
    modelId: String(r['model_id']), promptVersion: String(r['prompt_version']), attempts: Number(r['attempts'] ?? 1),
    droppedCodes: textArray(r['dropped_codes']) as RecapAttemptCode[], droppedClaims: Number(r['dropped_claims'] ?? 0),
  };
}

export function recapOpenFromRow(r: Record<string, unknown>): RecapOpen {
  return {
    interviewId: String(r['interview_id']), interviewerId: String(r['interviewer_id']),
    ratings: json<OpenRating[]>(r['ratings'], []), openedAt: isoOf(r['opened_at']),
  };
}

const ATTEMPT_CODES: readonly RecapAttemptCode[] = ['malformed', 'judges', 'personal', 'timeout', 'error'];

export function recapAttemptFromRow(r: Record<string, unknown>): RecapAttempt {
  const code = r['code'] === null || r['code'] === undefined ? null : String(r['code']);
  return {
    interviewId: String(r['interview_id']), attempt: Number(r['attempt']),
    // A code this file never wrote reads as a failed call: the attempt still counts.
    code: code === null ? null : (ATTEMPT_CODES as readonly string[]).includes(code) ? code as RecapAttemptCode : 'error',
    madeAt: isoOf(r['made_at']),
  };
}

/** Interview ids carry no comma (lib/interviews/spend.ts's id rule); anything else names no interview. */
const idList = (ids: readonly string[]): string => ids.filter((id) => /^[A-Za-z0-9._-]+$/.test(id)).join(',');

export class SqlRecapStore implements RecapStore {
  constructor(private readonly exec: SqlExec) {}

  async getRecap(interviewId: string): Promise<RecapRecord | null> {
    const rows = await this.exec(GET_RECAP_SQL, [text('interview_id', interviewId)]);
    return rows[0] ? recapFromRow(rows[0]) : null;
  }

  async putRecap(row: RecapRecord): Promise<{ row: RecapRecord; created: boolean }> {
    const out = await this.exec(INSERT_RECAP_SQL, [
      text('interview_id', row.interviewId), text('state', row.state), text('content', JSON.stringify(row.content)), text('written_at', row.writtenAt),
      text('model_id', row.modelId), text('prompt_version', row.promptVersion), int('attempts', row.attempts),
      text('dropped_codes', JSON.stringify(row.droppedCodes)), int('dropped_claims', row.droppedClaims),
    ]);
    if (out[0]) return { row: recapFromRow(out[0]), created: true };
    const was = await this.getRecap(row.interviewId);
    if (!was) throw new Error('recap not stored');
    return { row: was, created: false };
  }

  async getOpen(interviewId: string, interviewerId: string): Promise<RecapOpen | null> {
    const rows = await this.exec(GET_RECAP_OPEN_SQL, [text('interview_id', interviewId), text('interviewer_id', interviewerId)]);
    return rows[0] ? recapOpenFromRow(rows[0]) : null;
  }

  async listOpens(interviewId: string): Promise<RecapOpen[]> {
    return (await this.exec(LIST_RECAP_OPENS_SQL, [text('interview_id', interviewId)])).map(recapOpenFromRow);
  }

  async putOpen(row: RecapOpen): Promise<{ row: RecapOpen; created: boolean }> {
    const out = await this.exec(INSERT_RECAP_OPEN_SQL, [
      text('interview_id', row.interviewId), text('interviewer_id', row.interviewerId), text('ratings', JSON.stringify(row.ratings)), text('opened_at', row.openedAt),
    ]);
    if (out[0]) return { row: recapOpenFromRow(out[0]), created: true };
    const was = await this.getOpen(row.interviewId, row.interviewerId);
    if (!was) throw new Error('recap open not stored');
    return { row: was, created: false };
  }

  async listAttempts(interviewId: string): Promise<RecapAttempt[]> {
    return (await this.exec(LIST_RECAP_ATTEMPTS_SQL, [text('interview_id', interviewId)])).map(recapAttemptFromRow);
  }

  async putAttempt(row: RecapAttempt): Promise<boolean> {
    const out = await this.exec(INSERT_RECAP_ATTEMPT_SQL, [text('interview_id', row.interviewId), int('attempt', row.attempt), text('made_at', row.madeAt)]);
    return out.length > 0;
  }

  async setAttemptCode(interviewId: string, attempt: number, code: RecapAttemptCode): Promise<void> {
    await this.exec(SET_RECAP_ATTEMPT_CODE_SQL, [text('interview_id', interviewId), int('attempt', attempt), text('code', code)]);
  }

  async clearAttempts(interviewId: string): Promise<void> {
    await this.exec(CLEAR_RECAP_ATTEMPTS_SQL, [text('interview_id', interviewId)]);
  }

  async eraseRecaps(interviewIds: readonly string[]): Promise<number> {
    const ids = idList(interviewIds);
    if (!ids) return 0;
    const recaps = await this.exec(ERASE_RECAPS_SQL, [text('interview_ids', ids)]);
    const opens = await this.exec(ERASE_RECAP_OPENS_SQL, [text('interview_ids', ids)]);
    const attempts = await this.exec(ERASE_RECAP_ATTEMPTS_SQL, [text('interview_ids', ids)]);
    return recaps.length + opens.length + attempts.length;
  }
}

// The coach log's SQL store (schema/interviews_schema.sql `interview_coach_log`), over the RDS Data API's `exec` shape,
// injected as lib/interviews/coach/store-sql.ts injects it so the contract test runs the statements against canned rows.
// Timestamps travel as ISO text and `sources` as JSON text, each CAST in the statement.
//
// Append-only in the statements themselves: an INSERT, the reads, and the retention DELETE by interview. No UPDATE.
import type { SqlParameter } from '@aws-sdk/client-rds-data';
import { isoOf, type SqlExec } from '../store-sql.js';
import type { CoachLogCode, CoachLogKind, CoachLogRecord, CoachLogSource, CoachLogStore } from './store.js';

const COLUMNS = 'id, interview_id, kind, asked_by, question, answer, sources, code, asked_at, model_id, prompt_version';

export const LIST_COACH_LOG_SQL = `SELECT ${COLUMNS} FROM interview_coach_log WHERE interview_id = :interview_id ORDER BY asked_at, id`;
export const LIST_COACH_LOG_KIND_SQL = `SELECT ${COLUMNS} FROM interview_coach_log WHERE interview_id = :interview_id AND kind = :kind ORDER BY asked_at, id`;
export const INSERT_COACH_LOG_SQL = `INSERT INTO interview_coach_log (id, interview_id, kind, asked_by, question, answer, sources, code, asked_at, model_id, prompt_version)
  VALUES (:id, :interview_id, :kind, :asked_by, :question, :answer, CAST(:sources AS JSONB), :code, CAST(:asked_at AS TIMESTAMPTZ), :model_id, :prompt_version)
  RETURNING ${COLUMNS}`;
export const ERASE_COACH_LOG_SQL = `DELETE FROM interview_coach_log WHERE interview_id = ANY(string_to_array(:interview_ids, ',')) RETURNING id`;

export const COACH_LOG_STATEMENTS = [LIST_COACH_LOG_SQL, LIST_COACH_LOG_KIND_SQL, INSERT_COACH_LOG_SQL, ERASE_COACH_LOG_SQL] as const;

const text = (name: string, value: string): SqlParameter => ({ name, value: { stringValue: value } });
const textOrNull = (name: string, value: string | null): SqlParameter => (value === null ? { name, value: { isNull: true } } : text(name, value));
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

function sourcesOf(v: unknown): CoachLogSource[] {
  const parsed = typeof v === 'string' ? (() => { try { return JSON.parse(v) as unknown; } catch { return []; } })() : v;
  return Array.isArray(parsed) ? (parsed as CoachLogSource[]) : [];
}

export function coachLogFromRow(r: Record<string, unknown>): CoachLogRecord {
  return {
    id: String(r['id']), interviewId: String(r['interview_id']), kind: String(r['kind']) as CoachLogKind, askedBy: String(r['asked_by']),
    question: String(r['question'] ?? ''), answer: String(r['answer'] ?? ''), sources: sourcesOf(r['sources']),
    code: strOrNull(r['code']) as CoachLogCode | null, askedAt: isoOf(r['asked_at']),
    modelId: String(r['model_id']), promptVersion: String(r['prompt_version']),
  };
}

export class SqlCoachLogStore implements CoachLogStore {
  constructor(private readonly exec: SqlExec) {}

  async list(interviewId: string, kind?: CoachLogKind): Promise<CoachLogRecord[]> {
    const rows = kind
      ? await this.exec(LIST_COACH_LOG_KIND_SQL, [text('interview_id', interviewId), text('kind', kind)])
      : await this.exec(LIST_COACH_LOG_SQL, [text('interview_id', interviewId)]);
    return rows.map(coachLogFromRow);
  }

  async append(row: CoachLogRecord): Promise<CoachLogRecord> {
    const out = (await this.exec(INSERT_COACH_LOG_SQL, [
      text('id', row.id), text('interview_id', row.interviewId), text('kind', row.kind), text('asked_by', row.askedBy),
      text('question', row.question), text('answer', row.answer), text('sources', JSON.stringify(row.sources)), textOrNull('code', row.code),
      text('asked_at', row.askedAt), text('model_id', row.modelId), text('prompt_version', row.promptVersion),
    ]))[0];
    if (!out) throw new Error('coach log row not stored');
    return coachLogFromRow(out);
  }

  async erase(interviewIds: readonly string[]): Promise<number> {
    // Interview ids carry no comma (lib/interviews/spend.ts's id rule); anything else names no interview.
    const ids = interviewIds.filter((id) => /^[A-Za-z0-9._-]+$/.test(id));
    if (!ids.length) return 0;
    return (await this.exec(ERASE_COACH_LOG_SQL, [text('interview_ids', ids.join(','))])).length;
  }
}

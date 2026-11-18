// The said log's SQL store (schema/interviews_schema.sql `interview_said_log`), over the RDS Data API's `exec` shape, injected as
// lib/interviews/coach/store-sql.ts injects it. Append-only in the statements: an INSERT, two marks that only set `posted` or `spoken`, and the
// retention DELETE by interview.
import type { SqlParameter } from '@aws-sdk/client-rds-data';
import { isoOf, type SqlExec } from '../store-sql.js';
import type { SaidKind, SaidRecord, SaidSource, SaidStore } from './store.js';

const COLUMNS = 'id, interview_id, call_id, kind, source, question_id, suggestion_id, text, asked_by, said_at, posted, spoken';

export const LIST_SAID_SQL = `SELECT ${COLUMNS} FROM interview_said_log WHERE interview_id = :interview_id ORDER BY said_at, id`;
export const INSERT_SAID_SQL = `INSERT INTO interview_said_log (${COLUMNS})
  VALUES (:id, :interview_id, :call_id, :kind, :source, :question_id, :suggestion_id, :text, :asked_by, CAST(:said_at AS TIMESTAMPTZ), :posted, :spoken)
  RETURNING ${COLUMNS}`;
export const MARK_POSTED_SQL = `UPDATE interview_said_log SET posted = TRUE WHERE interview_id = :interview_id AND id = :id RETURNING ${COLUMNS}`;
export const MARK_SPOKEN_SQL = `UPDATE interview_said_log SET spoken = TRUE WHERE interview_id = :interview_id AND id = :id RETURNING ${COLUMNS}`;
export const ERASE_SAID_SQL = `DELETE FROM interview_said_log WHERE interview_id = ANY(string_to_array(:interview_ids, ',')) RETURNING id`;
export const SAID_STATEMENTS = [LIST_SAID_SQL, INSERT_SAID_SQL, MARK_POSTED_SQL, MARK_SPOKEN_SQL, ERASE_SAID_SQL] as const;

const text = (name: string, value: string): SqlParameter => ({ name, value: { stringValue: value } });
const textOrNull = (name: string, value: string | null): SqlParameter => (value === null ? { name, value: { isNull: true } } : text(name, value));
const bool = (name: string, value: boolean): SqlParameter => ({ name, value: { booleanValue: value } });
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const truthy = (v: unknown): boolean => v === true || v === 't' || v === 'true';

export function saidFromRow(r: Record<string, unknown>): SaidRecord {
  return {
    id: String(r['id']), interviewId: String(r['interview_id']), callId: strOrNull(r['call_id']), kind: String(r['kind']) as SaidKind,
    source: String(r['source']) as SaidSource, questionId: strOrNull(r['question_id']), suggestionId: strOrNull(r['suggestion_id']),
    text: String(r['text'] ?? ''), askedBy: String(r['asked_by']), saidAt: isoOf(r['said_at']), posted: truthy(r['posted']), spoken: truthy(r['spoken']),
  };
}

export class SqlSaidStore implements SaidStore {
  constructor(private readonly exec: SqlExec) {}

  async list(interviewId: string): Promise<SaidRecord[]> {
    return (await this.exec(LIST_SAID_SQL, [text('interview_id', interviewId)])).map(saidFromRow);
  }

  async append(row: SaidRecord): Promise<SaidRecord> {
    const out = await this.exec(INSERT_SAID_SQL, [
      text('id', row.id), text('interview_id', row.interviewId), textOrNull('call_id', row.callId), text('kind', row.kind), text('source', row.source),
      textOrNull('question_id', row.questionId), textOrNull('suggestion_id', row.suggestionId), text('text', row.text), text('asked_by', row.askedBy),
      text('said_at', row.saidAt), bool('posted', row.posted), bool('spoken', row.spoken),
    ]);
    if (!out[0]) throw new Error('said log row not stored');
    return saidFromRow(out[0]);
  }

  async markPosted(interviewId: string, id: string): Promise<SaidRecord | null> {
    return this.mark(MARK_POSTED_SQL, interviewId, id);
  }

  async markSpoken(interviewId: string, id: string): Promise<SaidRecord | null> {
    return this.mark(MARK_SPOKEN_SQL, interviewId, id);
  }

  private async mark(sql: string, interviewId: string, id: string): Promise<SaidRecord | null> {
    const out = await this.exec(sql, [text('interview_id', interviewId), text('id', id)]);
    return out[0] ? saidFromRow(out[0]) : null;
  }

  async erase(interviewIds: readonly string[]): Promise<number> {
    const ids = interviewIds.filter((id) => /^[A-Za-z0-9._-]+$/.test(id));
    if (!ids.length) return 0;
    return (await this.exec(ERASE_SAID_SQL, [text('interview_ids', ids.join(','))])).length;
  }
}

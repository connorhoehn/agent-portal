// The suggestion log's SQL store (schema/interviews_schema.sql `interview_suggestions`), over the RDS Data API's `exec`
// shape, injected as lib/interviews/consent/store-sql.ts injects it so the contract test runs the statements against
// canned rows. Timestamps travel as ISO text, CAST in the statement.
//
// Append-only in the statements themselves: an INSERT, a mark-shown that only fills an empty `shown_at`, an answer that
// only fills an empty `answer` (WHERE answer IS NULL), and the retention DELETE by interview.
import type { SqlParameter } from '@aws-sdk/client-rds-data';
import { isoOf, type SqlExec } from '../store-sql.js';
import type { WriteResult } from '../store.js';
import type { SuggestionAnswer, SuggestionDropCode, SuggestionRecord, SuggestionStore } from './store.js';

const COLUMNS = 'id, interview_id, call_id, through_seq, text, competency_id, based_on, made_at, shown_at, answer, answered_at, spoken, model_id, prompt_version, dropped';

export const LIST_SUGGESTIONS_SQL = `SELECT ${COLUMNS} FROM interview_suggestions WHERE interview_id = :interview_id ORDER BY made_at, id`;
export const GET_SUGGESTION_SQL = `SELECT ${COLUMNS} FROM interview_suggestions WHERE interview_id = :interview_id AND id = :id`;
export const INSERT_SUGGESTION_SQL = `INSERT INTO interview_suggestions (id, interview_id, call_id, through_seq, text, competency_id, based_on,
    made_at, shown_at, answer, answered_at, spoken, model_id, prompt_version, dropped)
  VALUES (:id, :interview_id, :call_id, :through_seq, :text, :competency_id, :based_on, CAST(:made_at AS TIMESTAMPTZ),
    CAST(:shown_at AS TIMESTAMPTZ), :answer, CAST(:answered_at AS TIMESTAMPTZ), :spoken, :model_id, :prompt_version, :dropped)
  RETURNING ${COLUMNS}`;
export const MARK_SHOWN_SQL = `UPDATE interview_suggestions SET shown_at = COALESCE(shown_at, CAST(:at AS TIMESTAMPTZ))
  WHERE interview_id = :interview_id AND id = :id
  RETURNING ${COLUMNS}`;
export const ANSWER_SUGGESTION_SQL = `UPDATE interview_suggestions SET answer = :answer, answered_at = CAST(:at AS TIMESTAMPTZ)
  WHERE interview_id = :interview_id AND id = :id AND dropped IS NULL AND answer IS NULL
  RETURNING ${COLUMNS}`;
export const MARK_SPOKEN_SQL = `UPDATE interview_suggestions SET spoken = TRUE
  WHERE interview_id = :interview_id AND id = :id AND answer = 'milo-ask'
  RETURNING ${COLUMNS}`;
export const ERASE_SUGGESTIONS_SQL = `DELETE FROM interview_suggestions WHERE interview_id = ANY(string_to_array(:interview_ids, ',')) RETURNING id`;

export const SUGGESTION_STATEMENTS = [LIST_SUGGESTIONS_SQL, GET_SUGGESTION_SQL, INSERT_SUGGESTION_SQL, MARK_SHOWN_SQL, ANSWER_SUGGESTION_SQL, ERASE_SUGGESTIONS_SQL] as const;

const text = (name: string, value: string): SqlParameter => ({ name, value: { stringValue: value } });
const textOrNull = (name: string, value: string | null): SqlParameter => (value === null ? { name, value: { isNull: true } } : text(name, value));
const bool = (name: string, value: boolean): SqlParameter => ({ name, value: { booleanValue: value } });
const int = (name: string, value: number): SqlParameter => ({ name, value: { longValue: value } });
const truthy = (v: unknown): boolean => v === true || v === 't' || v === 'true';
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const isoOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : isoOf(v));

export function suggestionFromRow(r: Record<string, unknown>): SuggestionRecord {
  return {
    id: String(r['id']), interviewId: String(r['interview_id']), callId: strOrNull(r['call_id']), throughSeq: Number(r['through_seq'] ?? 0),
    text: String(r['text'] ?? ''), competencyId: strOrNull(r['competency_id']), basedOn: strOrNull(r['based_on']),
    madeAt: isoOf(r['made_at']), shownAt: isoOrNull(r['shown_at']),
    answer: strOrNull(r['answer']) as SuggestionAnswer | null, answeredAt: isoOrNull(r['answered_at']),
    spoken: truthy(r['spoken']), modelId: String(r['model_id']), promptVersion: String(r['prompt_version']),
    dropped: strOrNull(r['dropped']) as SuggestionDropCode | null,
  };
}

const first = (rows: Record<string, unknown>[]): SuggestionRecord | null => (rows[0] ? suggestionFromRow(rows[0]) : null);

export class SqlSuggestionStore implements SuggestionStore {
  constructor(private readonly exec: SqlExec) {}

  async listSuggestions(interviewId: string): Promise<SuggestionRecord[]> {
    return (await this.exec(LIST_SUGGESTIONS_SQL, [text('interview_id', interviewId)])).map(suggestionFromRow);
  }

  async appendSuggestion(row: SuggestionRecord): Promise<SuggestionRecord> {
    const out = first(await this.exec(INSERT_SUGGESTION_SQL, [
      text('id', row.id), text('interview_id', row.interviewId), textOrNull('call_id', row.callId), int('through_seq', row.throughSeq),
      text('text', row.text), textOrNull('competency_id', row.competencyId), textOrNull('based_on', row.basedOn),
      text('made_at', row.madeAt), textOrNull('shown_at', row.shownAt), textOrNull('answer', row.answer), textOrNull('answered_at', row.answeredAt),
      bool('spoken', row.spoken), text('model_id', row.modelId), text('prompt_version', row.promptVersion), textOrNull('dropped', row.dropped),
    ]));
    if (!out) throw new Error('suggestion not stored');
    return out;
  }

  async markShown(interviewId: string, id: string, at: string): Promise<SuggestionRecord | null> {
    return first(await this.exec(MARK_SHOWN_SQL, [text('interview_id', interviewId), text('id', id), text('at', at)]));
  }

  async answerSuggestion(interviewId: string, id: string, answer: SuggestionAnswer, at: string): Promise<WriteResult<SuggestionRecord>> {
    const row = first(await this.exec(ANSWER_SUGGESTION_SQL, [text('interview_id', interviewId), text('id', id), text('answer', answer), text('at', at)]));
    if (row) return { ok: true, row };
    const now = first(await this.exec(GET_SUGGESTION_SQL, [text('interview_id', interviewId), text('id', id)]));
    return now && now.dropped === null ? { ok: false, reason: 'stale', row: now } : { ok: false, reason: 'not-found' };
  }

  async markSpoken(interviewId: string, id: string): Promise<SuggestionRecord | null> {
    return first(await this.exec(MARK_SPOKEN_SQL, [text('interview_id', interviewId), text('id', id)]));
  }

  async eraseSuggestions(interviewIds: readonly string[]): Promise<number> {
    // Interview ids carry no comma (lib/interviews/spend.ts's id rule); anything else names no interview.
    const ids = interviewIds.filter((id) => /^[A-Za-z0-9._-]+$/.test(id));
    if (!ids.length) return 0;
    const rows = await this.exec(ERASE_SUGGESTIONS_SQL, [text('interview_ids', ids.join(','))]);
    return rows.length;
  }
}

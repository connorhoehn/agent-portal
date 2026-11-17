// The run log's SQL store (schema/interviews_schema.sql `interview_runs`), over the RDS Data API's `exec` shape,
// injected as lib/interviews/coach/store-sql.ts injects it so the contract test runs the statements against canned rows.
// Timestamps travel as ISO text, CAST in the statement; the files, the source, the result and the events as JSON text,
// CAST to JSONB.
//
// The statements only do what store.ts says: an INSERT that does nothing on a repeat (ON CONFLICT DO NOTHING, then the
// first row is read), events appended only while there is no result, a status move only while there is no result, a
// finish only WHERE result IS NULL, and the retention DELETE by interview.
import type { SqlParameter } from '@aws-sdk/client-rds-data';
import { isoOf, type SqlExec } from '../store-sql.js';
import type { RunLanguage, RunResult, RunStatus } from './executor.js';
import type { InsertResult, RunRecord, RunSide, RunStore, StoredRunEvent } from './store.js';

const COLUMNS = `interview_id, run_id, language, entrypoint, files, source, stdin, started_by_id, started_by_name, started_by_side, status,
  queued_at, started_at, ended_at, result, events, hold_id, spend_source_id`;

export const GET_RUN_SQL = `SELECT ${COLUMNS} FROM interview_runs WHERE interview_id = :interview_id AND run_id = :run_id`;
export const LIST_RUNS_SQL = `SELECT ${COLUMNS} FROM interview_runs WHERE interview_id = :interview_id ORDER BY queued_at, run_id`;
export const COUNT_RUNS_SQL = 'SELECT COUNT(*) AS n FROM interview_runs WHERE interview_id = :interview_id';
export const INSERT_RUN_SQL = `INSERT INTO interview_runs (interview_id, run_id, language, entrypoint, files, source, stdin, started_by_id,
    started_by_name, started_by_side, status, queued_at, started_at, ended_at, result, events, hold_id, spend_source_id)
  VALUES (:interview_id, :run_id, :language, :entrypoint, CAST(:files AS JSONB), CAST(:source AS JSONB), :stdin, :started_by_id,
    :started_by_name, :started_by_side, :status, CAST(:queued_at AS TIMESTAMPTZ), NULL, NULL, NULL, CAST(:events AS JSONB), :hold_id, :spend_source_id)
  ON CONFLICT (interview_id, run_id) DO NOTHING
  RETURNING ${COLUMNS}`;
export const APPEND_EVENTS_SQL = `UPDATE interview_runs SET events = events || CAST(:events AS JSONB)
  WHERE interview_id = :interview_id AND run_id = :run_id AND result IS NULL`;
export const SET_STATUS_SQL = `UPDATE interview_runs SET status = :status, started_at = COALESCE(started_at, CAST(:at AS TIMESTAMPTZ))
  WHERE interview_id = :interview_id AND run_id = :run_id AND result IS NULL
  RETURNING ${COLUMNS}`;
export const FINISH_RUN_SQL = `UPDATE interview_runs SET status = :status, result = CAST(:result AS JSONB), ended_at = CAST(:ended_at AS TIMESTAMPTZ),
    events = events || CAST(:events AS JSONB)
  WHERE interview_id = :interview_id AND run_id = :run_id AND result IS NULL
  RETURNING ${COLUMNS}`;
export const LIST_UNFINISHED_SQL = `SELECT ${COLUMNS} FROM interview_runs WHERE result IS NULL ORDER BY queued_at, run_id`;
export const ERASE_RUNS_SQL = `DELETE FROM interview_runs WHERE interview_id = ANY(string_to_array(:interview_ids, ',')) RETURNING run_id`;

export const RUN_STATEMENTS = [GET_RUN_SQL, LIST_RUNS_SQL, COUNT_RUNS_SQL, INSERT_RUN_SQL, APPEND_EVENTS_SQL, SET_STATUS_SQL, FINISH_RUN_SQL, LIST_UNFINISHED_SQL, ERASE_RUNS_SQL] as const;

const text = (name: string, value: string): SqlParameter => ({ name, value: { stringValue: value } });
const textOrNull = (name: string, value: string | null): SqlParameter => (value === null ? { name, value: { isNull: true } } : text(name, value));
const json = (name: string, value: unknown): SqlParameter => text(name, JSON.stringify(value));
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const isoOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : isoOf(v));
function parsed<T>(v: unknown, fallback: T): T {
  if (v === null || v === undefined) return fallback;
  if (typeof v !== 'string') return v as T;
  try { return JSON.parse(v) as T; } catch { return fallback; }
}

export function runFromRow(r: Record<string, unknown>): RunRecord {
  return {
    interviewId: String(r['interview_id']), runId: String(r['run_id']), language: String(r['language']) as RunLanguage,
    entrypoint: String(r['entrypoint']), files: parsed(r['files'], []), source: parsed(r['source'], []), stdin: strOrNull(r['stdin']),
    startedBy: { id: String(r['started_by_id']), name: String(r['started_by_name']), side: String(r['started_by_side']) as RunSide },
    status: String(r['status']) as RunStatus, queuedAt: isoOf(r['queued_at']), startedAt: isoOrNull(r['started_at']), endedAt: isoOrNull(r['ended_at']),
    result: parsed<RunResult | null>(r['result'], null), events: parsed<StoredRunEvent[]>(r['events'], []),
    holdId: strOrNull(r['hold_id']), spendSourceId: strOrNull(r['spend_source_id']),
  };
}

const first = (rows: Record<string, unknown>[]): RunRecord | null => (rows[0] ? runFromRow(rows[0]) : null);
const key = (interviewId: string, runId: string): SqlParameter[] => [text('interview_id', interviewId), text('run_id', runId)];

export class SqlRunStore implements RunStore {
  constructor(private readonly exec: SqlExec) {}

  async getRun(interviewId: string, runId: string): Promise<RunRecord | null> {
    return first(await this.exec(GET_RUN_SQL, key(interviewId, runId)));
  }

  async listRuns(interviewId: string): Promise<RunRecord[]> {
    return (await this.exec(LIST_RUNS_SQL, [text('interview_id', interviewId)])).map(runFromRow);
  }

  async countRuns(interviewId: string): Promise<number> {
    const rows = await this.exec(COUNT_RUNS_SQL, [text('interview_id', interviewId)]);
    return Number(rows[0]?.['n'] ?? 0);
  }

  async insertRun(row: RunRecord): Promise<InsertResult> {
    const out = first(await this.exec(INSERT_RUN_SQL, [
      ...key(row.interviewId, row.runId), text('language', row.language), text('entrypoint', row.entrypoint),
      json('files', row.files), json('source', row.source), textOrNull('stdin', row.stdin),
      text('started_by_id', row.startedBy.id), text('started_by_name', row.startedBy.name), text('started_by_side', row.startedBy.side),
      text('status', row.status), text('queued_at', row.queuedAt), json('events', row.events),
      textOrNull('hold_id', row.holdId), textOrNull('spend_source_id', row.spendSourceId),
    ]));
    if (out) return { ok: true, row: out };
    const had = await this.getRun(row.interviewId, row.runId);
    if (!had) throw new Error('run not stored');
    return { ok: false, reason: 'exists', row: had };
  }

  async appendEvents(interviewId: string, runId: string, events: readonly StoredRunEvent[]): Promise<void> {
    if (!events.length) return;
    await this.exec(APPEND_EVENTS_SQL, [...key(interviewId, runId), json('events', events)]);
  }

  async setStatus(interviewId: string, runId: string, status: 'compiling' | 'running', at: string): Promise<RunRecord | null> {
    return first(await this.exec(SET_STATUS_SQL, [...key(interviewId, runId), text('status', status), text('at', at)]));
  }

  async finishRun(interviewId: string, runId: string, result: RunResult, endedAt: string, events: readonly StoredRunEvent[]): Promise<RunRecord | null> {
    return first(await this.exec(FINISH_RUN_SQL, [
      ...key(interviewId, runId), text('status', result.status), json('result', result), text('ended_at', endedAt), json('events', events),
    ]));
  }

  async listUnfinished(): Promise<RunRecord[]> {
    return (await this.exec(LIST_UNFINISHED_SQL, [])).map(runFromRow);
  }

  async eraseRuns(interviewIds: readonly string[]): Promise<number> {
    // Interview ids carry no comma (lib/interviews/spend.ts's id rule); anything else names no interview.
    const ids = interviewIds.filter((id) => /^[A-Za-z0-9._-]+$/.test(id));
    if (!ids.length) return 0;
    return (await this.exec(ERASE_RUNS_SQL, [text('interview_ids', ids.join(','))])).length;
  }
}

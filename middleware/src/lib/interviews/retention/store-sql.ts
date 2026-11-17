// The deletion log's SQL store (schema/interviews_schema.sql `interview_deletions`), over the RDS Data API's `exec`
// shape, injected as lib/interviews/consent/store-sql.ts injects it so the contract test runs the statements against
// canned rows. Timestamps travel as ISO text, CAST in the statement; the lists travel as JSON text.
import type { SqlParameter } from '@aws-sdk/client-rds-data';
import { isoOf, type SqlExec } from '../store-sql.js';
import type { WriteResult } from '../store.js';
import { coverageOf, type DeletionReason, type DeletionRow, type DeletionStore, type DeletionUpdate, type LeftItem, type NewDeletion, type RemovedCount } from './store.js';

const COLUMNS = 'id, candidate_id, interview_ids, reason, requested_at, requested_by, due_by, done_at, removed, left_behind, attempts, revision';

export const INSERT_DELETION_SQL = `INSERT INTO interview_deletions (id, candidate_id, interview_ids, reason, requested_at, requested_by, due_by,
    done_at, removed, left_behind, attempts, revision)
  VALUES (:id, :candidate_id, CAST(:interview_ids AS JSONB), :reason, CAST(:requested_at AS TIMESTAMPTZ), :requested_by,
    CAST(:due_by AS TIMESTAMPTZ), CAST(:done_at AS TIMESTAMPTZ), CAST(:removed AS JSONB), CAST(:left_behind AS JSONB), :attempts, 1)
  RETURNING ${COLUMNS}`;
export const UPDATE_DELETION_SQL = `UPDATE interview_deletions
  SET done_at = CAST(:done_at AS TIMESTAMPTZ), removed = CAST(:removed AS JSONB), left_behind = CAST(:left_behind AS JSONB),
    attempts = :attempts, revision = revision + 1
  WHERE id = :id AND revision = :revision
  RETURNING ${COLUMNS}`;
export const GET_DELETION_SQL = `SELECT ${COLUMNS} FROM interview_deletions WHERE id = :id`;
export const CANDIDATE_DELETIONS_SQL = `SELECT ${COLUMNS} FROM interview_deletions WHERE candidate_id = :candidate_id
  ORDER BY requested_at DESC, id DESC`;
export const OPEN_DELETIONS_SQL = `SELECT ${COLUMNS} FROM interview_deletions WHERE done_at IS NULL
  ORDER BY requested_at ASC, id ASC LIMIT :limit`;
export const COVERAGE_SQL = `SELECT interview_ids, requested_at FROM interview_deletions WHERE reason = ANY(string_to_array(:reasons, ','))`;

export const DELETION_STATEMENTS = [INSERT_DELETION_SQL, UPDATE_DELETION_SQL, GET_DELETION_SQL, CANDIDATE_DELETIONS_SQL, OPEN_DELETIONS_SQL, COVERAGE_SQL] as const;

const text = (name: string, value: string | null): SqlParameter => (value === null ? { name, value: { isNull: true } } : { name, value: { stringValue: value } });
const int = (name: string, value: number): SqlParameter => ({ name, value: { longValue: value } });

function jsonList<T>(v: unknown): T[] {
  if (Array.isArray(v)) return v as T[];
  if (typeof v === 'string' && v) { try { const p = JSON.parse(v) as unknown; return Array.isArray(p) ? p as T[] : []; } catch { return []; } }
  return [];
}
const isoOrNull = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : isoOf(v));

export function deletionFromRow(r: Record<string, unknown>): DeletionRow {
  return {
    id: String(r['id']), candidateId: String(r['candidate_id']), interviewIds: jsonList<string>(r['interview_ids']),
    reason: String(r['reason']) as DeletionReason, requestedAt: isoOf(r['requested_at']),
    requestedBy: r['requested_by'] === null || r['requested_by'] === undefined ? null : String(r['requested_by']),
    dueBy: isoOf(r['due_by']), doneAt: isoOrNull(r['done_at']),
    removed: jsonList<RemovedCount>(r['removed']), left: jsonList<LeftItem>(r['left_behind']),
    attempts: Number(r['attempts'] ?? 1), revision: Number(r['revision'] ?? 1),
  };
}

export class SqlDeletionStore implements DeletionStore {
  constructor(private readonly exec: SqlExec) {}

  async insert(row: NewDeletion): Promise<DeletionRow> {
    const rows = await this.exec(INSERT_DELETION_SQL, [
      text('id', row.id), text('candidate_id', row.candidateId), text('interview_ids', JSON.stringify(row.interviewIds)),
      text('reason', row.reason), text('requested_at', row.requestedAt), text('requested_by', row.requestedBy),
      text('due_by', row.dueBy), text('done_at', row.doneAt), text('removed', JSON.stringify(row.removed)),
      text('left_behind', JSON.stringify(row.left)), int('attempts', row.attempts),
    ]);
    if (!rows[0]) throw new Error('The deletion log did not take the row.');
    return deletionFromRow(rows[0]);
  }

  async update(id: string, change: DeletionUpdate, revision: number): Promise<WriteResult<DeletionRow>> {
    const rows = await this.exec(UPDATE_DELETION_SQL, [
      text('id', id), text('done_at', change.doneAt), text('removed', JSON.stringify(change.removed)),
      text('left_behind', JSON.stringify(change.left)), int('attempts', change.attempts), int('revision', revision),
    ]);
    if (rows[0]) return { ok: true, row: deletionFromRow(rows[0]) };
    const now = (await this.exec(GET_DELETION_SQL, [text('id', id)]))[0];
    return now ? { ok: false, reason: 'stale', row: deletionFromRow(now) } : { ok: false, reason: 'not-found' };
  }

  async forCandidate(candidateId: string): Promise<DeletionRow[]> {
    return (await this.exec(CANDIDATE_DELETIONS_SQL, [text('candidate_id', candidateId)])).map(deletionFromRow);
  }

  async open(limit: number): Promise<DeletionRow[]> {
    return (await this.exec(OPEN_DELETIONS_SQL, [int('limit', limit)])).map(deletionFromRow);
  }

  async coverage(reasons: readonly DeletionReason[]): Promise<Map<string, string>> {
    const rows = await this.exec(COVERAGE_SQL, [text('reasons', reasons.join(','))]);
    return coverageOf(rows.map((r) => ({ interviewIds: jsonList<string>(r['interview_ids']), requestedAt: isoOf(r['requested_at']) })));
  }
}

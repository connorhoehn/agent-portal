// The résumé rows (row I1.6): the table `interview_resumes`, one current row per candidate, behind one
// interface with two implementations chosen as the interviews store is (store-select.ts): memory over the
// registered fixture `interviews.resumes` under the mock providers, SQL otherwise. One contract test runs
// over both (__tests__/row-store.test.ts).
//
// The candidate's pointer (`resumeFileId`, schema column `interview_candidates.resume_file_id`) is written
// here, not through InterviewsStore: the memory store changes the candidates fixture's row, the SQL store
// runs its own UPDATE. `replace` and `remove` return the row they took out, so the caller can remove its
// bytes afterwards; the order in service.ts keeps a failure from leaving a row with no bytes.
//
// SQL notes: the Data API's `:name` binding, timestamps as ISO text CAST in the statement. The three
// statements of a replace run one after another (delete, insert, point); a failure between them leaves the
// candidate with no résumé, never with a row whose file is gone, and the next upload repairs it.

import type { SqlParameter } from '@aws-sdk/client-rds-data';
import { config } from '../../../config.js';
import { interviewCandidatesFixture } from '../../../mock/interviews.js';
import { interviewResumesFixture } from '../../../mock/interviews-resumes.js';
import { RESUME_CONTENT_TYPE, type ResumeRecord } from './types.js';

export interface ResumeRowStore {
  /** The candidate's current résumé, or null. */
  get(candidateId: string): Promise<ResumeRecord | null>;
  /** Make `row` the candidate's current résumé and point the candidate at it. Answers the row it replaced, or null. */
  replace(row: ResumeRecord): Promise<ResumeRecord | null>;
  /** Remove the candidate's résumé row and clear the pointer. Answers the row removed, or null. */
  remove(candidateId: string): Promise<ResumeRecord | null>;
}

export class MemoryResumeRows implements ResumeRowStore {
  async get(candidateId: string): Promise<ResumeRecord | null> {
    const row = interviewResumesFixture.rows().find((r) => r.candidateId === candidateId);
    return row ? structuredClone(row) : null;
  }

  async replace(row: ResumeRecord): Promise<ResumeRecord | null> {
    const rows = interviewResumesFixture.rows();
    const at = rows.findIndex((r) => r.candidateId === row.candidateId);
    const previous = at >= 0 ? rows.splice(at, 1)[0]! : null;
    rows.push(structuredClone(row));
    this.point(row.candidateId, row.id);
    return previous ? structuredClone(previous) : null;
  }

  async remove(candidateId: string): Promise<ResumeRecord | null> {
    const rows = interviewResumesFixture.rows();
    const at = rows.findIndex((r) => r.candidateId === candidateId);
    if (at < 0) { this.point(candidateId, null); return null; }
    const [gone] = rows.splice(at, 1);
    this.point(candidateId, null);
    return structuredClone(gone!);
  }

  private point(candidateId: string, fileId: string | null): void {
    const c = interviewCandidatesFixture.rows().find((x) => x.id === candidateId);
    if (c) c.resumeFileId = fileId;
  }
}

// ── SQL ─────────────────────────────────────────────────────────────────────
const COLUMNS = 'id, candidate_id, file_name, size_bytes, content_type, sha256, uploaded_by, uploaded_at, storage_key';
export const GET_RESUME_SQL = `SELECT ${COLUMNS}
  FROM interview_resumes WHERE candidate_id = :candidate_id`;
export const DELETE_RESUME_SQL = `DELETE FROM interview_resumes WHERE candidate_id = :candidate_id
  RETURNING ${COLUMNS}`;
export const INSERT_RESUME_SQL = `INSERT INTO interview_resumes (${COLUMNS})
  VALUES (:id, :candidate_id, :file_name, :size_bytes, :content_type, :sha256, :uploaded_by, CAST(:uploaded_at AS TIMESTAMPTZ), :storage_key)
  RETURNING ${COLUMNS}`;
export const POINT_CANDIDATE_SQL = `UPDATE interview_candidates SET resume_file_id = :resume_file_id WHERE id = :id`;
export const RESUME_STATEMENTS = [GET_RESUME_SQL, DELETE_RESUME_SQL, INSERT_RESUME_SQL] as const;

export type ResumeSqlExec = (sql: string, params?: SqlParameter[]) => Promise<Record<string, unknown>[]>;

const text = (name: string, value: string | null): SqlParameter => (value === null ? { name, value: { isNull: true } } : { name, value: { stringValue: value } });

const str = (v: unknown): string => (v == null ? '' : String(v));
const isoOf = (v: unknown): string => {
  const s = str(v);
  const d = new Date(/[zZ]|[+-]\d\d(:?\d\d)?$/.test(s) ? s : `${s.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? s : d.toISOString();
};

export function resumeFromRow(r: Record<string, unknown>): ResumeRecord {
  return {
    id: str(r['id']), candidateId: str(r['candidate_id']), fileName: str(r['file_name']), sizeBytes: Number(r['size_bytes']),
    contentType: RESUME_CONTENT_TYPE, sha256: str(r['sha256']), uploadedBy: str(r['uploaded_by']), uploadedAt: isoOf(r['uploaded_at']),
    storageKey: str(r['storage_key']),
  };
}

export class SqlResumeRows implements ResumeRowStore {
  constructor(private readonly exec: ResumeSqlExec) {}

  async get(candidateId: string): Promise<ResumeRecord | null> {
    const rows = await this.exec(GET_RESUME_SQL, [text('candidate_id', candidateId)]);
    return rows[0] ? resumeFromRow(rows[0]) : null;
  }

  async replace(row: ResumeRecord): Promise<ResumeRecord | null> {
    const gone = await this.exec(DELETE_RESUME_SQL, [text('candidate_id', row.candidateId)]);
    await this.exec(INSERT_RESUME_SQL, [
      text('id', row.id), text('candidate_id', row.candidateId), text('file_name', row.fileName),
      { name: 'size_bytes', value: { longValue: row.sizeBytes } }, text('content_type', row.contentType), text('sha256', row.sha256),
      text('uploaded_by', row.uploadedBy), text('uploaded_at', row.uploadedAt), text('storage_key', row.storageKey),
    ]);
    await this.exec(POINT_CANDIDATE_SQL, [text('id', row.candidateId), text('resume_file_id', row.id)]);
    return gone[0] ? resumeFromRow(gone[0]) : null;
  }

  async remove(candidateId: string): Promise<ResumeRecord | null> {
    const gone = await this.exec(DELETE_RESUME_SQL, [text('candidate_id', candidateId)]);
    await this.exec(POINT_CANDIDATE_SQL, [text('id', candidateId), text('resume_file_id', null)]);
    return gone[0] ? resumeFromRow(gone[0]) : null;
  }
}

export function createResumeRows(): ResumeRowStore {
  if (config.mock?.aurora) return new MemoryResumeRows();
  return new SqlResumeRows(async (sql, params) => (await import('../../../providers/aurora.js')).exec(sql, params));
}

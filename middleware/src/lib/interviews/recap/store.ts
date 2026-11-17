// Milo's recap and who opened it (docs/interviews-tenant-plan.md decision 14, "The model": Recap; row I5.2; contract E3).
//
// Two records, both written once and kept:
//   the recap   one per interview: what Milo wrote (evidence per competency with its sources, what was not covered), when,
//               with which model and prompt version, after how many attempts, and the codes of the attempts dropped by
//               code (their text is never kept). `failed` when every attempt was used without one: the readers' "none".
//   the opens   one per (interview, interviewer): the ratings as they stood when that person opened the recap, and when.
//               The first open wins; a repeat stores nothing. The scorecard's `changedAfterRecap` compares against it.
// Rows leave only through `eraseRecaps` (retention, E7), which removes both.
//
// Two implementations behind one interface, chosen as the coach's store chooses: the memory store over the registered
// fixtures (mock/interviews-recaps.ts) under the mock providers, the SQL store (store-sql.ts, schema/interviews_schema.sql
// `interview_recaps` and `interview_recap_opens`) otherwise. __tests__/store.test.ts runs one contract over both.
import { config } from '../../../config.js';
import { interviewRecapOpensFixture, interviewRecapsFixture } from '../../../mock/interviews-recaps.js';
import type { RecapContent } from './parse.js';
import { SqlRecapStore } from './store-sql.js';

/** Why an attempt left no recap: parse.ts's codes or a failed call. */
export type RecapAttemptCode = 'malformed' | 'judges' | 'personal' | 'timeout' | 'error';

export interface RecapRecord {
  interviewId: string;
  state: 'ready' | 'failed';
  /** Empty (no competencies, nothing listed) on a failed row. */
  content: RecapContent;
  writtenAt: string;
  modelId: string;
  promptVersion: string;
  /** Attempts made, 1 to 3, including the one that wrote it. */
  attempts: number;
  /** One code per attempt dropped before this row was written, in order. */
  droppedCodes: RecapAttemptCode[];
  /** Statements dropped from the kept attempt for having no source in the transcript (or touching a personal trait). */
  droppedClaims: number;
}

export interface OpenRating { competencyId: string; rating: 1 | 2 | 3 | 4 }
export interface RecapOpen { interviewId: string; interviewerId: string; ratings: OpenRating[]; openedAt: string }

export interface RecapStore {
  getRecap(interviewId: string): Promise<RecapRecord | null>;
  /** Write the recap unless one is there; the row as it now is, and whether this call wrote it. */
  putRecap(row: RecapRecord): Promise<{ row: RecapRecord; created: boolean }>;
  getOpen(interviewId: string, interviewerId: string): Promise<RecapOpen | null>;
  /** Everyone's opens of this interview's recap, oldest first. */
  listOpens(interviewId: string): Promise<RecapOpen[]>;
  /** Store the open unless this person's is there; the row as it now is, and whether this call wrote it. */
  putOpen(row: RecapOpen): Promise<{ row: RecapOpen; created: boolean }>;
  /** Remove these interviews' recaps and opens; how many rows went. */
  eraseRecaps(interviewIds: readonly string[]): Promise<number>;
}

const copy = <T>(row: T): T => structuredClone(row);

export class MemoryRecapStore implements RecapStore {
  async getRecap(interviewId: string): Promise<RecapRecord | null> {
    const row = interviewRecapsFixture.rows().find((r) => r.interviewId === interviewId);
    return row ? copy(row) : null;
  }

  async putRecap(row: RecapRecord): Promise<{ row: RecapRecord; created: boolean }> {
    const rows = interviewRecapsFixture.rows();
    const was = rows.find((r) => r.interviewId === row.interviewId);
    if (was) return { row: copy(was), created: false };
    rows.push(copy(row));
    return { row: copy(row), created: true };
  }

  async getOpen(interviewId: string, interviewerId: string): Promise<RecapOpen | null> {
    const row = interviewRecapOpensFixture.rows().find((r) => r.interviewId === interviewId && r.interviewerId === interviewerId);
    return row ? copy(row) : null;
  }

  async listOpens(interviewId: string): Promise<RecapOpen[]> {
    return interviewRecapOpensFixture.rows().filter((r) => r.interviewId === interviewId)
      .sort((a, b) => a.openedAt.localeCompare(b.openedAt) || a.interviewerId.localeCompare(b.interviewerId)).map(copy);
  }

  async putOpen(row: RecapOpen): Promise<{ row: RecapOpen; created: boolean }> {
    const rows = interviewRecapOpensFixture.rows();
    const was = rows.find((r) => r.interviewId === row.interviewId && r.interviewerId === row.interviewerId);
    if (was) return { row: copy(was), created: false };
    rows.push(copy(row));
    return { row: copy(row), created: true };
  }

  async eraseRecaps(interviewIds: readonly string[]): Promise<number> {
    const ids = new Set(interviewIds);
    let gone = 0;
    for (const rows of [interviewRecapsFixture.rows(), interviewRecapOpensFixture.rows()] as Array<Array<{ interviewId: string }>>) {
      const keep = rows.filter((r) => !ids.has(r.interviewId));
      gone += rows.length - keep.length;
      rows.splice(0, rows.length, ...keep);
    }
    return gone;
  }
}

let current: RecapStore | null = null;

export function createRecapStore(): RecapStore {
  if (config.mock?.aurora) return new MemoryRecapStore();
  return new SqlRecapStore(async (sql, params) => (await import('../../../providers/aurora.js')).exec(sql, params));
}

export function recapStore(): RecapStore { return (current ??= createRecapStore()); }
export function setRecapStore(next: RecapStore | null): void { current = next; }

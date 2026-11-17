// The deletion log (docs/interviews-tenant-plan.md "The model", decision 17, row I6.3): one row per deletion, whether a
// candidate asked for it or a period ran out.
//
// Two implementations behind one interface, chosen as lib/interviews/consent/store.ts chooses: the memory store over
// the registered fixture (mock/interviews-deletions.ts) under the mock providers, the SQL store (store-sql.ts,
// schema/interviews_schema.sql `interview_deletions`) otherwise. __tests__/store.test.ts runs one contract over both.
//
// A row says what was removed (kinds and counts, never content), for which candidate and interviews, when it was
// asked and by whom (a person's id, or null for a sweep), by when it is due, when it was done, and what is left and
// why. It never holds a name, an address or a file name. A row with something left to retry stays open (`doneAt`
// null) and the next sweep takes it up; its update names the revision it read (409-style `stale` when another run
// got there first).

import { config } from '../../../config.js';
import { interviewDeletionsFixture } from '../../../mock/interviews-deletions.js';
import type { WriteResult } from '../store.js';
import { SqlDeletionStore } from './store-sql.js';

export type DeletionReason = 'request' | 'media-period' | 'record-period';
export const DELETION_REASONS: readonly DeletionReason[] = ['request', 'media-period', 'record-period'];

export interface RemovedCount { kind: string; count: number }
/**
 * Something not removed. `why`: `pending` (not tried yet: a run that stopped part way), `failed` (an error; retried), `call-running` (retried), `no-service` (there was
 * nothing to call here; not retried).
 */
export interface LeftItem { kind: string; why: 'pending' | 'failed' | 'call-running' | 'no-service'; retry: boolean }

export interface DeletionRow {
  id: string;
  candidateId: string;
  interviewIds: string[];
  reason: DeletionReason;
  requestedAt: string;
  /** The person who asked; null for a sweep. */
  requestedBy: string | null;
  dueBy: string;
  doneAt: string | null;
  removed: RemovedCount[];
  left: LeftItem[];
  /** How many runs have worked on it. */
  attempts: number;
  revision: number;
}

export type NewDeletion = Omit<DeletionRow, 'revision'>;
export type DeletionUpdate = Pick<DeletionRow, 'doneAt' | 'removed' | 'left' | 'attempts'>;

export interface DeletionStore {
  insert(row: NewDeletion): Promise<DeletionRow>;
  /** Save a run's result against the revision it read. */
  update(id: string, change: DeletionUpdate, revision: number): Promise<WriteResult<DeletionRow>>;
  /** A candidate's rows, newest first. */
  forCandidate(candidateId: string): Promise<DeletionRow[]>;
  /** Rows with something left to retry, oldest first, at most `limit`. */
  open(limit: number): Promise<DeletionRow[]>;
  /** For every interview named by a row of these reasons: the latest `requestedAt` of such a row (ISO). */
  coverage(reasons: readonly DeletionReason[]): Promise<Map<string, string>>;
}

const copy = <T>(row: T): T => structuredClone(row);
const newestFirst = (a: DeletionRow, b: DeletionRow) => b.requestedAt.localeCompare(a.requestedAt) || b.id.localeCompare(a.id);

export class MemoryDeletionStore implements DeletionStore {
  private rows(): DeletionRow[] { return interviewDeletionsFixture.rows(); }

  async insert(row: NewDeletion): Promise<DeletionRow> {
    const stored: DeletionRow = { ...copy(row), revision: 1 };
    this.rows().push(stored);
    return copy(stored);
  }

  async update(id: string, change: DeletionUpdate, revision: number): Promise<WriteResult<DeletionRow>> {
    const current = this.rows().find((r) => r.id === id);
    if (!current) return { ok: false, reason: 'not-found' };
    if (current.revision !== revision) return { ok: false, reason: 'stale', row: copy(current) };
    Object.assign(current, copy(change), { revision: current.revision + 1 });
    return { ok: true, row: copy(current) };
  }

  async forCandidate(candidateId: string): Promise<DeletionRow[]> {
    return this.rows().filter((r) => r.candidateId === candidateId).sort(newestFirst).map(copy);
  }

  async open(limit: number): Promise<DeletionRow[]> {
    return this.rows().filter((r) => r.doneAt === null).sort((a, b) => -newestFirst(a, b)).slice(0, limit).map(copy);
  }

  async coverage(reasons: readonly DeletionReason[]): Promise<Map<string, string>> {
    return coverageOf(this.rows().filter((r) => reasons.includes(r.reason)));
  }
}

export function coverageOf(rows: readonly Pick<DeletionRow, 'interviewIds' | 'requestedAt'>[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of rows) for (const id of r.interviewIds) if ((out.get(id) ?? '') < r.requestedAt) out.set(id, r.requestedAt);
  return out;
}

let current: DeletionStore | null = null;

export function createDeletionStore(): DeletionStore {
  if (config.mock?.aurora) return new MemoryDeletionStore();
  // Loaded on first use so a mock process never pulls in the AWS client.
  return new SqlDeletionStore(async (sql, params) => (await import('../../../providers/aurora.js')).exec(sql, params));
}

export function deletionStore(): DeletionStore { return (current ??= createDeletionStore()); }
export function setDeletionStore(next: DeletionStore | null): void { current = next; }

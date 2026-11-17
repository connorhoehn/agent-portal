// The two deletion-log stores behave the same (lib/interviews/retention/store.ts, store-sql.ts; row I6.3), and every
// statement names only columns schema/interviews_schema.sql declares.
jest.mock('../../../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SqlParameter } from '@aws-sdk/client-rds-data';
import { MemoryDeletionStore, type DeletionStore, type NewDeletion } from '../store.js';
import {
  CANDIDATE_DELETIONS_SQL, COVERAGE_SQL, DELETION_STATEMENTS, GET_DELETION_SQL, INSERT_DELETION_SQL, OPEN_DELETIONS_SQL, SqlDeletionStore, UPDATE_DELETION_SQL,
} from '../store-sql.js';
import type { SqlExec } from '../../store-sql.js';
import { fixtureRegistry } from '../../../../mock/core/index.js';

type P = { stringValue?: string; longValue?: number; isNull?: boolean };
const param = (params: SqlParameter[] | undefined, name: string): P => (params?.find((x) => x.name === name)?.value ?? {}) as P;
const ts = (iso: string | null) => (iso === null ? null : iso.replace('T', ' ').replace('Z', ''));

/** interview_deletions as the Data API keeps and answers it (timestamps as text without the T, JSON as text). */
function deletionsTableExec(): SqlExec {
  const table: Record<string, unknown>[] = [];
  const out = (rows: Record<string, unknown>[]) => rows.map((r) => ({ ...r }));
  return async (sql, params) => {
    const s = (n: string) => (param(params, n).isNull ? null : String(param(params, n).stringValue ?? ''));
    const i = (n: string) => Number(param(params, n).longValue);
    if (sql === INSERT_DELETION_SQL) {
      const row = {
        id: s('id'), candidate_id: s('candidate_id'), interview_ids: s('interview_ids'), reason: s('reason'), requested_at: ts(s('requested_at')),
        requested_by: s('requested_by'), due_by: ts(s('due_by')), done_at: ts(s('done_at')), removed: s('removed'), left_behind: s('left_behind'),
        attempts: i('attempts'), revision: 1,
      };
      table.push(row);
      return out([row]);
    }
    if (sql === UPDATE_DELETION_SQL) {
      const row = table.find((r) => r['id'] === s('id') && r['revision'] === i('revision'));
      if (!row) return [];
      Object.assign(row, { done_at: ts(s('done_at')), removed: s('removed'), left_behind: s('left_behind'), attempts: i('attempts'), revision: Number(row['revision']) + 1 });
      return out([row]);
    }
    if (sql === GET_DELETION_SQL) return out(table.filter((r) => r['id'] === s('id')));
    if (sql === CANDIDATE_DELETIONS_SQL) {
      return out(table.filter((r) => r['candidate_id'] === s('candidate_id'))
        .sort((a, b) => String(b['requested_at']).localeCompare(String(a['requested_at'])) || String(b['id']).localeCompare(String(a['id']))));
    }
    if (sql === OPEN_DELETIONS_SQL) {
      return out(table.filter((r) => r['done_at'] === null)
        .sort((a, b) => String(a['requested_at']).localeCompare(String(b['requested_at'])) || String(a['id']).localeCompare(String(b['id']))).slice(0, i('limit')));
    }
    if (sql === COVERAGE_SQL) {
      const reasons = String(s('reasons')).split(',');
      return out(table.filter((r) => reasons.includes(String(r['reason']))).map((r) => ({ interview_ids: r['interview_ids'], requested_at: r['requested_at'] })));
    }
    throw new Error(`unexpected statement: ${sql.slice(0, 60)}`);
  };
}

const row = (id: string, over: Partial<NewDeletion> = {}): NewDeletion => ({
  id, candidateId: 'cand-a', interviewIds: ['iv-1', 'iv-2'], reason: 'request', requestedAt: '2026-11-16T09:00:00.000Z', requestedBy: 'u-greta',
  dueBy: '2026-12-16T09:00:00.000Z', doneAt: null, removed: [], left: [{ kind: 'recording', why: 'pending', retry: true }], attempts: 0, ...over,
});

afterEach(() => fixtureRegistry.resetAll('default'));

describe.each([
  ['memory', () => new MemoryDeletionStore() as DeletionStore],
  ['sql', () => new SqlDeletionStore(deletionsTableExec()) as DeletionStore],
])('the %s deletion log', (_name, make) => {
  let store: DeletionStore;
  beforeEach(() => { store = make(); });

  it('inserts at revision 1 and reads a candidate\'s rows newest first', async () => {
    const a = await store.insert(row('del-a'));
    expect(a).toEqual({ ...row('del-a'), revision: 1 });
    await store.insert(row('del-b', { requestedAt: '2026-11-17T09:00:00.000Z' }));
    await store.insert(row('del-c', { candidateId: 'cand-other' }));
    expect((await store.forCandidate('cand-a')).map((r) => r.id)).toEqual(['del-b', 'del-a']);
  });

  it('saves a run against the revision it read and refuses a stale one with the row as it is', async () => {
    await store.insert(row('del-a'));
    const done = { doneAt: '2026-11-16T09:00:01.000Z', removed: [{ kind: 'resume', count: 1 }], left: [{ kind: 'recording', why: 'no-service' as const, retry: false }], attempts: 1 };
    const saved = await store.update('del-a', done, 1);
    expect(saved).toEqual({ ok: true, row: { ...row('del-a'), ...done, revision: 2 } });
    const stale = await store.update('del-a', { ...done, attempts: 9 }, 1);
    expect(stale.ok).toBe(false);
    expect(stale.ok === false && stale.reason === 'stale' && stale.row.attempts).toBe(1);
    expect(await store.update('del-missing', done, 1)).toEqual({ ok: false, reason: 'not-found' });
  });

  it('lists the open rows oldest first, bounded', async () => {
    await store.insert(row('del-new', { requestedAt: '2026-11-18T09:00:00.000Z' }));
    await store.insert(row('del-old', { requestedAt: '2026-11-10T09:00:00.000Z' }));
    await store.insert(row('del-done', { doneAt: '2026-11-11T09:00:00.000Z' }));
    expect((await store.open(10)).map((r) => r.id)).toEqual(['del-old', 'del-new']);
    expect((await store.open(1)).map((r) => r.id)).toEqual(['del-old']);
  });

  it('answers, per interview, the latest time a row of the given reasons named it', async () => {
    await store.insert(row('del-a', { reason: 'media-period', interviewIds: ['iv-1'], requestedAt: '2026-11-10T09:00:00.000Z' }));
    await store.insert(row('del-b', { reason: 'media-period', interviewIds: ['iv-1'], requestedAt: '2026-11-12T09:00:00.000Z' }));
    await store.insert(row('del-c', { reason: 'record-period', interviewIds: ['iv-2'] }));
    const media = await store.coverage(['media-period']);
    expect([...media]).toEqual([['iv-1', '2026-11-12T09:00:00.000Z']]);
    expect([...(await store.coverage(['media-period', 'record-period'])).keys()].sort()).toEqual(['iv-1', 'iv-2']);
  });
});

describe('every deletion statement matches schema/interviews_schema.sql', () => {
  const ddl = readFileSync(join(__dirname, '..', '..', '..', '..', '..', '..', 'schema', 'interviews_schema.sql'), 'utf8');
  const table = /CREATE TABLE IF NOT EXISTS interview_deletions \(([\s\S]*?)\n\);/.exec(ddl)?.[1] ?? '';
  const columns = new Set([...table.matchAll(/^\s+([a-z_]+)\s+[A-Z]/gm)].map((m) => m[1]));
  it('declares the table and every column a statement names', () => {
    expect(columns.size).toBe(12);
    for (const sql of DELETION_STATEMENTS) {
      const named = [...sql.replace(/:[a-z_]+/g, '').matchAll(/\b([a-z]+(?:_[a-z]+)+|reason|removed|attempts|revision)\b/g)].map((m) => m[1]!)
        .filter((w) => !['interview_deletions', 'string_to_array'].includes(w));
      for (const col of named) expect([col, columns.has(col)]).toEqual([col, true]);
    }
  });
});

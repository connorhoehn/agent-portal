// The two résumé row stores behave the same (row I1.6): one contract, run over the memory store (the registered
// fixture, the candidates fixture's pointer) and the SQL store (its real statements against a stateful stand-in for
// the table), then every statement is held to schema/interviews_schema.sql.
jest.mock('../../../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SqlParameter } from '@aws-sdk/client-rds-data';
import {
  DELETE_RESUME_SQL, GET_RESUME_SQL, INSERT_RESUME_SQL, MemoryResumeRows, POINT_CANDIDATE_SQL, RESUME_STATEMENTS, SqlResumeRows, type ResumeRowStore,
} from '../row-store.js';
import { interviewCandidatesFixture } from '../../../../mock/interviews.js';
import { interviewResumesFixture } from '../../../../mock/interviews-resumes.js';
import { fixtureRegistry } from '../../../../mock/core/index.js';
import { MemoryInterviewsStore } from '../../store.js';
import type { ResumeRecord } from '../types.js';

const ts = (iso: string) => iso.replace('T', ' ').replace('Z', '');

/** A Data API over a stateful interview_resumes table (seeded from the fixture) and the candidates' pointer column. */
function tableExec(pointers: Map<string, string | null>) {
  const table: Record<string, unknown>[] = interviewResumesFixture.rows().map((r) => ({
    id: r.id, candidate_id: r.candidateId, file_name: r.fileName, size_bytes: String(r.sizeBytes), content_type: r.contentType, sha256: r.sha256,
    uploaded_by: r.uploadedBy, uploaded_at: ts(r.uploadedAt), storage_key: r.storageKey,
  }));
  const seen: string[] = [];
  const exec = async (sql: string, params: SqlParameter[] = []) => {
    seen.push(sql);
    const b = new Map(params.map((p) => [p.name!, p.value!.isNull ? null : p.value!.stringValue ?? p.value!.longValue ?? null]));
    if (sql === GET_RESUME_SQL) return table.filter((r) => r['candidate_id'] === b.get('candidate_id'));
    if (sql === DELETE_RESUME_SQL) {
      const gone = table.filter((r) => r['candidate_id'] === b.get('candidate_id'));
      for (const g of gone) table.splice(table.indexOf(g), 1);
      return gone;
    }
    if (sql === INSERT_RESUME_SQL) {
      if (table.some((r) => r['candidate_id'] === b.get('candidate_id'))) throw new Error('duplicate key value violates unique constraint');
      const row = {
        id: b.get('id'), candidate_id: b.get('candidate_id'), file_name: b.get('file_name'), size_bytes: String(b.get('size_bytes')), content_type: b.get('content_type'),
        sha256: b.get('sha256'), uploaded_by: b.get('uploaded_by'), uploaded_at: ts(String(b.get('uploaded_at'))), storage_key: b.get('storage_key'),
      };
      table.push(row);
      return [row];
    }
    if (sql === POINT_CANDIDATE_SQL) { pointers.set(String(b.get('id')), b.get('resume_file_id') as string | null); return []; }
    throw new Error(`unexpected statement: ${sql}`);
  };
  return { exec, seen };
}

const NEW: ResumeRecord = {
  id: 'rf-new', candidateId: 'cand-rx6tcaqj', fileName: 'Mateo-new.pdf', sizeBytes: 1234, contentType: 'application/pdf', sha256: 'a'.repeat(64),
  uploadedBy: 'u-greta', uploadedAt: '2026-11-16T09:30:00.000Z', storageKey: 'interviews/resumes/cand-rx6tcaqj/rf-new.pdf',
};
const FIRST_TIME: ResumeRecord = { ...NEW, id: 'rf-9p2atayb', candidateId: 'cand-9p2atayb', fileName: 'Chloe.pdf', storageKey: 'interviews/resumes/cand-9p2atayb/rf-9p2atayb.pdf' };

/** What the candidate row points at, as each implementation keeps it. */
type Harness = { name: string; store: ResumeRowStore; pointer: (candidateId: string) => Promise<string | null> };
const harnesses: Array<[string, () => Harness]> = [
  ['memory', () => ({ name: 'memory', store: new MemoryResumeRows(), pointer: async (id) => (await new MemoryInterviewsStore().listCandidates()).find((c) => c.id === id)!.resumeFileId })],
  ['sql', () => {
    const pointers = new Map<string, string | null>(interviewCandidatesFixture.rows().map((c) => [c.id, c.resumeFileId]));
    return { name: 'sql', store: new SqlResumeRows(tableExec(pointers).exec), pointer: async (id) => pointers.get(id) ?? null };
  }],
];

beforeEach(() => fixtureRegistry.resetAll('default'));

describe.each(harnesses)('the %s résumé rows', (_name, make) => {
  let h: Harness;
  beforeEach(() => { h = make(); });

  it('reads the seeded résumé and nothing for a candidate with none', async () => {
    expect(await h.store.get('cand-rx6tcaqj')).toMatchObject({ id: 'rf-rx6tcaqj', candidateId: 'cand-rx6tcaqj', contentType: 'application/pdf', uploadedBy: 'u-greta' });
    expect(await h.store.get('cand-9p2atayb')).toBeNull();
    expect(await h.pointer('cand-rx6tcaqj')).toBe('rf-rx6tcaqj');
    expect(await h.pointer('cand-9p2atayb')).toBeNull();
  });

  it('a first résumé is written and the candidate points at it', async () => {
    expect(await h.store.replace(FIRST_TIME)).toBeNull();
    expect(await h.store.get('cand-9p2atayb')).toEqual(FIRST_TIME);
    expect(await h.pointer('cand-9p2atayb')).toBe('rf-9p2atayb');
  });

  it('a new one replaces the old: one row, the old row handed back, the pointer moved', async () => {
    const before = (await h.store.get('cand-rx6tcaqj'))!;
    expect(await h.store.replace(NEW)).toEqual(before);
    expect(await h.store.get('cand-rx6tcaqj')).toEqual(NEW);
    expect(await h.pointer('cand-rx6tcaqj')).toBe('rf-new');
  });

  it('removal hands the row back, clears the pointer, and a second removal finds nothing', async () => {
    const before = (await h.store.get('cand-qz63q3a3'))!;
    expect(await h.store.remove('cand-qz63q3a3')).toEqual(before);
    expect(await h.store.get('cand-qz63q3a3')).toBeNull();
    expect(await h.pointer('cand-qz63q3a3')).toBeNull();
    expect(await h.store.remove('cand-qz63q3a3')).toBeNull();
    expect(await h.store.get('cand-rx6tcaqj')).not.toBeNull();
  });
});

describe('the SQL store runs its statements in order', () => {
  it('replace deletes, inserts, then points; remove deletes then clears', async () => {
    const pointers = new Map<string, string | null>();
    const { exec, seen } = tableExec(pointers);
    const sql = new SqlResumeRows(exec);
    await sql.replace(NEW);
    expect(seen).toEqual([DELETE_RESUME_SQL, INSERT_RESUME_SQL, POINT_CANDIDATE_SQL]);
    seen.length = 0;
    await sql.remove('cand-rx6tcaqj');
    expect(seen).toEqual([DELETE_RESUME_SQL, POINT_CANDIDATE_SQL]);
  });
});

describe('every statement matches schema/interviews_schema.sql', () => {
  const ddl = readFileSync(join(__dirname, '..', '..', '..', '..', '..', '..', 'schema', 'interviews_schema.sql'), 'utf8');
  const block = /CREATE TABLE IF NOT EXISTS interview_resumes \(([\s\S]*?)\n\);/.exec(ddl)![1]!;
  const cols = new Set([...block.matchAll(/^\s{2}([a-z_0-9]+)\s+[A-Z]/gm)].map((m) => m[1]!));

  it('declares the table, one row per candidate', () => {
    expect(cols.size).toBe(9);
    expect(block).toMatch(/candidate_id\s+TEXT NOT NULL UNIQUE REFERENCES interview_candidates\(id\)/);
  });

  it.each(RESUME_STATEMENTS.map((s) => [s.split('\n')[0]!.slice(0, 50), s]))('%s… names only declared columns, and an insert names all', (_l, statement) => {
    const named = [
      ...(/INSERT INTO interview_resumes \(([^)]+)\)/.exec(statement)?.[1]?.split(',') ?? []),
      ...(/RETURNING ([\s\S]+)$/.exec(statement)?.[1]?.split(',') ?? []),
      ...(/SELECT ([\s\S]+?)\s+FROM/.exec(statement)?.[1]?.split(',') ?? []),
    ].map((c) => c.trim());
    expect(named.length).toBeGreaterThan(1);
    for (const c of named) expect([c, cols.has(c)]).toEqual([c, true]);
    if (statement.startsWith('INSERT')) expect(/INSERT INTO interview_resumes \(([^)]+)\)/.exec(statement)![1]!.split(',').map((c) => c.trim()).sort()).toEqual([...cols].sort());
  });

  it('the pointer statement writes the candidates\' declared column', () => {
    expect(POINT_CANDIDATE_SQL).toContain('interview_candidates SET resume_file_id');
    expect(/CREATE TABLE IF NOT EXISTS interview_candidates \(([\s\S]*?)\n\);/.exec(ddl)![1]).toMatch(/resume_file_id\s+TEXT/);
  });
});

// Hardening (H1, O-029): a replace that fails midway, through the service that orders the put, the swap and the drop.
describe('a replace that fails midway (the service\'s order: put the new bytes, swap the row, drop the old bytes)', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { setResumeStores, storeResume, readResume } = require('../service.js') as typeof import('../service.js');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { MemoryResumeBytes } = require('../bytes-store.js') as typeof import('../bytes-store.js');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { buildSimplePdf } = require('../../../../mock/interviews-resumes.js') as typeof import('../../../../mock/interviews-resumes.js');
  const NEWPDF = buildSimplePdf(['Replacement Person', 'Fictional headline', 'A line.']);
  const upload = { candidateId: 'cand-rx6tcaqj', bytes: NEWPDF, rawName: 'replacement.pdf', uploadedBy: 'u-greta' };
  let bytes: InstanceType<typeof MemoryResumeBytes>;
  let rows: ResumeRowStore;
  beforeEach(() => {
    fixtureRegistry.resetAll('default');
    bytes = new MemoryResumeBytes();
    rows = new MemoryResumeRows();
    setResumeStores({ rows, bytes });
  });
  afterAll(() => setResumeStores({ rows: null, bytes: null }));
  const seed = async () => { const old = (await rows.get('cand-rx6tcaqj'))!; await bytes.put(old.storageKey, Buffer.from('%PDF-1.4 old')); return old; };

  it('the new bytes cannot be put: nothing changes, the old row and bytes stand and the error reaches the caller', async () => {
    const old = await seed();
    jest.spyOn(bytes, 'put').mockRejectedValueOnce(new Error('bucket down'));
    await expect(storeResume(upload)).rejects.toThrow('bucket down');
    expect(await rows.get('cand-rx6tcaqj')).toEqual(old);
    expect((await readResume('cand-rx6tcaqj'))?.bytes.toString()).toBe('%PDF-1.4 old');
  });

  it('the row cannot be swapped: the new bytes are taken back out, the old row and bytes stand', async () => {
    const old = await seed();
    jest.spyOn(rows, 'replace').mockRejectedValueOnce(new Error('database down'));
    const removed: string[] = [];
    const realRemove = bytes.remove.bind(bytes);
    jest.spyOn(bytes, 'remove').mockImplementation(async (k: string) => { removed.push(k); return realRemove(k); });
    await expect(storeResume(upload)).rejects.toThrow('database down');
    expect(removed).toHaveLength(1);
    expect(removed[0]).not.toBe(old.storageKey);
    expect(await bytes.get(removed[0]!)).toBeNull();
    expect(await rows.get('cand-rx6tcaqj')).toEqual(old);
    expect((await readResume('cand-rx6tcaqj'))?.bytes.toString()).toBe('%PDF-1.4 old');
  });

  it('the old bytes cannot be dropped after the swap: the upload still succeeds, one orphan is left that no row points to, and nothing personal is logged', async () => {
    const old = await seed();
    jest.spyOn(bytes, 'remove').mockRejectedValueOnce(new Error('delete refused'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const out = await storeResume(upload);
    expect(out.ok).toBe(true);
    expect((await rows.get('cand-rx6tcaqj'))?.fileName).toBe('replacement.pdf');
    expect(await bytes.get(old.storageKey)).not.toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/mateo|replacement|delete refused|Person/i);
    warn.mockRestore();
  });
});

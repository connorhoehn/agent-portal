// The private notes' and scorecard drafts' writes (store.ts PrivateNoteWrites; gap audit 2026-11-20 §5) behave the same
// in both stores: the SQL store runs its real statements against small stateful tables that answer the way the RDS
// Data API does, and every answer is compared with the memory store's. A last block holds the statements to the schema.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SqlParameter } from '@aws-sdk/client-rds-data';
import { fixtureRegistry } from '../../../mock/core/index.js';
import { MemoryInterviewsStore, type InterviewsStore } from '../store.js';
import { PRIVATE_NOTE_SQL, SCORECARD_DRAFT_SQL, SqlInterviewsStore, type SqlExec } from '../store-sql.js';

const ts = (iso: string) => iso.replace('T', ' ').replace('Z', '');

function tablesExec(): SqlExec {
  const tables: Record<'notes' | 'drafts', Array<Record<string, unknown>>> = { notes: [], drafts: [] };
  const bound = (params: SqlParameter[] = []) => new Map(params.map((p) => [p.name!, p.value!.isNull ? null : p.value!.stringValue ?? p.value!.longValue ?? null]));
  const key = (b: Map<string, unknown>) => (r: Record<string, unknown>) => r['interview_id'] === b.get('interview_id') && r['author_id'] === b.get('author_id');
  const ids = (b: Map<string, unknown>) => [...b.entries()].filter(([k]) => /^id\d+$/.test(k)).map(([, v]) => v);
  return async (sql, params) => {
    const b = bound(params);
    for (const [name, t, cols] of [['notes', PRIVATE_NOTE_SQL, ['body']], ['drafts', SCORECARD_DRAFT_SQL, ['based_on', 'draft']]] as const) {
      const rows = tables[name];
      const values = () => Object.fromEntries(cols.map((c) => [c, b.get(c)]));
      if (sql === t.get) return rows.filter(key(b)).map((r) => ({ ...r }));
      if (sql === t.insert) {
        if (rows.some(key(b))) return [];
        const row = { interview_id: b.get('interview_id'), author_id: b.get('author_id'), ...values(), revision: 1, updated_at: ts(String(b.get('updated_at'))) };
        rows.push(row);
        return [{ ...row }];
      }
      if (sql === t.update) {
        const row = rows.find(key(b));
        if (!row || row['revision'] !== b.get('revision')) return [];
        Object.assign(row, values(), { revision: Number(row['revision']) + 1, updated_at: ts(String(b.get('updated_at'))) });
        return [{ ...row }];
      }
      if (sql.includes(' IN (') && sql.includes(name === 'notes' ? 'interview_private_notes' : 'interview_scorecard_drafts')) {
        const list = ids(b);
        const gone = rows.filter((r) => list.includes(r['interview_id']));
        tables[name] = rows.filter((r) => !list.includes(r['interview_id']));
        return gone.map((r) => ({ interview_id: r['interview_id'] }));
      }
      if (name === 'drafts' && sql === SCORECARD_DRAFT_SQL.delete) {
        const gone = rows.filter(key(b));
        tables.drafts = rows.filter((r) => !key(b)(r));
        return gone.map((r) => ({ interview_id: r['interview_id'] }));
      }
    }
    throw new Error(`unexpected statement: ${sql}`);
  };
}

beforeEach(() => fixtureRegistry.resetAll('default'));

const AT = '2026-11-16T10:00:00.000Z';
const LATER = '2026-11-16T10:05:00.000Z';

/** One script over a store; every answer, in order. */
async function script(store: InterviewsStore): Promise<unknown[]> {
  const out: unknown[] = [];
  const note = (body: string, updatedAt = AT) => ({ interviewId: 'iv-1', authorId: 'u-wen', body, updatedAt });
  out.push(await store.getPrivateNote('iv-1', 'u-wen'));
  out.push(await store.savePrivateNote(note('first'), 0));
  out.push(await store.savePrivateNote(note('again'), 0)); // stale: one exists
  out.push(await store.savePrivateNote(note('second', LATER), 1));
  out.push(await store.savePrivateNote(note('old tab'), 1)); // stale
  out.push(await store.savePrivateNote({ ...note('x'), authorId: 'u-hugo' }, 3)); // not-found
  out.push(await store.savePrivateNote({ ...note('lead'), authorId: 'u-hugo' }, 0));
  out.push(await store.savePrivateNote({ ...note('other round'), interviewId: 'iv-2' }, 0));
  out.push(await store.getPrivateNote('iv-1', 'u-wen'), await store.getPrivateNote('iv-1', 'u-nobody'));
  const draft = (summary: string, basedOn = 0) => ({ interviewId: 'iv-1', authorId: 'u-wen', basedOn, draft: { summary, ratings: { c1: 3 } }, updatedAt: AT });
  out.push(await store.getScorecardDraft('iv-1', 'u-wen'));
  out.push(await store.saveScorecardDraft(draft('a'), 0));
  out.push(await store.saveScorecardDraft(draft('b', 1), 1));
  out.push(await store.saveScorecardDraft(draft('c'), 1)); // stale
  out.push(await store.getScorecardDraft('iv-1', 'u-wen'));
  out.push(await store.saveScorecardDraft({ ...draft('d'), interviewId: 'iv-2' }, 0));
  out.push(await store.deleteScorecardDraft('iv-1', 'u-wen'), await store.deleteScorecardDraft('iv-1', 'u-wen'));
  out.push(await store.getScorecardDraft('iv-1', 'u-wen'));
  out.push(await store.erasePrivateNotes(['iv-1']), await store.erasePrivateNotes(['iv-1']), await store.erasePrivateNotes([]));
  out.push(await store.getPrivateNote('iv-1', 'u-wen'), await store.getPrivateNote('iv-1', 'u-hugo'), (await store.getPrivateNote('iv-2', 'u-wen'))?.body);
  out.push(await store.eraseScorecardDrafts(['iv-2', 'iv-9']), await store.getScorecardDraft('iv-2', 'u-wen'));
  return out;
}

describe('private notes and drafts in both stores', () => {
  it('answer identically, step by step', async () => {
    const memory = await script(new MemoryInterviewsStore());
    const sql = await script(new SqlInterviewsStore(tablesExec()));
    expect(sql).toEqual(memory);
    // And the answers are the ones the routes rely on.
    expect(memory[1]).toMatchObject({ ok: true, row: { body: 'first', revision: 1 } });
    expect(memory[2]).toMatchObject({ ok: false, reason: 'stale', row: { body: 'first' } });
    expect(memory[4]).toMatchObject({ ok: false, reason: 'stale', row: { body: 'second', revision: 2, updatedAt: LATER } });
    expect(memory[5]).toEqual({ ok: false, reason: 'not-found' });
    // Delete on submit once (then 0), erase by interview once (then 0), and only the interviews named.
    expect(memory.slice(-11)).toEqual([1, 0, null, 2, 0, 0, null, null, 'other round', 1, null]);
  });
});

describe('the statements and schema/interviews_schema.sql', () => {
  const schema = readFileSync(join(__dirname, '..', '..', '..', '..', '..', 'schema', 'interviews_schema.sql'), 'utf8');
  const rls = readFileSync(join(__dirname, '..', '..', '..', '..', '..', 'schema', 'row_level_security.sql'), 'utf8');
  it.each([['interview_private_notes', ['interview_id', 'author_id', 'body', 'revision', 'updated_at']], ['interview_scorecard_drafts', ['interview_id', 'author_id', 'based_on', 'draft', 'revision', 'updated_at']]])(
    '%s exists, idempotently, keyed by interview and author, with every column the statements name, under the tenant\'s row-level security',
    (table, cols) => {
      const ddl = new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`).exec(schema)?.[1] ?? '';
      for (const c of cols) expect(ddl).toMatch(new RegExp(`^\\s+${c}\\s`, 'm'));
      expect(ddl).toContain('PRIMARY KEY (interview_id, author_id)');
      expect(rls).toContain(`('${table}',`);
    },
  );
  it('notes are capped at 10,000 characters in the table too', () => {
    expect(schema).toMatch(/body\s+TEXT NOT NULL CHECK \(char_length\(body\) <= 10000\)/);
  });
});

// The two pad-log stores behave the same (lib/interviews/pad/log/store.ts; decision 12, row I4.3), and U3's
// latestPadSnapshot and the eraser read and erase through the chosen store.
jest.mock('../../../../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));
import type { SqlParameter } from '@aws-sdk/client-rds-data';
import type { SqlExec } from '../../../store-sql.js';
import { MemoryPadLogStore, setPadLogStore, type NewPadEvent, type PadLogStore } from '../store.js';
import {
  COUNT_PAD_EVENTS_SQL, ERASE_PAD_EVENTS_SQL, INSERT_PAD_EVENTS_SQL, LATEST_PAD_SNAPSHOT_SQL, LIST_PAD_EVENTS_SQL, PAD_LOG_STATEMENTS, POSTED_QUESTION_IDS_SQL, SqlPadLogStore,
} from '../store-sql.js';
import { erasePadLog, latestPadSnapshot } from '../index.js';
import { PAD_LOG_KINDS } from '../rules.js';
import { readFileSync } from 'node:fs';
import { fixtureRegistry } from '../../../../../mock/core/index.js';
import { interviewPadLogFixture } from '../../../../../mock/interviews-pad-log.js';

type P = { stringValue?: string; longValue?: number; isNull?: boolean };
const param = (params: SqlParameter[] | undefined, name: string): P => (params?.find((x) => x.name === name)?.value ?? {}) as P;
const ts = (iso: string) => iso.replace('T', ' ').replace('Z', '');

/** interview_pad_events as the Data API would keep and answer it (timestamps as text, the primary key enforced). */
function padTableExec(opts: { raceOnce?: boolean } = {}): SqlExec & { inserts: number } {
  const table: Record<string, unknown>[] = [];
  let race = !!opts.raceOnce;
  const out = (rows: Record<string, unknown>[]) => rows.map((r) => ({ ...r }));
  const mine = (id: string | null) => table.filter((r) => r['interview_id'] === id).sort((a, b) => Number(a['seq']) - Number(b['seq']));
  const fn = (async (sql, params) => {
    const s = (n: string) => param(params, n).stringValue ?? null;
    const l = (n: string) => Number(param(params, n).longValue);
    if (sql === COUNT_PAD_EVENTS_SQL) {
      const rows = mine(s('interview_id'));
      return [{ events: rows.length, snapshots: rows.filter((r) => r['kind'] === 'snapshot').length, last_seq: rows.reduce((m, r) => Math.max(m, Number(r['seq'])), 0) }];
    }
    if (sql === INSERT_PAD_EVENTS_SQL) {
      fn.inserts += 1;
      const id = s('interview_id');
      const last = mine(id).reduce((m, r) => Math.max(m, Number(r['seq'])), 0);
      if (race) {
        // Another post took the next seq between this one's read of the last and its insert.
        race = false;
        table.push({ interview_id: id, seq: last + 1, at: ts('2026-11-17T10:00:00.000Z'), client_at: ts('2026-11-17T10:00:00.000Z'), who_id: 'u-other', side: 'panel', kind: 'language',
          from_pos: null, inserted: null, deleted: null, doc_length: null, lines: null, via: null, language: 'go', question_id: null, text: null });
        throw new Error('duplicate key value violates unique constraint "interview_pad_events_pkey"');
      }
      const evs = JSON.parse(s('events')!) as Record<string, unknown>[];
      const rows = evs.map((e, i) => ({
        interview_id: id, seq: last + i + 1, at: ts(String(e['at'])), client_at: ts(String(e['clientAt'])), who_id: e['whoId'], side: e['side'], kind: e['kind'],
        from_pos: e['from'], inserted: e['inserted'], deleted: e['deleted'], doc_length: e['length'], lines: e['lines'], via: e['via'], language: e['language'],
        question_id: e['questionId'], text: e['text'],
      }));
      table.push(...rows);
      return out(rows.reverse()); // RETURNING promises no order
    }
    if (sql === LIST_PAD_EVENTS_SQL) return out(mine(s('interview_id')).filter((r) => Number(r['seq']) > l('after_seq')).slice(0, l('limit')));
    if (sql === LATEST_PAD_SNAPSHOT_SQL) return out(mine(s('interview_id')).filter((r) => r['kind'] === 'snapshot').slice(-1));
    if (sql === POSTED_QUESTION_IDS_SQL) {
      return mine(s('interview_id')).filter((r) => r['kind'] === s('kind') && r['question_id'] !== null).map((r) => ({ question_id: r['question_id'] }));
    }
    if (sql === ERASE_PAD_EVENTS_SQL) {
      const ids = String(s('interview_ids')).split(',');
      const gone = table.filter((r) => ids.includes(String(r['interview_id'])));
      for (const g of gone) table.splice(table.indexOf(g), 1);
      return gone.map((g) => ({ seq: g['seq'] }));
    }
    throw new Error(`unexpected statement: ${sql.slice(0, 60)}`);
  }) as SqlExec & { inserts: number };
  fn.inserts = 0;
  return fn;
}

const T = (second: number) => new Date(Date.UTC(2026, 10, 17, 10, 0, second)).toISOString();
const none = { from: null, inserted: null, deleted: null, length: null, lines: null, via: null, language: null, questionId: null, text: null };
const edit = (second: number, over: Partial<NewPadEvent> = {}): NewPadEvent =>
  ({ ...none, at: T(second), clientAt: T(second), whoId: 'guest:inv-1', side: 'candidate', kind: 'edit', from: 4, inserted: 3, deleted: 0, length: 40, ...over });
const snap = (second: number, text: string): NewPadEvent => edit(second, { kind: 'snapshot', from: null, inserted: null, deleted: null, length: text.length, language: 'python', text });

afterEach(() => { fixtureRegistry.resetAll('default'); setPadLogStore(null); });

describe.each([
  ['memory', () => { fixtureRegistry.resetAll('empty'); return new MemoryPadLogStore() as PadLogStore; }],
  ['sql', () => new SqlPadLogStore(padTableExec()) as PadLogStore],
])('the %s pad log', (_name, make) => {
  it('gives each interview its own seq that only grows, in the order of the post', async () => {
    const store = make();
    const first = await store.append('iv-1', [edit(1), edit(2, { kind: 'paste', deleted: null, lines: 2, via: 'paste', inserted: 80 })]);
    expect(first.map((r) => r.seq)).toEqual([1, 2]);
    expect((await store.append('iv-2', [edit(3)])).map((r) => r.seq)).toEqual([1]);
    const again = await store.append('iv-1', [edit(4)]);
    expect(again).toEqual([{ ...edit(4), interviewId: 'iv-1', seq: 3 }]);
    expect(await store.counts('iv-1')).toEqual({ events: 3, snapshots: 0, lastSeq: 3 });
    expect(await store.counts('iv-none')).toEqual({ events: 0, snapshots: 0, lastSeq: 0 });
    expect(await store.append('iv-1', [])).toEqual([]);
  });

  it('reads after a seq, at most a limit, and nothing of another interview', async () => {
    const store = make();
    await store.append('iv-1', [edit(1), edit(2), edit(3), edit(4)]);
    await store.append('iv-2', [edit(5)]);
    expect((await store.listAfter('iv-1', 1, 2)).map((r) => r.seq)).toEqual([2, 3]);
    expect((await store.listAfter('iv-1', 4, 10))).toEqual([]);
    const paste = (await store.listAfter('iv-1', 0, 1))[0]!;
    expect(paste).toEqual({ ...edit(1), interviewId: 'iv-1', seq: 1 });
  });

  it('keeps snapshots with their text, counts them, and answers the latest', async () => {
    const store = make();
    expect(await store.latestSnapshot('iv-1')).toBeNull();
    await store.append('iv-1', [snap(1, 'a = 1\n'), edit(2), snap(3, 'a = 2\n')]);
    expect(await store.latestSnapshot('iv-1')).toMatchObject({ seq: 3, text: 'a = 2\n', language: 'python', kind: 'snapshot' });
    expect((await store.counts('iv-1')).snapshots).toBe(2);
  });

  it('names the questions posted into the pad, first insert first, each once, and only that interview\'s', async () => {
    const store = make();
    const insert = (second: number, questionId: string) => edit(second, { kind: 'insert', side: 'panel', whoId: 'u-lead', from: null, inserted: null, deleted: null, length: null, questionId });
    expect(await store.postedQuestionIds('iv-1')).toEqual([]);
    await store.append('iv-1', [insert(1, 'q-b'), edit(2), insert(3, 'q-a'), insert(4, 'q-b')]);
    await store.append('iv-2', [insert(5, 'q-c')]);
    expect(await store.postedQuestionIds('iv-1')).toEqual(['q-b', 'q-a']);
  });

  it('names the questions whose provided design was revealed, each once, apart from the pad\'s inserts', async () => {
    const store = make();
    const row = (second: number, kind: 'insert' | 'reveal', questionId: string) => edit(second, { kind, side: 'panel', whoId: 'u-lead', from: null, inserted: null, deleted: null, length: null, questionId });
    await store.append('iv-1', [row(1, 'insert', 'q-a'), row(2, 'reveal', 'q-t'), row(3, 'reveal', 'q-t')]);
    expect(await store.postedQuestionIds('iv-1', 'reveal')).toEqual(['q-t']);
    expect(await store.postedQuestionIds('iv-1')).toEqual(['q-a']);
  });

  it('erases by interview and nothing else', async () => {
    const store = make();
    await store.append('iv-1', [edit(1), edit(2)]);
    await store.append('iv-2', [edit(3)]);
    expect(await store.erase(['iv-1', 'bad,id'])).toBe(2);
    expect(await store.listAfter('iv-1', 0, 10)).toEqual([]);
    expect(await store.listAfter('iv-2', 0, 10)).toHaveLength(1);
    expect(await store.erase([])).toBe(0);
  });
});

describe('the schema and the kinds the log holds', () => {
  it('lets every kind the server writes into interview_pad_events, in the CREATE and in the constraint that replaces older lists', () => {
    const schema = readFileSync(`${process.cwd()}/../schema/interviews_schema.sql`, 'utf8');
    const lists = [...schema.matchAll(/CHECK \(kind IN \(([^)]*)\)\)/g)].map((m) => m[1]!.split(',').map((k) => k.trim().replace(/'/g, '')).sort());
    const padLists = lists.filter((l) => l.includes('snapshot') && l.includes('insert'));
    expect(padLists).toHaveLength(2);
    for (const l of padLists) expect(l).toEqual([...PAD_LOG_KINDS].sort());
  });
});

describe('the SQL store', () => {
  it('tries a post again on the new last seq when another post took its numbers', async () => {
    const exec = padTableExec({ raceOnce: true });
    const store = new SqlPadLogStore(exec);
    expect((await store.append('iv-1', [edit(1), edit(2)])).map((r) => r.seq)).toEqual([2, 3]);
    expect(exec.inserts).toBe(2);
  });

  it('never updates a row', () => {
    for (const sql of PAD_LOG_STATEMENTS) expect(sql).not.toMatch(/\bUPDATE\b/i);
  });
});

describe('U3 and the eraser, through the chosen store', () => {
  it('answers the seeded round\'s latest snapshot, then erases its log', async () => {
    const latest = await latestPadSnapshot('iv-j6x2d9sb');
    expect(latest).toMatchObject({ language: 'python' });
    expect(latest!.text).toContain('def clamp');
    expect(await latestPadSnapshot('iv-k1p5w8ra')).toBeNull();
    const seeded = interviewPadLogFixture.rows().filter((r) => r.interviewId === 'iv-j6x2d9sb').length;
    expect(await erasePadLog(['iv-j6x2d9sb'])).toBe(seeded);
    expect(await latestPadSnapshot('iv-j6x2d9sb')).toBeNull();
    expect(await erasePadLog([])).toBe(0);
  });

  it('seeds edits as counts only and text only on snapshots', () => {
    for (const r of interviewPadLogFixture.rows('default')) expect([r.kind, r.text !== null]).toEqual([r.kind, r.kind === 'snapshot']);
  });
});

describe('the export of what Milo showed', () => {
  it('does not include the pad log (it is media, not a decision record)', async () => {
    await import('../../../export/sections.js');
    const { exportSections } = await import('../../../export/registry.js');
    const keys = exportSections().map((s) => s.key);
    expect(keys).toContain('milo-for-you');
    expect(keys.filter((k) => /pad|code/i.test(k))).toEqual([]);
  });
});

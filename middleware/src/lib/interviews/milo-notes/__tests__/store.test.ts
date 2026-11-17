// The two coach-log stores behave the same (lib/interviews/milo-notes/store.ts; decision 8, row I3.6), and E7/E8's two
// functions read and erase through the chosen store.
jest.mock('../../../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));
import type { SqlParameter } from '@aws-sdk/client-rds-data';
import type { SqlExec } from '../../store-sql.js';
import { MemoryCoachLogStore, setCoachLogStore, type CoachLogRecord, type CoachLogStore } from '../store.js';
import { COACH_LOG_STATEMENTS, ERASE_COACH_LOG_SQL, INSERT_COACH_LOG_SQL, LIST_COACH_LOG_KIND_SQL, LIST_COACH_LOG_SQL, SqlCoachLogStore } from '../store-sql.js';
import { eraseCoachLog, exportCoachLog } from '../index.js';
import { fixtureRegistry } from '../../../../mock/core/index.js';
import { interviewCoachLogFixture } from '../../../../mock/interviews-coach-log.js';

type P = { stringValue?: string; isNull?: boolean };
const param = (params: SqlParameter[] | undefined, name: string): P => (params?.find((x) => x.name === name)?.value ?? {}) as P;
const ts = (iso: string) => iso.replace('T', ' ').replace('Z', '');

/** interview_coach_log as the Data API would keep and answer it (timestamps as text, sources as JSON text). */
function coachLogTableExec(): SqlExec {
  const table: Record<string, unknown>[] = [];
  const out = (rows: Record<string, unknown>[]) => rows.map((r) => ({ ...r }));
  const order = (a: Record<string, unknown>, b: Record<string, unknown>) => String(a['asked_at']).localeCompare(String(b['asked_at'])) || String(a['id']).localeCompare(String(b['id']));
  return async (sql, params) => {
    const s = (n: string) => { const p = param(params, n); return p.isNull ? null : (p.stringValue ?? null); };
    if (sql === LIST_COACH_LOG_SQL) return out(table.filter((r) => r['interview_id'] === s('interview_id')).sort(order));
    if (sql === LIST_COACH_LOG_KIND_SQL) return out(table.filter((r) => r['interview_id'] === s('interview_id') && r['kind'] === s('kind')).sort(order));
    if (sql === INSERT_COACH_LOG_SQL) {
      if (table.some((r) => r['id'] === s('id'))) throw new Error('duplicate key');
      const row = {
        id: s('id'), interview_id: s('interview_id'), kind: s('kind'), asked_by: s('asked_by'), question: s('question'), answer: s('answer'),
        sources: s('sources'), code: s('code'), asked_at: ts(s('asked_at')!), model_id: s('model_id'), prompt_version: s('prompt_version'),
      };
      table.push(row);
      return out([row]);
    }
    if (sql === ERASE_COACH_LOG_SQL) {
      const ids = String(s('interview_ids')).split(',');
      const gone = table.filter((r) => ids.includes(String(r['interview_id'])));
      for (const g of gone) table.splice(table.indexOf(g), 1);
      return gone.map((g) => ({ id: g['id'] }));
    }
    throw new Error(`unexpected statement: ${sql.slice(0, 60)}`);
  };
}

const T = (minute: number) => new Date(Date.UTC(2026, 10, 16, 10, minute)).toISOString();
const row = (id: string, interviewId: string, minute: number, over: Partial<CoachLogRecord> = {}): CoachLogRecord => ({
  id, interviewId, kind: 'answer', askedBy: 'u-wen', question: 'What did they say about testing?', answer: 'The candidate spoke of it in line 4.',
  sources: [{ seq: 4, quote: 'we wrote the tests first' }], code: null, askedAt: T(minute), modelId: 'scripted-milo', promptVersion: 'milo-ask-2026-11-17.1', ...over,
});

afterEach(() => { fixtureRegistry.resetAll('default'); setCoachLogStore(null); });

describe.each([
  ['memory', () => { fixtureRegistry.resetAll('empty'); return new MemoryCoachLogStore() as CoachLogStore; }],
  ['sql', () => new SqlCoachLogStore(coachLogTableExec()) as CoachLogStore],
])('the %s coach log', (_name, make) => {
  it('appends and lists an interview\'s rows oldest first, and nothing of another interview', async () => {
    const store = make();
    await store.append(row('ml-b', 'iv-1', 5));
    await store.append(row('ml-a', 'iv-1', 1));
    await store.append(row('ml-c', 'iv-2', 2));
    expect(await store.list('iv-1')).toEqual([row('ml-a', 'iv-1', 1), row('ml-b', 'iv-1', 5)]);
  });

  it('keeps a kind: plan rows (row I3.10) with their own sources, listed apart', async () => {
    const store = make();
    const plan = row('ml-p', 'iv-1', 3, { kind: 'plan', question: '', answer: '2 questions', sources: [{ questionId: 'q-1', why: 'Not covered yet' }], modelId: 'amazon.nova-pro-v1:0' });
    await store.append(row('ml-a', 'iv-1', 1));
    await store.append(plan);
    expect(await store.list('iv-1', 'plan')).toEqual([plan]);
    expect((await store.list('iv-1', 'answer')).map((r) => r.id)).toEqual(['ml-a']);
  });

  it('keeps a refusal and a dropped answer as their code only', async () => {
    const store = make();
    const refused = row('ml-r', 'iv-1', 1, { answer: '', sources: [], code: 'refused-judgement', modelId: 'none' });
    await store.append(refused);
    expect(await store.list('iv-1')).toEqual([refused]);
  });

  it('refuses a used id, and erases by interview (append-only otherwise)', async () => {
    const store = make();
    await store.append(row('ml-a', 'iv-1', 1));
    await expect(store.append(row('ml-a', 'iv-1', 2))).rejects.toThrow();
    await store.append(row('ml-b', 'iv-2', 1));
    expect(await store.erase(['iv-1', 'bad,id'])).toBe(1);
    expect(await store.list('iv-1')).toEqual([]);
    expect(await store.list('iv-2')).toHaveLength(1);
    expect(await store.erase([])).toBe(0);
  });
});

describe('the statements', () => {
  it('never update a row', () => {
    for (const sql of COACH_LOG_STATEMENTS) expect(sql).not.toMatch(/\bUPDATE\b/i);
  });
});

describe('E7 and E8', () => {
  it('erases the interviews\' rows and exports one interview\'s rows as logged', async () => {
    const exported = await exportCoachLog('iv-f2b6t5zh') as { rows: CoachLogRecord[] };
    expect(exported.rows.map((r) => r.id)).toEqual(['ml-ingrid-together-1', 'ml-ingrid-together-2']);
    expect(await eraseCoachLog(['iv-f2b6t5zh'])).toBe(2);
    expect(interviewCoachLogFixture.rows().map((r) => r.interviewId)).toEqual(['iv-j6x2d9sb']);
    expect(await eraseCoachLog([])).toBe(0);
  });
});

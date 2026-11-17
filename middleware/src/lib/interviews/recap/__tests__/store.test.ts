// The two recap stores behave the same (lib/interviews/recap/store.ts; row I5.2), and E7's eraser and E8's export.
jest.mock('../../../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));
import type { SqlParameter } from '@aws-sdk/client-rds-data';
import type { SqlExec } from '../../store-sql.js';
import { MemoryRecapStore, setRecapStore, type RecapOpen, type RecapRecord, type RecapStore } from '../store.js';
import {
  ERASE_RECAP_OPENS_SQL, ERASE_RECAPS_SQL, GET_RECAP_OPEN_SQL, GET_RECAP_SQL, INSERT_RECAP_OPEN_SQL, INSERT_RECAP_SQL, LIST_RECAP_OPENS_SQL, SqlRecapStore,
} from '../store-sql.js';
import { eraseRecaps, exportRecap } from '../index.js';
import { fixtureRegistry } from '../../../../mock/core/index.js';
import { interviewRecapsFixture } from '../../../../mock/interviews-recaps.js';
import { interviewsFixture } from '../../../../mock/interviews.js';

type P = { stringValue?: string; longValue?: number; isNull?: boolean };
const param = (params: SqlParameter[] | undefined, name: string): P => (params?.find((x) => x.name === name)?.value ?? {}) as P;
const ts = (iso: string) => iso.replace('T', ' ').replace('Z', '');

/** The two tables as the Data API would keep and answer them (timestamps as text, JSONB as text, TEXT[] as `{a,b}`). */
function recapTablesExec(): SqlExec {
  const recaps: Record<string, unknown>[] = [];
  const opens: Record<string, unknown>[] = [];
  const out = (rows: Record<string, unknown>[]) => rows.map((r) => ({ ...r }));
  return async (sql, params) => {
    const s = (n: string) => param(params, n).stringValue ?? null;
    if (sql === GET_RECAP_SQL) return out(recaps.filter((r) => r['interview_id'] === s('interview_id')));
    if (sql === INSERT_RECAP_SQL) {
      if (recaps.some((r) => r['interview_id'] === s('interview_id'))) return [];
      const row = {
        interview_id: s('interview_id'), state: s('state'), content: s('content'), written_at: ts(s('written_at')!), model_id: s('model_id'),
        prompt_version: s('prompt_version'), attempts: param(params, 'attempts').longValue, dropped_codes: `{${(JSON.parse(s('dropped_codes')!) as string[]).join(',')}}`,
        dropped_claims: param(params, 'dropped_claims').longValue,
      };
      recaps.push(row);
      return out([row]);
    }
    const mine = (r: Record<string, unknown>) => r['interview_id'] === s('interview_id') && r['interviewer_id'] === s('interviewer_id');
    if (sql === GET_RECAP_OPEN_SQL) return out(opens.filter(mine));
    if (sql === LIST_RECAP_OPENS_SQL) {
      return out(opens.filter((r) => r['interview_id'] === s('interview_id')).sort((a, b) => String(a['opened_at']).localeCompare(String(b['opened_at']))));
    }
    if (sql === INSERT_RECAP_OPEN_SQL) {
      if (opens.some(mine)) return [];
      const row = { interview_id: s('interview_id'), interviewer_id: s('interviewer_id'), ratings: s('ratings'), opened_at: ts(s('opened_at')!) };
      opens.push(row);
      return out([row]);
    }
    if (sql === ERASE_RECAPS_SQL || sql === ERASE_RECAP_OPENS_SQL) {
      const table = sql === ERASE_RECAPS_SQL ? recaps : opens;
      const ids = String(s('interview_ids')).split(',');
      const gone = table.filter((r) => ids.includes(String(r['interview_id'])));
      for (const g of gone) table.splice(table.indexOf(g), 1);
      return gone.map((g) => ({ interview_id: g['interview_id'] }));
    }
    throw new Error(`unexpected statement: ${sql.slice(0, 60)}`);
  };
}

const T = (minute: number) => new Date(Date.UTC(2026, 10, 16, 10, minute)).toISOString();
const recap = (interviewId: string, over: Partial<RecapRecord> = {}): RecapRecord => ({
  interviewId, state: 'ready', writtenAt: T(1), modelId: 'scripted-recap', promptVersion: 'recap-2026-11-17.1', attempts: 2, droppedCodes: ['judges'], droppedClaims: 1,
  content: { competencies: [{ id: 'communication', evidence: [{ text: 'The candidate said: “I paged the lead”', seq: 2, quote: 'I paged the lead' }] }], notCovered: ['collaboration'] },
  ...over,
});
const open = (interviewId: string, interviewerId: string, minute: number, rating: 1 | 2 | 3 | 4 = 3): RecapOpen =>
  ({ interviewId, interviewerId, openedAt: T(minute), ratings: [{ competencyId: 'communication', rating }, { competencyId: 'collaboration', rating: 2 }] });

afterEach(() => { fixtureRegistry.resetAll('default'); setRecapStore(null); });

describe.each([
  ['memory', () => { fixtureRegistry.resetAll('empty'); return new MemoryRecapStore() as RecapStore; }],
  ['sql', () => new SqlRecapStore(recapTablesExec()) as RecapStore],
])('the %s recap store', (_name, make) => {
  it('writes a recap once and keeps the first', async () => {
    const store = make();
    expect(await store.getRecap('iv-1')).toBeNull();
    expect(await store.putRecap(recap('iv-1'))).toEqual({ row: recap('iv-1'), created: true });
    expect(await store.putRecap(recap('iv-1', { state: 'failed', attempts: 3 }))).toEqual({ row: recap('iv-1'), created: false });
    expect(await store.getRecap('iv-1')).toEqual(recap('iv-1'));
  });

  it('keeps a failed recap with its codes and no content', async () => {
    const store = make();
    const failed = recap('iv-2', { state: 'failed', attempts: 3, droppedCodes: ['malformed', 'judges', 'timeout'], droppedClaims: 0, content: { competencies: [], notCovered: [] } });
    await store.putRecap(failed);
    expect(await store.getRecap('iv-2')).toEqual(failed);
  });

  it('stores each person\'s first open only, and lists them oldest first', async () => {
    const store = make();
    expect(await store.putOpen(open('iv-1', 'u-wen', 5, 3))).toEqual({ row: open('iv-1', 'u-wen', 5, 3), created: true });
    expect(await store.putOpen(open('iv-1', 'u-wen', 9, 1))).toEqual({ row: open('iv-1', 'u-wen', 5, 3), created: false });
    await store.putOpen(open('iv-1', 'u-hugo', 2));
    await store.putOpen(open('iv-2', 'u-wen', 1));
    expect(await store.getOpen('iv-1', 'u-wen')).toEqual(open('iv-1', 'u-wen', 5, 3));
    expect(await store.getOpen('iv-1', 'u-amara')).toBeNull();
    expect((await store.listOpens('iv-1')).map((o) => o.interviewerId)).toEqual(['u-hugo', 'u-wen']);
  });

  it('erases an interview\'s recap and opens, and nothing of another', async () => {
    const store = make();
    await store.putRecap(recap('iv-1'));
    await store.putRecap(recap('iv-2'));
    await store.putOpen(open('iv-1', 'u-wen', 1));
    await store.putOpen(open('iv-2', 'u-wen', 1));
    expect(await store.eraseRecaps(['iv-1', 'bad,id'])).toBe(2);
    expect(await store.getRecap('iv-1')).toBeNull();
    expect(await store.getOpen('iv-1', 'u-wen')).toBeNull();
    expect(await store.getRecap('iv-2')).not.toBeNull();
    expect(await store.eraseRecaps([])).toBe(0);
  });
});

describe('the seed and E7/E8', () => {
  it('seeds recaps only on finished interviews, with every claim quoting itself', () => {
    const finished = new Set(interviewsFixture.rows().filter((i) => ['scored', 'reviewed'].includes(i.state)).map((i) => i.id));
    for (const r of interviewRecapsFixture.rows()) {
      expect([r.interviewId, finished.has(r.interviewId)]).toEqual([r.interviewId, true]);
      for (const c of r.content.competencies) for (const e of c.evidence) expect(e.text).toContain(e.quote);
    }
  });

  it('exports and erases through the index', async () => {
    const exported = await exportRecap('iv-j6x2d9sb') as { recap: RecapRecord | null; opens: RecapOpen[] };
    expect(exported.recap?.state).toBe('ready');
    expect(exported.opens.map((o) => o.interviewerId)).toEqual(['u-hugo']);
    expect(await eraseRecaps(['iv-j6x2d9sb'])).toBe(2);
    expect(await exportRecap('iv-j6x2d9sb')).toEqual({ recap: null, opens: [] });
  });
});

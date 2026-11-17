// The two run stores behave the same (lib/interviews/runs/store.ts; row I4.4), the statements only do what the store
// says, and D6's eraser.
jest.mock('../../../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));
import type { SqlParameter } from '@aws-sdk/client-rds-data';
import type { SqlExec } from '../../store-sql.js';
import { fixtureRegistry } from '../../../../mock/core/index.js';
import { interviewRunsFixture } from '../../../../mock/interviews-runs.js';
import { serviceResult } from '../executor.js';
import { MOCK_RUNTIME_VERSIONS } from '../mock-executor.js';
import { MemoryRunStore, type RunRecord, type RunStore, type StoredRunEvent } from '../store.js';
import {
  APPEND_EVENTS_SQL, COUNT_RUNS_SQL, ERASE_RUNS_SQL, FINISH_RUN_SQL, GET_RUN_SQL, INSERT_RUN_SQL, LIST_RUNS_SQL, LIST_UNFINISHED_SQL, RUN_STATEMENTS,
  SET_STATUS_SQL, SqlRunStore,
} from '../store-sql.js';
import { eraseRuns } from '../index.js';

type P = { stringValue?: string; isNull?: boolean };
const param = (params: SqlParameter[] | undefined, name: string): P => (params?.find((x) => x.name === name)?.value ?? {}) as P;
const ts = (iso: string | null) => (iso === null ? null : iso.replace('T', ' ').replace('Z', ''));

/** interview_runs as the Data API would keep and answer it: timestamps and JSONB as text, nulls as null. */
function runsTableExec(): SqlExec {
  const table: Record<string, unknown>[] = [];
  const out = (rows: Record<string, unknown>[]) => rows.map((r) => ({ ...r }));
  return async (sql, params) => {
    const s = (n: string) => { const p = param(params, n); return p.isNull ? null : (p.stringValue ?? null); };
    const find = () => table.find((r) => r['interview_id'] === s('interview_id') && r['run_id'] === s('run_id'));
    const order = (a: Record<string, unknown>, b: Record<string, unknown>) => String(a['queued_at']).localeCompare(String(b['queued_at'])) || String(a['run_id']).localeCompare(String(b['run_id']));
    if (sql === GET_RUN_SQL) { const r = find(); return r ? out([r]) : []; }
    if (sql === LIST_RUNS_SQL) return out(table.filter((r) => r['interview_id'] === s('interview_id')).sort(order));
    if (sql === COUNT_RUNS_SQL) return [{ n: table.filter((r) => r['interview_id'] === s('interview_id')).length }];
    if (sql === LIST_UNFINISHED_SQL) return out(table.filter((r) => r['result'] === null).sort(order));
    if (sql === INSERT_RUN_SQL) {
      if (find()) return [];
      const row: Record<string, unknown> = {
        interview_id: s('interview_id'), run_id: s('run_id'), language: s('language'), entrypoint: s('entrypoint'), files: s('files'), source: s('source'),
        stdin: s('stdin'), started_by_id: s('started_by_id'), started_by_name: s('started_by_name'), started_by_side: s('started_by_side'), status: s('status'),
        queued_at: ts(s('queued_at')), started_at: null, ended_at: null, result: null, events: s('events'), hold_id: s('hold_id'), spend_source_id: s('spend_source_id'),
      };
      table.push(row);
      return out([row]);
    }
    const cat = (a: unknown, b: string | null) => JSON.stringify([...JSON.parse(String(a)), ...JSON.parse(b ?? '[]')]);
    if (sql === APPEND_EVENTS_SQL) { const r = find(); if (r && r['result'] === null) r['events'] = cat(r['events'], s('events')); return []; }
    if (sql === SET_STATUS_SQL) {
      const r = find();
      if (!r || r['result'] !== null) return [];
      r['status'] = s('status');
      r['started_at'] ??= ts(s('at'));
      return out([r]);
    }
    if (sql === FINISH_RUN_SQL) {
      const r = find();
      if (!r || r['result'] !== null) return [];
      Object.assign(r, { status: s('status'), result: s('result'), ended_at: ts(s('ended_at')), events: cat(r['events'], s('events')) });
      return out([r]);
    }
    if (sql === ERASE_RUNS_SQL) {
      const ids = String(s('interview_ids')).split(',');
      const gone = table.filter((r) => ids.includes(String(r['interview_id'])));
      for (const g of gone) table.splice(table.indexOf(g), 1);
      return gone.map((g) => ({ run_id: g['run_id'] }));
    }
    throw new Error(`unexpected statement: ${sql.slice(0, 40)}`);
  };
}

const T = (s: number) => new Date(Date.UTC(2026, 10, 17, 14, 0, s)).toISOString();
const ev = (seq: number, n: number, data: string, stream: StoredRunEvent['stream'] = 'status'): StoredRunEvent => ({ seq, n, stream, data, at: T(seq) });
const run = (runId: string, interviewId: string, s: number, over: Partial<RunRecord> = {}): RunRecord => ({
  interviewId, runId, language: 'python', entrypoint: 'main.py', files: [{ path: 'main.py', bytes: 11 }], source: [{ path: 'main.py', content: 'print("hi")' }],
  stdin: null, startedBy: { id: 'u-hugo', name: 'Hugo Marchetti', side: 'panel' }, status: 'queued', queuedAt: T(s), startedAt: null, endedAt: null,
  result: null, events: [ev(1, s, 'queued')], holdId: `h-${runId}`, spendSourceId: `iv:op:${interviewId}:run:${runId}`, ...over,
});
const done = serviceResult('succeeded', { backend: 'mock', runtimeVersions: MOCK_RUNTIME_VERSIONS }, 'python', { exitCode: 0, stdout: 'hi\n', timeMs: 300, peakMemoryMb: 18 });

describe.each([
  ['memory', () => { fixtureRegistry.resetAll('default'); return new MemoryRunStore(); }],
  ['sql', () => new SqlRunStore(runsTableExec())],
] as [string, () => RunStore][])('the %s run store', (_name, make) => {
  it('inserts once per (interview, runId); a repeat answers the first row', async () => {
    const store = make();
    expect(await store.insertRun(run('r-1', 'iv-1', 1))).toMatchObject({ ok: true, row: { runId: 'r-1', status: 'queued' } });
    const again = await store.insertRun(run('r-1', 'iv-1', 2, { language: 'go' }));
    expect(again).toMatchObject({ ok: false, reason: 'exists', row: { language: 'python', queuedAt: T(1) } });
    expect((await store.insertRun(run('r-1', 'iv-2', 3))).ok).toBe(true);
    expect(await store.countRuns('iv-1')).toBe(1);
    expect(await store.getRun('iv-1', 'r-1')).toEqual(run('r-1', 'iv-1', 1));
  });

  it('moves the status and appends events only while there is no result, and finishes once', async () => {
    const store = make();
    await store.insertRun(run('r-1', 'iv-1', 1));
    expect(await store.setStatus('iv-1', 'r-1', 'running', T(5))).toMatchObject({ status: 'running', startedAt: T(5) });
    expect(await store.setStatus('iv-1', 'r-1', 'running', T(6))).toMatchObject({ startedAt: T(5) });
    await store.appendEvents('iv-1', 'r-1', [ev(2, 2, 'running'), ev(3, 3, 'hi\n', 'stdout')]);
    const finished = await store.finishRun('iv-1', 'r-1', done, T(9), [ev(4, 4, 'succeeded')]);
    expect(finished).toMatchObject({ status: 'succeeded', endedAt: T(9), result: done });
    expect(finished?.events.map((e) => e.data)).toEqual(['queued', 'running', 'hi\n', 'succeeded']);
    expect(await store.finishRun('iv-1', 'r-1', { ...done, status: 'failed' }, T(10), [ev(5, 5, 'failed')])).toBeNull();
    await store.appendEvents('iv-1', 'r-1', [ev(6, 6, 'late', 'stdout')]);
    expect(await store.setStatus('iv-1', 'r-1', 'compiling', T(11))).toBeNull();
    expect((await store.getRun('iv-1', 'r-1'))?.events.length).toBe(4);
    expect((await store.getRun('iv-1', 'r-1'))?.result?.status).toBe('succeeded');
  });

  it('lists oldest first, finds what has no result across interviews, and erases by interview', async () => {
    const store = make();
    await store.insertRun(run('r-b', 'iv-1', 2));
    await store.insertRun(run('r-a', 'iv-1', 1));
    await store.insertRun(run('r-c', 'iv-2', 3));
    await store.finishRun('iv-1', 'r-a', done, T(4), []);
    expect((await store.listRuns('iv-1')).map((r) => r.runId)).toEqual(['r-a', 'r-b']);
    expect((await store.listUnfinished()).map((r) => r.runId)).toEqual(['r-b', 'r-c']);
    expect(await store.eraseRuns(['iv-1', 'iv-3'])).toBe(2);
    expect(await store.listRuns('iv-1')).toEqual([]);
    expect(await store.countRuns('iv-2')).toBe(1);
    expect(await store.eraseRuns([])).toBe(0);
  });
});

describe('the statements', () => {
  it('only insert (never over a row), fill while unfinished, finish once, or delete by interview', () => {
    expect(INSERT_RUN_SQL).toMatch(/ON CONFLICT \(interview_id, run_id\) DO NOTHING/);
    const updates = RUN_STATEMENTS.filter((s) => /^UPDATE/.test(s));
    expect(updates).toEqual([APPEND_EVENTS_SQL, SET_STATUS_SQL, FINISH_RUN_SQL]);
    for (const u of updates) expect(u).toMatch(/result IS NULL/);
    expect(RUN_STATEMENTS.filter((s) => /^DELETE/.test(s))).toEqual([ERASE_RUNS_SQL]);
  });
});

describe('D6: eraseRuns', () => {
  it('removes those interviews\' runs and says how many', async () => {
    fixtureRegistry.resetAll('default');
    interviewRunsFixture.rows().length = 0;
    interviewRunsFixture.rows().push(run('r-1', 'iv-j6x2d9sb', 1), run('r-2', 'iv-j6x2d9sb', 2), run('r-3', 'iv-d7q4n9xe', 3));
    expect(await eraseRuns(['iv-j6x2d9sb'])).toBe(2);
    expect(interviewRunsFixture.rows().map((r) => r.runId)).toEqual(['r-3']);
    expect(await eraseRuns([])).toBe(0);
  });
  it('the seed holds runs only for the finished technical rounds (row I5.1)', () => {
    fixtureRegistry.resetAll('default');
    expect([...new Set(interviewRunsFixture.rows('default').map((r) => r.interviewId))].sort()).toEqual(['iv-d7q4n9xe', 'iv-j6x2d9sb', 'iv-p2v7j4ye']);
  });
});

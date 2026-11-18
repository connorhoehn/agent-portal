// The run service (lib/interviews/runs/service.ts; row I4.4, contract U4): the queue, repeats, the cap, cancel in each
// state, the wall-time safeguard, the service's own output cut, the events and a reader that reconnects, money (held,
// settled, released, refused) and what a restart leaves. A hand-driven executor makes each state exact.
jest.mock('../../../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));
import { fixtureRegistry } from '../../../../mock/core/index.js';
import type { Executor, ExecutorOutput, RunRequest, RunResult } from '../executor.js';
import { serviceResult } from '../executor.js';
import { MemoryRunStore, type RunRecord } from '../store.js';
import {
  cancelRun, checkRunBody, COMPILE_ALLOWANCE_MS, WALL_GRACE_MS, ensureRecovered, getRun, guestRunView, listRuns, MAX_RUNS_PER_INTERVIEW, openRunEvents, plainPath, runPriceUsd, runsSettled,
  setRunDeps, startRun, type RunBody, type RunDeps, type RunEvent,
} from '../service.js';
import { lastRun } from '../index.js';

interface Live { request: RunRequest; emit: (o: ExecutorOutput) => void; cancels: number }
class HandExecutor implements Executor {
  readonly backend = 'hand';
  readonly runtimeVersions = { python: 'P 1', swift: 'S 1', javascript: 'J 1', typescript: 'T 1', java: 'Jv 1', go: 'G 1', cpp: 'C 1' };
  runs: Live[] = [];
  answerCancel = true;
  throwOnStart = false;
  start(request: RunRequest, emit: (o: ExecutorOutput) => void) {
    if (this.throwOnStart) throw new Error('no sandbox');
    const live: Live = { request, emit, cancels: 0 };
    this.runs.push(live);
    return { cancel: () => { live.cancels++; if (this.answerCancel) emit({ type: 'result', result: this.result('cancelled', request) }); } };
  }
  result(status: RunResult['status'], r: RunRequest, over: Partial<RunResult> = {}): RunResult {
    return serviceResult(status, this, r.language, { exitCode: status === 'succeeded' ? 0 : null, ...over });
  }
}

const IV = 'iv-k1p5w8ra';
const HUGO = { id: 'u-hugo', name: 'Hugo Marchetti', side: 'panel' as const };
const CANDIDATE = { id: 'guest:inv-1', name: 'Candidate', side: 'candidate' as const };
const store = new MemoryRunStore();
let ex: HandExecutor;
let now = Date.UTC(2026, 10, 17, 14, 0);
let money: { reserve: jest.Mock; settle: jest.Mock; release: jest.Mock };
let k = 0;
const body = (over: Partial<RunBody> = {}): RunBody => ({ runId: `run-${String(++k).padStart(4, '0')}`, language: 'python', files: [{ path: 'main.py', content: 'print("hi")' }], entrypoint: 'main.py', stdin: null, ...over });
const flush = () => new Promise((r) => setImmediate(r));
/** Wait (bounded) until `cond` holds: for a state reached while a later run is still going. */
async function until(cond: () => Promise<boolean> | boolean): Promise<void> {
  for (let i = 0; i < 500; i++) { if (await cond()) return; await flush(); }
  throw new Error('the state was never reached');
}
const row = (runId: string) => store.getRun(IV, runId) as Promise<RunRecord>;

function deps(over: Partial<RunDeps> = {}): Partial<RunDeps> {
  return {
    store: () => store, executor: () => ex, now: () => now, priceUsd: () => 0.0017,
    limits: () => ({ wallMs: 10_000, memoryMb: 256, maxOutputBytes: 64 }),
    reserve: money.reserve, settle: money.settle, release: money.release, ...over,
  };
}

beforeEach(() => {
  fixtureRegistry.resetAll('default');
  ex = new HandExecutor();
  k = 0;
  money = {
    reserve: jest.fn(async (i) => ({ ok: true, holdId: `h-${i.key}`, sourceId: `iv:op-backend:${IV}:run:${i.key}`, amountUsd: i.estimateUsd })),
    settle: jest.fn(async () => undefined),
    release: jest.fn(async () => undefined),
  };
  setRunDeps(deps());
});
afterAll(() => setRunDeps(null));

describe('the body', () => {
  it('takes the seven languages, one to eight files, plain relative names, 64 KB in all, an entrypoint among them', () => {
    const ok = { runId: 'abcdefgh', language: 'go', files: [{ path: 'src/main.go', content: 'x' }], entrypoint: 'src/main.go' };
    expect(checkRunBody(ok)).toMatchObject({ ok: true, body: { stdin: null } });
    expect(checkRunBody({ ...ok, limits: { wallMs: 999_999 } })).toMatchObject({ ok: true });
    const bad = (b: unknown) => { const c = checkRunBody(b); return c.ok ? null : c.error; };
    expect(bad({ ...ok, runId: 'short' })).toMatch(/id/);
    expect(bad({ ...ok, runId: 'has:colon:in-it' })).toMatch(/id/);
    expect(bad({ ...ok, language: 'rust' })).toMatch(/languages the pad offers/);
    expect(bad({ ...ok, files: [] })).toMatch(/one to 8 files/);
    expect(bad({ ...ok, files: Array.from({ length: 9 }, (_, i) => ({ path: `f${i}.go`, content: '' })) })).toMatch(/one to 8/);
    expect(bad({ ...ok, files: [{ path: '../etc/passwd', content: '' }], entrypoint: '../etc/passwd' })).toMatch(/plain relative/);
    expect(bad({ ...ok, files: [{ path: '/abs.go', content: '' }], entrypoint: '/abs.go' })).toMatch(/plain relative/);
    expect(bad({ ...ok, files: [{ path: 'a.go', content: 'x'.repeat(64 * 1024 + 1) }], entrypoint: 'a.go' })).toMatch(/64 KB/);
    expect(bad({ ...ok, entrypoint: 'other.go' })).toMatch(/which of the files/);
    expect(bad({ ...ok, files: [{ path: 'a.go', content: 1 }] })).toMatch(/name and its text/);
    expect(bad({ ...ok, stdin: 5 })).toMatch(/input must be text/);
    expect(bad(null)).toMatch(/id/);
    expect([plainPath('a/b.c'), plainPath('a/./b'), plainPath('a\\b'), plainPath('.hidden')]).toEqual([true, false, false, false]);
  });
});

describe('the queue', () => {
  it('starts a run at once, the next waits as queued, and it starts when the first ends', async () => {
    const a = await startRun(IV, HUGO, body());
    const b = await startRun(IV, CANDIDATE, body({ language: 'java', files: [{ path: 'Main.java', content: 'x' }], entrypoint: 'Main.java' }));
    await flush();
    expect([a.kind, b.kind]).toEqual(['created', 'created']);
    expect(ex.runs.length).toBe(1);
    expect((await row('run-0002')).status).toBe('queued');
    ex.runs[0]!.emit({ type: 'event', stream: 'status', data: 'running' });
    ex.runs[0]!.emit({ type: 'event', stream: 'stdout', data: 'hi\n' });
    ex.runs[0]!.emit({ type: 'result', result: ex.result('succeeded', ex.runs[0]!.request, { stdout: 'hi\n' }) });
    await until(() => ex.runs.length === 2);
    expect(ex.runs[1]!.request).toMatchObject({ runId: 'run-0002', language: 'java', interviewId: IV, limits: { wallMs: 10_000, memoryMb: 256, maxOutputBytes: 64 } });
    const first = await row('run-0001');
    expect(first).toMatchObject({ status: 'succeeded', startedBy: HUGO, files: [{ path: 'main.py', bytes: 11 }], source: [{ path: 'main.py', content: 'print("hi")' }] });
    expect(first.events.map((e) => [e.seq, e.stream, e.data])).toEqual([[1, 'status', 'queued'], [2, 'status', 'running'], [3, 'stdout', 'hi\n'], [4, 'status', 'succeeded']]);
    expect(first.startedAt).not.toBeNull();
    expect(first.result?.backend).toBe('hand');
  });

  it('a repeat of a runId returns the first run and starts nothing (and holds nothing)', async () => {
    const b = body();
    await startRun(IV, HUGO, b);
    const again = await startRun(IV, HUGO, { ...b, language: 'go' });
    expect(again.kind).toBe('repeat');
    expect(again.kind === 'repeat' && again.run.language).toBe('python');
    await flush();
    expect(ex.runs.length).toBe(1);
    expect(money.reserve).toHaveBeenCalledTimes(1);
  });

  it(`refuses the ${MAX_RUNS_PER_INTERVIEW + 1}st run of an interview, whatever became of the others, and holds nothing for it`, async () => {
    ex.answerCancel = true;
    for (let i = 0; i < MAX_RUNS_PER_INTERVIEW; i++) await startRun(IV, HUGO, body());
    expect((await startRun(IV, HUGO, body())).kind).toBe('limit');
    expect(money.reserve).toHaveBeenCalledTimes(MAX_RUNS_PER_INTERVIEW);
    expect((await startRun('iv-c3k8w2ma', HUGO, body())).kind).toBe('created');
  });

  it('lists newest first; lastRun is the newest', async () => {
    await startRun(IV, HUGO, body());
    now += 1000;
    await startRun(IV, HUGO, body());
    expect((await listRuns(IV)).map((r) => r.runId)).toEqual(['run-0002', 'run-0001']);
    expect((await lastRun(IV))?.runId).toBe('run-0002');
    expect(await lastRun('iv-none')).toBeNull();
  });

  it('a runner_timeout (the program never started) is the runner\'s failure: the money goes back, nothing is settled', async () => {
    await startRun(IV, HUGO, body());
    await flush();
    ex.runs[0]!.emit({ type: 'result', result: ex.result('runner_timeout', ex.runs[0]!.request) });
    await runsSettled(IV);
    expect((await row('run-0001')).result?.status).toBe('runner_timeout');
    expect(money.release).toHaveBeenCalledWith(['h-run-0001']);
    expect(money.settle).not.toHaveBeenCalled();
  });

  it('a result the store refuses still settles the money: a runner_timeout gives the hold back', async () => {
    const refusing = new MemoryRunStore();
    refusing.finishRun = async () => { throw new Error('status rule refused the row'); };
    setRunDeps(deps({ store: () => refusing }));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await startRun(IV, HUGO, body());
    await flush();
    ex.runs[0]!.emit({ type: 'result', result: ex.result('runner_timeout', ex.runs[0]!.request) });
    await runsSettled(IV);
    warn.mockRestore();
    expect(money.release).toHaveBeenCalledWith(['h-run-0001']);
    expect(money.settle).not.toHaveBeenCalled();
    expect(ex.runs.length).toBe(1);
  });

  it('a queued cancel the store refuses still gives the money back, and that run is never started', async () => {
    const refusing = new MemoryRunStore();
    refusing.finishRun = async () => { throw new Error('store down'); };
    setRunDeps(deps({ store: () => refusing }));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await startRun(IV, HUGO, body());
    await startRun(IV, HUGO, body());
    await flush();
    await expect(cancelRun(IV, 'run-0002')).rejects.toThrow('store down');
    expect(money.release).toHaveBeenCalledWith(['h-run-0002']);
    ex.runs[0]!.emit({ type: 'result', result: ex.result('succeeded', ex.runs[0]!.request) });
    await runsSettled(IV);
    warn.mockRestore();
    expect(ex.runs.length).toBe(1);
  });

  it('a start that throws is an internal_error, and the queue moves on', async () => {
    ex.throwOnStart = true;
    await startRun(IV, HUGO, body());
    await runsSettled(IV);
    expect((await row('run-0001')).result?.status).toBe('internal_error');
    expect(money.release).toHaveBeenCalledWith(['h-run-0001']);
  });
});

describe('cancel, in each state', () => {
  it('while queued: never reaches the executor; the money goes back', async () => {
    await startRun(IV, HUGO, body());
    await startRun(IV, HUGO, body());
    await flush();
    const out = await cancelRun(IV, 'run-0002');
    expect(out.kind === 'ok' && out.run).toMatchObject({ status: 'cancelled', startedAt: null, result: { status: 'cancelled', backend: 'hand', runtimeVersion: 'P 1' } });
    expect(money.release).toHaveBeenCalledWith(['h-run-0002']);
    ex.runs[0]!.emit({ type: 'result', result: ex.result('succeeded', ex.runs[0]!.request) });
    await runsSettled(IV);
    expect(ex.runs.length).toBe(1);
  });

  it('while compiling: the executor is asked; the money goes back (it never ran)', async () => {
    await startRun(IV, HUGO, body({ language: 'swift', files: [{ path: 'main.swift', content: '' }], entrypoint: 'main.swift' }));
    await flush();
    ex.runs[0]!.emit({ type: 'event', stream: 'status', data: 'compiling' });
    const out = await cancelRun(IV, 'run-0001');
    expect(ex.runs[0]!.cancels).toBe(1);
    expect(out.kind === 'ok' && out.run.status).toBe('cancelled');
    expect(money.release).toHaveBeenCalledWith(['h-run-0001']);
    expect(money.settle).not.toHaveBeenCalled();
  });

  it('while running: the executor is asked; the run is paid for', async () => {
    await startRun(IV, HUGO, body());
    await flush();
    ex.runs[0]!.emit({ type: 'event', stream: 'status', data: 'running' });
    const out = await cancelRun(IV, 'run-0001');
    expect(out.kind === 'ok' && out.run.status).toBe('cancelled');
    expect(money.settle).toHaveBeenCalledWith(expect.objectContaining({ sourceId: `iv:op-backend:${IV}:run:run-0001`, costUsd: 0.0017, basis: 'estimated', provider: 'local' }));
  });

  it('an executor that does not answer the cancel is written cancelled by the service', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    try {
      ex.answerCancel = false;
      await startRun(IV, HUGO, body());
      await flush();
      ex.runs[0]!.emit({ type: 'event', stream: 'status', data: 'running' });
      const pending = cancelRun(IV, 'run-0001');
      await flush();
      await jest.advanceTimersByTimeAsync(3_100);
      const out = await pending;
      expect(out.kind === 'ok' && out.run.result?.status).toBe('cancelled');
    } finally {
      jest.useRealTimers();
    }
  });

  it('a finished run is answered as it is; an unknown one is not found', async () => {
    await startRun(IV, HUGO, body());
    await flush();
    ex.runs[0]!.emit({ type: 'result', result: ex.result('failed', ex.runs[0]!.request, { exitCode: 1 }) });
    await runsSettled(IV);
    const out = await cancelRun(IV, 'run-0001');
    expect(out.kind === 'ok' && out.run.status).toBe('failed');
    expect((await cancelRun(IV, 'run-none-here')).kind).toBe('not-found');
    expect((await cancelRun('iv-c3k8w2ma', 'run-0001')).kind).toBe('not-found');
  });
});

describe('the safeguards', () => {
  it('a run that outlives the wall time (plus the compile allowance and grace) is timed_out, whatever comes later', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    try {
      await startRun(IV, HUGO, body());
      await flush();
      ex.runs[0]!.emit({ type: 'event', stream: 'status', data: 'running' });
      await jest.advanceTimersByTimeAsync(10_000 + COMPILE_ALLOWANCE_MS + WALL_GRACE_MS + 10);
      await runsSettled(IV);
      ex.runs[0]!.emit({ type: 'result', result: ex.result('succeeded', ex.runs[0]!.request) });
      const r = await row('run-0001');
      expect(r.result?.status).toBe('timed_out');
      expect(ex.runs[0]!.cancels).toBe(1);
      expect(r.events.filter((e) => e.stream === 'status').map((e) => e.data)).toEqual(['queued', 'running', 'timed_out']);
    } finally {
      jest.useRealTimers();
    }
  });

  it('cuts a stream at the limit whatever the executor sends, and keeps one result', async () => {
    await startRun(IV, HUGO, body());
    await flush();
    const e = ex.runs[0]!;
    e.emit({ type: 'event', stream: 'status', data: 'running' });
    e.emit({ type: 'event', stream: 'stdout', data: 'a'.repeat(50) });
    e.emit({ type: 'event', stream: 'stdout', data: 'b'.repeat(50) });
    e.emit({ type: 'event', stream: 'stdout', data: 'c' });
    e.emit({ type: 'event', stream: 'stderr', data: 'err' });
    e.emit({ type: 'event', stream: 'status', data: 'bogus' });
    e.emit({ type: 'result', result: ex.result('succeeded', e.request) });
    e.emit({ type: 'result', result: ex.result('failed', e.request) });
    await runsSettled(IV);
    const r = await row('run-0001');
    expect(r.events.filter((x) => x.stream === 'stdout').map((x) => x.data).join('')).toBe(`${'a'.repeat(50)}${'b'.repeat(14)}`);
    expect(r.events.filter((x) => x.stream === 'stderr').map((x) => x.data)).toEqual(['err']);
    expect(r.result?.status).toBe('succeeded');
    expect(money.settle).toHaveBeenCalledTimes(1);
  });

  it('a restart: runs left queued, compiling or running become internal_error and give their money back', async () => {
    await startRun(IV, HUGO, body());
    await startRun(IV, HUGO, body());
    await flush();
    ex.runs[0]!.emit({ type: 'event', stream: 'status', data: 'running' });
    await new Promise((r) => setTimeout(r, 10));
    // A new process: nothing in flight is held in memory any more.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    setRunDeps(deps());
    await ensureRecovered();
    warn.mockRestore();
    expect((await row('run-0001')).result?.status).toBe('internal_error');
    expect((await row('run-0002')).result?.status).toBe('internal_error');
    expect((await row('run-0001')).events.at(-1)).toMatchObject({ stream: 'status', data: 'internal_error' });
    expect(money.release).toHaveBeenCalledWith(['h-run-0001']);
    expect(money.release).toHaveBeenCalledWith(['h-run-0002']);
  });
});

describe('money (decision 18)', () => {
  it('holds the run\'s price as part `run`, keyed by the runId, before it is queued; settles it when it ends', async () => {
    await startRun(IV, CANDIDATE, body());
    expect(money.reserve).toHaveBeenCalledWith(expect.objectContaining({ interviewId: IV, part: 'run', key: 'run-0001', estimateUsd: 0.0017 }));
    await flush();
    ex.runs[0]!.emit({ type: 'event', stream: 'status', data: 'running' });
    ex.runs[0]!.emit({ type: 'result', result: ex.result('succeeded', ex.runs[0]!.request) });
    await runsSettled(IV);
    // The candidate is not an account: the ledger row names nobody.
    expect(money.settle).toHaveBeenCalledWith(expect.objectContaining({ costUsd: 0.0017, actorId: null, model: 'hand-executor' }));
    expect(money.release).not.toHaveBeenCalled();
  });

  it('a refused hold (an opening with no cap, a cap reached) queues nothing and stores nothing', async () => {
    money.reserve.mockResolvedValueOnce({ ok: false, refusal: { status: 403, body: { error: 'This opening has no spending cap yet, so nothing that costs money can start in its interviews.' } } });
    const out = await startRun(IV, HUGO, body());
    expect(out).toEqual({ kind: 'refused', refusal: { status: 403, body: { error: expect.stringMatching(/no spending cap/) } } });
    expect(await store.listRuns(IV)).toEqual([]);
    await flush();
    expect(ex.runs.length).toBe(0);
  });

  it('the price is a setting', () => {
    expect(runPriceUsd({})).toBe(0.0017);
    expect(runPriceUsd({ INTERVIEWS_RUN_PRICE_USD: '0.01' })).toBe(0.01);
    expect(runPriceUsd({ INTERVIEWS_RUN_PRICE_USD: 'free' })).toBe(0.0017);
  });
});

describe('the events', () => {
  it('reach every open reader in order, and a reader that reconnects with the last id gets what it missed', async () => {
    const a: RunEvent[] = [];
    const stopA = await openRunEvents(IV, null, (e) => a.push(e));
    await startRun(IV, HUGO, body());
    await startRun(IV, CANDIDATE, body());
    await flush();
    const e0 = ex.runs[0]!;
    e0.emit({ type: 'event', stream: 'status', data: 'running' });
    e0.emit({ type: 'event', stream: 'stdout', data: 'one\n' });
    const seenBefore = a.length;
    stopA();
    e0.emit({ type: 'event', stream: 'stdout', data: 'two\n' });
    e0.emit({ type: 'result', result: ex.result('succeeded', e0.request) });
    await until(async () => ex.runs.length === 2 && (await row('run-0001')).result !== null);
    expect(a.map((e) => `${e.runId}:${e.seq} ${e.stream} ${e.data}`)).toEqual([
      'run-0001:1 status queued', 'run-0002:1 status queued', 'run-0001:2 status running', 'run-0001:3 stdout one\n',
    ]);
    const last = a[seenBefore - 1]!;
    const b: RunEvent[] = [];
    const stopB = await openRunEvents(IV, `${last.runId}:${last.seq}`, (e) => b.push(e));
    expect(b.map((e) => `${e.runId}:${e.seq} ${e.data}`)).toEqual(['run-0001:4 two\n', 'run-0001:5 succeeded']);
    // Unknown id: everything from the start.
    const c: RunEvent[] = [];
    const stopC = await openRunEvents(IV, 'run-none:9', (e) => c.push(e));
    expect(c[0]).toMatchObject({ runId: 'run-0001', seq: 1, data: 'queued' });
    expect(Object.keys(c[0]!).sort()).toEqual(['at', 'data', 'runId', 'seq', 'stream']);
    stopB(); stopC();
  });

  it('a reader sees each event once, even one emitted while it was catching up', async () => {
    await startRun(IV, HUGO, body());
    await flush();
    const got: string[] = [];
    const opening = openRunEvents(IV, null, (e) => got.push(`${e.runId}:${e.seq}`));
    ex.runs[0]!.emit({ type: 'event', stream: 'status', data: 'running' });
    const stop = await opening;
    ex.runs[0]!.emit({ type: 'event', stream: 'stdout', data: 'x' });
    expect(got).toEqual(['run-0001:1', 'run-0001:2', 'run-0001:3']);
    stop();
  });
});

describe('views', () => {
  it('the guest\'s view names no panel member', async () => {
    await startRun(IV, HUGO, body());
    const r = (await getRun(IV, 'run-0001'))!;
    expect(guestRunView(r).startedBy).toEqual({ id: 'panel', name: 'Interviewer', side: 'panel' });
    await startRun(IV, CANDIDATE, body());
    expect(guestRunView((await getRun(IV, 'run-0002'))!).startedBy).toEqual(CANDIDATE);
  });
});

// The executor contract (docs/interviews-tenant-plan.md "I4.6 answer", "What both must pass"; row I4.4): one function,
// run unchanged against each backend. mock-executor.test.ts calls it with the mock and its marker programs; a real
// backend (rows I4.7–I4.9) calls it with its own factory and real programs that do what each name says.
//
// Two parts. The executor alone: each terminal status, truncation, cancel while compiling and while running, and
// `runtimeVersion` and `backend` on every result. Through the service (lib/interviews/runs/service.ts, over the memory
// store, money stubbed): a repeat of a runId, one run at a time with the next `queued`, the 61st refused, and cancel
// while queued. The hostile programs are skipped tests named for what only a real backend can prove.
import {
  COMPILED_LANGUAGES, RUN_LANGUAGES, type Executor, type ExecutorOutput, type RunFile, type RunLanguage, type RunLimits, type RunRequest, type RunResult,
} from '../executor.js';
import { MemoryRunStore } from '../store.js';
import { cancelRun, getRun, MAX_RUNS_PER_INTERVIEW, runsSettled, setRunDeps, startRun, type RunBody } from '../service.js';

export interface ContractProgram { files: RunFile[]; entrypoint: string }

export interface ContractPrograms {
  /** Prints `hello` and then `world`, each on its own line, and exits 0. */
  hello(language: RunLanguage): ContractProgram;
  /** Exits non-zero with something on stderr. */
  fail(language: RunLanguage): ContractProgram;
  /** Does not compile (compiled languages only). */
  compileError(language: RunLanguage): ContractProgram;
  /** Never ends on its own (prints nothing more after it starts). */
  forever(language: RunLanguage): ContractProgram;
  /** Allocates past the memory limit. */
  memory(language: RunLanguage): ContractProgram;
  /** Prints far more than `maxOutputBytes` to stdout, then exits 0. */
  flood(language: RunLanguage): ContractProgram;
}

export interface ContractOptions {
  /** A new executor for each test. */
  make: () => Executor;
  programs: ContractPrograms;
  /** An executor and program whose run hits a service failure (an injected one is fine). */
  internalError: (language: RunLanguage) => { executor: Executor; program: ContractProgram };
  /** The languages this backend runs. Default: all seven. */
  languages?: readonly RunLanguage[];
  limits?: RunLimits;
  /** Per test, for a real backend's cold starts. */
  timeoutMs?: number;
}

export interface Collected { events: Extract<ExecutorOutput, { type: 'event' }>[]; result: RunResult; results: number }

let n = 0;
export function requestOf(language: RunLanguage, p: ContractProgram, limits: RunLimits): RunRequest {
  return { runId: `contract-${++n}-${language}`, interviewId: 'iv-contract', language, files: p.files, entrypoint: p.entrypoint, limits };
}

/** Run one request to its result; `onEvent` may cancel through the handle it is given. */
export function collect(executor: Executor, request: RunRequest, onEvent?: (e: Extract<ExecutorOutput, { type: 'event' }>, cancel: () => void) => void): Promise<Collected> {
  return new Promise((resolve) => {
    const events: Collected['events'] = [];
    let results = 0;
    let handle: { cancel(): void } | null = null;
    let early = false;
    const cancel = () => { if (handle) handle.cancel(); else early = true; };
    handle = executor.start(request, (o) => {
      if (o.type === 'event') { events.push(o); onEvent?.(o, cancel); return; }
      results += 1;
      // Let any late emit arrive before answering, so a second result would be counted.
      setTimeout(() => resolve({ events, result: o.result, results }), 20);
    });
    if (early) handle.cancel();
  });
}

const statuses = (c: Collected) => c.events.filter((e) => e.stream === 'status').map((e) => e.data);
const out = (c: Collected, stream: 'stdout' | 'stderr') => c.events.filter((e) => e.stream === stream).map((e) => e.data).join('');

export function executorContract(name: string, o: ContractOptions): void {
  const languages = o.languages ?? RUN_LANGUAGES;
  const limits: RunLimits = o.limits ?? { wallMs: 10_000, memoryMb: 256, maxOutputBytes: 64 * 1024 };
  const compiled = languages.filter((l) => COMPILED_LANGUAGES.includes(l));
  const t = o.timeoutMs ?? 5_000;

  const versioned = (r: RunResult, ex: Executor, lang: RunLanguage) => {
    expect(r.backend).toBe(ex.backend);
    expect(r.runtimeVersion).toBe(ex.runtimeVersions[lang]);
    expect(r.runtimeVersion.length).toBeGreaterThan(0);
  };

  describe(`the executor contract: ${name}`, () => {
    describe.each(languages.map((l) => [l]))('%s', (lang) => {
      it('succeeded: prints in order to stdout, exit 0, one result', async () => {
        const ex = o.make();
        const c = await collect(ex, requestOf(lang, o.programs.hello(lang), limits));
        expect(c.result.status).toBe('succeeded');
        expect(c.result.exitCode).toBe(0);
        expect(c.result.stdout).toBe('hello\nworld\n');
        expect(out(c, 'stdout')).toBe('hello\nworld\n');
        expect(c.results).toBe(1);
        expect(statuses(c).at(-1)).toBe('running');
        if (COMPILED_LANGUAGES.includes(lang)) expect(statuses(c)).toEqual(['compiling', 'running']);
        versioned(c.result, ex, lang);
      }, t);

      it('failed: a non-zero exit with stderr', async () => {
        const ex = o.make();
        const c = await collect(ex, requestOf(lang, o.programs.fail(lang), limits));
        expect(c.result.status).toBe('failed');
        expect(c.result.exitCode).not.toBe(0);
        expect(c.result.exitCode).not.toBeNull();
        expect(c.result.stderr.length).toBeGreaterThan(0);
        versioned(c.result, ex, lang);
      }, t);

      it('timed_out at the wall time', async () => {
        const ex = o.make();
        const c = await collect(ex, requestOf(lang, o.programs.forever(lang), { ...limits, wallMs: Math.min(limits.wallMs, 3_000) }));
        expect(c.result.status).toBe('timed_out');
        versioned(c.result, ex, lang);
      }, t + 5_000);

      it('memory_exceeded past the memory limit', async () => {
        const ex = o.make();
        const c = await collect(ex, requestOf(lang, o.programs.memory(lang), limits));
        expect(c.result.status).toBe('memory_exceeded');
        versioned(c.result, ex, lang);
      }, t);

      it('truncation: output past maxOutputBytes is cut and flagged, and the run goes on to its own end', async () => {
        const ex = o.make();
        const small = { ...limits, maxOutputBytes: 4096 };
        const c = await collect(ex, requestOf(lang, o.programs.flood(lang), small));
        expect(c.result.status).toBe('succeeded');
        expect(c.result.truncated.stdout).toBe(true);
        expect(Buffer.byteLength(c.result.stdout)).toBeLessThanOrEqual(4096);
        expect(Buffer.byteLength(out(c, 'stdout'))).toBeLessThanOrEqual(4096);
        versioned(c.result, ex, lang);
      }, t);

      it('cancelled while running', async () => {
        const ex = o.make();
        const c = await collect(ex, requestOf(lang, o.programs.forever(lang), limits), (e, cancel) => { if (e.stream === 'status' && e.data === 'running') cancel(); });
        expect(c.result.status).toBe('cancelled');
        expect(c.results).toBe(1);
        versioned(c.result, ex, lang);
      }, t);

      it('internal_error on a service failure', async () => {
        const { executor, program } = o.internalError(lang);
        const c = await collect(executor, requestOf(lang, program, limits));
        expect(c.result.status).toBe('internal_error');
        versioned(c.result, executor, lang);
      }, t);
    });

    if (compiled.length) {
      describe.each(compiled.map((l) => [l]))('%s, compiled', (lang) => {
        it('compile_error, with the compiler\'s words in compileOutput', async () => {
          const ex = o.make();
          const c = await collect(ex, requestOf(lang, o.programs.compileError(lang), limits));
          expect(c.result.status).toBe('compile_error');
          expect(c.result.compileOutput.length).toBeGreaterThan(0);
          expect(statuses(c)).toEqual(['compiling']);
          versioned(c.result, ex, lang);
        }, t);

        it('cancelled while compiling', async () => {
          const ex = o.make();
          const c = await collect(ex, requestOf(lang, o.programs.hello(lang), limits), (e, cancel) => { if (e.stream === 'status' && e.data === 'compiling') cancel(); });
          expect(c.result.status).toBe('cancelled');
          expect(statuses(c)).toEqual(['compiling']);
          versioned(c.result, ex, lang);
        }, t);
      });
    }

    describe('through the service (the queue is held outside the executor)', () => {
      const lang = languages[0]!;
      const store = new MemoryRunStore();
      const IV = 'iv-contract-queue';
      const ME = { id: 'u-contract', name: 'Contract', side: 'panel' as const };
      let k = 0;
      const body = (p: ContractProgram): RunBody => ({ runId: `contract-run-${++k}`, language: lang, files: p.files, entrypoint: p.entrypoint, stdin: null });
      beforeEach(async () => {
        await store.eraseRuns([IV]);
        setRunDeps({
          store: () => store, executor: o.make, limits: () => limits, priceUsd: () => 0,
          reserve: async (i) => ({ ok: true, holdId: `h-${i.key}`, sourceId: `iv:op:${i.interviewId}:run:${i.key}`, amountUsd: 0 }),
          settle: async () => undefined, release: async () => undefined,
        });
      });
      afterAll(() => setRunDeps(null));

      it('a repeat of a runId returns the first run and starts nothing', async () => {
        const b = body(o.programs.hello(lang));
        const first = await startRun(IV, ME, b);
        const again = await startRun(IV, ME, { ...b, files: o.programs.fail(lang).files });
        expect(first.kind).toBe('created');
        expect(again.kind).toBe('repeat');
        await runsSettled(IV);
        expect((await store.listRuns(IV)).length).toBe(1);
        expect((await getRun(IV, b.runId))?.result?.status).toBe('succeeded');
      }, t);

      it('one run at a time per interview: a second waits as queued, then runs', async () => {
        const a = body(o.programs.forever(lang));
        const b = body(o.programs.hello(lang));
        await startRun(IV, ME, a);
        await startRun(IV, ME, b);
        expect((await store.getRun(IV, b.runId))?.status).toBe('queued');
        await cancelRun(IV, a.runId);
        await runsSettled(IV);
        expect((await store.getRun(IV, a.runId))?.result?.status).toBe('cancelled');
        expect((await store.getRun(IV, b.runId))?.result?.status).toBe('succeeded');
      }, t);

      it('cancel while queued: it never reaches the executor', async () => {
        const a = body(o.programs.forever(lang));
        const b = body(o.programs.hello(lang));
        await startRun(IV, ME, a);
        await startRun(IV, ME, b);
        const c = await cancelRun(IV, b.runId);
        expect(c.kind === 'ok' && c.run.result?.status).toBe('cancelled');
        expect(c.kind === 'ok' && c.run.startedAt).toBeNull();
        await cancelRun(IV, a.runId);
        await runsSettled(IV);
        expect((await store.getRun(IV, b.runId))?.events.map((e) => e.data)).toEqual(['queued', 'cancelled']);
      }, t);

      it(`the ${MAX_RUNS_PER_INTERVIEW + 1}st run is refused`, async () => {
        for (let i = 0; i < MAX_RUNS_PER_INTERVIEW; i++) {
          expect((await startRun(IV, ME, body(o.programs.hello(lang)))).kind).toBe('created');
        }
        expect((await startRun(IV, ME, body(o.programs.hello(lang)))).kind).toBe('limit');
        await runsSettled(IV);
        expect((await store.listRuns(IV)).every((r) => r.result?.status === 'succeeded')).toBe(true);
      }, t * 6);
    });

    describe('hostile programs (only a real backend proves these; written in the plan by hand per backend)', () => {
      it.skip('a fork bomb ends in failed or memory_exceeded within the wall time and leaves the next run unaffected', () => undefined);
      it.skip('a socket to an outside address fails', () => undefined);
      it.skip('a DNS lookup fails', () => undefined);
      it.skip('a connection to the metadata address (169.254.169.254) fails', () => undefined);
      it.skip('a write outside the working directory fails', () => undefined);
      it.skip('a file written inside the working directory is gone in the next run', () => undefined);
      it.skip('an output flood is cut and stopped (the process is stopped, not only its output dropped)', () => undefined);
    });
  });
}

// The queue and the run service (docs/interviews-tenant-plan.md decisions 13 and 18, "The run interface", "I4.6 answer"
// "What I4.4 must expose"; row I4.4; contract U4).
//
// Held here, outside the executor, so every backend gets them unchanged:
//   * the run row keyed by (interview, runId): a repeat of a runId returns the first run and starts nothing;
//   * 60 runs per interview (any outcome counts); the 61st is refused;
//   * one run at a time per interview: a run waits as `queued` until the one before it ends, oldest first;
//   * money (decision 18): each run is held against the opening as part `run` BEFORE it is queued; a refused hold queues
//     nothing. When it ends the hold is settled at the run's price, except that a run cancelled before it reached
//     `running` (while queued or compiling) and a run that ended in `internal_error` or `runner_timeout` give the money back (both
//     are the runner's failure: the candidate's program never started, so nobody is charged for it);
//   * cancel while queued (never reaches the executor), compiling or running (the executor is asked to stop; if it does
//     not answer within CANCEL_GRACE_MS the service writes `cancelled` itself);
//   * the wall-time safeguard: a run that outlives the wall time plus the compile allowance and a grace is stopped and
//     written `timed_out` by the service, whatever the executor says later;
//   * the events: each one stamped with the run's `seq`, the time, and an order `n` across the whole interview, kept
//     with the run, and handed to every open reader of the interview at once. A reader that reconnects names the last
//     event it had (`<runId>:<seq>`) and gets everything after it;
//   * one result per run, written once; the money follows the result even when the store refuses to write it, and a run
//     whose result was not written is never started again by this process (a restart's recovery finishes its row);
//   * a restart loses what was in flight: the first use of the service in a process writes every run left `queued`,
//     `compiling` or `running` as `internal_error` and gives its money back (one middleware task: the gateway's
//     one-task safeguard already covers the pads; several tasks would need the per-interview lock in the table).
//
// Nothing here knows HTTP: routes/interviews/runs.ts and routes/interview-invite-runs.ts decide who may and check the
// body (checkRunBody below), this module runs and records.
import {
  DEFAULT_RUN_LIMITS, RUN_LANGUAGES, isTerminal, serviceResult,
  type Executor, type ExecutorOutput, type ExecutorRun, type RunLanguage, type RunLimits, type RunResult, type RunStatus, type RunStream,
} from './executor.js';
import { createRunExecutor } from './backend.js';
import { runStore, type RunPerson, type RunRecord, type RunStore, type StoredRunEvent } from './store.js';
import {
  releaseInterviewSpend, reserveInterviewSpend, settleInterviewSpend,
  type InterviewReserveInput, type InterviewReserveOutcome, type InterviewSettleInput,
} from '../spend.js';

/** The plan's 60 runs per interview. */
export const MAX_RUNS_PER_INTERVIEW = 60;
/** Most files in one run, and the most bytes of all of them together. */
export const MAX_RUN_FILES = 8;
export const MAX_RUN_SOURCE_BYTES = 64 * 1024;
export const MAX_RUN_STDIN_BYTES = 64 * 1024;
export const MAX_PATH_CHARS = 128;
/** Time a runner's start and a compile may take on top of the wall time before the safeguard stops the run. */
export const COMPILE_ALLOWANCE_MS = 40_000;
export const WALL_GRACE_MS = 5_000;
export const CANCEL_GRACE_MS = 3_000;
/** A run's hold expires on its own after this (a full queue of runs ahead of it fits). */
export const RUN_HOLD_MS = 30 * 60_000;

/** I3.9's worst case for one run (a compiled run of 30 seconds on 2 vCPU and 2 GB): about $0.0017. */
export const DEFAULT_RUN_PRICE_USD = 0.0017;
export const RUN_PRICE_SETTING = 'INTERVIEWS_RUN_PRICE_USD';
/** `INTERVIEWS_RUN_PRICE_USD`: dollars held and booked per run on the mock executor, a non-negative number. */
export function runPriceUsd(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env[RUN_PRICE_SETTING] ?? '').trim();
  const n = raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_RUN_PRICE_USD;
}

// ── Views ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** U4's view of a run. */
export interface RunView {
  runId: string;
  language: string;
  status: RunStatus;
  startedBy: RunPerson;
  queuedAt: string;
  startedAt: string | null;
  endedAt: string | null;
  result: RunResult | null;
}

/** U4's event, as the stream sends it (`id: <runId>:<seq>`). */
export interface RunEvent { runId: string; seq: number; stream: RunStream; data: string; at: string }

export function runView(r: RunRecord): RunView {
  return { runId: r.runId, language: r.language, status: r.status, startedBy: { ...r.startedBy }, queuedAt: r.queuedAt, startedAt: r.startedAt, endedAt: r.endedAt, result: r.result };
}

/** What the candidate reads: the same run, with no panel member named. */
export const PANEL_STAND_IN: RunPerson = { id: 'panel', name: 'Interviewer', side: 'panel' };
export function guestRunView(r: RunRecord): RunView {
  const v = runView(r);
  return v.startedBy.side === 'panel' ? { ...v, startedBy: { ...PANEL_STAND_IN } } : v;
}

export const eventId = (e: Pick<RunEvent, 'runId' | 'seq'>): string => `${e.runId}:${e.seq}`;

// ── The body ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface RunBody { runId: string; language: RunLanguage; files: { path: string; content: string }[]; entrypoint: string; stdin: string | null }
export type BodyCheck = { ok: true; body: RunBody } | { ok: false; error: string };

const RUN_ID = /^[A-Za-z0-9_-]{8,80}$/;
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const bytes = (s: string): number => Buffer.byteLength(s, 'utf8');

/** A plain relative name: segments of letters, digits, dots, dashes and underscores, no `..`, no leading `/`. */
export function plainPath(path: string): boolean {
  if (!path || path.length > MAX_PATH_CHARS || path.startsWith('/') || path.includes('\\')) return false;
  return path.split('/').every((seg) => seg !== '.' && seg !== '..' && SEGMENT.test(seg));
}

/** The body of a start, checked. Limits are never read from it. */
export function checkRunBody(raw: unknown): BodyCheck {
  const b = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  if (typeof b['runId'] !== 'string' || !RUN_ID.test(b['runId'])) return { ok: false, error: 'Each run needs its own id of 8 to 80 letters, digits, dashes or underscores.' };
  if (typeof b['language'] !== 'string' || !RUN_LANGUAGES.includes(b['language'] as RunLanguage)) {
    return { ok: false, error: 'Choose one of the languages the pad offers: Python, Swift, JavaScript, TypeScript, Java, Go or C++.' };
  }
  const files = b['files'];
  if (!Array.isArray(files) || files.length < 1 || files.length > MAX_RUN_FILES) return { ok: false, error: `A run takes one to ${MAX_RUN_FILES} files.` };
  const seen = new Set<string>();
  let total = 0;
  const clean: RunBody['files'] = [];
  for (const f of files as unknown[]) {
    const o = (f && typeof f === 'object' ? f : {}) as Record<string, unknown>;
    if (typeof o['path'] !== 'string' || typeof o['content'] !== 'string') return { ok: false, error: 'Each file needs a name and its text.' };
    if (!plainPath(o['path'])) return { ok: false, error: 'File names must be plain relative names, without "..", a leading "/" or unusual characters.' };
    if (seen.has(o['path'])) return { ok: false, error: 'Two files have the same name.' };
    seen.add(o['path']);
    total += bytes(o['content']);
    clean.push({ path: o['path'], content: o['content'] });
  }
  if (total > MAX_RUN_SOURCE_BYTES) return { ok: false, error: 'The files are larger than 64 KB in all, so the run was not started.' };
  if (typeof b['entrypoint'] !== 'string' || !seen.has(b['entrypoint'])) return { ok: false, error: 'Say which of the files to run.' };
  const stdin = b['stdin'];
  if (stdin !== undefined && stdin !== null && typeof stdin !== 'string') return { ok: false, error: 'The input must be text.' };
  if (typeof stdin === 'string' && bytes(stdin) > MAX_RUN_STDIN_BYTES) return { ok: false, error: 'The input is larger than 64 KB, so the run was not started.' };
  return { ok: true, body: { runId: b['runId'], language: b['language'] as RunLanguage, files: clean, entrypoint: b['entrypoint'], stdin: typeof stdin === 'string' ? stdin : null } };
}

// ── Dependencies ──────────────────────────────────────────────────────────────────────────────────────────────────

export interface RunDeps {
  store: () => RunStore;
  executor: () => Executor;
  reserve: (i: InterviewReserveInput) => Promise<InterviewReserveOutcome>;
  settle: (i: InterviewSettleInput) => Promise<void>;
  release: (holdIds: readonly (string | null)[]) => Promise<void>;
  now: () => number;
  priceUsd: () => number;
  limits: () => RunLimits;
}

let defaultExecutor: Executor | null = null;
const DEFAULTS: RunDeps = {
  store: runStore,
  // The mock, unless INTERVIEWS_RUN_BACKEND=docker picks the Docker runner on a developer's machine (backend.ts).
  executor: () => (defaultExecutor ??= createRunExecutor()),
  reserve: reserveInterviewSpend,
  settle: settleInterviewSpend,
  release: releaseInterviewSpend,
  now: Date.now,
  priceUsd: () => runPriceUsd(),
  limits: () => DEFAULT_RUN_LIMITS,
};

let overrides: Partial<RunDeps> = {};
const deps = (): RunDeps => ({ ...DEFAULTS, ...overrides });

/** Tests: replace some dependencies; `null` puts every default back. Either way the in-process state starts again. */
export function setRunDeps(next: Partial<RunDeps> | null): void {
  overrides = next ?? {};
  resetRunService();
}

// ── In-process state ──────────────────────────────────────────────────────────────────────────────────────────────

interface Slot {
  interviewId: string;
  runId: string;
  language: RunLanguage;
  handle: ExecutorRun | null;
  status: RunStatus;
  seq: number;
  outBytes: { stdout: number; stderr: number };
  finished: boolean;
  cancelRequested: boolean;
  timers: ReturnType<typeof setTimeout>[];
  chain: Promise<unknown>;
  done: Promise<void>;
  resolveDone: () => void;
  /** Write this result (once) and move the queue on. */
  finish: (result: RunResult) => void;
}

type Listener = (e: RunEvent & { n: number }) => void;

let active = new Map<string, Slot | 'starting'>();
let counters = new Map<string, number>();
let pending = new Map<string, Map<number, RunEvent & { n: number }>>();
let listeners = new Map<string, Set<Listener>>();
let locks = new Map<string, Promise<unknown>>();
/**
 * Runs this process ended whose result row is not written yet (being written, or refused by the store), with that ending. The
 * queue never starts them, and every read shows them ended (`withEnding`), as the stream already does from the pending status
 * event, so a refused row never leaves a reader's run spinning; a restart's recovery ends them in the store.
 */
interface Ending { result: RunResult; endedAt: string; event: StoredRunEvent }
let endedHere = new Map<string, Ending>();
/** The waits before writing a result row again after the store refused it. */
const RESULT_WRITE_RETRY_MS = [200, 1000] as const;
let recovered: Promise<void> | null = null;

/** Tests: forget everything held in this process, as a restart would. */
export function resetRunService(): void {
  for (const s of active.values()) if (s !== 'starting') for (const t of s.timers) clearTimeout(t);
  active = new Map(); counters = new Map(); pending = new Map(); listeners = new Map(); locks = new Map();
  endedHere = new Map(); recovered = null; defaultExecutor = null;
}

const iso = (ms: number): string => new Date(ms).toISOString();
const slotKey = (interviewId: string, runId: string) => `${interviewId}\u0000${runId}`;

async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const before = locks.get(key) ?? Promise.resolve();
  const run = before.then(fn, fn);
  const tail = run.then(() => undefined, () => undefined);
  locks.set(key, tail);
  try { return await run; } finally { if (locks.get(key) === tail) locks.delete(key); }
}

async function counterFor(interviewId: string): Promise<void> {
  if (counters.has(interviewId)) return;
  const rows = await deps().store().listRuns(interviewId);
  if (counters.has(interviewId)) return;
  counters.set(interviewId, rows.reduce((m, r) => r.events.reduce((k, e) => Math.max(k, e.n), m), 0));
}

/** Stamp an event, keep it as pending until stored, and hand it to every open reader of the interview. */
function stamp(interviewId: string, runId: string, seq: number, stream: RunStream, data: string): StoredRunEvent {
  const n = (counters.get(interviewId) ?? 0) + 1;
  counters.set(interviewId, n);
  const e: StoredRunEvent = { seq, n, stream, data, at: iso(deps().now()) };
  const wire = { runId, seq, stream, data, at: e.at, n };
  let p = pending.get(interviewId);
  if (!p) pending.set(interviewId, (p = new Map()));
  p.set(n, wire);
  for (const l of listeners.get(interviewId) ?? []) { try { l(wire); } catch { /* a reader's failure is its own */ } }
  return e;
}
const stored = (interviewId: string, events: readonly StoredRunEvent[]) => { const p = pending.get(interviewId); for (const e of events) p?.delete(e.n); };

/** A row as readers see it: ended, when this process ended it and its result row is not written yet. */
function withEnding(r: RunRecord): RunRecord {
  const end = r.result === null ? endedHere.get(slotKey(r.interviewId, r.runId)) : undefined;
  return end ? { ...r, status: end.result.status, result: end.result, endedAt: end.endedAt, events: [...r.events, end.event] } : r;
}

/**
 * Write a run's ending: readers see it ended at once (endedHere), the row is written, and a refusal is tried again
 * (RESULT_WRITE_RETRY_MS). Resolves to the stored row, or rejects with the last refusal, leaving the ending held.
 */
async function writeEnding(interviewId: string, runId: string, result: RunResult, endedAt: string, event: StoredRunEvent): Promise<RunRecord | null> {
  const key = slotKey(interviewId, runId);
  endedHere.set(key, { result, endedAt, event });
  for (let attempt = 0; ; attempt += 1) {
    try {
      const done = await deps().store().finishRun(interviewId, runId, result, endedAt, [event]);
      stored(interviewId, [event]);
      endedHere.delete(key);
      return done;
    } catch (e) {
      const wait = RESULT_WRITE_RETRY_MS[attempt];
      if (wait === undefined) throw e;
      await new Promise<void>((r) => { const t = setTimeout(r, wait); t.unref?.(); });
    }
  }
}

// ── Recovery ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** The first use in a process: every run with no result was in flight in an earlier one. */
export function ensureRecovered(): Promise<void> {
  return (recovered ??= (async () => {
    const d = deps();
    const left = await d.store().listUnfinished();
    for (const r of left) {
      if (active.has(r.interviewId)) continue;
      await counterFor(r.interviewId);
      const result = serviceResult('internal_error', d.executor(), r.language);
      const e = stamp(r.interviewId, r.runId, (r.events.at(-1)?.seq ?? 0) + 1, 'status', 'internal_error');
      await d.store().finishRun(r.interviewId, r.runId, result, iso(d.now()), [e]);
      stored(r.interviewId, [e]);
      await d.release([r.holdId]).catch(() => undefined);
    }
    if (left.length) console.warn('[interviews] runs left in flight by a restart', left.length);
  })().catch((e) => { recovered = null; throw e; }));
}

// ── Start ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export type StartOutcome =
  | { kind: 'created'; run: RunRecord }
  | { kind: 'repeat'; run: RunRecord }
  | { kind: 'limit' }
  | { kind: 'refused'; refusal: { status: number; body: Record<string, unknown> } };

/** Queue a run for an interview the route has already checked. */
export async function startRun(interviewId: string, by: RunPerson, body: RunBody): Promise<StartOutcome> {
  await ensureRecovered();
  const d = deps();
  const out = await withLock(interviewId, async (): Promise<StartOutcome> => {
    const store = d.store();
    const had = await store.getRun(interviewId, body.runId);
    if (had) return { kind: 'repeat', run: had };
    if ((await store.countRuns(interviewId)) >= MAX_RUNS_PER_INTERVIEW) return { kind: 'limit' };
    const held = await d.reserve({ interviewId, part: 'run', key: body.runId, estimateUsd: d.priceUsd(), expiresInMs: RUN_HOLD_MS });
    if (!held.ok) return { kind: 'refused', refusal: held.refusal };
    await counterFor(interviewId);
    const queuedAt = iso(d.now());
    const first = stamp(interviewId, body.runId, 1, 'status', 'queued');
    const row: RunRecord = {
      interviewId, runId: body.runId, language: body.language, entrypoint: body.entrypoint,
      files: body.files.map((f) => ({ path: f.path, bytes: bytes(f.content) })), source: body.files.map((f) => ({ ...f })), stdin: body.stdin,
      startedBy: { ...by }, status: 'queued', queuedAt, startedAt: null, endedAt: null, result: null, events: [first],
      holdId: held.holdId, spendSourceId: held.sourceId,
    };
    const written = await store.insertRun(row);
    stored(interviewId, [first]);
    if (!written.ok) { await d.release([held.holdId]); return { kind: 'repeat', run: written.row }; }
    return { kind: 'created', run: written.row };
  });
  if (out.kind === 'created') void pump(interviewId);
  return out;
}

/** Start the oldest queued run when nothing of this interview is running. */
async function pump(interviewId: string): Promise<void> {
  if (active.has(interviewId)) return;
  active.set(interviewId, 'starting');
  try {
    const d = deps();
    const next = (await d.store().listRuns(interviewId)).find((r) => r.status === 'queued' && r.result === null && !endedHere.has(slotKey(interviewId, r.runId)));
    if (!next) { active.delete(interviewId); return; }
    begin(next);
  } catch (e) {
    active.delete(interviewId);
    console.warn('[interviews] run queue did not advance', (e as Error)?.name ?? 'error');
  }
}

function begin(row: RunRecord): void {
  const d = deps();
  const executor = d.executor();
  const limits = d.limits();
  const store = d.store();
  const { interviewId, runId } = row;
  let resolveDone: () => void = () => undefined;
  const slot: Slot = {
    interviewId, runId, language: row.language, handle: null, status: 'queued', seq: row.events.at(-1)?.seq ?? 1,
    outBytes: { stdout: 0, stderr: 0 }, finished: false, cancelRequested: false, timers: [], chain: Promise.resolve(),
    done: new Promise<void>((r) => { resolveDone = r; }), resolveDone: () => resolveDone(), finish: () => undefined,
  };
  active.set(interviewId, slot);
  const startedMs = d.now();

  const record = (stream: RunStream, data: string) => {
    const e = stamp(interviewId, runId, ++slot.seq, stream, data);
    slot.chain = slot.chain.then(() => store.appendEvents(interviewId, runId, [e])).then(() => stored(interviewId, [e]), () => undefined);
  };

  const finish = (result: RunResult) => {
    if (slot.finished) return;
    slot.finished = true;
    for (const t of slot.timers) clearTimeout(t);
    const reachedRunning = slot.status === 'running';
    const last = stamp(interviewId, runId, ++slot.seq, 'status', result.status);
    slot.chain = slot.chain.then(async () => {
      try {
        await writeEnding(interviewId, runId, result, iso(d.now()), last);
      } catch (e) {
        console.warn('[interviews] run result not stored', (e as Error)?.name ?? 'error');
      }
      try {
        const giveBack = result.status === 'internal_error' || result.status === 'runner_timeout' || (result.status === 'cancelled' && !reachedRunning);
        if (giveBack || !row.spendSourceId) await d.release([row.holdId]);
        else await d.settle({ sourceId: row.spendSourceId, costUsd: d.priceUsd(), basis: 'estimated', model: `${executor.backend}-executor`, actorId: row.startedBy.side === 'panel' ? row.startedBy.id : null, provider: 'local' });
      } catch (e) {
        console.warn('[interviews] run spend not booked', (e as Error)?.name ?? 'error');
      }
    }).finally(() => {
      if (active.get(interviewId) === slot) active.delete(interviewId);
      slot.resolveDone();
      void pump(interviewId);
    });
  };
  slot.finish = finish;

  const emit = (o: ExecutorOutput) => {
    if (slot.finished) return;
    if (o.type === 'result') {
      finish({ ...o.result, backend: executor.backend, runtimeVersion: o.result.runtimeVersion || executor.runtimeVersions[row.language] });
      return;
    }
    if (o.stream === 'status') {
      if (o.data !== 'compiling' && o.data !== 'running') return;
      if (slot.status === o.data || slot.status === 'running') return;
      slot.status = o.data;
      const at = iso(d.now());
      slot.chain = slot.chain.then(() => store.setStatus(interviewId, runId, o.data as 'compiling' | 'running', at)).catch(() => undefined);
      record('status', o.data);
      return;
    }
    // The service's own cut, under the executor's: no backend can flood the log or the readers.
    const room = limits.maxOutputBytes - slot.outBytes[o.stream];
    if (room <= 0 || !o.data) return;
    const piece = bytes(o.data) <= room ? o.data : Buffer.from(o.data).subarray(0, room).toString('utf8');
    slot.outBytes[o.stream] += bytes(piece);
    record(o.stream, piece);
  };

  // The wall-time safeguard.
  const wall = setTimeout(() => {
    if (slot.finished) return;
    finish(serviceResult('timed_out', executor, row.language, { timeMs: d.now() - startedMs }));
    try { slot.handle?.cancel(); } catch { /* it is written timed_out already */ }
  }, limits.wallMs + COMPILE_ALLOWANCE_MS + WALL_GRACE_MS);
  wall.unref?.();
  slot.timers.push(wall);

  try {
    slot.handle = executor.start({
      runId, interviewId, language: row.language, files: row.source.map((f) => ({ ...f })), entrypoint: row.entrypoint,
      ...(row.stdin !== null ? { stdin: row.stdin } : {}), limits: { ...limits },
    }, emit);
  } catch {
    finish(serviceResult('internal_error', executor, row.language));
    return;
  }
  if (slot.cancelRequested) requestCancel(slot);
}

function requestCancel(slot: Slot): void {
  slot.cancelRequested = true;
  if (slot.finished || !slot.handle) return;
  try { slot.handle.cancel(); } catch { /* the grace below ends it */ }
  const grace = setTimeout(() => {
    // The executor did not answer the cancel: the service writes it.
    if (!slot.finished) slot.finish(serviceResult('cancelled', deps().executor(), slot.language));
  }, CANCEL_GRACE_MS);
  grace.unref?.();
  slot.timers.push(grace);
}

// ── Read and cancel ───────────────────────────────────────────────────────────────────────────────────────────────

/** The interview's runs, newest first. */
export async function listRuns(interviewId: string): Promise<RunRecord[]> {
  await ensureRecovered();
  return (await deps().store().listRuns(interviewId)).map(withEnding).reverse();
}

export async function getRun(interviewId: string, runId: string): Promise<RunRecord | null> {
  await ensureRecovered();
  const row = await deps().store().getRun(interviewId, runId);
  return row && withEnding(row);
}

/** The interview's newest run, or null. */
export async function lastRunRecord(interviewId: string): Promise<RunRecord | null> {
  const row = (await deps().store().listRuns(interviewId)).at(-1);
  return row ? withEnding(row) : null;
}

export type CancelOutcome = { kind: 'ok'; run: RunRecord } | { kind: 'not-found' };

/** Cancel a run of the interview in any state; a finished run is answered as it is. */
export async function cancelRun(interviewId: string, runId: string): Promise<CancelOutcome> {
  await ensureRecovered();
  const d = deps();
  const store = d.store();
  const found = await store.getRun(interviewId, runId);
  if (!found) return { kind: 'not-found' };
  const row = withEnding(found);
  if (row.result !== null) return { kind: 'ok', run: row };
  const slot = active.get(interviewId);
  if (slot && slot !== 'starting' && slot.runId === runId) {
    requestCancel(slot);
    await Promise.race([slot.done, new Promise<void>((r) => { const t = setTimeout(r, CANCEL_GRACE_MS * 2); t.unref?.(); })]);
    const now = await store.getRun(interviewId, runId);
    return { kind: 'ok', run: now ? withEnding(now) : row };
  }
  // Still queued: it never reaches the executor, and its money goes back.
  await counterFor(interviewId);
  const e = stamp(interviewId, runId, (row.events.at(-1)?.seq ?? 1) + 1, 'status', 'cancelled');
  // A store that refuses the row leaves it to a restart's recovery (held ended and unstarted here); the money goes back either way.
  const out = await writeEnding(interviewId, runId, serviceResult('cancelled', d.executor(), row.language), iso(d.now()), e)
    .then((done) => ({ done, refused: null }), (error: unknown) => ({ done: null, refused: { error } }));
  if (out.done || out.refused) await d.release([row.holdId]).catch(() => undefined);
  if (out.refused) throw out.refused.error;
  const now = out.done ?? (await store.getRun(interviewId, runId));
  return { kind: 'ok', run: now ? withEnding(now) : row };
}

// ── The stream ────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Open a reader of the interview's events. Everything after `lastEventId` (`<runId>:<seq>`; everything when it is
 * missing or names no event) is sent first, in order, then each new event as it happens. Returns the way to stop.
 */
export async function openRunEvents(interviewId: string, lastEventId: string | null, send: (e: RunEvent) => void): Promise<() => void> {
  await ensureRecovered();
  let live = false;
  let lastN = 0;
  const buffer: (RunEvent & { n: number })[] = [];
  const out = (e: RunEvent & { n: number }) => {
    if (e.n <= lastN) return;
    lastN = e.n;
    send({ runId: e.runId, seq: e.seq, stream: e.stream, data: e.data, at: e.at });
  };
  const listener: Listener = (e) => { if (live) out(e); else buffer.push(e); };
  let set = listeners.get(interviewId);
  if (!set) listeners.set(interviewId, (set = new Set()));
  set.add(listener);
  const stop = () => {
    const s = listeners.get(interviewId);
    s?.delete(listener);
    if (s && s.size === 0) listeners.delete(interviewId);
  };
  try {
    const rows = await deps().store().listRuns(interviewId);
    const byN = new Map<number, RunEvent & { n: number }>();
    for (const r of rows) for (const e of r.events) byN.set(e.n, { runId: r.runId, seq: e.seq, stream: e.stream, data: e.data, at: e.at, n: e.n });
    for (const e of pending.get(interviewId)?.values() ?? []) byN.set(e.n, e);
    const all = [...byN.values()].sort((a, b) => a.n - b.n);
    let from = 0;
    if (lastEventId) {
      const cut = lastEventId.lastIndexOf(':');
      const runId = cut > 0 ? lastEventId.slice(0, cut) : '';
      const seq = Number(lastEventId.slice(cut + 1));
      const hit = all.find((e) => e.runId === runId && e.seq === seq);
      if (hit) from = hit.n;
    }
    lastN = from;
    for (const e of all) out(e);
    live = true;
    for (const e of buffer.sort((a, b) => a.n - b.n)) out(e);
    buffer.length = 0;
  } catch (e) {
    stop();
    throw e;
  }
  return stop;
}

/** How many readers the interview's stream has now (tests). */
export const runReaders = (interviewId: string): number => listeners.get(interviewId)?.size ?? 0;
/** Wait until nothing of this interview is starting or running (tests). */
export async function runsSettled(interviewId: string): Promise<void> {
  for (let i = 0; i < 10_000; i++) {
    const s = active.get(interviewId);
    if (!s) return;
    if (s === 'starting') await new Promise((r) => setImmediate(r));
    else await s.done;
  }
}

/** Erase these interviews' runs (D6, a media-class eraser). */
export async function eraseRunRows(interviewIds: readonly string[]): Promise<number> {
  return deps().store().eraseRuns(interviewIds);
}

export { isTerminal };

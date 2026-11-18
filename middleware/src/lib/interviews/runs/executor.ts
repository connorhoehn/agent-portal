// The run interface (docs/interviews-tenant-plan.md decision 13, "The run interface", "I4.6 answer"; row I4.4).
//
// One seam every backend implements: the mock (mock-executor.ts) now, AgentCore Code Interpreter and the container runner
// later (rows I4.7–I4.9). An executor knows nothing about HTTP, stores, money or the queue: the service (service.ts) holds
// one-at-a-time per interview, the 60-run count, the run row keyed by `runId`, the hold and settle, the wall-time
// safeguard and the event log, so every backend gets them unchanged.
//
// `start(request, emit)` begins one run and returns at once with a handle whose `cancel()` asks it to stop. The executor
// then calls `emit` with output and status events in order, and exactly once with the run's result; nothing after the
// result is read. The service stamps each event with the run's `seq` and the time (the wire's `{ runId, seq, stream,
// data, at }`), so an executor only says which stream and what text.
//
// Status events carry the new status as their `data`: `compiling` (compiled languages only, before it runs) and
// `running`. The terminal status is the result's own; the service writes its status event. The network is always off;
// the limits are the server's, never the caller's.

/** The seven languages of the pad (decision 11), by the pad's own ids. */
export type RunLanguage = 'python' | 'swift' | 'javascript' | 'typescript' | 'java' | 'go' | 'cpp';
export const RUN_LANGUAGES: readonly RunLanguage[] = ['python', 'swift', 'javascript', 'typescript', 'java', 'go', 'cpp'];

export type RunStatus = 'queued' | 'compiling' | 'running' | 'succeeded' | 'failed' | 'compile_error' | 'timed_out' | 'runner_timeout' | 'memory_exceeded' | 'cancelled' | 'internal_error';
export const RUN_STATUSES: readonly RunStatus[] = ['queued', 'compiling', 'running', 'succeeded', 'failed', 'compile_error', 'timed_out', 'runner_timeout', 'memory_exceeded', 'cancelled', 'internal_error'];
export const TERMINAL_STATUSES: readonly RunStatus[] = ['succeeded', 'failed', 'compile_error', 'timed_out', 'runner_timeout', 'memory_exceeded', 'cancelled', 'internal_error'];
export const isTerminal = (s: RunStatus): boolean => TERMINAL_STATUSES.includes(s);

export interface RunLimits { wallMs: number; memoryMb: number; maxOutputBytes: number }
/** The plan's defaults: 10 seconds, 256 MB, 64 KB of output. */
export const DEFAULT_RUN_LIMITS: RunLimits = { wallMs: 10_000, memoryMb: 256, maxOutputBytes: 64 * 1024 };

export interface RunFile { path: string; content: string }

/** The plan's request. */
export interface RunRequest {
  runId: string;
  interviewId: string;
  language: RunLanguage;
  files: RunFile[];
  entrypoint: string;
  stdin?: string;
  limits: RunLimits;
}

export type RunStream = 'stdout' | 'stderr' | 'status';

/** The plan's result: one per `runId`. */
export interface RunResult {
  status: RunStatus;
  exitCode: number | null;
  compileOutput: string;
  stdout: string;
  stderr: string;
  truncated: { stdout: boolean; stderr: boolean };
  timeMs: number;
  peakMemoryMb: number | null;
  backend: string;
  runtimeVersion: string;
}

/** What an executor hands the service: an event (output or a status change), then once the result. */
export type ExecutorOutput =
  | { type: 'event'; stream: RunStream; data: string }
  | { type: 'result'; result: RunResult };

export interface ExecutorRun {
  /** Ask the run to stop; it answers with a `cancelled` result (or its own end, if that came first). Safe to call twice. */
  cancel(): void;
}

export interface Executor {
  /** Written on every result (`mock`, later `agentcore-code-interpreter`, `container-runner`). */
  readonly backend: string;
  /** The one pinned version per language, written on every result. */
  readonly runtimeVersions: Readonly<Record<RunLanguage, string>>;
  start(request: RunRequest, emit: (out: ExecutorOutput) => void): ExecutorRun;
}

/** The languages whose run begins with a compile step (decision 13: the container runner's four). */
export const COMPILED_LANGUAGES: readonly RunLanguage[] = ['swift', 'java', 'go', 'cpp'];

/** A result the service makes itself when a run never reached the executor or the executor never answered. */
export function serviceResult(status: RunStatus, executor: Pick<Executor, 'backend' | 'runtimeVersions'>, language: RunLanguage, partial: Partial<RunResult> = {}): RunResult {
  return {
    status, exitCode: null, compileOutput: '', stdout: '', stderr: '', truncated: { stdout: false, stderr: false }, timeMs: 0, peakMemoryMb: null,
    backend: executor.backend, runtimeVersion: executor.runtimeVersions[language], ...partial,
  };
}

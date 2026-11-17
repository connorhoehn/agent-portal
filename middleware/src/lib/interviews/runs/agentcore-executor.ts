// The AgentCore Code Interpreter executor (docs/interviews-tenant-plan.md "I4.6 answer"; row I4.7): Python, JavaScript and
// TypeScript in the interviews' own sandboxed interpreter (`<prefix>_interview_runs`, network mode SANDBOX, an execution role
// that holds nothing). The four compiled languages need the container runner (rows I4.8 and I4.9); here they end at once in
// `internal_error` with one plain sentence, which gives the run's money back.
//
// A session per run, never shared: nothing of one run's files, processes or memory reaches the next. One run is
//
//   StartCodeInterpreterSession  (timeout: the wall time plus a backstop)
//   writeFiles                   the candidate's files under run/, stdin, and the wrapper below
//   executeCommand               bash wrap.sh: limits, the program under `timeout`, each stream through a cap that keeps the
//                                first maxOutputBytes + 1 bytes and drains the rest (so a flood is cut and the program still
//                                reaches its own end), the program's own exit code into a file
//   executeCommand               the two capped streams (base64), the exit code and the runtime's version, on four lines
//   StopCodeInterpreterSession   always, also on cancel and on any failure
//
// Measured on the account's built-in interpreter (17 November 2026): a session starts in about 1.1 s and a command returns in
// about 0.2 s; Python is 3.12, `node` is 24, TypeScript runs through tsx; DNS does not resolve. The interpreter returns a
// command's output only when it ends, so the run's output events arrive in one burst after `running`, which the contract
// allows. stdout and stderr come back merged from the terminal, which is why each goes to its own file.
//
// Limits are the server's: `timeout` stops the program at the wall time (exit 124, `timed_out`); Python's address space is
// capped with `ulimit -v` (a MemoryError, `memory_exceeded`), and Node's heap with --max-old-space-size (V8 reserves far more
// address space than it uses, so `ulimit -v` would stop it from starting); exit 137 without the wall time is the kernel's kill.
// A process cap stops a fork bomb. The middleware's own timer is the backstop: past the wall time plus WALL_BACKSTOP_MS the
// session is stopped and the run is `timed_out`.
import {
  BedrockAgentCoreClient, InvokeCodeInterpreterCommand, StartCodeInterpreterSessionCommand, StopCodeInterpreterSessionCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import {
  serviceResult, type Executor, type ExecutorOutput, type ExecutorRun, type RunLanguage, type RunRequest, type RunResult, type RunStatus,
} from './executor.js';

export const AGENTCORE_BACKEND = 'agentcore-code-interpreter';
/** The versions this backend was measured with. The interpreter chooses its own; a run that reports another major warns once. */
export const AGENTCORE_RUNTIME_VERSIONS: Readonly<Record<RunLanguage, string>> = {
  python: 'Python 3.12',
  javascript: 'Node.js 24',
  typescript: 'TypeScript (tsx) on Node.js 24',
  java: 'not available on this backend',
  go: 'not available on this backend',
  cpp: 'not available on this backend',
  swift: 'not available on this backend',
};
export const AGENTCORE_LANGUAGES: readonly RunLanguage[] = ['python', 'javascript', 'typescript'];
/** What a candidate reads for a language this backend does not run. */
export const NOT_HERE = (language: RunLanguage): string =>
  `${LANGUAGE_NAMES[language]} programs cannot be run in this deployment yet. Python, JavaScript and TypeScript can.`;
const LANGUAGE_NAMES: Readonly<Record<RunLanguage, string>> = {
  python: 'Python', javascript: 'JavaScript', typescript: 'TypeScript', java: 'Java', go: 'Go', cpp: 'C++', swift: 'Swift',
};
/** Past the wall time, how long the middleware waits for the interpreter before it stops the session itself. */
export const WALL_BACKSTOP_MS = 4_000;
/** The most processes and threads the program may have (a fork bomb ends in `failed`). Not lower: tsx starts esbuild, a Go binary whose threads count against it. */
export const MAX_PROCESSES = 256;

/** The slice of the SDK client this executor uses, so a test can hand in a fake. */
export interface InterpreterClient { send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown> }

export interface AgentCoreExecutorOptions {
  /** The interpreter's id (INTERVIEWS_CODE_INTERPRETER_ID). */
  interpreterId: string;
  client?: InterpreterClient;
  region?: string;
  /** Warned once per language when the runtime reports a different major version. */
  warn?: (message: string) => void;
}

const RUN_DIR = 'run';
const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** The program's command line, run inside run/ with stdin from ../stdin.txt. */
function programCommand(language: RunLanguage, entrypoint: string, memoryMb: number): string {
  switch (language) {
    case 'python': return `ulimit -v ${memoryMb * 1024}; exec python3 -u ${q(entrypoint)}`;
    case 'javascript': return `exec node --max-old-space-size=${memoryMb} ${q(entrypoint)}`;
    case 'typescript': return `NODE_OPTIONS=--max-old-space-size=${memoryMb} exec tsx ${q(entrypoint)}`;
    default: throw new Error(`no command for ${language}`);
  }
}

const VERSION_COMMAND: Partial<Record<RunLanguage, string>> = {
  python: 'python3 -V 2>&1', javascript: 'node --version', typescript: 'node --version',
};

/** The wrapper: limits, the program under `timeout`, each stream capped and drained, the exit code. Exported for its test. */
export function wrapperScript(request: RunRequest): string {
  const wallS = Math.max(1, Math.ceil(request.limits.wallMs / 1000));
  const keep = request.limits.maxOutputBytes + 1;
  return [
    '#!/bin/bash',
    'cd "$(dirname "$0")"',
    // Keep the first bytes of a stream and read the rest to the end, so the writer is never blocked or broken by a full pipe.
    `cap() { head -c ${keep} > "$1"; cat > /dev/null; }`,
    `ulimit -u ${MAX_PROCESSES} 2>/dev/null`,
    // No core file: V8's abort on a full heap otherwise spends the rest of the wall time writing one.
    'ulimit -c 0 2>/dev/null',
    `cd ${RUN_DIR}`,
    `( timeout -k 1 ${wallS} bash -c ${q(programCommand(request.language, request.entrypoint, request.limits.memoryMb))} < ../stdin.txt 2> >(cap ../err.txt) ) | cap ../out.txt`,
    'echo "${PIPESTATUS[0]}" > ../code.txt',
    // The stderr cap runs in a process substitution: give it its moment to finish writing.
    'sleep 0.2',
    '',
  ].join('\n');
}

/** What the second command prints: four lines. Exported for its test. */
export function readBackCommand(language: RunLanguage): string {
  return `base64 -w0 out.txt 2>/dev/null; echo; base64 -w0 err.txt 2>/dev/null; echo; cat code.txt 2>/dev/null || echo; ${VERSION_COMMAND[language] ?? 'echo'}`;
}

/** Map the program's exit and its stderr to a terminal status. Exported for its test. */
export function statusOf(language: RunLanguage, exitCode: number | null, stderr: string): RunStatus {
  // The out-of-memory message first: V8 aborts after printing it, and a process that is slow to die (or tsx's parent
  // waiting on it) can still reach the wall time.
  if (language === 'python' && /\bMemoryError\b/.test(stderr)) return 'memory_exceeded';
  if (language !== 'python' && /JavaScript heap out of memory|Reached heap limit/.test(stderr)) return 'memory_exceeded';
  if (exitCode === 124) return 'timed_out';
  if (exitCode === 0) return 'succeeded';
  if (exitCode === 137) return 'memory_exceeded';
  return exitCode === null ? 'internal_error' : 'failed';
}

/** The text of one InvokeCodeInterpreter result, and whether the tool said it failed. */
async function invokeText(resp: unknown): Promise<{ stdout: string; isError: boolean }> {
  let stdout = '';
  let isError = false;
  for await (const event of ((resp as { stream?: AsyncIterable<unknown> }).stream ?? [])) {
    const e = event as { result?: { isError?: boolean; structuredContent?: { stdout?: string }; content?: Array<{ text?: string }> } } & Record<string, unknown>;
    if (e.result) {
      if (e.result.isError) isError = true;
      stdout += e.result.structuredContent?.stdout ?? (e.result.content ?? []).map((c) => c.text ?? '').join('');
      continue;
    }
    const ex = Object.entries(e).find(([k]) => k.endsWith('Exception'));
    if (ex) throw new Error(`interpreter: ${ex[0]}`);
  }
  return { stdout, isError };
}

export class AgentCoreExecutor implements Executor {
  readonly backend = AGENTCORE_BACKEND;
  readonly runtimeVersions = AGENTCORE_RUNTIME_VERSIONS;
  private readonly client: InterpreterClient;
  private readonly warned = new Set<RunLanguage>();

  constructor(private readonly opts: AgentCoreExecutorOptions) {
    this.client = opts.client ?? (new BedrockAgentCoreClient({ region: opts.region }) as unknown as InterpreterClient);
  }

  start(request: RunRequest, emit: (out: ExecutorOutput) => void): ExecutorRun {
    let done = false;
    let cancelled = false;
    let sessionId: string | null = null;
    const abort = new AbortController();
    const finish = (result: RunResult): void => {
      if (done) return;
      done = true;
      emit({ type: 'result', result });
    };
    const base = (status: RunStatus, partial: Partial<RunResult> = {}): RunResult => serviceResult(status, this, request.language, partial);

    if (!AGENTCORE_LANGUAGES.includes(request.language)) {
      queueMicrotask(() => finish(base('internal_error', { stderr: NOT_HERE(request.language) })));
      return { cancel() { /* already ended */ } };
    }

    const id = this.opts.interpreterId;
    const stop = (): void => {
      const sid = sessionId;
      if (!sid) return;
      sessionId = null;
      void this.client.send(new StopCodeInterpreterSessionCommand({ codeInterpreterIdentifier: id, sessionId: sid })).catch(() => undefined);
    };
    const backstop = setTimeout(() => {
      if (done) return;
      abort.abort();
      stop();
      finish(base('timed_out', { timeMs: request.limits.wallMs }));
    }, request.limits.wallMs + WALL_BACKSTOP_MS + 15_000);
    backstop.unref?.();

    const invoke = async (name: string, args: Record<string, unknown>) => invokeText(await this.client.send(
      new InvokeCodeInterpreterCommand({ codeInterpreterIdentifier: id, sessionId: sessionId!, name: name as never, arguments: args as never }),
      { abortSignal: abort.signal },
    ));

    void (async () => {
      try {
        const started = await this.client.send(new StartCodeInterpreterSessionCommand({
          codeInterpreterIdentifier: id, name: `run-${request.runId}`.replace(/[^\w-]/g, '-').slice(0, 100),
          sessionTimeoutSeconds: Math.ceil(request.limits.wallMs / 1000) + 60,
        }), { abortSignal: abort.signal }) as { sessionId?: string };
        sessionId = started.sessionId ?? null;
        if (!sessionId) throw new Error('interpreter: no session');
        if (cancelled) { stop(); finish(base('cancelled')); return; }

        const written = await invoke('writeFiles', {
          content: [
            ...request.files.map((f) => ({ path: `${RUN_DIR}/${f.path}`, text: f.content })),
            { path: 'stdin.txt', text: request.stdin ?? '' },
            { path: 'wrap.sh', text: wrapperScript(request) },
          ],
        });
        if (written.isError) throw new Error('interpreter: writeFiles refused');
        if (cancelled) { stop(); finish(base('cancelled')); return; }

        emit({ type: 'event', stream: 'status', data: 'running' });
        const began = Date.now();
        // A reader may cancel on the `running` event itself, before the command is sent.
        if (cancelled) { stop(); finish(base('cancelled')); return; }
        // The wall time is enforced inside by `timeout`; the backstop timer above catches an interpreter that never answers.
        const wallTimer = setTimeout(() => { if (!done) { abort.abort(); stop(); finish(base('timed_out', { timeMs: Date.now() - began })); } },
          request.limits.wallMs + WALL_BACKSTOP_MS);
        wallTimer.unref?.();
        try { await invoke('executeCommand', { command: 'bash wrap.sh' }); } finally { clearTimeout(wallTimer); }
        if (done) return;
        if (cancelled) { stop(); finish(base('cancelled', { timeMs: Date.now() - began })); return; }
        const timeMs = Date.now() - began;

        const back = await invoke('executeCommand', { command: readBackCommand(request.language) });
        const [outB64 = '', errB64 = '', codeLine = '', ...versionLines] = back.stdout.replace(/\r/g, '').split('\n');
        const max = request.limits.maxOutputBytes;
        const decode = (b64: string) => Buffer.from(b64.trim(), 'base64');
        const outBuf = decode(outB64), errBuf = decode(errB64);
        const cut = (b: Buffer) => b.subarray(0, Math.min(b.length, max)).toString('utf8');
        const stdout = cut(outBuf), stderr = cut(errBuf);
        const code = /^\d+$/.test(codeLine.trim()) ? Number(codeLine.trim()) : null;
        this.checkVersion(request.language, versionLines.join(' ').trim());

        if (stdout) emit({ type: 'event', stream: 'stdout', data: stdout });
        if (stderr) emit({ type: 'event', stream: 'stderr', data: stderr });
        stop();
        finish(base(statusOf(request.language, code, stderr), {
          exitCode: code, stdout, stderr, timeMs,
          truncated: { stdout: outBuf.length > max, stderr: errBuf.length > max },
        }));
      } catch (err) {
        stop();
        if (done) return;
        // A cancel aborts the call in flight: that is the cancel's answer, not a failure.
        if (cancelled) { finish(base('cancelled')); return; }
        // The SDK's message can carry request detail: only its name reaches the log, never the program or its output.
        console.warn('[interviews] code run failed on the interpreter:', (err as Error).name || 'Error');
        finish(base('internal_error', { stderr: 'The code could not be run just now. Try again in a moment.' }));
      } finally {
        clearTimeout(backstop);
      }
    })();

    return {
      cancel: () => {
        if (done || cancelled) return;
        cancelled = true;
        abort.abort();
        stop();
      },
    };
  }

  private checkVersion(language: RunLanguage, reported: string): void {
    if (!reported || this.warned.has(language)) return;
    // As precise as the pinned name: "Python 3.12" wants 3.12.x, "Node.js 24" wants 24.x.
    const want = /\d+(?:\.\d+)?/.exec(AGENTCORE_RUNTIME_VERSIONS[language].replace(/^TypeScript \(tsx\) on /, ''))?.[0];
    const got = /\d+(?:\.\d+)*/.exec(reported)?.[0];
    if (want && got && got !== want && !got.startsWith(`${want}.`)) {
      this.warned.add(language);
      (this.opts.warn ?? ((m) => console.warn(m)))(`[interviews] the code interpreter runs ${language} as "${reported.slice(0, 40)}", not ${AGENTCORE_RUNTIME_VERSIONS[language]}`);
    }
  }
}

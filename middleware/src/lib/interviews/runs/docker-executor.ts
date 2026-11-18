// The Docker runner (docs/interviews-tenant-plan.md "I4.6 answer", "The Docker runner on a developer's machine"): a
// real backend for a developer's machine, behind the same `Executor` as the mock. Chosen only by
// `INTERVIEWS_RUN_BACKEND=docker` (backend.ts); the default stays the mock, and the deployed path is not this.
//
// One fresh container per run, made by docker-process.ts with no network, a read-only root, no capabilities, no new
// privileges, an unprivileged user, process, memory and CPU limits, and `--rm`. The files and the input go in as a tar
// on the container's stdin (no host mount). The language picks a row of the allowlist (docker-runtimes.ts): its image
// and its fixed script. Nothing a person typed is ever part of a command line except the entrypoint, which is a plain
// relative name passed as its own argument.
//
// Statuses: `compiling` at the start for compiled languages, `running` when the script prints the run's marker (just
// before the program starts). Then: exit 0 `succeeded`; exit 137 that the runner did not cause `memory_exceeded`;
// any other exit `failed`; the program's own `wallMs` running out `timed_out`; the runner's timer running out BEFORE the marker (the container
// or its compile step never got the program started: a slow daemon or image start, `prepareMs`) `runner_timeout`, which is the
// runner's failure and not the candidate's, with a plain sentence on stderr; a cancel `cancelled`; exit 97 before the marker `compile_error`; Docker unreachable, an image
// missing or anything else before the marker `internal_error`, with a plain sentence on stderr. Output: the first
// `maxOutputBytes` of each stream are kept and streamed; past that it is cut and flagged and the run goes on; past four
// times that the run is stopped as an output flood and ends `failed`. Every stop removes the container by name.
import { randomBytes } from 'node:crypto';
import {
  type Executor, type ExecutorOutput, type ExecutorRun, type RunLanguage, type RunRequest, type RunResult, type RunStatus,
} from './executor.js';
import { COMPILE_FAILED_EXIT, DOCKER_RUNTIMES, type DockerRuntime } from './docker-runtimes.js';
import { CONTAINER_PREFIX, createDockerProcesses, type DockerChild, type DockerProcesses } from './docker-process.js';
import { cutBytes } from './mock-executor.js';

export const DOCKER_BACKEND = 'docker-runner';
export const DOCKER_RUNTIME_VERSIONS: Readonly<Record<RunLanguage, string>> = Object.fromEntries(
  Object.entries(DOCKER_RUNTIMES).map(([lang, r]) => [lang, r.version]),
) as Record<RunLanguage, string>;

/** Past this many times `maxOutputBytes` on one stream, the run is stopped as an output flood. */
export const FLOOD_FACTOR = 4;

export const DOCKER_SENTENCES = {
  noDocker: 'Code runs use Docker on this machine, and the docker command is not installed, so the run could not start.\n',
  unreachable: 'Code runs use Docker on this machine, and Docker is not reachable, so the run could not start.\n',
  noImage: (lang: string, image: string) => `The ${lang} image (${image}) is not on this machine, so the run could not start. Pull it once with: docker pull ${image}\n`,
  failedStart: 'The code runner could not start this run.\n',
  slowStart: 'The code runner did not get this program started in time, so it never ran. This is the runner, not your code. Try again.\n',
  flood: (max: number) => `The program printed more than ${FLOOD_FACTOR} times the ${Math.round(max / 1024)} KB output limit, so it was stopped.\n`,
} as const;

const LANGUAGE_NAMES: Readonly<Record<RunLanguage, string>> = { python: 'Python', javascript: 'JavaScript', typescript: 'TypeScript', java: 'Java', go: 'Go', cpp: 'C++', swift: 'Swift' };

export interface DockerExecutorOptions {
  /** The processes it starts. Default: the real `docker` binary. Tests pass a fake spawner. */
  processes?: DockerProcesses;
  /** Overrides the row's `prepareMs` (tests). */
  prepareMs?: number;
  /** After a stop, how long to wait for `docker run` to end before ending the run anyway. */
  stopGraceMs?: number;
  /** A second `docker rm -f` this long after a stop, for a container that was still being created at the first. */
  removeRetryMs?: number;
  now?: () => number;
}

// ── The tar the container reads on stdin ──────────────────────────────────────────────────────────────────────────

function octal(n: number, width: number): string { return n.toString(8).padStart(width - 1, '0') + '\0'; }

function header(name: string, size: number, type: '0' | '5', mode: number): Buffer {
  const h = Buffer.alloc(512, 0);
  let prefix = '';
  let base = name;
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf('/', name.length - 2);
    prefix = name.slice(0, cut);
    base = name.slice(cut + 1);
  }
  h.write(base, 0, 100, 'utf8');
  h.write(octal(mode, 8), 100, 8, 'ascii');
  h.write(octal(65534, 8), 108, 8, 'ascii');
  h.write(octal(65534, 8), 116, 8, 'ascii');
  h.write(octal(size, 12), 124, 12, 'ascii');
  h.write(octal(0, 12), 136, 12, 'ascii');
  h.write('        ', 148, 8, 'ascii');
  h.write(type, 156, 1, 'ascii');
  h.write('ustar\u000000', 257, 8, 'ascii');
  h.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return h;
}

/** A ustar archive of `src/<path>` for each file (their folders first) and `.stdin`. Paths are checked by the caller. */
export function runTar(files: readonly { path: string; content: string }[], stdin: string): Buffer {
  const parts: Buffer[] = [];
  const dirs = new Set<string>(['src/']);
  for (const f of files) {
    const segs = f.path.split('/');
    for (let i = 1; i < segs.length; i++) dirs.add(`src/${segs.slice(0, i).join('/')}/`);
  }
  for (const d of [...dirs].sort((a, b) => a.length - b.length)) parts.push(header(d, 0, '5', 0o700));
  const file = (name: string, text: string) => {
    const body = Buffer.from(text, 'utf8');
    parts.push(header(name, body.length, '0', 0o600), body, Buffer.alloc((512 - (body.length % 512)) % 512, 0));
  };
  for (const f of files) file(`src/${f.path}`, f.content);
  file('.stdin', stdin);
  parts.push(Buffer.alloc(1024, 0));
  return Buffer.concat(parts);
}

const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const plainPath = (p: string): boolean => p.length > 0 && p.length <= 128 && !p.startsWith('/') && p.split('/').every((s) => s !== '.' && s !== '..' && SEGMENT.test(s));

// ── The executor ──────────────────────────────────────────────────────────────────────────────────────────────────

type StopReason = 'cancel' | 'timeout' | 'flood';

export class DockerExecutor implements Executor {
  readonly backend = DOCKER_BACKEND;
  readonly runtimeVersions = DOCKER_RUNTIME_VERSIONS;
  private readonly processes: DockerProcesses;
  private readonly opts: DockerExecutorOptions;
  private readonly now: () => number;

  constructor(opts: DockerExecutorOptions = {}) {
    this.processes = opts.processes ?? createDockerProcesses();
    this.opts = opts;
    this.now = opts.now ?? Date.now;
  }

  start(request: RunRequest, emit: (out: ExecutorOutput) => void): ExecutorRun {
    const lang = request.language;
    const rt: DockerRuntime | undefined = DOCKER_RUNTIMES[lang];
    const limits = request.limits;
    const maxOut = limits.maxOutputBytes;
    const startedAt = this.now();
    let runningAt: number | null = null;
    let done = false;
    let stopReason: StopReason | null = null;
    let child: DockerChild | null = null;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const out = { stdout: '', stderr: '', compileOutput: '' };
    const produced = { stdout: 0, stderr: 0 };
    const truncated = { stdout: false, stderr: false };
    const marker = randomBytes(16).toString('hex');
    const name = `${CONTAINER_PREFIX}${randomBytes(8).toString('hex')}`;
    const markerLine = Buffer.from(`${marker}\n`);
    // Before its marker, a stream's bytes are the runner's or the compiler's (held whole, at most a little).
    const pre = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    const past = { stdout: false, stderr: false };
    const decoders = { stdout: new TextDecoder('utf-8'), stderr: new TextDecoder('utf-8') };

    const event = (stream: 'stdout' | 'stderr' | 'status', data: string) => { if (!done) emit({ type: 'event', stream, data }); };
    const clear = () => { for (const t of timers) clearTimeout(t); timers.length = 0; };
    const finish = (status: RunStatus, exitCode: number | null, extra: Partial<RunResult> = {}) => {
      if (done) return;
      clear();
      const end = this.now();
      const result: RunResult = {
        status, exitCode, compileOutput: out.compileOutput, stdout: out.stdout, stderr: out.stderr, truncated: { ...truncated },
        timeMs: Math.max(0, end - (runningAt ?? startedAt)), peakMemoryMb: null, backend: this.backend, runtimeVersion: this.runtimeVersions[lang] ?? '', ...extra,
      };
      done = true;
      emit({ type: 'result', result });
    };
    /** A plain sentence on stderr, then `internal_error`. */
    const refuse = (sentence: string) => {
      if (done) return;
      out.stderr = cutBytes(out.stderr + sentence, maxOut);
      event('stderr', sentence);
      finish('internal_error', null);
    };

    const remove = () => {
      try {
        const r = this.processes.remove(name);
        r.on('error', () => undefined);
        r.stdout?.resume(); r.stderr?.resume();
      } catch { /* the name is the runner's own; nothing else to do */ }
    };
    const stop = (reason: StopReason) => {
      if (done || stopReason) return;
      stopReason = reason;
      remove();
      // A container still being created at the first remove is caught by the second.
      const again = setTimeout(remove, this.opts.removeRetryMs ?? 2_000);
      again.unref?.();
      // If `docker run` never ends, end the run anyway (the container is removed by name above).
      const grace = setTimeout(() => {
        try { child?.kill('SIGKILL'); } catch { /* already gone */ }
        end(null);
      }, this.opts.stopGraceMs ?? 5_000);
      grace.unref?.();
      timers.push(grace);
    };
    const arm = (ms: number) => {
      clear();
      const t = setTimeout(() => stop('timeout'), ms);
      t.unref?.();
      timers.push(t);
    };

    const write = (stream: 'stdout' | 'stderr', text: string) => {
      if (!text) return;
      const size = Buffer.byteLength(text);
      produced[stream] += size;
      const room = maxOut - Buffer.byteLength(out[stream]);
      if (room <= 0) truncated[stream] = true;
      else {
        const piece = size <= room ? text : cutBytes(text, room);
        if (piece.length < text.length) truncated[stream] = true;
        if (piece) { out[stream] += piece; event(stream, piece); }
      }
      if (produced[stream] > maxOut * FLOOD_FACTOR) stop('flood');
    };
    const running = () => {
      // After a stop, the run never reports `running` (a cancel while compiling stays `compiling`).
      if (runningAt !== null || done || stopReason) return;
      runningAt = this.now();
      event('status', 'running');
      arm(limits.wallMs);
    };
    const onData = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
      if (done) return;
      if (past[stream]) { write(stream, decoders[stream].decode(chunk, { stream: true })); return; }
      const all = Buffer.concat([pre[stream], chunk]);
      const at = all.indexOf(markerLine);
      if (at < 0) {
        // Keep what came before the marker, at most twice the output limit (a compiler's words are short).
        pre[stream] = all.length > maxOut * 2 ? all.subarray(all.length - maxOut * 2) : all;
        return;
      }
      pre[stream] = all.subarray(0, at);
      past[stream] = true;
      running();
      write(stream, decoders[stream].decode(all.subarray(at + markerLine.length), { stream: true }));
    };
    const preText = () => cutBytes(Buffer.concat([pre.stdout, pre.stderr]).toString('utf8'), maxOut);

    const end = (code: number | null) => {
      if (done) return;
      for (const s of ['stdout', 'stderr'] as const) if (past[s]) write(s, decoders[s].decode());
      if (stopReason === 'cancel') return finish('cancelled', null);
      if (stopReason === 'timeout') {
        // Before the marker the program never started: the runner's failure, said in a sentence, and not the candidate's timeout.
        if (runningAt === null) {
          if (Buffer.byteLength(out.stderr) + Buffer.byteLength(DOCKER_SENTENCES.slowStart) <= maxOut) { out.stderr += DOCKER_SENTENCES.slowStart; event('stderr', DOCKER_SENTENCES.slowStart); }
          return finish('runner_timeout', null);
        }
        return finish('timed_out', null);
      }
      if (stopReason === 'flood') {
        const s = DOCKER_SENTENCES.flood(maxOut);
        if (Buffer.byteLength(out.stderr) + Buffer.byteLength(s) <= maxOut) { out.stderr += s; event('stderr', s); }
        return finish('failed', null);
      }
      if (runningAt !== null) {
        if (code === 0) return finish('succeeded', 0);
        if (code === 137) return finish('memory_exceeded', 137);
        return finish('failed', code);
      }
      // It ended before the program started.
      const text = preText();
      if (code === COMPILE_FAILED_EXIT && rt?.compiled) {
        out.compileOutput = text;
        out.stderr = text;
        if (text) event('stderr', text);
        return finish('compile_error', 1);
      }
      if (code === 137 && rt?.compiled) {
        out.compileOutput = text;
        return finish('memory_exceeded', 137);
      }
      if (/Cannot connect to the Docker daemon|error during connect|docker daemon is not running|connect: no such file or directory|Is the docker daemon running/i.test(text)) return refuse(DOCKER_SENTENCES.unreachable);
      if (/No such image|Unable to find image|pull access denied/i.test(text) && rt) return refuse(DOCKER_SENTENCES.noImage(LANGUAGE_NAMES[lang], rt.image));
      console.warn('[interviews] docker run ended before the program started', code);
      return refuse(DOCKER_SENTENCES.failedStart);
    };

    if (!rt || !request.files.length || !request.files.every((f) => plainPath(f.path)) || !plainPath(request.entrypoint)) {
      // The service checks these first; a request that still gets here is refused before anything starts.
      queueMicrotask(() => refuse(DOCKER_SENTENCES.failedStart));
      return { cancel: () => undefined };
    }

    try {
      child = this.processes.run({
        name, image: rt.image, script: rt.script, marker, entrypoint: request.entrypoint,
        memoryMb: Math.max(limits.memoryMb, rt.minMemoryMb), cpus: rt.cpus, pidsLimit: rt.pidsLimit, env: rt.env,
      });
    } catch (e) {
      console.warn('[interviews] docker run refused', (e as Error)?.message ?? 'error');
      queueMicrotask(() => refuse(DOCKER_SENTENCES.failedStart));
      return { cancel: () => undefined };
    }

    if (rt.compiled) event('status', 'compiling');
    arm(this.opts.prepareMs ?? rt.prepareMs);
    child.on('error', (err: Error & { code?: string }) => {
      if (done) return;
      clear();
      refuse(err.code === 'ENOENT' ? DOCKER_SENTENCES.noDocker : DOCKER_SENTENCES.failedStart);
    });
    child.on('close', (code) => end(code));
    child.stdout?.on('data', (c: Buffer) => onData('stdout', c));
    child.stderr?.on('data', (c: Buffer) => onData('stderr', c));
    child.stdout?.on('error', () => undefined);
    child.stderr?.on('error', () => undefined);
    // The program may exit before reading everything; a closed pipe is not an error of the run.
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(runTar(request.files, request.stdin ?? ''));

    return {
      cancel: () => {
        if (done) return;
        stop('cancel');
      },
    };
  }
}

export function createDockerExecutor(opts: DockerExecutorOptions = {}): Executor { return new DockerExecutor(opts); }

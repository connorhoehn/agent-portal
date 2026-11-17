// The mock executor (docs/interviews-tenant-plan.md decisions 13 and 19; row I4.4): scripted, realistic and
// deterministic, driven only by the request's text. It NEVER executes anything: no process is spawned, no text is
// evaluated, nothing touches the network or the disk. It reads the files as strings and plays a script.
//
// What it plays:
//   * the obvious literal output calls of each language, in the order they appear in the entrypoint (all files when the
//     entrypoint is not among them), to stdout, a chunk per call after a short pause:
//       python, swift          print("…") / print('…')
//       javascript, typescript console.log("…" | '…' | `…`)
//       java                   System.out.println("…")
//       go                     fmt.Println("…")
//       cpp                    std::cout << "…"   (a newline when `std::endl` or "\n" ends it)
//   * `compiling` first for Swift, Java, Go and C++, then `running`;
//   * a marker comment anywhere in the files picks a scripted outcome, so walks and tests can ask for each status:
//       mock:fail            the prints, then a stack trace on stderr in the language's own shape, a non-zero exit
//       mock:compile-error   compiled languages: a compiler error, `compile_error`; the others fail with a syntax error
//       mock:timeout         the prints, then nothing until the wall time: `timed_out`
//       mock:memory          `memory_exceeded` at the memory limit, exit 137
//       mock:flood           output past the limit: cut, flagged, and the run goes on to its own end (`succeeded`)
//       mock:internal        `internal_error`, as an injected service failure
//   * no literal output and no marker: "ran, no output", `succeeded`, exit 0.
// A pinned `runtimeVersion` per language and `backend: 'mock'` on every result. Times are scripted (the result's
// `timeMs` is the sum of the script's pauses, not a clock), and the pause itself is injected so tests run instantly.
import {
  COMPILED_LANGUAGES, type Executor, type ExecutorOutput, type ExecutorRun, type RunLanguage, type RunRequest, type RunResult, type RunStatus,
} from './executor.js';

export const MOCK_RUNTIME_VERSIONS: Readonly<Record<RunLanguage, string>> = {
  python: 'Python 3.12.7',
  javascript: 'Node.js 22.11.0',
  typescript: 'TypeScript 5.6.3 on Node.js 22.11.0',
  java: 'OpenJDK 21.0.5',
  go: 'Go 1.23.3',
  cpp: 'g++ 14.2.0 (C++20)',
  swift: 'Swift 6.0.2',
};

const PEAK_MB: Readonly<Record<RunLanguage, number>> = { python: 18, javascript: 42, typescript: 47, java: 64, go: 9, cpp: 4, swift: 12 };

export type MockMarker = 'fail' | 'compile-error' | 'timeout' | 'memory' | 'flood' | 'internal';
export const MOCK_MARKERS: readonly MockMarker[] = ['fail', 'compile-error', 'timeout', 'memory', 'flood', 'internal'];

export interface MockTimings {
  /** Before anything happens (a sandbox starting). */
  startMs: number;
  compileMs: number;
  /** Between two output chunks. */
  chunkMs: number;
}
export const MOCK_TIMINGS: MockTimings = { startMs: 120, compileMs: 700, chunkMs: 180 };

export interface MockExecutorOptions {
  timings?: Partial<MockTimings>;
  /** The pause between steps. Default: a timer. Tests pass one that resolves at once. */
  wait?: (ms: number) => Promise<void>;
}

/** The first marker in the files, or null. */
export function markerOf(files: readonly { content: string }[]): MockMarker | null {
  for (const f of files) {
    const m = /mock:(compile-error|fail|timeout|memory|flood|internal)\b/.exec(f.content);
    if (m) return m[1] as MockMarker;
  }
  return null;
}

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\'': '\'', '`': '`', '\\': '\\', '0': '\0' };
const unescape = (s: string): string => s.replace(/\\(.)/g, (_m, c: string) => ESCAPES[c] ?? c);

const STRING = String.raw`("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|\x60(?:\\.|[^\x60\\])*\x60)`;
const CALLS: Readonly<Record<RunLanguage, RegExp>> = {
  python: new RegExp(String.raw`\bprint\(\s*${STRING}\s*\)`, 'g'),
  swift: new RegExp(String.raw`\bprint\(\s*${STRING}\s*\)`, 'g'),
  javascript: new RegExp(String.raw`\bconsole\.log\(\s*${STRING}\s*\)`, 'g'),
  typescript: new RegExp(String.raw`\bconsole\.log\(\s*${STRING}\s*\)`, 'g'),
  java: new RegExp(String.raw`\bSystem\.out\.println\(\s*${STRING}\s*\)`, 'g'),
  go: new RegExp(String.raw`\bfmt\.Println\(\s*${STRING}\s*\)`, 'g'),
  cpp: new RegExp(String.raw`\bstd::cout\s*<<\s*${STRING}([^;\n]*)`, 'g'),
};

/** The text the obvious literal output calls print, one entry per call, in order. */
export function literalPrints(language: RunLanguage, text: string): string[] {
  const out: string[] = [];
  // Only double quotes are strings in Java, Go, C++ and Swift; single quotes and backticks there are not matched.
  const doubleOnly = language === 'java' || language === 'go' || language === 'cpp' || language === 'swift';
  for (const m of text.matchAll(CALLS[language])) {
    const lit = m[1]!;
    if (doubleOnly && lit[0] !== '"') continue;
    if (language !== 'javascript' && language !== 'typescript' && lit[0] === '`') continue;
    const body = unescape(lit.slice(1, -1));
    if (language === 'cpp') {
      const rest = m[2] ?? '';
      out.push(body + (/std::endl|"\\n"|'\\n'/.test(rest) ? '\n' : ''));
    } else {
      out.push(`${body}\n`);
    }
  }
  return out;
}

/** The line (1-based) of the marker in this text, else of the first non-empty line. */
function markerLine(text: string): number {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => /mock:/.test(l));
  if (at >= 0) return at + 1;
  const first = lines.findIndex((l) => l.trim().length > 0);
  return first >= 0 ? first + 1 : 1;
}

const baseName = (path: string): string => path.split('/').pop() ?? path;

/** A stack trace in the shape the language's runtime prints, and the exit code it ends with. */
function failure(language: RunLanguage, file: string, line: number): { stderr: string; exitCode: number } {
  const name = baseName(file);
  switch (language) {
    case 'python':
      return { exitCode: 1, stderr: `Traceback (most recent call last):\n  File "${name}", line ${line}, in <module>\n    raise RuntimeError("mock failure")\nRuntimeError: mock failure\n` };
    case 'javascript':
    case 'typescript':
      return { exitCode: 1, stderr: `${name}:${line}\n    throw new Error("mock failure");\n    ^\n\nError: mock failure\n    at Object.<anonymous> (${name}:${line}:11)\n    at Module._compile (node:internal/modules/cjs/loader:1546:14)\n\nNode.js v22.11.0\n` };
    case 'java':
      return { exitCode: 1, stderr: `Exception in thread "main" java.lang.IllegalStateException: mock failure\n\tat Main.main(${name}:${line})\n` };
    case 'go':
      return { exitCode: 2, stderr: `panic: mock failure\n\ngoroutine 1 [running]:\nmain.main()\n\t${name}:${line} +0x25\nexit status 2\n` };
    case 'cpp':
      return { exitCode: 134, stderr: 'terminate called after throwing an instance of \'std::runtime_error\'\n  what():  mock failure\nAborted (core dumped)\n' };
    case 'swift':
      return { exitCode: 133, stderr: `${name}:${line}: Fatal error: mock failure\nTrace/breakpoint trap (core dumped)\n` };
  }
}

function compileError(language: RunLanguage, file: string, line: number): string {
  const name = baseName(file);
  switch (language) {
    case 'java': return `${name}:${line}: error: ';' expected\n        int total = 0\n                     ^\n1 error\n`;
    case 'go': return `# command-line-arguments\n./${name}:${line}:2: undefined: totl\n`;
    case 'cpp': return `${name}:${line}:5: error: 'totl' was not declared in this scope; did you mean 'total'?\ncompilation terminated due to errors.\n`;
    case 'swift': return `${name}:${line}:5: error: cannot find 'totl' in scope\n    totl += 1\n    ^~~~\n`;
    default: return '';
  }
}

function syntaxError(language: RunLanguage, file: string, line: number): string {
  const name = baseName(file);
  if (language === 'python') return `  File "${name}", line ${line}\n    def total(values)\n                     ^\nSyntaxError: expected ':'\n`;
  return `${name}:${line}\n    function total(values {\n                         ^\n\nSyntaxError: Unexpected token '{'\n\nNode.js v22.11.0\n`;
}

/** Cut text to at most `max` UTF-8 bytes, at a character boundary. */
export function cutBytes(text: string, max: number): string {
  if (Buffer.byteLength(text) <= max) return text;
  let out = Buffer.from(text).subarray(0, Math.max(0, max)).toString('utf8');
  while (Buffer.byteLength(out) > max || out.endsWith('\uFFFD')) out = out.slice(0, -1);
  return out;
}

const realWait = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms).unref?.(); });

export class MockExecutor implements Executor {
  readonly backend = 'mock';
  readonly runtimeVersions = MOCK_RUNTIME_VERSIONS;
  private readonly timings: MockTimings;
  private readonly wait: (ms: number) => Promise<void>;

  constructor(opts: MockExecutorOptions = {}) {
    this.timings = { ...MOCK_TIMINGS, ...opts.timings };
    this.wait = opts.wait ?? realWait;
  }

  start(request: RunRequest, emit: (out: ExecutorOutput) => void): ExecutorRun {
    let cancelled = false;
    let wake: (() => void) | null = null;
    let done = false;
    const lang = request.language;
    const limits = request.limits;
    const entry = request.files.find((f) => f.path === request.entrypoint) ?? null;
    const text = entry ? entry.content : request.files.map((f) => f.content).join('\n');
    const file = entry?.path ?? request.entrypoint;
    const marker = markerOf(request.files);
    const line = markerLine(text);
    let elapsed = 0;
    const out = { stdout: '', stderr: '', compileOutput: '' };
    const truncated = { stdout: false, stderr: false };

    // A pause that a cancel cuts short. Returns false when the run was cancelled during (or before) it.
    const pause = async (ms: number): Promise<boolean> => {
      if (cancelled) return false;
      await Promise.race([this.wait(ms), new Promise<void>((r) => { wake = r; })]);
      wake = null;
      if (cancelled) return false;
      elapsed += ms;
      return true;
    };
    const event = (stream: 'stdout' | 'stderr' | 'status', data: string) => { if (!done) emit({ type: 'event', stream, data }); };
    const write = (stream: 'stdout' | 'stderr', data: string) => {
      const room = limits.maxOutputBytes - Buffer.byteLength(out[stream]);
      if (room <= 0) { if (data) truncated[stream] = true; return; }
      const piece = cutBytes(data, room);
      if (piece.length < data.length) truncated[stream] = true;
      if (!piece) return;
      out[stream] += piece;
      event(stream, piece);
    };
    const finish = (status: RunStatus, exitCode: number | null, peak: number | null = PEAK_MB[lang]) => {
      if (done) return;
      done = true;
      const result: RunResult = {
        status, exitCode, compileOutput: out.compileOutput, stdout: out.stdout, stderr: out.stderr, truncated: { ...truncated },
        timeMs: elapsed, peakMemoryMb: peak, backend: this.backend, runtimeVersion: this.runtimeVersions[lang],
      };
      emit({ type: 'result', result });
    };
    const stopped = () => finish('cancelled', null);

    const script = async (): Promise<void> => {
      if (!(await pause(this.timings.startMs))) return stopped();
      const compiled = COMPILED_LANGUAGES.includes(lang);
      if (compiled) {
        event('status', 'compiling');
        if (!(await pause(this.timings.compileMs))) return stopped();
        if (marker === 'compile-error') {
          out.compileOutput = compileError(lang, file, line);
          write('stderr', out.compileOutput);
          return finish('compile_error', 1, null);
        }
      }
      event('status', 'running');
      if (marker === 'internal') {
        if (!(await pause(this.timings.chunkMs))) return stopped();
        return finish('internal_error', null, null);
      }
      if (marker === 'compile-error') {
        // An interpreted language has no compile step: the parser refuses the file when it runs.
        if (!(await pause(this.timings.chunkMs))) return stopped();
        write('stderr', syntaxError(lang, file, line));
        return finish('failed', 1);
      }
      if (marker === 'memory') {
        if (!(await pause(this.timings.chunkMs * 3))) return stopped();
        write('stderr', 'Killed: the run used more than its memory limit.\n');
        return finish('memory_exceeded', 137, limits.memoryMb);
      }
      if (marker === 'flood') {
        // Line after line until well past the limit; what is past it is cut, and the run goes on to its own end.
        let n = 0;
        const target = limits.maxOutputBytes * 2;
        let produced = 0;
        while (produced < target) {
          let chunk = '';
          while (chunk.length < 8192) chunk += `line ${++n}\n`;
          produced += chunk.length;
          write('stdout', chunk);
          if (!(await pause(this.timings.chunkMs / 4))) return stopped();
        }
        return finish('succeeded', 0);
      }
      const prints = literalPrints(lang, text);
      // A few timed chunks: at most four, the prints shared out among them in order.
      const chunks = Math.min(4, prints.length);
      for (let c = 0; c < chunks; c++) {
        if (!(await pause(this.timings.chunkMs))) return stopped();
        const from = Math.floor((c * prints.length) / chunks);
        const to = Math.floor(((c + 1) * prints.length) / chunks);
        write('stdout', prints.slice(from, to).join(''));
      }
      if (marker === 'fail') {
        if (!(await pause(this.timings.chunkMs))) return stopped();
        const f = failure(lang, file, line);
        write('stderr', f.stderr);
        return finish('failed', f.exitCode);
      }
      if (marker === 'timeout') {
        // Nothing more until the wall time, as a loop that never ends would.
        if (!(await pause(Math.max(0, limits.wallMs - elapsed)))) return stopped();
        return finish('timed_out', null);
      }
      if (!chunks && !(await pause(this.timings.chunkMs))) return stopped();
      return finish('succeeded', 0);
    };

    void script().catch(() => finish('internal_error', null, null));
    return {
      cancel: () => {
        if (done || cancelled) return;
        cancelled = true;
        const w = wake as (() => void) | null;
        if (w) w();
      },
    };
  }
}

export function createMockExecutor(opts: MockExecutorOptions = {}): Executor { return new MockExecutor(opts); }

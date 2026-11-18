// The Docker runner (lib/interviews/runs/docker-executor.ts, docker-process.ts, docker-runtimes.ts) over a fake
// spawner: the exact hardened argument list, no shell, the allowlist, the marker that splits compile output from the
// program's, the timers, cancel, truncation and the output flood, and Docker missing or unreachable. Nothing here
// starts a process; docker-executor.real.test.ts runs the same runner against a real Docker when REAL_DOCKER_RUNS=1.
jest.mock('../../../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));
import { EventEmitter } from 'node:events';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { DEFAULT_RUN_LIMITS, RUN_LANGUAGES, type ExecutorOutput, type RunLanguage, type RunLimits, type RunRequest, type RunResult } from '../executor.js';
import { checkSpec, createDockerProcesses, dockerRunArgs, type ContainerSpec, type DockerChild, type SpawnImpl } from '../docker-process.js';
import { DOCKER_IMAGES, DOCKER_RUNTIMES } from '../docker-runtimes.js';
import { createDockerExecutor, DOCKER_BACKEND, DOCKER_SENTENCES, runTar } from '../docker-executor.js';
import { createRunExecutor, runBackendChoice } from '../backend.js';
import { MockExecutor } from '../mock-executor.js';
import { COMPILE_ALLOWANCE_MS } from '../service.js';

class FakeChild extends EventEmitter implements DockerChild {
  stdin: Writable;
  stdout = new PassThrough();
  stderr = new PassThrough();
  input = Buffer.alloc(0);
  killed: string[] = [];
  constructor() {
    super();
    this.stdin = new Writable({ write: (c: Buffer, _e, cb) => { this.input = Buffer.concat([this.input, c]); cb(); } });
  }
  kill(signal?: NodeJS.Signals): boolean { this.killed.push(signal ?? 'SIGTERM'); return true; }
  out(text: string) { this.stdout.write(text); }
  err(text: string) { this.stderr.write(text); }
  /** Ends the process once its output has been read. */
  close(code: number | null) { setImmediate(() => this.emit('close', code, null)); }
}

interface Call { command: string; args: readonly string[]; shell: unknown; child: FakeChild }

function fakeDocker(opts: { onRemove?: (run: FakeChild) => void } = {}) {
  const calls: Call[] = [];
  const spawnImpl: SpawnImpl = (command, args, options) => {
    const child = new FakeChild();
    calls.push({ command, args, shell: options.shell, child });
    if (args[0] === 'rm') {
      child.close(0);
      const run = calls.find((c) => c.args[0] === 'run');
      if (run) (opts.onRemove ?? ((r) => r.close(137)))(run.child);
    }
    return child;
  };
  const run = () => calls.find((c) => c.args[0] === 'run')!;
  const removes = () => calls.filter((c) => c.args[0] === 'rm');
  return { calls, spawnImpl, processes: createDockerProcesses(spawnImpl), run, removes };
}

const FILE: Record<RunLanguage, string> = { python: 'main.py', swift: 'main.swift', javascript: 'main.js', typescript: 'main.ts', java: 'Main.java', go: 'main.go', cpp: 'main.cpp' };
const SOURCE = 'print("$(rm -rf /) `id` ; echo pwned")\n';
const request = (language: RunLanguage, limits: Partial<RunLimits> = {}, stdin?: string): RunRequest => ({
  runId: `docker-test-${language}`, interviewId: 'iv-docker', language, files: [{ path: FILE[language], content: SOURCE }], entrypoint: FILE[language],
  limits: { ...DEFAULT_RUN_LIMITS, ...limits }, ...(stdin !== undefined ? { stdin } : {}),
});

function start(fake: ReturnType<typeof fakeDocker>, req: RunRequest, opts: { startMs?: number; compileMs?: number; stopGraceMs?: number } = {}) {
  const events: Extract<ExecutorOutput, { type: 'event' }>[] = [];
  let resolve: (r: RunResult) => void = () => undefined;
  const result = new Promise<RunResult>((r) => { resolve = r; });
  let results = 0;
  const ex = createDockerExecutor({ processes: fake.processes, removeRetryMs: 10, ...opts });
  const handle = ex.start(req, (o) => {
    if (o.type === 'event') events.push(o);
    else { results += 1; resolve(o.result); }
  });
  const markerOf = () => fake.run().args.at(-2)!;
  return {
    handle, events, result, results: () => results, markerOf,
    statuses: () => events.filter((e) => e.stream === 'status').map((e) => e.data),
    /** The script's compile marker on stdout: the compile begins. */
    compile: () => fake.run().child.out(`${markerOf()}:compile\n`),
    /** The script's marker line on both streams: the program starts. */
    begin: () => { const m = markerOf(); fake.run().child.out(`${m}\n`); fake.run().child.err(`${m}\n`); },
  };
}
const tick = () => new Promise((r) => setImmediate(r));

describe('the Docker runner: the command it starts', () => {
  it('only docker-process.ts can start a process, and only the docker binary (the I4.4 judge holds the same rule)', () => {
    const dir = join(__dirname, '..');
    const sources = readdirSync(dir).filter((f) => f.endsWith('.ts')).map((f) => ({ f, text: readFileSync(join(dir, f), 'utf8') }));
    const spawners = sources.filter((s) => /from '(node:)?child_process'/.test(s.text)).map((s) => s.f);
    expect(spawners).toEqual(['docker-process.ts']);
    const dp = sources.find((s) => s.f === 'docker-process.ts')!.text;
    expect(dp).toContain("import { spawn } from 'node:child_process';");
    expect(dp.match(/\bspawn\([^)]*/g)).toEqual(['spawn(DOCKER_BIN, [...args], { ...options, stdio: [...options.stdio] }']);
    for (const s of sources) expect(s.text).not.toMatch(/from '(node:)?(vm|worker_threads|net|http|https|dgram|tls|cluster)'|\beval\(|new Function\(/);
  });

  it('starts only the docker binary, without a shell, with exactly the hardened argument list', () => {
    const fake = fakeDocker();
    start(fake, request('python'));
    const { command, args, shell } = fake.run();
    expect(command).toBe('docker');
    expect(shell).toBe(false);
    const name = args[args.indexOf('--name') + 1]!;
    const marker = args.at(-2)!;
    expect(name).toMatch(/^iv-run-[0-9a-f]{16}$/);
    expect(marker).toMatch(/^[0-9a-f]{32}$/);
    expect(args).toEqual([
      'run', '--rm', '--interactive', '--pull', 'never',
      '--name', name, '--label', 'interviews.run=1', '--hostname', 'sandbox',
      '--init',
      '--network', 'none',
      '--read-only',
      '--tmpfs', '/work:rw,exec,nosuid,nodev,size=128m,mode=1777',
      '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777',
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '--user', '65534:65534',
      '--pids-limit', '64',
      '--memory', '256m', '--memory-swap', '256m',
      '--cpus', '1',
      '--ulimit', 'core=0', '--ulimit', 'nofile=256:256',
      '--ipc', 'private',
      '--log-driver', 'none',
      '--no-healthcheck',
      '--env', 'HOME=/work', '--env', 'TMPDIR=/work/.tmp', '--env', 'LANG=C.UTF-8', '--env', 'PYTHONUNBUFFERED=1',
      '--workdir', '/work',
      '--entrypoint', '/bin/sh',
      'python:3.12.7-slim-bookworm',
      '-c', DOCKER_RUNTIMES.python.script, 'sandbox', marker, 'main.py',
    ]);
    // No host mount of any kind, and no privilege flag.
    expect(args.some((a) => /^(-v|--volume|--mount|--privileged|--cap-add|--device|--pid|--userns)$/.test(a))).toBe(false);
  });

  it.each(RUN_LANGUAGES.map((l) => [l]))('%s: its allowlisted image and fixed script; the code goes in on stdin, never on the command line', (lang) => {
    const fake = fakeDocker();
    start(fake, request(lang, {}, 'the input'));
    const { args, child } = fake.run();
    const rt = DOCKER_RUNTIMES[lang];
    expect(args[args.indexOf('/bin/sh') + 1]).toBe(rt.image);
    expect(args.at(-4)).toBe(rt.script);
    expect(args.at(-1)).toBe(FILE[lang]);
    expect(args.join(' ')).not.toContain('pwned');
    expect(args).toContain('--network');
    expect(args[args.indexOf('--memory') + 1]).toBe(`${Math.max(256, rt.minMemoryMb)}m`);
    // The tar on stdin carries the source under src/ and the input as .stdin.
    const tar = child.input.toString('latin1');
    expect(tar).toContain(`src/${FILE[lang]}`);
    expect(tar).toContain('pwned');
    expect(tar).toContain('.stdin');
    expect(tar).toContain('the input');
    expect(child.input.length % 512).toBe(0);
  });

  it('every row names a pinned image (a version tag, never latest) and a script with no placeholder for code', () => {
    for (const rt of Object.values(DOCKER_RUNTIMES)) {
      expect(rt.image).toMatch(/^[a-z-]+:\d+\.\d+(\.\d+)?[\w.-]*$/);
      expect(rt.image).not.toMatch(/latest/);
      expect(rt.script).not.toMatch(/\$\{?[03-9@*]/);
      expect(DOCKER_IMAGES).toContain(rt.image);
    }
  });

  it('a compiled row prints its compile marker before compiling, and its start and compile fit the service\'s allowance', () => {
    for (const rt of Object.values(DOCKER_RUNTIMES)) {
      const markAt = rt.script.indexOf(`printf '%s:compile\\n' "$1";`);
      expect(markAt >= 0).toBe(rt.compiled);
      expect(rt.compileMs > 0).toBe(rt.compiled);
      if (rt.compiled) expect(markAt).toBeLessThan(rt.script.indexOf('|| exit 97'));
      expect(rt.startMs + rt.compileMs).toBeLessThanOrEqual(COMPILE_ALLOWANCE_MS);
    }
  });

  it('refuses a spec off the allowlist before anything starts', () => {
    const rt = DOCKER_RUNTIMES.python;
    const good: ContainerSpec = { name: 'iv-run-0123456789abcdef', image: rt.image, script: rt.script, marker: 'a'.repeat(32), entrypoint: 'main.py', memoryMb: 256, cpus: 1, pidsLimit: 64, env: {} };
    expect(() => checkSpec(good)).not.toThrow();
    const bad: Partial<ContainerSpec>[] = [
      { name: 'orgiq-social-1' }, { name: 'iv-run-xyz' }, { image: 'alpine:latest' }, { script: 'rm -rf /' }, { marker: 'nothex' },
      { entrypoint: '-o' }, { entrypoint: '../main.py' }, { entrypoint: '/etc/passwd' }, { entrypoint: 'a b.py' }, { entrypoint: '$(id).py' },
      { memoryMb: 0 }, { memoryMb: 1e9 }, { cpus: 0 }, { pidsLimit: 1e6 }, { env: { PATH: '/x y' } }, { env: { 'A;B': 'x' } },
    ];
    const calls: string[][] = [];
    const processes = createDockerProcesses((_c, args) => { calls.push([...args]); return new FakeChild(); });
    for (const b of bad) {
      expect(() => dockerRunArgs({ ...good, ...b })).toThrow(/docker runner/);
      expect(() => processes.run({ ...good, ...b })).toThrow(/docker runner/);
    }
    expect(() => processes.remove('orgiq-social-1')).toThrow(/docker runner/);
    expect(calls).toEqual([]);
  });

  it('a request with a path that is not plain is refused with a sentence, and nothing starts', async () => {
    const fake = fakeDocker();
    const r = start(fake, { ...request('python'), files: [{ path: '../x.py', content: 'x' }], entrypoint: '../x.py' });
    const res = await r.result;
    expect(res.status).toBe('internal_error');
    expect(res.stderr).toBe(DOCKER_SENTENCES.failedStart);
    expect(fake.calls).toEqual([]);
  });

  it('writes a tar whose header checksums are right', () => {
    const tar = runTar([{ path: 'a/main.py', content: 'x' }], '');
    for (let off = 0; off + 512 <= tar.length; off += 512) {
      const h = tar.subarray(off, off + 512);
      if (h.every((b) => b === 0)) continue;
      if (h.toString('latin1', 257, 262) !== 'ustar') continue;
      const stored = parseInt(h.toString('latin1', 148, 154), 8);
      const copy = Buffer.from(h); copy.fill(0x20, 148, 156);
      expect(copy.reduce((s, b) => s + b, 0)).toBe(stored);
    }
    expect(tar.toString('latin1')).toMatch(/src\/a\/\0/);
  });
});

describe('the Docker runner: statuses and output', () => {
  it('succeeded: what comes before the marker is not the program\'s output; after it, streamed in order', async () => {
    const fake = fakeDocker();
    const r = start(fake, request('python'));
    fake.run().child.err('WARNING: some docker notice\n');
    r.begin();
    fake.run().child.out('hello\n');
    fake.run().child.out('world\n');
    await tick();
    fake.run().child.close(0);
    const res = await r.result;
    expect(res).toMatchObject({ status: 'succeeded', exitCode: 0, stdout: 'hello\nworld\n', stderr: '', backend: DOCKER_BACKEND, runtimeVersion: 'Python 3.12.7', peakMemoryMb: null });
    expect(r.statuses()).toEqual(['running']);
    expect(r.events.filter((e) => e.stream === 'stdout').map((e) => e.data).join('')).toBe('hello\nworld\n');
    expect(r.results()).toBe(1);
  });

  it('compiled: compiling, then running at the marker', async () => {
    const fake = fakeDocker();
    const r = start(fake, request('cpp'));
    await tick();
    expect(r.statuses()).toEqual(['compiling']);
    r.begin();
    fake.run().child.out('hi\n');
    await tick();
    fake.run().child.close(0);
    expect((await r.result).status).toBe('succeeded');
    expect(r.statuses()).toEqual(['compiling', 'running']);
  });

  it('compile_error: exit 97 before the marker, with the compiler\'s words (and not the compile marker)', async () => {
    const fake = fakeDocker();
    const r = start(fake, request('go'));
    r.compile();
    fake.run().child.err('./main.go:3:2: undefined: totl\n');
    await tick();
    fake.run().child.close(97);
    const res = await r.result;
    expect(res).toMatchObject({ status: 'compile_error', exitCode: 1, compileOutput: './main.go:3:2: undefined: totl\n' });
    expect(r.statuses()).toEqual(['compiling']);
  });

  it('failed on a non-zero exit; memory_exceeded on 137 the runner did not cause', async () => {
    for (const [code, status] of [[1, 'failed'], [125, 'failed'], [137, 'memory_exceeded']] as const) {
      const fake = fakeDocker();
      const r = start(fake, request('javascript'));
      r.begin();
      fake.run().child.err('Error: boom\n');
      await tick();
      fake.run().child.close(code);
      const res = await r.result;
      expect([res.status, res.exitCode, res.stderr]).toEqual([status, code, 'Error: boom\n']);
      expect(fake.removes()).toEqual([]);
    }
  });

  it('timed_out at the wall time: the container is removed by name', async () => {
    const fake = fakeDocker();
    const r = start(fake, request('python', { wallMs: 30 }));
    r.begin();
    const res = await r.result;
    expect(res.status).toBe('timed_out');
    expect(res.exitCode).toBeNull();
    const name = fake.run().args[fake.run().args.indexOf('--name') + 1];
    expect(fake.removes()[0]!.args).toEqual(['rm', '--force', name]);
    expect(fake.removes()[0]!.command).toBe('docker');
  });

  it('runner_timeout when the container never prints its marker: the runner\'s failure, said in a sentence, not the candidate\'s timeout', async () => {
    const fake = fakeDocker();
    const r = start(fake, request('python'), { startMs: 20 });
    const res = await r.result;
    expect(res).toMatchObject({ status: 'runner_timeout', exitCode: null, stderr: DOCKER_SENTENCES.slowStart, stdout: '' });
    expect(r.statuses()).toEqual([]);
    expect(fake.removes()[0]!.args[0]).toBe('rm');
  });

  it('runner_timeout when a compiled language\'s container never begins its compile', async () => {
    const fake = fakeDocker();
    const r = start(fake, request('cpp'), { startMs: 20, compileMs: 60_000 });
    const res = await r.result;
    expect(res).toMatchObject({ status: 'runner_timeout', stderr: DOCKER_SENTENCES.slowStart });
    expect(r.statuses()).toEqual(['compiling']);
    expect(fake.removes().length).toBeGreaterThanOrEqual(1);
  });

  it('a compile that outlasts its limit is the candidate\'s compile timeout (timed_out, charged), never runner_timeout', async () => {
    const fake = fakeDocker();
    const r = start(fake, request('cpp'), { startMs: 30, compileMs: 40 });
    r.compile();
    fake.run().child.err('main.cpp: deep template instantiation\n');
    // Past the start limit, inside the compile limit: still compiling.
    await new Promise((x) => setTimeout(x, 35));
    expect(r.results()).toBe(0);
    const res = await r.result;
    const said = DOCKER_SENTENCES.slowCompile(40);
    expect(res).toMatchObject({ status: 'timed_out', exitCode: null, compileOutput: `main.cpp: deep template instantiation\n${said}`, stderr: said });
    expect(res.compileOutput).not.toContain(':compile');
    expect(r.statuses()).toEqual(['compiling']);
  });

  it('cancelled while running, once, and a second cancel is harmless', async () => {
    const fake = fakeDocker();
    const r = start(fake, request('python'));
    r.begin();
    await tick();
    r.handle.cancel();
    r.handle.cancel();
    const res = await r.result;
    expect(res.status).toBe('cancelled');
    await new Promise((x) => setTimeout(x, 30));
    expect(r.results()).toBe(1);
    // The remove, then its retry for a container still being created.
    expect(fake.removes().length).toBe(2);
  });

  it('cancelled while compiling never reports running, even if the marker arrives after', async () => {
    const fake = fakeDocker({ onRemove: (run) => { const m = fake.run().args.at(-2)!; run.out(`${m}\n`); run.close(137); } });
    const r = start(fake, request('java'));
    await tick();
    r.handle.cancel();
    const res = await r.result;
    expect(res.status).toBe('cancelled');
    expect(r.statuses()).toEqual(['compiling']);
  });

  it('a docker run that never ends after a stop is killed (the process this runner started) and the run ends', async () => {
    const fake = fakeDocker({ onRemove: () => undefined });
    const r = start(fake, request('python'), { stopGraceMs: 20 });
    r.begin();
    await tick();
    r.handle.cancel();
    const res = await r.result;
    expect(res.status).toBe('cancelled');
    expect(fake.run().child.killed).toEqual(['SIGKILL']);
  });

  it('truncation: past maxOutputBytes the output is cut and flagged and the run goes on to its own end', async () => {
    const fake = fakeDocker();
    const r = start(fake, request('python', { maxOutputBytes: 10 }));
    r.begin();
    fake.run().child.out('0123456789abcdefghij\n');
    await tick();
    fake.run().child.close(0);
    const res = await r.result;
    expect(res.status).toBe('succeeded');
    expect(res.stdout).toBe('0123456789');
    expect(res.truncated).toEqual({ stdout: true, stderr: false });
    expect(fake.removes()).toEqual([]);
  });

  it('an output flood (past four times the limit) is stopped and ends failed', async () => {
    const fake = fakeDocker();
    const r = start(fake, request('python', { maxOutputBytes: 100 }));
    r.begin();
    fake.run().child.out('x'.repeat(401));
    const res = await r.result;
    expect(res.status).toBe('failed');
    expect(res.truncated.stdout).toBe(true);
    expect(Buffer.byteLength(res.stdout)).toBe(100);
    expect(fake.removes().length).toBeGreaterThanOrEqual(1);
  });
});

describe('the Docker runner: when Docker is not there', () => {
  it('the docker command missing: internal_error with a plain sentence, no crash', async () => {
    const fake = fakeDocker();
    const r = start(fake, request('python'));
    fake.run().child.emit('error', Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' }));
    fake.run().child.close(-2);
    const res = await r.result;
    expect(res).toMatchObject({ status: 'internal_error', stderr: DOCKER_SENTENCES.noDocker });
    expect(r.results()).toBe(1);
  });

  it('the daemon not reachable: internal_error with a plain sentence, and none of Docker\'s own words', async () => {
    const fake = fakeDocker();
    const r = start(fake, request('python'));
    fake.run().child.err('docker: Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n');
    await tick();
    fake.run().child.close(125);
    const res = await r.result;
    expect(res).toMatchObject({ status: 'internal_error', stderr: DOCKER_SENTENCES.unreachable, stdout: '', compileOutput: '' });
    expect(r.events.map((e) => e.data)).toEqual([DOCKER_SENTENCES.unreachable]);
  });

  it('the image not pulled: internal_error naming the image to pull', async () => {
    const fake = fakeDocker();
    const r = start(fake, request('go'));
    fake.run().child.err('docker: Error response from daemon: No such image: golang:1.23.3-alpine3.20.\n');
    await tick();
    fake.run().child.close(125);
    const res = await r.result;
    expect(res.status).toBe('internal_error');
    expect(res.stderr).toContain('docker pull golang:1.23.3-alpine3.20');
  });

  it('anything else before the program starts: internal_error', async () => {
    const fake = fakeDocker();
    const r = start(fake, request('python'));
    fake.run().child.close(96);
    expect(await r.result).toMatchObject({ status: 'internal_error', stderr: DOCKER_SENTENCES.failedStart });
  });
});

describe('choosing the backend', () => {
  it('the mock unless INTERVIEWS_RUN_BACKEND=docker, and never the Docker runner in production', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(runBackendChoice({})).toBe('mock');
    expect(runBackendChoice({ INTERVIEWS_RUN_BACKEND: 'agentcore' })).toBe('mock');
    expect(runBackendChoice({ INTERVIEWS_RUN_BACKEND: 'docker' })).toBe('docker');
    expect(runBackendChoice({ INTERVIEWS_RUN_BACKEND: ' Docker ' })).toBe('docker');
    expect(runBackendChoice({ INTERVIEWS_RUN_BACKEND: 'docker', NODE_ENV: 'production' })).toBe('mock');
    expect(createRunExecutor({})).toBeInstanceOf(MockExecutor);
    expect(createRunExecutor({ INTERVIEWS_RUN_BACKEND: 'docker' }).backend).toBe(DOCKER_BACKEND);
    warn.mockRestore();
  });
});

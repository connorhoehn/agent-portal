// The AgentCore Code Interpreter executor (lib/interviews/runs/agentcore-executor.ts; row I4.7) and the backend selection
// (select.ts). The unit part runs against a fake interpreter client. The live part runs the executor contract and the hostile
// programs against a real interpreter in AWS, only with INTERVIEWS_CI_LIVE=1 (it spends a fraction of a cent):
//
//   INTERVIEWS_CI_LIVE=1 [INTERVIEWS_CI_ID=aws.codeinterpreter.v1] npx jest src/lib/interviews/runs/__tests__/agentcore-executor.test.ts
jest.mock('../../../../config.js', () => ({ config: { mock: { aurora: true }, region: 'us-east-1' } }));
import {
  AgentCoreExecutor, AGENTCORE_LANGUAGES, NOT_HERE, readBackCommand, statusOf, wrapperScript, type InterpreterClient,
} from '../agentcore-executor.js';
import { DEFAULT_RUN_LIMITS, type RunLanguage } from '../executor.js';
import { NOT_SET_UP, runBackend, unavailableExecutor } from '../select.js';
import { collect, executorContract, requestOf, type ContractProgram } from './executor-contract.js';

const LIMITS = DEFAULT_RUN_LIMITS;

/** A fake interpreter: records the commands, answers each with what the test scripts. */
function fakeClient(answer: (name: string, args: any) => { stdout?: string; isError?: boolean } | Error): InterpreterClient & { calls: Array<{ kind: string; name?: string; args?: any }> } {
  const calls: Array<{ kind: string; name?: string; args?: any }> = [];
  return {
    calls,
    async send(command: any) {
      const kind = command.constructor.name;
      const input = command.input;
      calls.push({ kind, name: input.name, args: input.arguments });
      if (kind === 'StartCodeInterpreterSessionCommand') return { sessionId: 'sess-1' };
      if (kind === 'StopCodeInterpreterSessionCommand') return {};
      const a = answer(input.name, input.arguments);
      if (a instanceof Error) throw a;
      return { stream: (async function* () { yield { result: { isError: a.isError ?? false, structuredContent: { stdout: a.stdout ?? '' } } }; })() };
    },
  };
}

const b64 = (s: string) => Buffer.from(s).toString('base64');
const readBack = (out: string, err: string, code: number | '', version = 'Python 3.12.13') => `${b64(out)}\r\n${b64(err)}\r\n${code}\r\n${version}\r\n`;
const py: ContractProgram = { files: [{ path: 'main.py', content: 'print("hi")' }], entrypoint: 'main.py' };

describe('statusOf', () => {
  it('maps the wrapper\'s exits and the runtimes\' out-of-memory words', () => {
    expect(statusOf('python', 0, '')).toBe('succeeded');
    expect(statusOf('python', 124, '')).toBe('timed_out');
    expect(statusOf('python', 137, '')).toBe('memory_exceeded');
    expect(statusOf('python', 1, 'Traceback...\nMemoryError\n')).toBe('memory_exceeded');
    expect(statusOf('javascript', 134, 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory')).toBe('memory_exceeded');
    expect(statusOf('typescript', 1, 'Error: boom')).toBe('failed');
    expect(statusOf('python', null, '')).toBe('internal_error');
  });
});

describe('the wrapper', () => {
  it('runs the entrypoint under timeout with the limits, each stream capped at one byte past the limit', () => {
    const w = wrapperScript({ ...requestOf('python', py, LIMITS), limits: { wallMs: 2500, memoryMb: 128, maxOutputBytes: 100 } });
    expect(w).toContain('timeout -k 1 3 ');
    expect(w).toContain('ulimit -v 131072');
    expect(w).toContain('ulimit -u 256');
    expect(w).toContain('head -c 101');
    expect(w).toContain('PIPESTATUS[0]');
    const js = wrapperScript(requestOf('javascript', { files: [{ path: 'a.js', content: '' }], entrypoint: 'a.js' }, LIMITS));
    expect(js).toContain('--max-old-space-size=256');
    expect(js).not.toContain('ulimit -v');
    expect(wrapperScript(requestOf('typescript', { files: [{ path: 'a.ts', content: '' }], entrypoint: 'a.ts' }, LIMITS))).toContain('exec tsx');
  });

  it('quotes a file name, so it cannot break out of the command', () => {
    const w = wrapperScript(requestOf('python', { files: [{ path: "x';rm -rf ~;'.py", content: '' }], entrypoint: "x';rm -rf ~;'.py" }, LIMITS));
    expect(w).toContain(`python3 -u '\\''x'\\''\\'\\'''\\'';rm -rf ~;'\\''\\'\\'''\\''.py'\\''`);
  });

  it('reads back four lines', () => {
    expect(readBackCommand('python')).toMatch(/base64 -w0 out\.txt.*base64 -w0 err\.txt.*code\.txt.*python3 -V/);
  });
});

describe('the executor against a fake interpreter', () => {
  it('one session per run: start, write the files, run, read back, stop', async () => {
    const client = fakeClient((name, args) => (name === 'writeFiles' ? { stdout: 'ok' }
      : args.command === 'bash wrap.sh' ? { stdout: '' } : { stdout: readBack('hello\nworld\n', '', 0) }));
    const ex = new AgentCoreExecutor({ interpreterId: 'ci-1', client });
    const c = await collect(ex, requestOf('python', py, LIMITS));
    expect(c.result).toMatchObject({ status: 'succeeded', exitCode: 0, stdout: 'hello\nworld\n', backend: 'agentcore-code-interpreter', runtimeVersion: 'Python 3.12' });
    expect(c.events.map((e) => [e.stream, e.data])).toEqual([['status', 'running'], ['stdout', 'hello\nworld\n']]);
    expect(client.calls.map((x) => (x.kind === 'InvokeCodeInterpreterCommand' ? x.name : x.kind))).toEqual(['StartCodeInterpreterSessionCommand', 'writeFiles', 'executeCommand', 'executeCommand', 'StopCodeInterpreterSessionCommand']);
    const written = client.calls[1]!.args.content.map((f: any) => f.path);
    expect(written).toEqual(['run/main.py', 'stdin.txt', 'wrap.sh']);
  });

  it('cuts each stream at maxOutputBytes and says so', async () => {
    const big = 'x'.repeat(200);
    const client = fakeClient((name, args) => (name === 'writeFiles' || args.command === 'bash wrap.sh' ? { stdout: '' } : { stdout: readBack(big, big, 0) }));
    const c = await collect(new AgentCoreExecutor({ interpreterId: 'ci', client }), { ...requestOf('python', py, LIMITS), limits: { ...LIMITS, maxOutputBytes: 50 } });
    expect(c.result.stdout).toHaveLength(50);
    expect(c.result.truncated).toEqual({ stdout: true, stderr: true });
  });

  it('a compiled language ends at once with a plain sentence, and no session is started', async () => {
    const client = fakeClient(() => ({ stdout: '' }));
    const c = await collect(new AgentCoreExecutor({ interpreterId: 'ci', client }), requestOf('go', { files: [{ path: 'm.go', content: '' }], entrypoint: 'm.go' }, LIMITS));
    expect(c.result.status).toBe('internal_error');
    expect(c.result.stderr).toBe(NOT_HERE('go'));
    expect(client.calls).toEqual([]);
    expect(AGENTCORE_LANGUAGES).toEqual(['python', 'javascript', 'typescript']);
  });

  it('a service failure is internal_error with no service text, and the session is still stopped', async () => {
    const client = fakeClient((name) => (name === 'executeCommand' ? new Error('ThrottlingException: secret detail') : { stdout: '' }));
    const c = await collect(new AgentCoreExecutor({ interpreterId: 'ci', client }), requestOf('python', py, LIMITS));
    expect(c.result.status).toBe('internal_error');
    expect(c.result.stderr).not.toContain('secret');
    expect(client.calls.at(-1)!.kind).toBe('StopCodeInterpreterSessionCommand');
  });

  it('cancel while running stops the session and answers cancelled once', async () => {
    let release: (() => void) | null = null;
    const client: InterpreterClient = {
      async send(command: any, opts?: { abortSignal?: AbortSignal }) {
        const kind = command.constructor.name;
        if (kind === 'StartCodeInterpreterSessionCommand') return { sessionId: 's' };
        if (kind === 'StopCodeInterpreterSessionCommand') { release?.(); return {}; }
        if (command.input.name === 'writeFiles') return { stream: (async function* () { yield { result: { structuredContent: { stdout: '' } } }; })() };
        return new Promise((_, reject) => { release = () => reject(new Error('aborted')); opts?.abortSignal?.addEventListener('abort', () => reject(new Error('aborted'))); });
      },
    };
    const c = await collect(new AgentCoreExecutor({ interpreterId: 'ci', client }), requestOf('python', py, LIMITS), (e, cancel) => { if (e.data === 'running') cancel(); });
    expect(c.result.status).toBe('cancelled');
    expect(c.results).toBe(1);
  });

  it('warns once when the interpreter runs another major version', async () => {
    const warn = jest.fn();
    const client = fakeClient((name, args) => (name === 'writeFiles' || args.command === 'bash wrap.sh' ? { stdout: '' } : { stdout: readBack('', '', 0, 'Python 3.13.1') }));
    const ex = new AgentCoreExecutor({ interpreterId: 'ci', client, warn });
    await collect(ex, requestOf('python', py, LIMITS));
    await collect(ex, requestOf('python', py, LIMITS));
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('the backend selection', () => {
  it('the mock world runs the mock; a cluster never does unless asked by name', () => {
    expect(runBackend({}, true)).toBe('mock');
    expect(runBackend({}, false)).toBe('none');
    expect(runBackend({ INTERVIEWS_CODE_INTERPRETER_ID: 'ci-1' }, false)).toBe('agentcore');
    expect(runBackend({ INTERVIEWS_RUN_BACKEND: 'mock' }, false)).toBe('mock');
    expect(runBackend({ INTERVIEWS_RUN_BACKEND: 'agentcore', INTERVIEWS_CODE_INTERPRETER_ID: 'ci' }, true)).toBe('agentcore');
    expect(() => runBackend({ INTERVIEWS_RUN_BACKEND: 'agentcore' }, false)).toThrow(/INTERVIEWS_CODE_INTERPRETER_ID/);
    expect(() => runBackend({ INTERVIEWS_RUN_BACKEND: 'lambda' }, false)).toThrow(/mock, agentcore or docker/);
  });

  it('"none" ends every run with the plain sentence', async () => {
    const c = await collect(unavailableExecutor, requestOf('python', py, LIMITS));
    expect(c.result).toMatchObject({ status: 'internal_error', stderr: NOT_SET_UP, backend: 'none' });
  });
});

// ── Live: a real interpreter ────────────────────────────────────────────────────────────────────────────────────────
const LIVE = process.env['INTERVIEWS_CI_LIVE'] === '1';
const LIVE_ID = process.env['INTERVIEWS_CI_ID'] ?? 'aws.codeinterpreter.v1';
const ENTRY: Record<string, string> = { python: 'main.py', javascript: 'main.js', typescript: 'main.ts' };
const SRC: Record<string, Record<string, string>> = {
  python: {
    hello: 'print("hello")\nprint("world")\n',
    fail: 'import sys\nsys.stderr.write("boom\\n")\nsys.exit(3)\n',
    forever: 'import time\nwhile True:\n    time.sleep(1)\n',
    memory: 'x = []\nwhile True:\n    x.append(bytearray(10 * 1024 * 1024))\n',
    flood: 'import sys\nfor i in range(20000):\n    sys.stdout.write("flood line %d\\n" % i)\n',
  },
  javascript: {
    hello: 'console.log("hello");\nconsole.log("world");\n',
    fail: 'console.error("boom");\nprocess.exit(3);\n',
    forever: 'setInterval(() => {}, 1000);\n',
    // Large strings live on V8's heap and reach its limit in a few steps (an array of small numbers spends the wall time in GC first).
    memory: 'const x = [];\nfor (let i = 0; ; i++) x.push(String(i).padEnd(16 * 1024 * 1024, "x"));\n',
    flood: 'for (let i = 0; i < 20000; i++) process.stdout.write(`flood line ${i}\\n`);\n',
  },
};
SRC['typescript'] = Object.fromEntries(Object.entries(SRC['javascript']!).map(([k, v]) => [k, `const tag: string = "ts";\nvoid tag;\n${v}`]));
const program = (kind: string) => (language: RunLanguage): ContractProgram => ({ files: [{ path: ENTRY[language]!, content: SRC[language]![kind]! }], entrypoint: ENTRY[language]! });

(LIVE ? describe : describe.skip)(`live: the interpreter ${LIVE_ID}`, () => {
  executorContract('agentcore-code-interpreter (live)', {
    make: () => new AgentCoreExecutor({ interpreterId: LIVE_ID, region: 'us-east-1' }),
    languages: AGENTCORE_LANGUAGES,
    timeoutMs: 40_000,
    programs: {
      hello: program('hello'), fail: program('fail'), forever: program('forever'), memory: program('memory'), flood: program('flood'),
      compileError: () => { throw new Error('no compiled languages here'); },
    },
    internalError: (language) => ({ executor: new AgentCoreExecutor({ interpreterId: 'no-such-interpreter-0000000000', region: 'us-east-1' }), program: program('hello')(language) }),
  });

  const live = () => new AgentCoreExecutor({ interpreterId: LIVE_ID, region: 'us-east-1' });
  const runPy = (src: string, files: Array<{ path: string; content: string }> = []) =>
    collect(live(), requestOf('python', { files: [{ path: 'main.py', content: src }, ...files], entrypoint: 'main.py' }, { ...LIMITS, wallMs: 5000 }));

  it('hostile: a fork bomb ends within the wall time and the next run is unaffected', async () => {
    const c = await runPy('import os\nwhile True:\n    try:\n        os.fork()\n    except OSError:\n        pass\n');
    expect(['failed', 'memory_exceeded', 'timed_out']).toContain(c.result.status);
    expect((await runPy('print("ok")')).result.stdout).toBe('ok\n');
  }, 60_000);

  it('hostile: no DNS, no outside socket, no metadata credentials', async () => {
    const c = await runPy([
      'import socket, urllib.request',
      'def tryit(f):',
      '    try:',
      '        f(); return "open"',
      '    except Exception as e:',
      '        return "closed"',
      'print(tryit(lambda: socket.getaddrinfo("example.com", 443)))',
      'print(tryit(lambda: socket.create_connection(("1.1.1.1", 443), timeout=2)))',
      'def meta():',
      '    t = urllib.request.urlopen(urllib.request.Request("http://169.254.169.254/latest/api/token", method="PUT", headers={"X-aws-ec2-metadata-token-ttl-seconds": "60"}), timeout=2).read().decode()',
      '    body = urllib.request.urlopen(urllib.request.Request("http://169.254.169.254/latest/meta-data/iam/security-credentials/", headers={"X-aws-ec2-metadata-token": t}), timeout=2).read().decode()',
      '    if not body.strip(): raise RuntimeError("empty")',
      'print(tryit(meta))',
    ].join('\n'));
    expect(c.result.stdout).toBe('closed\nclosed\nclosed\n');
  }, 60_000);

  it('hostile: a file written in one run is gone in the next', async () => {
    await runPy('open("left.txt", "w").write("x")\nprint("wrote")');
    const c = await runPy('import os\nprint(os.path.exists("left.txt"), os.path.exists("../run/left.txt"))');
    expect(c.result.stdout).toBe('False False\n');
  }, 60_000);
});

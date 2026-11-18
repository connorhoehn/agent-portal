// The mock executor (lib/interviews/runs/mock-executor.ts; row I4.4) against the executor contract, then what is the
// mock's own: the literal prints of each language, the markers, determinism, and that it never runs anything.
// The mock's pauses are injected at a hundredth of their length, so the contract's waits take milliseconds.
jest.mock('../../../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));
import { DEFAULT_RUN_LIMITS, type Executor, type RunLanguage } from '../executor.js';
import { createMockExecutor, literalPrints, markerOf, simulatedOutput, MOCK_RUNTIME_VERSIONS, type MockExecutorOptions } from '../mock-executor.js';
import { collect, executorContract, requestOf, type ContractProgram } from './executor-contract.js';

const fast: MockExecutorOptions = { wait: (ms) => new Promise((r) => setTimeout(r, ms / 100)) };
const make = (): Executor => createMockExecutor(fast);

const comment = (lang: RunLanguage, text: string) => (lang === 'python' ? `# ${text}` : `// ${text}`);
const FILE: Record<RunLanguage, string> = { python: 'main.py', swift: 'main.swift', javascript: 'main.js', typescript: 'main.ts', java: 'Main.java', go: 'main.go', cpp: 'main.cpp' };

/** A small program in the language's own shape that prints `hello` then `world`. */
function helloSource(lang: RunLanguage): string {
  switch (lang) {
    case 'python': return 'def main():\n    print("hello")\n    print(\'world\')\n\nmain()\n';
    case 'swift': return 'func main() {\n    print("hello")\n    print("world")\n}\nmain()\n';
    case 'javascript': return 'function main() {\n  console.log("hello");\n  console.log(`world`);\n}\nmain();\n';
    case 'typescript': return 'function main(): void {\n  console.log(\'hello\');\n  console.log("world");\n}\nmain();\n';
    case 'java': return 'public class Main {\n  public static void main(String[] args) {\n    System.out.println("hello");\n    System.out.println("world");\n  }\n}\n';
    case 'go': return 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("hello")\n\tfmt.Println("world")\n}\n';
    case 'cpp': return '#include <iostream>\n\nint main() {\n  std::cout << "hello" << std::endl;\n  std::cout << "world\\n";\n  return 0;\n}\n';
  }
}
const program = (lang: RunLanguage, marker?: string): ContractProgram =>
  ({ entrypoint: FILE[lang], files: [{ path: FILE[lang], content: marker ? `${comment(lang, marker)}\n${helloSource(lang)}` : helloSource(lang) }] });

executorContract('mock', {
  make,
  programs: {
    hello: (l) => program(l),
    fail: (l) => program(l, 'mock:fail'),
    compileError: (l) => program(l, 'mock:compile-error'),
    forever: (l) => program(l, 'mock:timeout'),
    memory: (l) => program(l, 'mock:memory'),
    flood: (l) => program(l, 'mock:flood'),
  },
  internalError: (l) => ({ executor: make(), program: program(l, 'mock:internal') }),
});

describe('the mock executor, its own behaviour', () => {
  it('reads the obvious literal output calls of each language, in order', () => {
    expect(literalPrints('python', 'print("a")\nx = 1\nprint(\'b\\tc\')\nprint(x)')).toEqual(['a\n', 'b\tc\n']);
    expect(literalPrints('javascript', 'console.log("a"); console.log(`b`); console.log(1)')).toEqual(['a\n', 'b\n']);
    expect(literalPrints('java', 'System.out.println("a \\"q\\""); System.out.println(\'c\');')).toEqual(['a "q"\n']);
    expect(literalPrints('go', 'fmt.Println("go")')).toEqual(['go\n']);
    expect(literalPrints('cpp', 'std::cout << "a"; std::cout << "b" << std::endl; std::cout << "c\\n";')).toEqual(['a', 'b\n', 'c\n']);
    expect(literalPrints('swift', 'print("s")')).toEqual(['s\n']);
  });

  it('finds a marker anywhere in any file', () => {
    expect(markerOf([{ content: 'x' }, { content: 'y // mock:flood here' }])).toBe('flood');
    expect(markerOf([{ content: 'mock:compile-error' }])).toBe('compile-error');
    expect(markerOf([{ content: 'mock:other' }])).toBeNull();
  });

  it('is deterministic: the same request gives the same events and result', async () => {
    const req = requestOf('go', program('go', 'mock:fail'), DEFAULT_RUN_LIMITS);
    const a = await collect(make(), req);
    const b = await collect(make(), req);
    expect(b.events).toEqual(a.events);
    expect(b.result).toEqual(a.result);
    expect(a.result.stderr).toMatch(/^panic: mock failure/);
    expect(a.result.exitCode).toBe(2);
    expect(a.result.stdout).toBe('hello\nworld\n');
  });

  it('prints plain values as the language would, and says plainly when a print is not simulated (E4 finding 43)', async () => {
    expect(simulatedOutput('python', 'print("a")\nprint(42)\nprint(True)\nprint(None)')).toEqual(['a\n', '42\n', 'True\n', 'None\n']);
    expect(simulatedOutput('javascript', 'console.log(`b`); console.log(false)')).toEqual(['b\n', 'false\n']);
    expect(simulatedOutput('python', 'def post(n):\n    return n\nprint("start")\nprint(post(1))\nprint(x)')).toEqual([
      'start\n', '[demo workspace] print(post(1)) is not simulated here: this runner prints literal values only.\n',
    ]);
    const c = await collect(make(), requestOf('python', { entrypoint: 'main.py', files: [{ path: 'main.py', content: 'print(post(1))\n' }] }, DEFAULT_RUN_LIMITS));
    expect(c.result).toMatchObject({ status: 'succeeded', exitCode: 0, stdout: '[demo workspace] print(post(1)) is not simulated here: this runner prints literal values only.\n' });
  });

  it('never runs what it is given: code that would exit, read the disk or open a socket just "ran, no output"', async () => {
    const src = 'import os, socket\nos.system("rm -rf /")\nsocket.create_connection(("169.254.169.254", 80))\nraise SystemExit(3)\n';
    const c = await collect(make(), requestOf('python', { entrypoint: 'main.py', files: [{ path: 'main.py', content: src }] }, DEFAULT_RUN_LIMITS));
    expect(c.result).toMatchObject({ status: 'succeeded', exitCode: 0, stdout: '', stderr: '', backend: 'mock', runtimeVersion: MOCK_RUNTIME_VERSIONS.python });
    expect(c.events.filter((e) => e.stream !== 'status')).toEqual([]);
  });

  it('prints over a few timed chunks, at most four', async () => {
    const lines = Array.from({ length: 9 }, (_, i) => `print("${i}")`).join('\n');
    const c = await collect(make(), requestOf('python', { entrypoint: 'main.py', files: [{ path: 'main.py', content: lines }] }, DEFAULT_RUN_LIMITS));
    const chunks = c.events.filter((e) => e.stream === 'stdout');
    expect(chunks.length).toBe(4);
    expect(c.result.stdout).toBe(Array.from({ length: 9 }, (_, i) => `${i}\n`).join(''));
    expect(c.result.timeMs).toBe(120 + 4 * 180);
  });

  it('an interpreted language asked for a compile error fails with a syntax error instead', async () => {
    const c = await collect(make(), requestOf('python', program('python', 'mock:compile-error'), DEFAULT_RUN_LIMITS));
    expect(c.result.status).toBe('failed');
    expect(c.result.stderr).toMatch(/SyntaxError/);
  });

  it('a cancel before anything happened is a cancelled result, once', async () => {
    const ex = make();
    let results = 0;
    const done = new Promise<string>((resolve) => {
      const h = ex.start(requestOf('java', program('java'), DEFAULT_RUN_LIMITS), (o) => { if (o.type === 'result') { results++; resolve(o.result.status); } });
      h.cancel();
      h.cancel();
    });
    expect(await done).toBe('cancelled');
    await new Promise((r) => setTimeout(r, 30));
    expect(results).toBe(1);
  });

  it('uses the plan\'s pinned version for every language', () => {
    expect(Object.keys(MOCK_RUNTIME_VERSIONS).sort()).toEqual(['cpp', 'go', 'java', 'javascript', 'python', 'swift', 'typescript']);
  });
});

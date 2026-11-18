// The Docker runner against a real Docker (docs/interviews-tenant-plan.md "I4.6 answer", "The Docker runner on a
// developer's machine"). Skipped unless REAL_DOCKER_RUNS=1, and the images in docker-runtimes.ts must be pulled first.
//
//   REAL_DOCKER_RUNS=1 npx jest src/lib/interviews/runs/__tests__/docker-executor.real.test.ts
//   REAL_DOCKER_LANGUAGES=python,javascript,cpp   (optional; the default is all seven)
//
// Two parts: the executor contract (executor-contract.ts) with real programs that do what each name says, and the
// hostile programs the contract leaves to a real backend: a fork bomb, a socket, a DNS lookup and the metadata address,
// a write outside the working directory, a file that must not survive to the next run, and an output flood.
jest.mock('../../../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));
import { execFileSync } from 'node:child_process';
import { RUN_LANGUAGES, type Executor, type RunLanguage, type RunLimits } from '../executor.js';
import { createDockerExecutor } from '../docker-executor.js';
import { collect, executorContract, requestOf, type ContractProgram, type ContractPrograms } from './executor-contract.js';

const REAL = process.env['REAL_DOCKER_RUNS'] === '1';
const LANGUAGES = ((process.env['REAL_DOCKER_LANGUAGES'] ?? '').split(',').map((s) => s.trim()).filter(Boolean) as RunLanguage[]).filter((l) => RUN_LANGUAGES.includes(l));
const languages: RunLanguage[] = LANGUAGES.length ? LANGUAGES : ['python', 'javascript', 'typescript', 'go', 'cpp', 'java', 'swift'];

const FILE: Record<RunLanguage, string> = { python: 'main.py', swift: 'main.swift', javascript: 'main.js', typescript: 'main.ts', java: 'Main.java', go: 'main.go', cpp: 'main.cpp' };
const one = (lang: RunLanguage, content: string): ContractProgram => ({ entrypoint: FILE[lang], files: [{ path: FILE[lang], content }] });
const js = (body: string) => body;

const SRC: Record<keyof ContractPrograms, Record<RunLanguage, string>> = {
  hello: {
    python: 'print("hello")\nprint("world")\n',
    javascript: js('console.log("hello");\nconsole.log("world");\n'),
    typescript: 'const words: string[] = ["hello", "world"];\nfor (const w of words) console.log(w);\n',
    go: 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("hello")\n\tfmt.Println("world")\n}\n',
    cpp: '#include <iostream>\nint main() {\n  std::cout << "hello" << std::endl;\n  std::cout << "world\\n";\n}\n',
    java: 'public class Main {\n  public static void main(String[] a) {\n    System.out.println("hello");\n    System.out.println("world");\n  }\n}\n',
    swift: 'print("hello")\nprint("world")\n',
  },
  fail: {
    python: 'import sys\nsys.stderr.write("boom\\n")\nsys.exit(3)\n',
    javascript: 'console.error("boom");\nprocess.exit(3);\n',
    typescript: 'const code: number = 3;\nconsole.error("boom");\nprocess.exit(code);\n',
    go: 'package main\n\nimport (\n\t"fmt"\n\t"os"\n)\n\nfunc main() {\n\tfmt.Fprintln(os.Stderr, "boom")\n\tos.Exit(3)\n}\n',
    cpp: '#include <iostream>\nint main() {\n  std::cerr << "boom\\n";\n  return 3;\n}\n',
    java: 'public class Main {\n  public static void main(String[] a) {\n    System.err.println("boom");\n    System.exit(3);\n  }\n}\n',
    swift: 'import Foundation\nFileHandle.standardError.write("boom\\n".data(using: .utf8)!)\nexit(3)\n',
  },
  compileError: {
    python: '', javascript: '', typescript: '',
    go: 'package main\n\nfunc main() {\n\ttotal := 0\n\ttotl += 1\n}\n',
    cpp: 'int main() {\n  int total = 0;\n  totl += 1;\n}\n',
    java: 'public class Main {\n  public static void main(String[] a) {\n    int total = 0\n  }\n}\n',
    swift: 'var total = 0\ntotl += 1\n',
  },
  forever: {
    python: 'while True:\n    pass\n',
    javascript: 'for (;;) {}\n',
    typescript: 'let n: number = 0;\nfor (;;) { n++; }\n',
    go: 'package main\n\nfunc main() {\n\tn := 0\n\tfor {\n\t\tn++\n\t}\n}\n',
    cpp: 'int main() {\n  volatile unsigned long n = 0;\n  for (;;) n++;\n}\n',
    java: 'public class Main {\n  static volatile long n;\n  public static void main(String[] a) {\n    while (true) n++;\n  }\n}\n',
    swift: 'var n = 0\nwhile true { n &+= 1 }\n',
  },
  memory: {
    python: 'chunks = []\nwhile True:\n    chunks.append(b"x" * (16 << 20))\n',
    javascript: 'const chunks = [];\nfor (;;) chunks.push(Buffer.alloc(16 << 20, 1));\n',
    typescript: 'const chunks: Buffer[] = [];\nfor (;;) chunks.push(Buffer.alloc(16 << 20, 1));\n',
    go: 'package main\n\nvar keep [][]byte\n\nfunc main() {\n\tfor {\n\t\tb := make([]byte, 16<<20)\n\t\tfor i := range b {\n\t\t\tb[i] = 1\n\t\t}\n\t\tkeep = append(keep, b)\n\t}\n}\n',
    cpp: '#include <vector>\n#include <cstring>\nint main() {\n  std::vector<char*> keep;\n  for (;;) { char* p = new char[16 << 20]; std::memset(p, 1, 16 << 20); keep.push_back(p); }\n}\n',
    java: 'import java.util.*;\npublic class Main {\n  public static void main(String[] a) {\n    List<byte[]> keep = new ArrayList<>();\n    for (;;) { byte[] b = new byte[16 << 20]; Arrays.fill(b, (byte) 1); keep.add(b); }\n  }\n}\n',
    swift: 'var keep: [[UInt8]] = []\nwhile true { keep.append([UInt8](repeating: 1, count: 16 << 20)) }\n',
  },
  flood: {
    // About 10 KB: past a 4 KB limit, and under four times it, so the run is cut but goes on to its own end.
    python: 'for i in range(1000):\n    print("line %04d" % i)\n',
    javascript: 'for (let i = 0; i < 1000; i++) console.log("line " + String(i).padStart(4, "0"));\n',
    typescript: 'for (let i: number = 0; i < 1000; i++) console.log("line " + String(i).padStart(4, "0"));\n',
    go: 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfor i := 0; i < 1000; i++ {\n\t\tfmt.Printf("line %04d\\n", i)\n\t}\n}\n',
    cpp: '#include <cstdio>\nint main() {\n  for (int i = 0; i < 1000; i++) std::printf("line %04d\\n", i);\n}\n',
    java: 'public class Main {\n  public static void main(String[] a) {\n    for (int i = 0; i < 1000; i++) System.out.printf("line %04d%n", i);\n  }\n}\n',
    swift: 'for i in 0..<1000 { print("line \\(1000 + i)") }\n',
  },
};

const programs: ContractPrograms = {
  hello: (l) => one(l, SRC.hello[l]), fail: (l) => one(l, SRC.fail[l]), compileError: (l) => one(l, SRC.compileError[l]),
  forever: (l) => one(l, SRC.forever[l]), memory: (l) => one(l, SRC.memory[l]), flood: (l) => one(l, SRC.flood[l]),
};

const make = (): Executor => createDockerExecutor();
const LIMITS: RunLimits = { wallMs: 10_000, memoryMb: 256, maxOutputBytes: 64 * 1024 };

/** This runner's containers still present (only the `iv-run-` prefix; nothing else is read). */
function leftovers(): string[] {
  const out = execFileSync('docker', ['ps', '--all', '--filter', 'name=^iv-run-', '--format', '{{.Names}}'], { encoding: 'utf8', timeout: 15_000 });
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

if (!REAL) {
  describe('the Docker runner against a real Docker', () => {
    it.skip('needs REAL_DOCKER_RUNS=1 and the pulled images', () => undefined);
  });
} else {
  executorContract('docker-runner (real Docker)', {
    make, programs, languages, limits: LIMITS, timeoutMs: 45_000,
    internalError: () => ({
      executor: createDockerExecutor({ processes: { run: () => { throw new Error('injected service failure'); }, remove: () => { throw new Error('unused'); } } }),
      program: programs.hello('python'),
    }),
  });

  // Hostile programs in Python, JavaScript and C++ (and the others where the language makes it short).
  const HOSTILE: RunLanguage[] = (['python', 'javascript', 'cpp'] as RunLanguage[]).filter((l) => languages.includes(l));
  const H: Record<string, Partial<Record<RunLanguage, string>>> = {
    forkBomb: {
      python: 'import os\nwhile True:\n    os.fork()\n',
      javascript: 'const { spawn } = require("child_process");\nfor (let i = 0; i < 10000; i++) spawn(process.execPath, [__filename], { stdio: "ignore" });\n',
      cpp: '#include <unistd.h>\nint main() {\n  for (;;) if (fork() < 0) return 1;\n}\n',
    },
    socket: {
      python: 'import socket\nsocket.create_connection(("1.1.1.1", 80), timeout=3)\nprint("CONNECTED")\n',
      javascript: 'require("net").connect(80, "1.1.1.1").on("connect", () => { console.log("CONNECTED"); process.exit(0); }).on("error", (e) => { console.error(e.code); process.exit(2); });\n',
      cpp: '#include <sys/socket.h>\n#include <netinet/in.h>\n#include <arpa/inet.h>\n#include <cstdio>\nint main() {\n  int s = socket(AF_INET, SOCK_STREAM, 0);\n  sockaddr_in a{}; a.sin_family = AF_INET; a.sin_port = htons(80); inet_pton(AF_INET, "1.1.1.1", &a.sin_addr);\n  if (connect(s, (sockaddr*)&a, sizeof a) != 0) { std::perror("connect"); return 2; }\n  std::puts("CONNECTED");\n}\n',
    },
    dns: {
      python: 'import socket\nprint(socket.getaddrinfo("example.com", 80))\nprint("RESOLVED")\n',
      javascript: 'require("dns").lookup("example.com", (e, addr) => { if (e) { console.error(e.code); process.exit(2); } console.log("RESOLVED", addr); });\n',
      cpp: '#include <netdb.h>\n#include <cstdio>\nint main() {\n  addrinfo* r = nullptr;\n  int e = getaddrinfo("example.com", "80", nullptr, &r);\n  if (e != 0) { std::fprintf(stderr, "%s\\n", gai_strerror(e)); return 2; }\n  std::puts("RESOLVED");\n}\n',
    },
    metadata: {
      python: 'import socket\nsocket.create_connection(("169.254.169.254", 80), timeout=3)\nprint("CONNECTED")\n',
      javascript: 'require("net").connect(80, "169.254.169.254").on("connect", () => { console.log("CONNECTED"); process.exit(0); }).on("error", (e) => { console.error(e.code); process.exit(2); });\n',
    },
    writeOutside: {
      python: 'import os\nfor p in ["/etc/x", "/usr/x", "/x", "/home/x", "/work/.bin/../../x"]:\n    try:\n        open(p, "w").write("x")\n        print("WROTE", p)\n    except OSError as e:\n        print("refused", p, e.errno)\nopen("left.txt", "w").write("x")\nprint("inside ok")\nprint("uid", os.getuid())\nprint([l for l in open("/proc/self/status") if l.startswith("CapEff")][0].strip())\n',
      javascript: 'const fs = require("fs");\nfor (const p of ["/etc/x", "/usr/x", "/x", "/home/x"]) {\n  try { fs.writeFileSync(p, "x"); console.log("WROTE", p); } catch (e) { console.log("refused", p, e.code); }\n}\nfs.writeFileSync("left.txt", "x");\nconsole.log("inside ok");\nconsole.log("uid", process.getuid());\n',
      cpp: '#include <cstdio>\nint main() {\n  const char* ps[] = {"/etc/x", "/usr/x", "/x", "/home/x"};\n  for (auto p : ps) { FILE* f = std::fopen(p, "w"); std::printf(f ? "WROTE %s\\n" : "refused %s\\n", p); }\n  FILE* f = std::fopen("left.txt", "w"); std::puts(f ? "inside ok" : "inside refused");\n}\n',
    },
    seeLeft: {
      python: 'import os\nprint("LEFT" if os.path.exists("left.txt") else "gone")\n',
      javascript: 'console.log(require("fs").existsSync("left.txt") ? "LEFT" : "gone");\n',
      cpp: '#include <cstdio>\nint main() { std::puts(std::fopen("left.txt", "r") ? "LEFT" : "gone"); }\n',
    },
    flood: {
      python: 'while True:\n    print("x" * 1000)\n',
      javascript: 'const line = "x".repeat(1000);\nfor (;;) process.stdout.write(line + "\\n");\n',
      cpp: '#include <cstdio>\n#include <string>\nint main() {\n  std::string line(1000, \'x\');\n  for (;;) std::puts(line.c_str());\n}\n',
    },
  };
  const hostile = (lang: RunLanguage, key: string): ContractProgram => one(lang, H[key]![lang]!);

  describe('hostile programs against a real Docker', () => {
    describe.each(HOSTILE.map((l) => [l]))('%s', (lang) => {
      // Python and C++ fail at the process limit. Node's processes each need several threads, so at the limit they
      // wedge instead of failing; that bomb is held until the wall time and ends timed_out.
      const bombEnds = lang === 'javascript' ? ['timed_out'] : ['failed', 'memory_exceeded'];
      it(`a fork bomb ends ${bombEnds.join(' or ')} by the wall time and leaves the next run unaffected`, async () => {
        const t0 = Date.now();
        const c = await collect(make(), requestOf(lang, hostile(lang, 'forkBomb'), LIMITS));
        expect(bombEnds).toContain(c.result.status);
        expect(Date.now() - t0).toBeLessThan(LIMITS.wallMs + 20_000);
        const next = await collect(make(), requestOf(lang, programs.hello(lang), LIMITS));
        expect(next.result.status).toBe('succeeded');
      }, 60_000);

      it('a socket to an outside address fails', async () => {
        const c = await collect(make(), requestOf(lang, hostile(lang, 'socket'), LIMITS));
        expect(c.result.status).toBe('failed');
        expect(c.result.stdout).not.toContain('CONNECTED');
      }, 45_000);

      it('a DNS lookup fails', async () => {
        const c = await collect(make(), requestOf(lang, hostile(lang, 'dns'), LIMITS));
        expect(c.result.status).toBe('failed');
        expect(c.result.stdout).not.toContain('RESOLVED');
      }, 45_000);

      if (H['metadata']![lang]) {
        it('a connection to the metadata address (169.254.169.254) fails', async () => {
          const c = await collect(make(), requestOf(lang, hostile(lang, 'metadata'), LIMITS));
          expect(c.result.status).toBe('failed');
          expect(c.result.stdout).not.toContain('CONNECTED');
        }, 45_000);
      }

      it('a write outside the working directory fails; the program is not root; a file written inside is gone in the next run', async () => {
        const c = await collect(make(), requestOf(lang, hostile(lang, 'writeOutside'), LIMITS));
        expect(c.result.status).toBe('succeeded');
        expect(c.result.stdout).not.toContain('WROTE');
        expect(c.result.stdout).toContain('inside ok');
        if (lang !== 'cpp') expect(c.result.stdout).toContain('uid 65534');
        if (lang === 'python') expect(c.result.stdout).toContain('CapEff:\t0000000000000000');
        const next = await collect(make(), requestOf(lang, hostile(lang, 'seeLeft'), LIMITS));
        expect(next.result.stdout).toBe('gone\n');
      }, 60_000);

      it('an output flood is cut and stopped (the process is stopped, not only its output dropped)', async () => {
        const limits = { ...LIMITS, maxOutputBytes: 4096 };
        const t0 = Date.now();
        const c = await collect(make(), requestOf(lang, hostile(lang, 'flood'), limits));
        expect(c.result.status).toBe('failed');
        expect(c.result.truncated.stdout).toBe(true);
        expect(Buffer.byteLength(c.result.stdout)).toBeLessThanOrEqual(4096);
        expect(Date.now() - t0).toBeLessThan(limits.wallMs);
      }, 45_000);
    });
  });

  describe('after every run above', () => {
    it('no container of this runner is left behind', async () => {
      await new Promise((r) => setTimeout(r, 3_000));
      expect(leftovers()).toEqual([]);
    }, 30_000);
  });
}

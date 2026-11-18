// The Docker runner's allowlist (docs/interviews-tenant-plan.md "I4.6 answer", "The Docker runner on a developer's
// machine"): one row per pad language, and nothing else can run. Pure data: no process is started here.
//
// Each row names an official image pinned by its version tag, the version written on every result, and a fixed POSIX
// `sh` script. The script never contains anything a person typed: it reads two positional parameters, `$1` (a
// per-run marker of hex digits the executor makes) and `$2` (the entrypoint, already a plain relative name), always
// quoted. What it does, in order:
//   1. unpack the run's files from a tar on stdin into /work (sources under /work/src, the input as /work/.stdin);
//   2. compiled languages: print the compile marker (`<marker>:compile`) on stdout, then compile into /work/.bin; on
//      failure exit 97 (the executor reads `compile_error`);
//   3. print the marker on stdout and on stderr, so the executor can tell compile output from the program's;
//   4. `exec` the program in /work/src with /work/.stdin as its input.
// The compile and the program each run under `timeout -s KILL 120`, a backstop for a middleware that died mid-run.
// Anything before the marker is the runner's or the compiler's; everything after is the program's. The compile marker
// splits the runner's start (its fault when it overruns `startMs`) from the candidate's compile (`compileMs`).
import type { RunLanguage } from './executor.js';

/** Exit codes the script uses before the marker; after it, every exit code is the program's own. */
export const UNPACK_FAILED_EXIT = 96;
export const COMPILE_FAILED_EXIT = 97;

export interface DockerRuntime {
  /** Official image, pinned by its version tag. Pulled by hand (`docker pull`), never by a run (`--pull never`). */
  image: string;
  /** Written on every result as `runtimeVersion`. */
  version: string;
  /** Whether the run starts with a compile step (`compiling`, then `running`). */
  compiled: boolean;
  /** The fixed script; see the top of this file. */
  script: string;
  /** Extra environment for the container, fixed per language (never from a request). */
  env: Readonly<Record<string, string>>;
  /** The compiler's own floor: the container gets at least this much memory, whatever the run's limit is. */
  minMemoryMb: number;
  /** CPUs for the container. */
  cpus: number;
  /** Processes and threads in the container (a JVM or the Go compiler starts many threads). */
  pidsLimit: number;
  /** From the container's start to its first marker (the compile marker, or the program's): unpacking and the runtime starting. */
  startMs: number;
  /** From the compile marker to the program's marker: the compile alone. 0 for a language with no compile step. */
  compileMs: number;
}

// Shared steps. `umask 077`: nothing the program writes is readable by any other user. `tar` runs with its working
// directory at /work and refuses absolute names on its own; the executor writes only `src/<plain name>` and `.stdin`.
const UNPACK = 'umask 077; cd /work || exit 96; tar -x -f - || exit 96; mkdir -p /work/.bin /work/.tmp /work/.cache || exit 96; cd /work/src || exit 96';
const MARK = 'printf \'%s\\n\' "$1"; printf \'%s\\n\' "$1" >&2';
// A backstop of the container's own: if the middleware dies mid-run, nothing it started outlives two minutes. The
// runner's timers (the compile limit, then `wallMs`) always end a run long before it.
export const BACKSTOP_SECONDS = 120;
const BACKSTOP = `timeout -s KILL ${BACKSTOP_SECONDS}`;
const compile = (cmd: string): string => `printf '%s:compile\\n' "$1"; ${BACKSTOP} ${cmd} || exit 97`;

const NODE_IMAGE = 'node:22.11.0-bookworm-slim';

export const DOCKER_RUNTIMES: Readonly<Record<RunLanguage, DockerRuntime>> = {
  python: {
    image: 'python:3.12.7-slim-bookworm', version: 'Python 3.12.7', compiled: false,
    // -I: no user site, no PYTHON* variables, no script directory on the path; -B: no .pyc files.
    script: `${UNPACK}; ${MARK}; exec ${BACKSTOP} python3 -I -B "$2" < /work/.stdin`,
    env: { PYTHONUNBUFFERED: '1' }, minMemoryMb: 0, cpus: 1, pidsLimit: 64, startMs: 10_000, compileMs: 0,
  },
  javascript: {
    image: NODE_IMAGE, version: 'Node.js 22.11.0', compiled: false,
    script: `${UNPACK}; ${MARK}; exec ${BACKSTOP} node "$2" < /work/.stdin`,
    env: {}, minMemoryMb: 0, cpus: 1, pidsLimit: 64, startMs: 10_000, compileMs: 0,
  },
  typescript: {
    // Node's own type stripping (with enums and namespaces transformed): no compiler to install and no network.
    image: NODE_IMAGE, version: 'Node.js 22.11.0 (TypeScript by type stripping)', compiled: false,
    script: `${UNPACK}; ${MARK}; exec ${BACKSTOP} node --experimental-transform-types --disable-warning=ExperimentalWarning "$2" < /work/.stdin`,
    env: {}, minMemoryMb: 0, cpus: 1, pidsLimit: 64, startMs: 10_000, compileMs: 0,
  },
  go: {
    image: 'golang:1.23.3-alpine3.20', version: 'Go 1.23.3', compiled: true,
    // The standard library is compiled into a fresh cache on every run (nothing is shared between runs).
    script: `${UNPACK}; ${compile('go build -o /work/.bin/main ./*.go')}; ${MARK}; exec ${BACKSTOP} /work/.bin/main < /work/.stdin`,
    env: { GOCACHE: '/work/.cache/go', GOPATH: '/work/.cache/gopath', GOTMPDIR: '/work/.tmp', GOTOOLCHAIN: 'local', GOPROXY: 'off', CGO_ENABLED: '0' },
    minMemoryMb: 512, cpus: 2, pidsLimit: 128, startMs: 10_000, compileMs: 30_000,
  },
  cpp: {
    image: 'gcc:14.2.0', version: 'g++ 14.2.0 (C++20)', compiled: true,
    script: `${UNPACK}; ${compile('g++ -std=c++20 -O2 -pipe -o /work/.bin/main ./*.cpp')}; ${MARK}; exec ${BACKSTOP} /work/.bin/main < /work/.stdin`,
    env: {}, minMemoryMb: 512, cpus: 2, pidsLimit: 64, startMs: 10_000, compileMs: 20_000,
  },
  java: {
    image: 'eclipse-temurin:21.0.5_11-jdk-alpine', version: 'OpenJDK 21.0.5 (Temurin)', compiled: true,
    // The class to run is the entrypoint's name without `.java` (the pad's file is Main.java). A full heap is the
    // memory limit: the JVM kills itself (exit 137, `memory_exceeded`) rather than print an OutOfMemoryError.
    script: `${UNPACK}; ${compile('javac -J-XX:-UsePerfData -d /work/.bin ./*.java')}; ${MARK}; c="\${2##*/}"; exec ${BACKSTOP} java -XX:-UsePerfData -XX:MaxRAMPercentage=75 '-XX:OnOutOfMemoryError=kill -9 %p' -cp /work/.bin "\${c%.java}" < /work/.stdin`,
    env: {}, minMemoryMb: 512, cpus: 2, pidsLimit: 128, startMs: 10_000, compileMs: 20_000,
  },
  swift: {
    image: 'swift:6.0.2-jammy', version: 'Swift 6.0.2', compiled: true,
    script: `${UNPACK}; ${compile('swiftc -module-cache-path /work/.cache/swift -o /work/.bin/main ./*.swift')}; ${MARK}; exec ${BACKSTOP} /work/.bin/main < /work/.stdin`,
    env: {}, minMemoryMb: 1024, cpus: 2, pidsLimit: 128, startMs: 10_000, compileMs: 25_000,
  },
};

/** Every image a run may name. */
export const DOCKER_IMAGES: readonly string[] = [...new Set(Object.values(DOCKER_RUNTIMES).map((r) => r.image))];

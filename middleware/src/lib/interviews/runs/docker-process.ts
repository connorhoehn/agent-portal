// The one place in the runs code that starts a process (docs/interviews-tenant-plan.md "I4.6 answer", "The Docker
// runner on a developer's machine"; the I4.4 judge piece checks that nothing else under lib/interviews/runs can).
//
// It starts only the `docker` binary, never through a shell, and only with one of two argument lists built here:
//   run    `docker run` with the hardened flags below, an image from the allowlist (docker-runtimes.ts), `/bin/sh -c`
//          with that language's fixed script, then the per-run marker and the entrypoint as positional parameters;
//   remove `docker rm -f <name>`, for a container this runner named.
// Every value that varies is checked before anything starts: the name, the image, the script, the marker, the
// entrypoint and the numbers. A spec that fails a check throws, and nothing is started.
import { spawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { DOCKER_IMAGES, DOCKER_RUNTIMES } from './docker-runtimes.js';

export const DOCKER_BIN = 'docker';
/** Every container this runner makes is named `iv-run-` and 16 hex digits, so leftovers are easy to find. */
export const CONTAINER_PREFIX = 'iv-run-';
const NAME = /^iv-run-[0-9a-f]{16}$/;
const MARKER = /^[0-9a-f]{32}$/;
const ENTRY_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const ENV_KEY = /^[A-Z][A-Z0-9_]*$/;
const ENV_VALUE = /^[A-Za-z0-9/._:=+-]*$/;

/** What a run container needs; every field is checked against the allowlist before it becomes an argument. */
export interface ContainerSpec {
  name: string;
  image: string;
  script: string;
  marker: string;
  entrypoint: string;
  memoryMb: number;
  cpus: number;
  pidsLimit: number;
  env: Readonly<Record<string, string>>;
}

/** The part of a child process the executor reads. */
export interface DockerChild {
  stdin: Writable | null;
  stdout: Readable | null;
  stderr: Readable | null;
  on(event: 'close', fn: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: 'error', fn: (err: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

/** `child_process.spawn`'s shape, so a test can pass a fake and read the exact arguments. */
export type SpawnImpl = (command: string, args: readonly string[], options: { shell: false; stdio: ['pipe', 'pipe', 'pipe']; windowsHide: true }) => DockerChild;

export interface DockerProcesses {
  run(spec: ContainerSpec): DockerChild;
  remove(name: string): DockerChild;
}

const SCRIPTS = new Set(Object.values(DOCKER_RUNTIMES).map((r) => r.script));
const plainEntrypoint = (p: string): boolean =>
  p.length > 0 && p.length <= 128 && !p.startsWith('/') && p.split('/').every((s) => s !== '.' && s !== '..' && ENTRY_SEGMENT.test(s));
const whole = (n: number, lo: number, hi: number): boolean => Number.isInteger(n) && n >= lo && n <= hi;

/** Throws unless every field is one this runner may pass. */
export function checkSpec(spec: ContainerSpec): void {
  if (!NAME.test(spec.name)) throw new Error('docker runner: container name is not the runner\'s');
  if (!DOCKER_IMAGES.includes(spec.image)) throw new Error('docker runner: image is not on the allowlist');
  if (!SCRIPTS.has(spec.script)) throw new Error('docker runner: script is not on the allowlist');
  if (!MARKER.test(spec.marker)) throw new Error('docker runner: marker is not 32 hex digits');
  if (!plainEntrypoint(spec.entrypoint)) throw new Error('docker runner: entrypoint is not a plain relative name');
  if (!whole(spec.memoryMb, 32, 4096)) throw new Error('docker runner: memory out of range');
  if (!(spec.cpus > 0 && spec.cpus <= 4)) throw new Error('docker runner: cpus out of range');
  if (!whole(spec.pidsLimit, 8, 512)) throw new Error('docker runner: pids limit out of range');
  for (const [k, v] of Object.entries(spec.env)) {
    if (!ENV_KEY.test(k) || !ENV_VALUE.test(v)) throw new Error('docker runner: environment entry is not plain');
  }
}

/** The hardened `docker run` argument list. */
export function dockerRunArgs(spec: ContainerSpec): string[] {
  checkSpec(spec);
  const env = Object.entries({ HOME: '/work', TMPDIR: '/work/.tmp', LANG: 'C.UTF-8', ...spec.env }).flatMap(([k, v]) => ['--env', `${k}=${v}`]);
  return [
    'run', '--rm', '--interactive', '--pull', 'never',
    '--name', spec.name, '--label', 'interviews.run=1', '--hostname', 'sandbox',
    '--network', 'none',
    '--read-only',
    '--tmpfs', '/work:rw,exec,nosuid,nodev,size=128m,mode=1777',
    '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--user', '65534:65534',
    '--pids-limit', String(spec.pidsLimit),
    '--memory', `${spec.memoryMb}m`, '--memory-swap', `${spec.memoryMb}m`,
    '--cpus', String(spec.cpus),
    '--ulimit', 'core=0', '--ulimit', 'nofile=256:256',
    '--ipc', 'private',
    '--log-driver', 'none',
    '--no-healthcheck',
    ...env,
    '--workdir', '/work',
    '--entrypoint', '/bin/sh',
    spec.image,
    '-c', spec.script, 'sandbox', spec.marker, spec.entrypoint,
  ];
}

export function dockerRemoveArgs(name: string): string[] {
  if (!NAME.test(name)) throw new Error('docker runner: container name is not the runner\'s');
  return ['rm', '--force', name];
}

const OPTIONS = { shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true } as const;
const nodeSpawn: SpawnImpl = (command, args, options) => spawn(command, [...args], { ...options, stdio: [...options.stdio] });

export function createDockerProcesses(spawnImpl: SpawnImpl = nodeSpawn): DockerProcesses {
  return {
    run: (spec) => spawnImpl(DOCKER_BIN, dockerRunArgs(spec), { ...OPTIONS, stdio: [...OPTIONS.stdio] }),
    remove: (name) => spawnImpl(DOCKER_BIN, dockerRemoveArgs(name), { ...OPTIONS, stdio: [...OPTIONS.stdio] }),
  };
}

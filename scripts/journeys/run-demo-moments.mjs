#!/usr/bin/env node
// The demo-moments journey (or `--journey voice-coverage`) in one command (docs/journeys.md, "The journeys job"):
// starts its own mock middleware (dev:mock's environment, MOCK_VOICE=1, its own
// port and voice log) and its own portal, waits for both, runs
// scripts/journeys/demo-moments.mjs against them, stops what it started, and
// exits with the journey's code (0 all ten runs passed, 1 a step failed, 2 the
// stack never came up).
//
//   cd portal && npm run journey:demo-moments [-- --only M2 --mode hand --out <dir>]
//
// Env: JOURNEY_MIDDLEWARE_PORT (default 3966), JOURNEY_PORTAL_PORT (default 5166).
// A port already in use is refused, never reused: every run resets the mock, so
// it must not be someone else's server. It stops only the processes it started
// (their own process groups).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MW_PORT = Number(process.env.JOURNEY_MIDDLEWARE_PORT ?? 3966);
const PORTAL_PORT = Number(process.env.JOURNEY_PORTAL_PORT ?? 5166);
const UP_MS = 180_000;

/** Nothing answers on the port (IPv4 or IPv6 loopback): a dev server may bind either. */
const answers = (port, host) => new Promise((resolve) => {
  const sock = net.connect({ port, host });
  sock.setTimeout(1000);
  sock.once('connect', () => { sock.destroy(); resolve(true); });
  sock.once('timeout', () => { sock.destroy(); resolve(false); });
  sock.once('error', () => resolve(false));
});
const portFree = async (port) => !(await answers(port, '127.0.0.1')) && !(await answers(port, '::1'));

/** dev:mock's environment, read from middleware/package.json so there is one list of it. */
function devMockEnv() {
  const script = JSON.parse(fs.readFileSync(path.join(ROOT, 'middleware', 'package.json'), 'utf8')).scripts['dev:mock'];
  const env = {};
  for (const tok of script.split(/\s+/)) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(tok);
    if (!m) break;
    env[m[1]] = m[2];
  }
  return env;
}

const started = [];
function start(name, cmd, args, cwd, env, log) {
  const out = fs.openSync(log, 'w');
  const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', out, out], detached: true });
  started.push({ name, child });
  return child;
}

function stopAll() {
  for (const { child } of started.splice(0)) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
  }
}
process.on('SIGINT', () => { stopAll(); process.exit(130); });
process.on('SIGTERM', () => { stopAll(); process.exit(143); });

async function waitUp(url, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(url); if (r.status < 500) return true; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'journeys-'));
for (const [port, what] of [[MW_PORT, 'middleware'], [PORTAL_PORT, 'portal']]) {
  if (!(await portFree(port))) {
    console.error(`port ${port} (${what}) is in use; set JOURNEY_MIDDLEWARE_PORT / JOURNEY_PORTAL_PORT to free ports. Nothing was started.`);
    process.exit(2);
  }
}

// The learning-loop walk dispatches a few dozen work items in a row through dev:mock's normal path (the governed run
// on the fake microVM), so it asks the fake for no pacing and the reconcile tick for a short interval. The path is
// the same; only the waits shrink. Every other journey keeps dev:mock's pacing.
const journeyArg = process.argv.indexOf('--journey');
const fastDispatch = journeyArg >= 0 && process.argv[journeyArg + 1] === 'learning-loop'
  ? { MOCK_DEVBOX_PACE_MS: '0', MOCK_DEVBOX_PROVISION_MS: '0', BOT_RECONCILE_INTERVAL_MS: '1500' } : {};

const mwLog = path.join(work, 'middleware.log');
const portalLog = path.join(work, 'portal.log');
start('middleware', process.execPath, [path.join(ROOT, 'middleware', 'node_modules', '.bin', 'tsx'), 'src/index.ts'], path.join(ROOT, 'middleware'), {
  ...devMockEnv(), PORT: String(MW_PORT), MOCK_VOICE: '1', VOICE_LOG_DIR: path.join(work, 'voice-log'), MOCK_PERSIST_PAIRINGS: '0', ...fastDispatch,
}, mwLog);
// The portal without its HMR socket and with its own dependency cache (journey-vite.mjs says why).
start('portal', process.execPath, [path.join(ROOT, 'scripts', 'journeys', 'journey-vite.mjs'), '--port', String(PORTAL_PORT)], path.join(ROOT, 'portal'), {
  VITE_GATEWAY_URL: `http://localhost:${MW_PORT}`, API_PROXY_TARGET: `http://127.0.0.1:${MW_PORT}`,
}, portalLog);

console.log(`journeys: middleware :${MW_PORT}, portal :${PORTAL_PORT}, logs in ${work}`);
const up = await waitUp(`http://127.0.0.1:${MW_PORT}/api/health`, UP_MS) && await waitUp(`http://localhost:${PORTAL_PORT}/`, UP_MS);
if (!up) {
  console.error(`the stack did not come up within ${UP_MS / 1000} s; see ${mwLog} and ${portalLog}`);
  stopAll();
  process.exit(2);
}

// `--journey voice-coverage` runs scripts/journeys/voice-coverage.mjs on the same stack (default: demo-moments).
const argv = process.argv.slice(2);
const at = argv.indexOf('--journey');
const name = at >= 0 ? argv[at + 1] : 'demo-moments';
const args = at >= 0 ? [...argv.slice(0, at), ...argv.slice(at + 2)] : argv;
if (!/^[a-z0-9-]+$/.test(name ?? '') || !fs.existsSync(path.join(ROOT, 'scripts', 'journeys', `${name}.mjs`))) {
  console.error(`no journey "${name}" in scripts/journeys`);
  stopAll();
  process.exit(2);
}
const out = args.includes('--out') ? [] : ['--out', path.join(work, 'results')];
const journey = spawn(process.execPath, [path.join(ROOT, 'scripts', 'journeys', `${name}.mjs`), ...out, ...args], {
  stdio: 'inherit', env: { ...process.env, PORTAL_URL: `http://localhost:${PORTAL_PORT}`, MIDDLEWARE_URL: `http://127.0.0.1:${MW_PORT}` },
});
const code = await new Promise((resolve) => journey.on('exit', (c) => resolve(c ?? 1)));
stopAll();
process.exit(code);

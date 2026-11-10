#!/usr/bin/env node
// scripts/learning-loop/local-report-e2e.mjs — acceptance item 10 of
// docs/learning-loop-design.md, end to end on a test stack of its own:
//
//   "A local compute worker run against a test stack posts a report, and its
//    run shows the reported cost as not billed."
//
// It boots its own mock middleware (dev:mock's environment, its own port,
// pairings NOT persisted), signs in as a member, mints a pairing code, and runs
// the REAL tools/local-compute-worker.mjs against it with:
//   - ORGIQ_PRESENCE_CONFIG, WORKER_LOG_DIR and REPOS_DIR in a temp folder, so
//     the operator's own pairing file is never read or written;
//   - a STUB `claude` first on PATH that prints a canned stream-json session
//     (a Skill tool call, then a final message ending in a lab-report block).
//     The real CLI is never invoked and nothing is spent.
// It queues one job for the paired machine, waits (bounded) for the run's
// report, asserts it, and stops only the processes it started.
//
//   node scripts/learning-loop/local-report-e2e.mjs        exit 0 on pass, 1 on any failed check
//   Env: LL_E2E_PORT (default 3919)

import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = Number(process.env.LL_E2E_PORT ?? 3919);
const BASE = `http://127.0.0.1:${PORT}`;
const RUNBOOK = 'rb-flaky-test-rerun-diff';
const REPORTED_COST = 0.0421;

const work = mkdtempSync(join(tmpdir(), 'll-e2e-'));
const started = [];
let failures = 0;
const check = (ok, what, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

function devMockEnv() {
  const script = JSON.parse(readFileSync(join(ROOT, 'middleware', 'package.json'), 'utf8')).scripts['dev:mock'];
  const env = {};
  for (const tok of script.split(/\s+/)) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(tok);
    if (!m) break;
    env[m[1]] = m[2];
  }
  return env;
}

function start(name, cmd, args, opts) {
  const out = openSync(join(work, `${name}.log`), 'w');
  const child = spawn(cmd, args, { ...opts, stdio: ['ignore', out, out], detached: true });
  started.push(child);
  return child;
}
function stopAll() {
  for (const child of started.splice(0)) { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ } }
}
process.on('SIGINT', () => { stopAll(); process.exit(130); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v; } catch { /* not yet */ }
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const jar = new Map();
async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [kv] = c.split(';');
    const i = kv.indexOf('=');
    jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
  }
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

/** A stand-in for `claude -p --output-format stream-json --verbose`: one Skill load, then the result. */
function writeStubClaude(dir) {
  mkdirSync(dir, { recursive: true });
  const final = [
    'Done. The collector test was flaky, not a regression.',
    '',
    '```lab-report',
    JSON.stringify({
      summary: 'Checked the collector integration test against the flaky-test runbook and left the code as it was.',
      verification: [{ command: 'npm test -- collector', passed: true }],
      obstacles: ['The first run failed on a timing assertion; a rerun passed and the outputs differed only in timestamps.'],
    }),
    '```',
  ].join('\n');
  const events = [
    { type: 'system', subtype: 'init', model: 'claude-sonnet-5' },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'Skill', input: { skill: RUNBOOK } }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: final }] } },
    { type: 'result', subtype: 'success', is_error: false, num_turns: 2, result: final, total_cost_usd: REPORTED_COST,
      usage: { input_tokens: 1200, output_tokens: 300 }, modelUsage: { 'claude-sonnet-5': {} } },
  ];
  const lines = events.map((e) => JSON.stringify(e)).join('\n');
  const stub = join(dir, 'claude');
  writeFileSync(stub, `#!/bin/sh\n# Stub claude for the learning-loop e2e: prints a canned stream-json session. Never the real CLI.\ncat <<'EOF'\n${lines}\nEOF\n`);
  chmodSync(stub, 0o755);
}

try {
  // ── The test stack: our own middleware on our own port. ──
  const env = { ...process.env, ...devMockEnv(), PORT: String(PORT), MOCK_PERSIST_PAIRINGS: '0', VOICE_LOG_DIR: join(work, 'voice') };
  start('middleware', join(ROOT, 'middleware', 'node_modules', '.bin', 'tsx'), ['src/index.ts'], { cwd: join(ROOT, 'middleware'), env });
  await until('the middleware', async () => (await fetch(`${BASE}/health`)).status < 500, 90_000);
  await sleep(10_000); // let boot-time work settle before driving it

  // ── A member pairs a throwaway machine identity. ──
  const login = await call('POST', '/api/session/login', { userId: 'u-mia' });
  check(login.status === 200, 'signed in as a member', JSON.stringify(login.body).slice(0, 200));
  const pairing = await call('POST', '/api/local-compute/pair/start');
  check(pairing.status === 200 && typeof pairing.body.code === 'string', 'minted a pairing code', JSON.stringify(pairing.body).slice(0, 200));

  const stubDir = join(work, 'bin');
  writeStubClaude(stubDir);
  const presence = join(work, 'orgiq-presence.json');
  const workerCwd = join(work, 'cwd');
  mkdirSync(workerCwd, { recursive: true });
  const { ANTHROPIC_BASE_URL: _b, ANTHROPIC_API_KEY: _k, CLAUDECODE: _c, CLAUDE_CODE_ENTRYPOINT: _e, ...base } = process.env;
  start('worker', process.execPath, [join(ROOT, 'tools', 'local-compute-worker.mjs'), '--pair', pairing.body.code, '--base', BASE], {
    cwd: workerCwd,
    env: {
      ...base, PATH: `${stubDir}:${process.env.PATH}`, ORGIQ_PRESENCE_CONFIG: presence,
      WORKER_LOG_DIR: join(work, 'worker-logs'), REPOS_DIR: join(work, 'repos'), POLL_INTERVAL_S: '1', JOB_KINDS: 'local:task',
      ANTHROPIC_MODEL: 'claude-sonnet-5',
    },
  });
  const nodeId = await until('the pairing file', () => existsSync(presence) && JSON.parse(readFileSync(presence, 'utf8')).nodeId, 30_000);
  check(Boolean(nodeId), 'the worker paired into the temp presence config only');

  const accept = await call('PATCH', `/api/local-compute/nodes/${nodeId}`, { acceptJobs: true });
  check(accept.status === 200, 'switched the machine on', JSON.stringify(accept.body).slice(0, 200));
  const queued = await call('POST', `/api/local-compute/nodes/${nodeId}/work`, {
    title: 'Check whether the collector test is flaky',
    prompt: 'Run the collector integration test twice and say whether it is flaky.',
    requiresReview: false,
  });
  check([200, 201, 202].includes(queued.status), 'queued a job for the machine', JSON.stringify(queued.body).slice(0, 300));
  const jobId = queued.body.job?.id ?? queued.body.id;

  // ── The run ends; its report is stored. ──
  const got = await until('the run report', async () => {
    const r = await call('GET', `/api/runs/${encodeURIComponent(jobId)}/report`);
    return r.status === 200 ? r.body.report : null;
  }, 60_000);

  check(got.executor === 'local', 'executor is local', got.executor);
  check(got.outcome === 'done', 'outcome is done', got.outcome);
  check(got.selfReport === 'ok', 'the lab-report block parsed', got.selfReport);
  check(/flaky-test runbook/.test(got.summary), 'summary came from the block', got.summary);
  check(JSON.stringify(got.verification) === JSON.stringify([{ command: 'npm test -- collector', passed: true }]), 'verification came from the block', JSON.stringify(got.verification));
  check(got.obstacles.length === 1, 'obstacles came from the block', JSON.stringify(got.obstacles));
  const use = got.runbooksUsed.find((u) => u.id === RUNBOOK);
  check(use?.source === 'observed' && Number.isInteger(use?.version), 'the Skill tool call is an observed use at the version the brief gave', JSON.stringify(got.runbooksUsed));
  check(got.cost.billedUsd === 0 && got.cost.reportedUsd === REPORTED_COST && got.cost.basis === 'reported', 'reported cost stored, not billed', JSON.stringify(got.cost));
  check(got.briefId === `brief-${jobId}`, 'the report names the frozen brief', got.briefId);

  const apps = await call('GET', `/api/runbooks/${RUNBOOK}/applications`);
  const mine = (apps.body.applications ?? []).filter((a) => a.run_ref === jobId);
  check(mine.length === 1 && mine[0].outcome === 'followed' && mine[0].brief_id === `brief-${jobId}`, 'one application row written for the used runbook', JSON.stringify(apps.body).slice(0, 300));
} catch (err) {
  check(false, 'the run completed', err.message);
} finally {
  stopAll();
  if (failures === 0) rmSync(work, { recursive: true, force: true });
  else console.log(`logs kept in ${work}`);
}
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);

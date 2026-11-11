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
// Then acceptance item 14 (`givenRunbook`): it queues the Auth Migration
// cutover story twice against a throwaway local repository. The stub fails the
// first run with an obstacle; the second run's prompt must carry the frozen
// brief with rb-tenant-cutover's whole text and the first attempt's obstacle,
// each inside the brief's untrusted-text fence, and its report must record the
// runbook as given and followed.
//
//   node scripts/learning-loop/local-report-e2e.mjs        exit 0 on pass, 1 on any failed check
//   Env: LL_E2E_PORT (default 3919)

import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = Number(process.env.LL_E2E_PORT ?? 3919);
const BASE = `http://127.0.0.1:${PORT}`;
const RUNBOOK = 'rb-tenant-cutover';
const REPORTED_COST = 0.0421;
/** Acceptance 14's work item: the Auth Migration cutover story the selector gives rb-tenant-cutover. */
const WORK_ITEM = 'wi-auth-e2-s2';
const ATTEMPT_OBSTACLE = 'The rehearsal tenant had its SAML app switched off, so sign-in on the shim failed before the flip.';

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
    'Done. The cutover plan is written; the rehearsal tenant moved and rolled back cleanly.',
    '',
    '```lab-report',
    JSON.stringify({
      summary: 'Wrote the cutover plan for one rehearsal tenant with the tenant cutover runbook and rehearsed its rollback.',
      verification: [{ command: 'npm test -- cutover', passed: true }],
      obstacles: ['Sign-in on the shim failed until the tenant callback URL was added; added it before moving the tenant.'],
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
  // Acceptance 14 adds two more invocations, told apart by a counter: the second fails (the work
  // item's first attempt) and the third succeeds having loaded the runbook its brief gave it. Every
  // invocation saves the prompt it was handed (`-p <prompt>`) to prompt-<n>.txt for the checks.
  const failed = [
    'I could not finish this: the rehearsal tenant could not sign in.',
    '',
    '```lab-report',
    JSON.stringify({ summary: 'Stopped at the rollback rehearsal.', verification: [], obstacles: [ATTEMPT_OBSTACLE] }),
    '```',
  ].join('\n');
  const followed = [
    'Done. The plan is written and the rehearsal tenant moved and rolled back.',
    '',
    '```lab-report',
    JSON.stringify({
      summary: 'Wrote the cutover plan with the tenant cutover runbook the brief gave, after enabling the rehearsal tenant SAML app.',
      verification: [{ command: 'npm test -- cutover', passed: true }],
      obstacles: [],
      runbooks: [{ id: RUNBOOK, followed: 'yes' }],
    }),
    '```',
  ].join('\n');
  const sessions = {
    1: { exit: 0, lines },
    2: {
      exit: 1,
      lines: [
        { type: 'system', subtype: 'init', model: 'claude-sonnet-5' },
        { type: 'assistant', message: { content: [{ type: 'text', text: failed }] } },
        { type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 1, result: failed, total_cost_usd: 0.01, usage: { input_tokens: 900, output_tokens: 90 } },
      ].map((e) => JSON.stringify(e)).join('\n'),
    },
    3: {
      exit: 0,
      lines: [
        { type: 'system', subtype: 'init', model: 'claude-sonnet-5' },
        { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu_9', name: 'Skill', input: { skill: RUNBOOK } }] } },
        { type: 'assistant', message: { content: [{ type: 'text', text: followed }] } },
        { type: 'result', subtype: 'success', is_error: false, num_turns: 2, result: followed, total_cost_usd: 0.02, usage: { input_tokens: 1500, output_tokens: 200 } },
      ].map((e) => JSON.stringify(e)).join('\n'),
    },
  };
  const stub = join(dir, 'claude');
  writeFileSync(stub, [
    '#!/usr/bin/env node',
    '// Stub claude for the learning-loop e2e: prints a canned stream-json session. Never the real CLI.',
    "const fs = require('node:fs');",
    `const dir = ${JSON.stringify(dir)};`,
    `const sessions = ${JSON.stringify(sessions)};`,
    "const counter = dir + '/count';",
    "const n = (fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0) + 1;",
    'fs.writeFileSync(counter, String(n));',
    "const at = process.argv.indexOf('-p');",
    "fs.writeFileSync(dir + '/prompt-' + n + '.txt', at >= 0 ? process.argv[at + 1] : '');",
    'const s = sessions[n] || sessions[1];',
    "process.stdout.write(s.lines + '\\n');",
    'process.exitCode = s.exit;',
    '',
  ].join('\n'));
  chmodSync(stub, 0o755);
}

/**
 * Acceptance 14 (docs/learning-loop-design.md): a brief that gives a runbook reaches the real
 * worker's prompt with the runbook's text and the previous-attempts section inside the fence, and
 * the report records the runbook as followed. The work item is the Auth Migration cutover story;
 * its codebase is a throwaway local repository the worker "pulls" from a bare origin on disk,
 * so nothing reaches the network.
 */
async function givenRunbook({ nodeId, stubDir, reposDir }) {
  // The initiative's codebase is github.com/connorhoehn/orgiq-auth-service; the worker reuses
  // REPOS_DIR/<name> when it exists, so a local clone of a bare repo stands in for it.
  const origin = join(work, 'origin', 'orgiq-auth-service.git');
  const seed = join(work, 'seed');
  mkdirSync(seed, { recursive: true });
  const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.invalid', ...a], { cwd, stdio: 'ignore' });
  git(seed, 'init', '-q', '-b', 'main');
  writeFileSync(join(seed, 'README.md'), '# auth service (e2e stand-in)\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-q', '-m', 'seed');
  mkdirSync(dirname(origin), { recursive: true });
  execFileSync('git', ['clone', '-q', '--bare', seed, origin], { stdio: 'ignore' });
  mkdirSync(reposDir, { recursive: true });
  execFileSync('git', ['clone', '-q', origin, join(reposDir, 'orgiq-auth-service')], { stdio: 'ignore' });

  const queue = async () => {
    const q = await call('POST', `/api/local-compute/nodes/${nodeId}/work`, { workItemId: WORK_ITEM });
    check([200, 201, 202].includes(q.status), `queued ${WORK_ITEM} for the machine`, JSON.stringify(q.body).slice(0, 300));
    return q.body.job?.id ?? q.body.id;
  };
  const reportOf = (jobId) => until(`the report of ${jobId}`, async () => {
    const r = await call('GET', `/api/runs/${encodeURIComponent(jobId)}/report`);
    return r.status === 200 ? r.body.report : null;
  }, 90_000);

  // First attempt: fails, with an obstacle.
  const firstId = await queue();
  const first = await reportOf(firstId);
  check(first.outcome === 'failed' && first.obstacles.includes(ATTEMPT_OBSTACLE), 'the first attempt failed and its obstacle was stored', JSON.stringify({ outcome: first.outcome, obstacles: first.obstacles }));

  // Second attempt: its brief gives the runbook and shows the first attempt.
  const secondId = await queue();
  const second = await reportOf(secondId);
  const prompt = readFileSync(join(stubDir, 'prompt-3.txt'), 'utf8');
  const token = /<untrusted-([0-9a-f]{32}) kind="work-item"/.exec(prompt)?.[1];
  check(Boolean(token), 'the prompt carries the frozen brief with its fence', prompt.slice(0, 200));
  const block = (kind, source) => {
    const m = new RegExp(`<untrusted-${token} kind="${kind}" source="${source}">\\n([\\s\\S]*?)\\n</untrusted-${token}>`).exec(prompt);
    return m ? m[1] : null;
  };
  const runbookText = block('runbook', `${RUNBOOK} v\\d+`);
  check(Boolean(runbookText) && runbookText.startsWith('# Cut one tenant over from SAML to Cognito') && /## Steps/.test(runbookText) && /## Roll back/.test(runbookText),
    'the runbook reached the prompt whole, inside the fence', (runbookText ?? prompt).slice(0, 300));
  check(/## Runbooks for this run[\s\S]*Given because: [^\n]*labels decom, runbook/.test(prompt), 'with the reason it was given');
  const attempt = block('previous-attempt', firstId);
  check(/## Previous attempts on this work item/.test(prompt) && Boolean(attempt) && attempt.includes(ATTEMPT_OBSTACLE),
    "the first attempt's obstacle reached the prompt under previous attempts, inside the fence", (attempt ?? '').slice(0, 300));
  check(!/`lab (applied|propose|remember)|no `lab` command/.test(prompt), 'the prompt asks for no lab commands');

  const frozen = await call('GET', `/api/runs/${encodeURIComponent(secondId)}/brief`);
  check(frozen.body.brief?.offer?.runbooks?.[0]?.id === RUNBOOK && prompt.includes(frozen.body.brief.markdown.trimEnd()),
    'the prompt carries the frozen brief byte for byte, and its offer names the runbook', JSON.stringify(frozen.body.brief?.offer ?? null).slice(0, 300));
  check(second.runbooksOffered.some((r) => r.id === RUNBOOK), 'the report records the runbook as given', JSON.stringify(second.runbooksOffered));
  const apps = await call('GET', `/api/runbooks/${RUNBOOK}/applications`);
  check((apps.body.applications ?? []).some((a) => a.run_ref === secondId && a.outcome === 'followed'), 'and as followed', JSON.stringify(apps.body).slice(0, 300));
  const ev = await call('GET', `/api/runbooks/${RUNBOOK}/evidence`);
  check((ev.body.evidence?.runs ?? []).some((r) => r.runRef === secondId), 'the runbook\'s evidence lists the run', JSON.stringify(ev.body.evidence ?? ev.body).slice(0, 300));
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
    title: 'Rehearse one tenant cutover with rollback',
    prompt: 'Rehearse moving one test tenant from SAML to Cognito, then roll it back.',
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
  check(/tenant cutover runbook/.test(got.summary), 'summary came from the block', got.summary);
  check(JSON.stringify(got.verification) === JSON.stringify([{ command: 'npm test -- cutover', passed: true }]), 'verification came from the block', JSON.stringify(got.verification));
  check(got.obstacles.length === 1, 'obstacles came from the block', JSON.stringify(got.obstacles));
  const use = got.runbooksUsed.find((u) => u.id === RUNBOOK);
  check(use?.source === 'observed' && Number.isInteger(use?.version), 'the Skill tool call is an observed use at the version the brief gave', JSON.stringify(got.runbooksUsed));
  check(got.cost.billedUsd === 0 && got.cost.reportedUsd === REPORTED_COST && got.cost.basis === 'reported', 'reported cost stored, not billed', JSON.stringify(got.cost));
  check(got.briefId === `brief-${jobId}`, 'the report names the frozen brief', got.briefId);

  const apps = await call('GET', `/api/runbooks/${RUNBOOK}/applications`);
  const mine = (apps.body.applications ?? []).filter((a) => a.run_ref === jobId);
  check(mine.length === 1 && mine[0].outcome === 'followed' && mine[0].brief_id === `brief-${jobId}`, 'one application row written for the used runbook', JSON.stringify(apps.body).slice(0, 300));

  // ── Acceptance 14: a brief that gives a runbook, and shows the previous attempt. ──
  await givenRunbook({ nodeId, stubDir, reposDir: join(work, 'repos') });
} catch (err) {
  check(false, 'the run completed', err.message);
} finally {
  stopAll();
  if (failures === 0) rmSync(work, { recursive: true, force: true });
  else console.log(`logs kept in ${work}`);
}
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);

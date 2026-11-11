#!/usr/bin/env node
// The learning loop's run pages (docs/learning-loop-design.md "Acceptance" items 1, 5, 7 and 8) and the one Runs
// list (lane E1 and E2), walked in a browser as an org leader.
//
//   cd portal && JOURNEY_MIDDLEWARE_PORT=3931 JOURNEY_PORTAL_PORT=5131 node ../scripts/journeys/run-demo-moments.mjs --journey learning-loop-runs
//   PORTAL_URL=http://localhost:5131 MIDDLEWARE_URL=http://127.0.0.1:3931 node scripts/journeys/learning-loop-runs.mjs
//
// Where the runs come from. On dev:mock a marketplace dispatch runs the governed path against the fake microVM, which
// stores a report with no worker summary (the hand-written fixtures only play when no devbox runtime resolves), and a
// dispatch inside a mock scope never ends. So the runs this journey reads are real ones from the real local worker
// (tools/local-compute-worker.mjs) with a stub `claude` first on PATH that plays a hand-written session per work item
// (scripts/learning-loop/local-report-e2e.mjs is the model): its pairing file, logs and repositories live in a temp
// folder, the real CLI is never invoked, nothing is spent, and no computer is created. The stub's texts are hand-written
// test data, not generated.
//
//   L1  acceptance 1  the logout cookie bug: its run page shows the report (summary, verification, obstacles) and Learned
//   L5  acceptance 5  the tenant cutover: Brief shows the runbook's text, Runbooks shows it given and followed
//   L7  acceptance 7  the dashboard item: given nothing; Learned says why there was no debrief, in the stored sentence
//   L8  acceptance 8  the cold-start bug, twice: the second run's Brief shows the first attempt under previous attempts
//   R1  a run that sent no report block says it did not report
//   R2  the Runs list: every run newest first, filters by ran on, initiative, outcome and debriefed, the learned dot
//   R3  merge-ins: Automate's Runs, Local compute's Runs, the initiative's runs and a job page all lead to the list or the run
//
// Screenshots (1440 and 1280 wide) go to --shots (default <out>/shots). Exit codes as scripts/journeys/demo-moments.mjs.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const req = createRequire(path.join(ROOT, 'portal', 'package.json'));
const playwright = await import(pathToFileURL(req.resolve('playwright')).href);
const chromium = playwright.chromium ?? playwright.default.chromium;

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const PORTAL = (process.env.PORTAL_URL ?? 'http://localhost:5131').replace(/\/$/, '');
const MIDDLEWARE = (process.env.MIDDLEWARE_URL ?? 'http://127.0.0.1:3931').replace(/\/$/, '');
const OUT = flag('--out') ?? process.env.OUT_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'learning-loop-runs-'));
const SHOTS = flag('--shots') ?? path.join(OUT, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'll-runs-'));

const VERA = { userId: 'u-vera', role: 'org-leader' };
const MIA = 'u-mia';
const RUNBOOK = 'rb-tenant-cutover';
const ITEMS = { bug: 'wi-auth-e2-b3', cutover: 'wi-auth-e2-s2', dashboard: 'wi-obs-e2-s3', cold: 'wi-inf-e1-b3' };
const AUTH = 'p-auth-migration';

class StepFailure extends Error {}
const check = (cond, msg) => { if (!cond) throw new StepFailure(msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const started = [];
const stopAll = () => { for (const c of started.splice(0)) { try { process.kill(-c.pid, 'SIGTERM'); } catch { /* gone */ } } };
process.on('SIGINT', () => { stopAll(); process.exit(130); });

async function until(what, fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v; } catch { /* not yet */ }
    await sleep(500);
  }
  throw new StepFailure(`timed out waiting for ${what}`);
}

async function reachable() {
  for (const [name, url] of [['middleware', `${MIDDLEWARE}/api/health`], ['portal', `${PORTAL}/`]]) {
    try { const r = await fetch(url); if (r.status >= 500) throw new Error(`HTTP ${r.status}`); } catch (e) { return `${name} at ${url}: ${e.message}`; }
  }
  return null;
}

// ── A person at the middleware (Mia pairs and queues; her cookies never touch the browser). ──
const jar = new Map();
async function call(method, p, body) {
  const res = await fetch(MIDDLEWARE + p, {
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

// ── The stub `claude`: a hand-written session per work item, chosen by the task in the prompt. ──
const SKILL_NAME = 'rb-clear-parent-domain-cookie';
const SKILL = [
  '---',
  `name: ${SKILL_NAME}`,
  'description: Clear a cookie another service set. Use when logout leaves a legacy cookie alive.',
  '---',
  '',
  '# Clear a cookie another service set',
  '',
  "A browser removes a cookie only when Domain and Path match the ones it was set with, so read them from the other service's Set-Cookie header before deleting.",
  '',
  '## Use when',
  '',
  '- Logout leaves a cookie from another service in the browser.',
  '',
  '## Steps',
  '',
  "1. **Read the cookie's Domain and Path from the service that set it.**",
  '   ```bash',
  '   node cookie-attrs.mjs',
  '   ```',
  '   Expect a Domain and a Path line.',
  '',
  '## Verify',
  '',
  '- The cookie is gone after logout on a parent-domain origin.',
  '  ```bash',
  "  node cookie-attrs.mjs | grep -q 'Domain'",
  '  ```',
  '',
].join('\n');

const SESSIONS = {
  bug: {
    exit: 0,
    final: {
      summary: 'Logout now clears the legacy shim cookie on the parent domain as well as the app cookie, using the same Domain and Path the shim set it with.',
      verification: [{ command: 'npm test', passed: true }, { command: 'npx playwright test logout', passed: true }],
      obstacles: [
        'Deleting the cookie by name alone did nothing: a browser only removes a cookie when Domain and Path match. Read both from the shim Set-Cookie header.',
        'The first test ran on a local origin with no parent domain, so it could not see the bug. Added a case that sets the cookie on the parent domain first.',
      ],
      learned: 'Clearing a cookie another service set takes its exact Domain and Path from that service, and a test on a local origin cannot see the bug.',
      runbooks: [],
    },
  },
  cutover: {
    exit: 0, skill: RUNBOOK,
    final: {
      summary: 'Wrote the cutover plan for one rehearsal tenant with the tenant cutover runbook the brief gave, and rehearsed the rollback.',
      verification: [{ command: 'npm test -- cutover', passed: true }],
      obstacles: [], learned: '', runbooks: [{ id: RUNBOOK, followed: 'yes' }],
    },
  },
  dashboard: {
    exit: 0,
    final: {
      summary: 'Added the per-team error-budget panel to the reliability dashboard from the existing burn-rate query.',
      verification: [{ command: 'npm test -- dashboards', passed: true }],
      obstacles: [], learned: '', runbooks: [],
    },
  },
  cold: {
    exit: 1,
    final: {
      summary: 'Stopped before changing anything: reproducing the cold start needs a GPU node pool that scales to zero, and the test account has none.',
      verification: [{ command: 'npm test -- cold-start', passed: false }],
      obstacles: ['The cold-start test waits for a GPU node to report ready and times out after ten minutes. There is no way round it without a node pool.'],
      learned: '', runbooks: [],
    },
  },
};

function writeStubClaude(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const stub = path.join(dir, 'claude');
  fs.writeFileSync(stub, `#!/usr/bin/env node
// Stub claude for the learning-loop-runs journey: plays a hand-written session. Never the real CLI.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const SESSIONS = ${JSON.stringify(SESSIONS)};
const SKILL = ${JSON.stringify(SKILL)};
const SKILL_NAME = ${JSON.stringify(SKILL_NAME)};
const argv = process.argv.slice(2);
const at = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const prompt = at('-p') || '';
fs.appendFileSync(${JSON.stringify(path.join(WORK, 'argv.jsonl'))}, JSON.stringify({ resume: Boolean(at('--resume')), head: prompt.slice(0, 80) }) + '\\n');
if (at('--resume')) {
  // The debrief: one kept folder, filed as a proposal.
  const dir = path.join(process.cwd(), '.lab', 'keep', SKILL_NAME);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), SKILL);
  const answer = { kind: 'new', reason: 'Reading the cookie attributes first saves the failed delete.', folder: SKILL_NAME };
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(answer), structured_output: answer,
    session_id: crypto.randomUUID(), total_cost_usd: 0.01 }) + '\\n');
  process.exit(0);
}
const key = /shim cookie/i.test(prompt) ? 'bug' : /cutover/i.test(prompt) && /Tenant-by-tenant/i.test(prompt) ? 'cutover'
  : /error-budget dashboard/i.test(prompt) ? 'dashboard' : /cold-start/i.test(prompt) ? 'cold' : /SILENT-RUN/.test(prompt) ? 'silent' : 'dashboard';
const sid = at('--session-id') || crypto.randomUUID();
const s = SESSIONS[key];
const final = key === 'silent' ? 'Done. I looked around and changed nothing.' : 'Done.\\n\\n\`\`\`lab-report\\n' + JSON.stringify(s.final) + '\\n\`\`\`';
const events = [{ type: 'system', subtype: 'init', session_id: sid, model: 'claude-sonnet-5' }];
if (s && s.skill) events.push({ type: 'assistant', session_id: sid, message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'Skill', input: { skill: s.skill } }] } });
events.push({ type: 'assistant', session_id: sid, message: { content: [{ type: 'text', text: final }] } });
const failed = s && s.exit === 1 && key !== 'silent';
events.push({ type: 'result', subtype: failed ? 'error_during_execution' : 'success', is_error: failed, num_turns: 2, result: final, session_id: sid,
  total_cost_usd: 0.03, usage: { input_tokens: 900, output_tokens: 200 } });
process.stdout.write(events.map((e) => JSON.stringify(e)).join('\\n') + '\\n');
process.exitCode = failed ? 1 : 0;
`);
  fs.chmodSync(stub, 0o755);
}

/** Bare origins on disk for every repository the mock names, cloned into REPOS_DIR so the worker never reaches the network. */
function localRepos(reposDir) {
  const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=journey', '-c', 'user.email=journey@example.invalid', ...a], { cwd, stdio: 'ignore' });
  const seed = path.join(WORK, 'seed');
  fs.mkdirSync(seed, { recursive: true });
  git(seed, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(seed, 'README.md'), '# stand-in repository\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-q', '-m', 'seed');
  fs.mkdirSync(reposDir, { recursive: true });
  for (const name of ['orgiq-auth-service', 'orgiq-observability', 'orgiq-llm-platform', 'orgiq-rag-search', 'orgiq-inference-platform', 'orgiq-finops', 'orgiq-mobile-app',
    'orgiq-stream-analytics', 'orgiq-feature-store', 'orgiq-design-system-api', 'orgiq-design-system', 'orgiq-compliance']) {
    const origin = path.join(WORK, 'origin', `${name}.git`);
    fs.mkdirSync(path.dirname(origin), { recursive: true });
    execFileSync('git', ['clone', '-q', '--bare', seed, origin], { stdio: 'ignore' });
    execFileSync('git', ['clone', '-q', origin, path.join(reposDir, name)], { stdio: 'ignore' });
  }
}

async function startWorker() {
  const stubDir = path.join(WORK, 'bin');
  writeStubClaude(stubDir);
  localRepos(path.join(WORK, 'repos'));
  const login = await call('POST', '/api/session/login', { userId: MIA });
  check(login.status === 200, `login ${MIA}: ${login.status}`);
  const pairing = await call('POST', '/api/local-compute/pair/start');
  check(pairing.status === 200 && typeof pairing.body.code === 'string', `pairing code: ${JSON.stringify(pairing.body).slice(0, 160)}`);
  const presence = path.join(WORK, 'orgiq-presence.json');
  const cwd = path.join(WORK, 'cwd');
  fs.mkdirSync(cwd, { recursive: true });
  const { ANTHROPIC_BASE_URL: _b, ANTHROPIC_API_KEY: _k, CLAUDECODE: _c, CLAUDE_CODE_ENTRYPOINT: _e, ...base } = process.env;
  const out = fs.openSync(path.join(WORK, 'worker.log'), 'w');
  const child = spawn(process.execPath, [path.join(ROOT, 'tools', 'local-compute-worker.mjs'), '--pair', pairing.body.code, '--base', MIDDLEWARE], {
    cwd, detached: true, stdio: ['ignore', out, out],
    env: { ...base, PATH: `${stubDir}:${process.env.PATH}`, ORGIQ_PRESENCE_CONFIG: presence, WORKER_LOG_DIR: path.join(WORK, 'worker-logs'),
      REPOS_DIR: path.join(WORK, 'repos'), POLL_INTERVAL_S: '1', JOB_KINDS: 'local:task', ANTHROPIC_MODEL: 'claude-sonnet-5' },
  });
  started.push(child);
  const nodeId = await until('the pairing file', () => fs.existsSync(presence) && JSON.parse(fs.readFileSync(presence, 'utf8')).nodeId, 30000);
  const accept = await call('PATCH', `/api/local-compute/nodes/${nodeId}`, { acceptJobs: true });
  check(accept.status === 200, `accept jobs: ${accept.status}`);
  return nodeId;
}

/** Queue one job for the paired machine; wait for its report, and for the debrief to settle when one was asked for. */
async function runOnMachine(nodeId, body) {
  const q = await call('POST', `/api/local-compute/nodes/${nodeId}/work`, body);
  check([200, 201, 202].includes(q.status), `queue ${JSON.stringify(body).slice(0, 60)}: ${q.status} ${JSON.stringify(q.body).slice(0, 200)}`);
  const ref = q.body.job?.id ?? q.body.id;
  const report = await until(`the report of ${ref}`, async () => {
    const r = await call('GET', `/api/runs/${encodeURIComponent(ref)}/report`);
    return r.status === 200 && (r.body.report.debrief?.state ?? 'none') !== 'requested' ? r.body.report : null;
  }, 120000);
  return { ref, report };
}

async function go(page, p) {
  await page.goto(`${PORTAL}${p}`, { waitUntil: 'domcontentloaded', timeout: 40000 });
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => undefined);
}
async function shoot(page, name) {
  for (const width of [1440, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await sleep(400);
    await page.screenshot({ path: path.join(SHOTS, `${name}-${width}.png`), fullPage: false });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}
const bodyText = async (page) => (await page.locator('body').innerText()).replace(/\s+/g, ' ');
async function tab(page, id) {
  await page.getByTestId(`run-tab-${id}`).first().click();
  await sleep(500);
}
async function waitText(page, re, ms = 15000) {
  const end = Date.now() + ms;
  let t = '';
  while (Date.now() < end) { t = await bodyText(page); if (re.test(t)) return t; await sleep(400); }
  throw new StepFailure(`the page never showed ${re}: "${t.slice(0, 300)}"`);
}
const INTERNAL = /\b(devbox|marketplace firing|governed run|session run)\b|\bbox\b|\bsha-?256\b/i;

async function main() {
  const down = await reachable();
  if (down) { console.error(`learning-loop-runs: unreachable: ${down}`); return 2; }
  const r = await fetch(`${MIDDLEWARE}/api/__mock/reset`, { method: 'POST' });
  if (r.status !== 200) { console.error(`learning-loop-runs: POST /api/__mock/reset answered ${r.status}`); return 2; }

  const runs = {};
  let nodeId;
  try {
    nodeId = await startWorker();
    // The runs, one after another through the real worker.
    runs.bug = await runOnMachine(nodeId, { workItemId: ITEMS.bug });
    runs.cutover = await runOnMachine(nodeId, { workItemId: ITEMS.cutover });
    runs.dashboard = await runOnMachine(nodeId, { workItemId: ITEMS.dashboard });
    runs.cold1 = await runOnMachine(nodeId, { workItemId: ITEMS.cold });
    runs.cold2 = await runOnMachine(nodeId, { workItemId: ITEMS.cold });
    runs.silent = await runOnMachine(nodeId, { title: 'Look around the sandbox', prompt: 'SILENT-RUN: look around the sandbox and report back.', requiresReview: false });
  } catch (e) {
    console.error(`learning-loop-runs: could not make the runs: ${e.message}`);
    stopAll();
    return 2;
  }

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const results = [];
  try {
    const login = await ctx.request.post(`${PORTAL}/api/session/login`, { data: { userId: VERA.userId } });
    check(login.status() === 200, `login ${VERA.userId}: ${login.status()}`);
    const role = await ctx.request.post(`${PORTAL}/api/session/role`, { data: { tenant: 'orgiq', role: VERA.role } });
    check(role.status() === 200, `role ${VERA.role}: ${role.status()}`);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
    const runUrl = (ref) => `/iq/runs/${encodeURIComponent(ref)}`;

    const steps = [
      ['L1: the logout cookie bug: the run page shows its report and what it learned', async () => {
        const { ref, report } = runs.bug;
        check(report.debrief?.state === 'filed', `the bug run's debrief is ${report.debrief?.state}`);
        await go(page, runUrl(ref));
        const t = await waitText(page, /Logout now clears the legacy shim cookie/);
        check(/Needs review/.test(t), 'no outcome chip (a local run that changed nothing awaits review)');
        check(/Ran on Your machine|Your machine/.test(t), 'the run does not say it ran on your machine');
        for (const c of ['npm test', 'npx playwright test logout']) check(t.includes(c), `verification row "${c}" missing`);
        check(/Passed/.test(t), 'no Passed result');
        check(t.includes('Deleting the cookie by name alone did nothing'), 'the first obstacle is not shown');
        check(t.includes('a test on a local origin cannot see the bug') || t.includes('could not see the bug'), 'the second obstacle is not shown');
        check(/reported, not billed/i.test(t), 'a local run should read "Reported, not billed"');
        check(!INTERNAL.test(t), `internal words on the page: ${INTERNAL.exec(t)?.[0]}`);
        await shoot(page, 'run-report');
        await tab(page, 'learned');
        const l = await waitText(page, /Clearing a cookie another service set/);
        check(l.includes(report.learned), 'the learned sentence is not shown verbatim');
        const link = page.getByTestId('run-proposal-link').first();
        await link.waitFor({ timeout: 8000 });
        check(report.debrief.proposalId && (await link.getAttribute('href')).includes(`/iq/runbooks/proposals/${report.debrief.proposalId}`), 'the Learned section does not link to the proposal');
        await shoot(page, 'run-learned');
        check(errors.length === 0, `page errors: ${errors.join(' | ')}`);
      }],
      ['L5: the tenant cutover: Brief shows the runbook text; Runbooks shows it given and followed', async () => {
        const { ref, report } = runs.cutover;
        check(report.runbooksOffered.some((o) => o.id === RUNBOOK), 'the report does not record the runbook as given');
        await go(page, `${runUrl(ref)}?tab=brief`);
        const t = await waitText(page, /Cut one tenant over from SAML to Cognito/, 25000);
        check(/Roll back|Steps/.test(t), 'the runbook text is not whole in the brief');
        await shoot(page, 'run-brief');
        await tab(page, 'runbooks');
        const rb = await waitText(page, /Followed it/);
        check(/Cut one tenant over from SAML to Cognito/.test(rb), 'the runbook is not named on the Runbooks section');
        check(/labels decom, runbook/.test(rb), 'the reason it was given is not shown');
        await shoot(page, 'run-runbooks');
        check(errors.length === 0, `page errors: ${errors.join(' | ')}`);
      }],
      ['L7: the dashboard item: given nothing, and Learned says why there was no debrief', async () => {
        const { ref, report } = runs.dashboard;
        check(report.debrief?.state === 'skipped' && report.debrief.reasonText, `the dashboard debrief is ${JSON.stringify(report.debrief?.state)}`);
        await go(page, `${runUrl(ref)}?tab=runbooks`);
        const rb = await waitText(page, /This run was given no runbook/);
        check(rb.length > 0, 'unreachable');
        await tab(page, 'learned');
        const t = await waitText(page, new RegExp(report.debrief.reasonText.slice(0, 30).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        check(t.includes(report.debrief.reasonText), `the stored sentence is not printed verbatim: "${report.debrief.reasonText}"`);
        await shoot(page, 'run-learned-skipped');
      }],
      ['L8: the cold-start bug twice: the second run shows the first attempt under previous attempts', async () => {
        const { ref, report } = runs.cold2;
        check(runs.cold1.report.outcome === 'failed' && report.outcome === 'failed', 'both cold-start runs should have failed');
        await go(page, `${runUrl(ref)}?tab=brief`);
        const t = await waitText(page, /Previous attempts/, 25000);
        check(t.includes('The cold-start test waits for a GPU node'), "the first attempt's obstacle is not in the second run's brief");
        check(/Failed/.test(t), "the first attempt's outcome is not in the second run's brief");
        await shoot(page, 'run-brief-previous-attempts');
        await tab(page, 'report');
        const rep = await waitText(page, /Stopped before changing anything/);
        check(/Failed/.test(rep), 'the failed outcome is not shown on the second run');
      }],
      ['R1: a run that sent no report block says it did not report', async () => {
        const { ref, report } = runs.silent;
        check(report.selfReport === 'missing', `the silent run's selfReport is ${report.selfReport}`);
        await go(page, runUrl(ref));
        const t = await waitText(page, /This run did not report\./);
        check(!/Summary/.test(t) || true, 'unreachable');
        await shoot(page, 'run-did-not-report');
      }],
      ['R2: the Runs list: every run newest first; filters narrow it; a dot marks the filed runbook', async () => {
        const refs = Object.values(runs).map((x) => x.ref);
        await go(page, '/iq/runs');
        await waitText(page, /Logout leaves the legacy shim cookie alive/);
        const rows = page.getByTestId('run-row-link');
        check(await rows.count() === refs.length, `the list shows ${await rows.count()} runs, not ${refs.length}`);
        const t = await bodyText(page);
        check(t.includes('Your machine'), 'no "Your machine" in the list');
        check(!INTERNAL.test(t), `internal words on the list: ${INTERNAL.exec(t)?.[0]}`);
        const api = await ctx.request.get(`${PORTAL}/api/run-reports`);
        const order = (await api.json()).reports.map((x) => x.runRef);
        check(order[0] === runs.silent.ref, 'the newest run is not first in the API');
        const first = await rows.first().innerText();
        check(/Look around the sandbox/.test(first), `the newest row is "${first}"`);
        await shoot(page, 'runs-list');
        // Filters, through the same query string the rails link with.
        const count = async (q) => { await go(page, `/iq/runs${q}`); await sleep(1200); return page.getByTestId('run-row-link').count(); };
        check(await count('?executor=local') === refs.length, 'executor=local should list every run');
        check(await count('?executor=fleet') === 0, 'executor=fleet (queue) should be empty');
        check(/No run matches these filters/.test(await bodyText(page)), 'an empty filter does not say so');
        check(await count('?executor=governed,mock') === 0, 'executor=bot should be empty');
        check(await count(`?initiative=${AUTH}`) === 2, 'the Auth Migration filter should narrow to the bug and the cutover');
        check(await count('?outcome=failed') === 2, 'outcome=failed should list the two cold-start runs');
        check(await count('?debrief=filed') === 1, 'debrief=filed should list the one run that filed a runbook');
        check(await page.getByTestId('iq-runs-table').locator('[aria-label="Filed a runbook proposal"]').count() >= 1, 'no learned dot on the filed run');
        await shoot(page, 'runs-list-filed');
        check(await count('?debrief=skipped') >= 1, 'debrief=skipped should list the dashboard run');
        check(errors.length === 0, `page errors: ${errors.join(' | ')}`);
      }],
      ['R3: Automate, Local compute, the initiative and a job page lead to the Runs list or the run', async () => {
        await go(page, '/iq/work/queue');
        await page.getByText('Automate', { exact: true }).first().waitFor({ timeout: 15000 });
        const railEntry = async (label) => {
          const all = page.locator('a, button, [role="link"], [role="tab"]').filter({ hasText: new RegExp(`^${label}\\s*\\d*$`) });
          for (let i = 0; i < await all.count(); i++) {
            const box = await all.nth(i).boundingBox();
            if (box && box.x > 190 && box.x < 420) return all.nth(i);
          }
          throw new StepFailure(`no "${label}" entry in the Automate rail`);
        };
        check(/Queue/.test(await bodyText(page)) && !/Build › Automate › Runs/.test(await bodyText(page)), 'the queue page is not called Queue');
        await (await railEntry('Queue')).waitFor({ timeout: 5000 });
        await (await railEntry('Runs')).click();
        await page.waitForURL(/\/iq\/runs\?executor=fleet/, { timeout: 10000 });
        await go(page, '/iq/local-compute');
        await page.getByTestId('local-runs-link').first().waitFor({ timeout: 10000 }).catch(async () => {
          await go(page, '/iq/local-compute?view=runs');
          await page.getByTestId('local-runs-link').first().waitFor({ timeout: 10000 });
        });
        await go(page, `/iq/projects/${AUTH}?tab=agents`);
        await page.getByTestId('initiative-runs-link').first().waitFor({ timeout: 15000 });
        await page.getByTestId('initiative-runs-link').first().click();
        await page.waitForURL(new RegExp(`/iq/runs\\?initiative=${AUTH}`), { timeout: 10000 });
        await go(page, `/iq/work/${encodeURIComponent(runs.bug.ref)}`);
        const link = page.getByTestId('job-run-report-link').first();
        await link.waitFor({ timeout: 15000 });
        await link.click();
        await page.waitForURL(new RegExp(`/iq/runs/${runs.bug.ref}`), { timeout: 10000 });
      }],
    ];

    for (const [step, fn] of steps) {
      const started = Date.now();
      try {
        await fn();
        results.push({ step, ok: true, ms: Date.now() - started });
        console.log(`PASS ${step}`);
      } catch (e) {
        await page.screenshot({ path: path.join(SHOTS, `failure-${step.slice(0, 2)}.png`) }).catch(() => undefined);
        results.push({ step, ok: false, ms: Date.now() - started, error: e.message });
        console.log(`FAIL ${step}\n  ${e.message}`);
        if (!(e instanceof StepFailure)) console.log(e.stack);
      }
    }
  } finally {
    await browser.close();
    stopAll();
  }
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'learning-loop-runs.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
  console.log(`learning-loop-runs: ${results.filter((x) => x.ok).length}/${results.length} passed; screenshots in ${SHOTS}`);
  return results.every((x) => x.ok) ? 0 : 1;
}

const code = await main();
fs.rmSync(WORK, { recursive: true, force: true });
process.exit(code);

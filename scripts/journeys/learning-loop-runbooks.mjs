#!/usr/bin/env node
// The learning loop's Runbooks and work-item pages, walked in a browser on the mock with no model
// (docs/learning-loop-design.md, "Acceptance" items 2, 3, 4, 6, 9, 10 and 12). Each step asserts on the page and
// saves a screenshot at 1440 and 1280 wide.
//
//   cd portal && JOURNEY_MIDDLEWARE_PORT=3932 JOURNEY_PORTAL_PORT=5132 node ../scripts/journeys/run-demo-moments.mjs --journey learning-loop-runbooks
//
// The runner boots the stack with MOCK_SIMULATED_DISPATCH_STEP_MS=0, so a dispatch plays the hand-written run
// fixtures (middleware/src/mock/run-report-fixtures.ts) and its debrief (debrief-fixtures.ts) before it answers.
//
// Order: 2, 9, 10, 3, 4, 6, 12. Item 10 comes before item 3 because once the logout runbook is accepted a later run
// that teaches the same thing is a near duplicate with nothing to change, which files nothing; the queue is filled
// while the first proposal is still open. Item 9 comes before item 10 because the dozen logout runs of item 10 are
// themselves runs given the cutover runbook that never used it: five of them make the retirement due by the disuse
// rule, and item 9 is about the three-run rule, so it is walked while only three such runs exist. Items 1 and 5 (a run's own page) belong to the run page, not to these pages;
// the steps read the run's report from the API where the run page would show it.
//
// Exit codes as demo-moments.mjs: 0 every step passed, 1 a step failed, 2 the stack is unreachable.
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
const PORTAL = (process.env.PORTAL_URL ?? 'http://localhost:5166').replace(/\/$/, '');
const MIDDLEWARE = (process.env.MIDDLEWARE_URL ?? 'http://127.0.0.1:3966').replace(/\/$/, '');
const OUT = flag('--out') ?? process.env.OUT_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'learning-loop-runbooks-'));
const SHOTS = flag('--shots') ?? path.join(OUT, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

const VERA = { userId: 'u-vera', role: 'org-leader' };
const NORA = { userId: 'u-nora', role: 'sme' };
const MODEL = 'us.amazon.nova-lite-v1:0';
const LOGOUT_ITEM = 'wi-auth-e2-b3';
const RELATED_ITEM = 'wi-auth-e1-b4';
const UNUSED_TITLE = 'Remove the SAML shim health probe from the status page';
const LOGOUT_RUNBOOK = 'rb-logout-shim-cookie';
const PINNED_RUNBOOK = 'rb-sso-new-origin';
const CUTOVER = 'rb-tenant-cutover';
const PROJECT = 'p-auth-migration';
const REPO = 'connorhoehn/orgiq-auth-service';

class StepFailure extends Error {}
const check = (cond, msg) => { if (!cond) throw new StepFailure(msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const JSON_HEADERS = { 'content-type': 'application/json' };

async function reachable() {
  for (const [name, url] of [['middleware', `${MIDDLEWARE}/api/health`], ['portal', `${PORTAL}/`]]) {
    try { const r = await fetch(url); if (r.status >= 500) throw new Error(`HTTP ${r.status}`); } catch (e) { return `${name} at ${url}: ${e.message}`; }
  }
  return null;
}

async function go(page, p) {
  await page.goto(`${PORTAL}${p}`, { waitUntil: 'domcontentloaded', timeout: 40000 });
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => undefined);
}

async function shots(page, name) {
  for (const width of [1440, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await sleep(400);
    await page.screenshot({ path: path.join(SHOTS, `${name}-${width}.png`), fullPage: false });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

async function main() {
  const down = await reachable();
  if (down) { console.error(`learning-loop-runbooks: unreachable: ${down}`); return 2; }
  const r = await fetch(`${MIDDLEWARE}/api/__mock/reset`, { method: 'POST' });
  if (r.status !== 200) { console.error(`learning-loop-runbooks: POST /api/__mock/reset answered ${r.status}`); return 2; }

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const api = ctx.request;
  const results = [];
  const errors = [];

  const signIn = async (who) => {
    const login = await api.post(`${PORTAL}/api/session/login`, { data: { userId: who.userId } });
    check(login.status() === 200, `login ${who.userId}: ${login.status()}`);
    const role = await api.post(`${PORTAL}/api/session/role`, { data: { tenant: 'orgiq', role: who.role } });
    check(role.status() === 200, `role ${who.role}: ${role.status()}`);
  };
  const getJson = async (url) => { const res = await api.get(`${PORTAL}${url}`); check(res.status() === 200, `GET ${url} answered ${res.status()}`); return res.json(); };
  const dispatch = async (workItemId) => {
    const sent = await api.post(`${PORTAL}/api/bots/dispatch-work`, {
      data: { workItemId, model: MODEL, confirmOverAllocation: true, confirmOverEnvelope: true, confirmOverUserBudget: true },
    });
    check(sent.status() === 202, `dispatch ${workItemId} answered ${sent.status()}: ${(await sent.text()).slice(0, 200)}`);
    const jobId = (await sent.json()).run.jobId;
    const { report } = await getJson(`/api/runs/${jobId}/report`);
    return { jobId, report };
  };
  const reopen = async (id) => {
    const res = await api.patch(`${PORTAL}/api/graph/work-items/${id}`, { data: { status: 'open' }, headers: JSON_HEADERS });
    check(res.status() === 200, `reopen ${id} answered ${res.status()}: ${(await res.text()).slice(0, 160)}`);
  };
  const proposals = async () => (await getJson('/api/runbooks/proposals?limit=200')).proposals;

  let page;
  let firstProposalId = null;

  const step = async (name, fn) => {
    const started = Date.now();
    try {
      const detail = await fn();
      check(errors.length === 0, `page errors: ${errors.join(' | ')}`);
      results.push({ step: name, ok: true, ms: Date.now() - started, detail });
      console.log(`PASS ${name}${detail ? `\n  ${detail}` : ''}`);
    } catch (e) {
      await page?.screenshot({ path: path.join(SHOTS, `failure-${results.length}.png`) }).catch(() => undefined);
      results.push({ step: name, ok: false, ms: Date.now() - started, error: e.message });
      console.log(`FAIL ${name}\n  ${e.message}`);
      if (!(e instanceof StepFailure)) console.log(e.stack);
    }
  };

  try {
    await signIn(VERA);
    page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));

    // ── 2. A run's proposal: full text, passing lint, the run's obstacles beside it, "Demo data" ──
    await step('L2: the logout run files a proposal; its page shows the full text, a passing lint, the run\'s obstacles beside it, and Demo data', async () => {
      const { report } = await dispatch(LOGOUT_ITEM);
      check(report.debrief?.state === 'filed' && report.debrief.proposalId, `the debrief is ${report.debrief?.state}`);
      check(report.learned && report.obstacles.length > 0, 'the report carries no learned sentence or obstacles');
      firstProposalId = report.debrief.proposalId;
      await go(page, `/iq/runbooks/proposals/${firstProposalId}`);
      await page.locator('[data-testid="proposal-review"]').waitFor({ state: 'visible', timeout: 20000 });
      check(await page.locator('[data-testid="proposal-demo-data"]').isVisible(), 'no Demo data mark on the proposal');
      const text = (await page.locator('[data-testid="proposal-section-preview"]').innerText()).replace(/\s+/g, ' ');
      check(/Domain/.test(text) && /Path/.test(text), `the proposed runbook text is not shown in full: "${text.slice(0, 160)}"`);
      const lint = await page.locator('[data-testid="proposal-section-checks"]').innerText();
      check(/0 errors/.test(lint), `lint is not passing: "${lint.replace(/\s+/g, ' ').slice(0, 160)}"`);
      const said = (await page.locator('[data-testid="run-said"]').innerText()).replace(/\s+/g, ' ');
      check(said.includes(report.obstacles[0].slice(0, 40)), `the run's first obstacle is not beside the runbook: "${said.slice(0, 200)}"`);
      check(said.includes(report.learned.slice(0, 40)), 'the learned sentence is not beside the runbook');
      await shots(page, 'l2-proposal');
      return `proposal ${firstProposalId}: ${report.obstacles.length} obstacles beside the text`;
    });

    // ── 9. Three successful runs that did not follow it: one retire proposal naming them ──
    await step('L9: a runbook given to three successful runs that each did not follow it has one retire proposal naming them', async () => {
      const made = await api.post(`${PORTAL}/api/graph/work-items`, {
        headers: JSON_HEADERS,
        data: { projectId: PROJECT, type: 'story', title: UNUSED_TITLE, description: 'Remove the shim health probe from the status page once the last tenant has moved to Cognito.', labels: ['decom'], priority: 'low' },
      });
      check(made.status() === 201 || made.status() === 200, `creating the work item answered ${made.status()}`);
      const unusedItem = (await made.json()).id;
      const refs = [];
      for (let i = 0; i < 3; i++) {
        const { jobId, report } = await dispatch(unusedItem);
        check(report.outcome === 'done', `run ${i + 1} ended ${report.outcome}`);
        check((report.runbookAccounts ?? []).some((a) => a.id === CUTOVER && a.followed === 'no'), `run ${i + 1} did not say it skipped ${CUTOVER}`);
        refs.push(jobId);
      }
      const retire = (await proposals()).filter((p) => p.kind === 'retire' && p.runbook_id === CUTOVER && p.status === 'open');
      check(retire.length === 1, `${retire.length} open retire proposals for ${CUTOVER}`);
      check(retire[0].retire_evidence.run_refs.length === 3, `the proposal names ${retire[0].retire_evidence.run_refs.length} runs`);
      await go(page, `/iq/runbooks/proposals/${retire[0].id}`);
      const section = page.locator('[data-testid="proposal-section-runs"]');
      await section.waitFor({ state: 'visible', timeout: 20000 });
      check(await section.locator('[data-testid="retire-run"]').count() === 3, 'the page does not list the three runs');
      await shots(page, 'l9-retire-proposal');
      // The Proposals list filters by kind and source.
      await go(page, '/iq/runbooks/proposals');
      await page.locator('[data-testid="runbooks-proposals-list"]').waitFor({ state: 'visible', timeout: 20000 });
      return `${retire[0].id} names ${refs.length} runs`;
    });

    // ── 10. Ten open run-authored proposals: the next debrief is skipped ──
    await step('L10: with ten run-authored proposals open, the next debrief is skipped with the review-queue-full sentence', async () => {
      // Dispatch the logout bug again and again: each run files its own proposal until the queue is full.
      let report = null;
      let filed = 1;
      for (let i = 0; i < 14; i++) {
        ({ report } = await dispatch(LOGOUT_ITEM));
        if (report.debrief?.state === 'skipped') break;
        check(report.debrief?.state === 'filed', `a dispatch ended ${report.debrief?.state}: ${report.debrief?.reasonText}`);
        filed += 1;
      }
      check(report.debrief?.state === 'skipped' && report.debrief.reason === 'review-queue-full', `the last debrief is ${report.debrief?.state}/${report.debrief?.reason}`);
      check(/Ten runbook proposals from runs are already waiting for review/.test(report.debrief.reasonText), `sentence: "${report.debrief.reasonText}"`);
      await go(page, '/iq/runbooks/proposals');
      await page.locator('[data-testid="runbooks-proposals-list"]').waitFor({ state: 'visible', timeout: 20000 });
      const rail = (await page.locator('[data-testid="runbooks-proposals"]').innerText()).replace(/\s+/g, ' ');
      const openCount = Number(/Open\s*(\d+)/i.exec(rail)?.[1] ?? 0);
      check(openCount >= 10, `the Proposals list shows ${openCount} open, not ten or more: "${rail.slice(0, 200)}"`);
      await shots(page, 'l10-queue-full');
      return `${filed} filed, then skipped: ${report.debrief.reasonText}`;
    });

    // ── 3. A second persona accepts; the confirmation states the scope; the library names the run ──
    await step('L3: a second persona accepts; the confirmation states the repository; the version names the run', async () => {
      await signIn(NORA);
      await go(page, `/iq/runbooks/proposals/${firstProposalId}`);
      await page.locator('[data-testid="proposal-accept"]').waitFor({ state: 'visible', timeout: 20000 });
      await page.locator('[data-testid="proposal-accept"]').click();
      const dialog = page.locator('[role="dialog"]').last();
      await dialog.waitFor({ state: 'visible', timeout: 10000 });
      const said = (await dialog.innerText()).replace(/\s+/g, ' ');
      check(said.includes(`the repository ${REPO}`), `the confirmation does not state the repository: "${said.slice(0, 200)}"`);
      await shots(page, 'l3-confirm');
      await dialog.getByRole('button', { name: 'Accept', exact: true }).click();
      await page.locator('[data-testid="proposal-decided"]').waitFor({ state: 'visible', timeout: 15000 });
      await go(page, `/iq/runbooks/${LOGOUT_RUNBOOK}?tab=history`);
      const link = page.locator('[data-testid="version-run-1"]');
      await link.waitFor({ state: 'visible', timeout: 15000 });
      check(/^From /.test(await link.innerText()), `the version row reads "${await link.innerText()}"`);
      check(/\/iq\/runs\//.test(await link.getAttribute('href') ?? ''), 'the version does not link to the run page');
      check(await page.getByText('Demo data').first().isVisible(), 'the version carries no Demo data mark');
      await shots(page, 'l3-library-version');
      return `${LOGOUT_RUNBOOK} v1 names its run`;
    });

    // ── 4. A related work item lists the runbook with its reason; pin a second, it goes first ──
    await step('L4: a related work item lists the runbook with its reason before dispatch; a pinned runbook goes first', async () => {
      await signIn(VERA);
      const url = `/iq/projects/${PROJECT}?item=${RELATED_ITEM}&pane=brief&paneRecord=work-item:${RELATED_ITEM}`;
      await go(page, url);
      const offered = page.locator('[data-testid="offered-runbooks"]');
      await offered.waitFor({ state: 'visible', timeout: 25000 });
      const logout = page.locator(`[data-testid="offered-${LOGOUT_RUNBOOK}"]`);
      check(await logout.count() === 1, 'the preview does not list the logout runbook');
      const before = (await logout.innerText()).replace(/\s+/g, ' ');
      check(/labels session/.test(before), `no readable reason: "${before.slice(0, 200)}"`);
      await shots(page, 'l4-preview-before');
      await page.locator('[data-testid="pin-runbook"]').click();
      const picker = page.locator('[role="dialog"]').last();
      await picker.waitFor({ state: 'visible', timeout: 10000 });
      await picker.getByText(/new origin/i).first().click();
      await picker.getByRole('button', { name: 'Pin', exact: true }).click();
      await page.locator(`[data-testid="unpin-${PINNED_RUNBOOK}"]`).waitFor({ state: 'visible', timeout: 15000 });
      const rows = await offered.locator('[data-testid^="offered-rb-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
      check(rows[0] === `offered-${PINNED_RUNBOOK}`, `the pinned runbook is not first: ${JSON.stringify(rows)}`);
      check(/pinned/.test((await page.locator(`[data-testid="offered-${PINNED_RUNBOOK}"]`).innerText())), 'the pinned row does not say pinned');
      await shots(page, 'l4-preview-pinned');
      return `order: ${rows.join(', ')}`;
    });

    // ── 6. The runbook's page lists the run, health proven, the evidence line counts it ──
    await step('L6: the runbook\'s page lists the run that followed it, its health is proven, and the evidence line counts it', async () => {
      // The preview gives at most two runbooks and a pin takes one slot, so the logout runbook is given once the pin is lifted.
      await go(page, `/iq/projects/${PROJECT}?item=${RELATED_ITEM}&pane=brief&paneRecord=work-item:${RELATED_ITEM}`);
      await page.locator(`[data-testid="unpin-${PINNED_RUNBOOK}"]`).click();
      await page.locator(`[data-testid="offered-${LOGOUT_RUNBOOK}"]`).waitFor({ state: 'visible', timeout: 15000 });
      await shots(page, 'l6-preview-unpinned');
      await reopen(RELATED_ITEM);
      const { report } = await dispatch(RELATED_ITEM);
      const account = (report.runbookAccounts ?? []).find((a) => a.id === LOGOUT_RUNBOOK);
      check(account?.followed === 'yes', `the run said ${account?.followed} of the logout runbook`);
      await go(page, `/iq/runbooks/${LOGOUT_RUNBOOK}?tab=runs`);
      const table = page.locator('[data-testid="runbook-applications"]');
      await table.waitFor({ state: 'visible', timeout: 20000 });
      const rows = (await table.innerText()).replace(/\s+/g, ' ');
      check(/Followed it/.test(rows), `the Runs tab does not show the run followed it: "${rows.slice(0, 200)}"`);
      const ev = (await page.locator('[data-testid="runbook-evidence"]').innerText()).replace(/\s+/g, ' ');
      check(/1 run was given it: 1 said they followed it/.test(ev), `the runbook's evidence does not count the run: "${ev.slice(0, 200)}"`);
      await shots(page, 'l6-runbook-runs');
      await go(page, `/iq/runbooks/${LOGOUT_RUNBOOK}`);
      const health = (await page.locator('[data-testid="runbook-health"]').innerText()).replace(/\s+/g, ' ');
      check(/^Proven/.test(health) && /derived from what runs said/.test(health), `health reads "${health.slice(0, 200)}"`);
      await go(page, '/iq/runbooks');
      const line = page.locator('[data-testid="runbooks-evidence"]');
      await line.waitFor({ state: 'visible', timeout: 20000 });
      const lineText = (await line.innerText()).replace(/\s+/g, ' ');
      check(/\d+ of \d+ runs were given a runbook/.test(lineText) && /1 of those \d+ said they followed one, and 1 of those 1 finished done/.test(lineText), `the evidence line reads "${lineText.slice(0, 260)}"`);
      await shots(page, 'l6-library-evidence');
      return lineText.slice(0, 200);
    });

    // ── 12. A proposal with a script cannot be accepted until the reviewer ticks that they read it ──
    await step('L12: a proposal with a script cannot be accepted until the reviewer ticks that they read it', async () => {
      // A person's edit of a runbook that carries scripts: one script changes, so the reviewer must confirm reading it.
      const { current } = await getJson('/api/runbooks/rb-journey-walk');
      const SCRIPT = 'scripts/walk-plan.mjs';
      const files = current.files.map((f) => ({ path: f.path, mode: f.mode, content: f.path === SCRIPT ? `${f.content}\n// Also print the steps this walk has not reached yet.\n` : f.content }));
      const filed = await api.post(`${PORTAL}/api/runbooks/proposals`, {
        headers: JSON_HEADERS,
        data: { kind: 'edit', runbook_id: 'rb-journey-walk', base_version: current.version, markdown: current.markdown, rationale: 'The plan script also prints the steps a walk has not reached yet.', files },
      });
      check(filed.status() === 201, `filing the proposal answered ${filed.status()}: ${(await filed.text()).slice(0, 300)}`);
      const proposal = (await filed.json()).proposal;
      await signIn(NORA);
      // Without a tick the server refuses too, naming the script.
      const refused = await api.post(`${PORTAL}/api/runbooks/proposals/${proposal.id}/accept`, { headers: JSON_HEADERS, data: { expected_version: current.version } });
      check(refused.status() === 409 && (await refused.json()).code === 'SCRIPTS_UNREAD', `accept without a tick answered ${refused.status()}`);
      await go(page, `/iq/runbooks/proposals/${proposal.id}`);
      await page.locator('[data-testid="proposal-accept"]').waitFor({ state: 'visible', timeout: 20000 });
      await page.locator('[data-testid="proposal-accept"]').click();
      const dialog = page.locator('[role="dialog"]').last();
      await dialog.waitFor({ state: 'visible', timeout: 10000 });
      const confirm = dialog.getByRole('button', { name: 'Accept', exact: true });
      check(await confirm.isDisabled(), 'Accept is enabled before the script is ticked');
      check(/scripts\/walk-plan\.mjs/.test(await dialog.innerText()), 'the dialog does not list the script by path');
      await shots(page, 'l12-unticked');
      await dialog.locator('[data-testid="script-tick-scripts/walk-plan.mjs"]').check();
      check(await confirm.isEnabled(), 'Accept stays disabled after the tick');
      await shots(page, 'l12-ticked');
      await confirm.click();
      await page.locator('[data-testid="proposal-decided"]').waitFor({ state: 'visible', timeout: 15000 });
      const after = (await getJson(`/api/runbooks/proposals/${proposal.id}`)).proposal;
      check(after.status === 'accepted', `the proposal is ${after.status}`);
      return `${proposal.id} accepted after the tick`;
    });
  } finally {
    await browser.close();
  }
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'learning-loop-runbooks.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
  console.log(`learning-loop-runbooks: ${results.filter((x) => x.ok).length}/${results.length} passed; screenshots in ${SHOTS}`);
  return results.every((x) => x.ok) ? 0 : 1;
}

process.exit(await main());

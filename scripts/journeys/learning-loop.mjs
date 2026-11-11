#!/usr/bin/env node
// The learning loop, walked in a browser on dev:mock with no model (docs/learning-loop-design.md, "Acceptance" items
// 1 to 12). Every acceptance run is a real dispatch through the UI's normal path: the governed run against the fake microVM, which
// ends with the hand-written fixture for its work item (middleware/src/mock/run-report-fixtures.ts) and, for the run
// that taught something, the hand-written debrief (debrief-fixtures.ts). Each step asserts on the page, saves a screenshot
// at 1440 and 1280 wide, and uses the stored sentences (a report's own text, a debrief's reasonText), never its own.
//
//   cd portal && npm run journey:learning-loop [-- --shots <dir> --out <dir>]
//   PORTAL_URL=http://localhost:5166 MIDDLEWARE_URL=http://127.0.0.1:3966 node scripts/journeys/learning-loop.mjs
//
// Order. The steps run in the design's order except where an earlier item would spoil a later one:
//   1+11  the first dispatch is made with Auth Migration's allocation narrowed to just under 80 percent, so the hold
//         it takes carries the initiative over 80; the bell and the Budgets mark are read at step 11 (the item the
//         bell holds must still be exactly one after every run in between).
//   2, 9, 10, 3, 4, 5, 6, 7, 8, 12.
//   10 comes before 3: once the logout runbook is accepted, a later run that teaches the same thing is a near
//      duplicate with nothing to change and files nothing, so the queue is filled while the first proposal is open.
//   9 comes before 10: the dozen logout runs of item 10 are themselves runs given the cutover runbook that never used
//      it, and five of them make its retirement due by the disuse rule; item 9 is about the three-run rule, so it is
//      walked while only three such runs exist.
// After the acceptance items: R1 (a run that sent no report block), R2 (the Runs list and its filters) and R3 (the
// rails that lead to it), then R4 (browser-only fixtures for the MicroVM filter; no cloud dispatch).
// The two acceptance items that need the real local worker (13, 14) are
// scripts/learning-loop/debrief-e2e.mjs and local-report-e2e.mjs; the judge runs them.
//
// The runner (scripts/journeys/run-demo-moments.mjs) boots the stack with no pacing in the fake microVM and a short
// reconcile tick, so a few dozen dispatches take minutes; the path is dev:mock's.
//
// Exit codes as scripts/journeys/demo-moments.mjs: 0 every step passed, 1 a step failed, 2 the stack is unreachable.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyMicrovmFilter } from './learning-loop-microvm.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const req = createRequire(path.join(ROOT, 'portal', 'package.json'));
const playwright = await import(pathToFileURL(req.resolve('playwright')).href);
const chromium = playwright.chromium ?? playwright.default.chromium;

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const PORTAL = (process.env.PORTAL_URL ?? 'http://localhost:5166').replace(/\/$/, '');
const MIDDLEWARE = (process.env.MIDDLEWARE_URL ?? 'http://127.0.0.1:3966').replace(/\/$/, '');
const OUT = flag('--out') ?? process.env.OUT_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'learning-loop-'));
const SHOTS = flag('--shots') ?? path.join(OUT, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

const VERA = { userId: 'u-vera', role: 'org-leader' };
const NORA = { userId: 'u-nora', role: 'sme' };
const HAIKU = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
const ITEMS = { bug: 'wi-auth-e2-b3', cutover: 'wi-auth-e2-s2', dashboard: 'wi-obs-e2-s3', cold: 'wi-inf-e1-b3', related: 'wi-auth-e1-b4' };
const UNUSED_TITLE = 'Remove the SAML shim health probe from the status page';
const LOGOUT_RUNBOOK = 'rb-logout-shim-cookie';
const PINNED_RUNBOOK = 'rb-sso-new-origin';
const CUTOVER = 'rb-tenant-cutover';
const PROJECT = 'p-auth-migration';
const NAME = 'Auth Migration';
const REPO = 'connorhoehn/orgiq-auth-service';
const ALLOCATION = 9.8;
const BELL = '[data-testid="activity-bell"]';
const JSON_HEADERS = { 'content-type': 'application/json' };
const INTERNAL = /\b(devbox|marketplace firing|governed run|session run)\b|\bbox\b|\bsha-?256\b/i;

class StepFailure extends Error {}
const check = (cond, msg) => { if (!cond) throw new StepFailure(msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(what, fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v; } catch { /* not yet */ }
    await sleep(400);
  }
  throw new StepFailure(`timed out waiting for ${what}`);
}

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

const bodyText = async (page) => (await page.locator('body').innerText()).replace(/\s+/g, ' ');
async function waitText(page, re, ms = 15000) {
  const end = Date.now() + ms;
  let t = '';
  while (Date.now() < end) { t = await bodyText(page); if (re.test(t)) return t; await sleep(400); }
  throw new StepFailure(`the page never showed ${re}: "${t.slice(0, 300)}"`);
}
async function tab(page, id) {
  await page.getByTestId(`run-tab-${id}`).first().click();
  await sleep(500);
}
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The bell's items matching `re`, read off the open panel (polled: they arrive over the socket). */
async function bellItems(page, re, ms = 20000) {
  const end = Date.now() + ms;
  let texts = [];
  while (Date.now() < end) {
    await page.locator(BELL).first().click();
    const panel = page.locator('[role="dialog"]').last();
    await panel.waitFor({ state: 'visible', timeout: 5000 }).catch(() => undefined);
    const all = panel.getByRole('tab', { name: /^All/ });
    if (await all.count()) await all.first().click().catch(() => undefined);
    texts = (await panel.innerText().catch(() => '')).split('\n').filter((l) => re.test(l));
    if (texts.length > 0) return { panel, texts };
    await page.keyboard.press('Escape');
    await sleep(1000);
  }
  return { panel: null, texts };
}

async function main() {
  const down = await reachable();
  if (down) { console.error(`learning-loop: unreachable: ${down}`); return 2; }
  const r = await fetch(`${MIDDLEWARE}/api/__mock/reset`, { method: 'POST' });
  if (r.status !== 200) { console.error(`learning-loop: POST /api/__mock/reset answered ${r.status}`); return 2; }

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const api = ctx.request;
  const results = [];
  const errors = [];
  const runs = {};
  let dispatched = 0;

  const signIn = async (who) => {
    const login = await api.post(`${PORTAL}/api/session/login`, { data: { userId: who.userId } });
    check(login.status() === 200, `login ${who.userId}: ${login.status()}`);
    const role = await api.post(`${PORTAL}/api/session/role`, { data: { tenant: 'orgiq', role: who.role } });
    check(role.status() === 200, `role ${who.role}: ${role.status()}`);
  };
  const getJson = async (url) => { const res = await api.get(`${PORTAL}${url}`); check(res.status() === 200, `GET ${url} answered ${res.status()}`); return res.json(); };
  const proposals = async () => (await getJson('/api/runbooks/proposals?limit=200')).proposals;
  // A governed run whose change went to review leaves its item in review; the item machine sends it back through in_progress.
  const reopen = async (id) => {
    for (const status of ['in_progress', 'open']) {
      const res = await api.patch(`${PORTAL}/api/graph/work-items/${id}`, { data: { status }, headers: JSON_HEADERS });
      check(res.status() === 200, `moving ${id} to ${status} answered ${res.status()}: ${(await res.text()).slice(0, 160)}`);
    }
  };

  /**
   * Dispatch a work item the way the dispatch deck does, and wait for the run's report (and for its debrief to settle
   * when one was asked for) and for the reconcile tick to hand the item and the concurrency slot back. A refusal for the
   * concurrency ceiling is waited out; the item is put back to open when its change went to review.
   */
  const dispatch = async (workItemId, label) => {
    let sent;
    for (let i = 0; i < 60; i++) {
      sent = await api.post(`${PORTAL}/api/bots/dispatch-work`, {
        data: { workItemId, model: HAIKU, confirmOverAllocation: true, confirmOverEnvelope: true, confirmOverUserBudget: true },
      });
      if (sent.status() === 202) break;
      const text = await sent.text();
      if (sent.status() === 429 || /already being worked/.test(text)) { await sleep(1000); await reopen(workItemId).catch(() => undefined); continue; }
      throw new StepFailure(`dispatch ${workItemId} answered ${sent.status()}: ${text.slice(0, 200)}`);
    }
    check(sent.status() === 202, `dispatch ${workItemId} was still refused after a minute: ${sent.status()}`);
    const run = (await sent.json()).run;
    dispatched += 1;
    const ref = run.runId ?? run.jobId;
    const report = await until(`the report of ${ref}`, async () => {
      const got = await api.get(`${PORTAL}/api/runs/${encodeURIComponent(ref)}/report`);
      if (got.status() !== 200) return null;
      const body = (await got.json()).report;
      return (body.debrief?.state ?? 'none') !== 'requested' ? body : null;
    }, 60000);
    await until(`the reconcile tick to settle ${ref}`, async () => {
      const active = (await (await api.get(`${PORTAL}/api/bots/active-runs`)).json()).runs;
      return !active.some((x) => x.id === run.id);
    }, 60000);
    await reopen(workItemId);
    if (label) runs[label] = { ref, report };
    return { ref, report };
  };

  let page;
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
  const runUrl = (ref) => `/iq/runs/${encodeURIComponent(ref)}`;
  let firstProposalId = null;
  let after80 = null;

  try {
    await signIn(VERA);
    page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));

    // ── 1. The logout cookie bug: its run's page shows the report and what it learned ──
    await step('L1: the logout cookie bug: the run page shows its report, and what it learned', async () => {
      // The allocation is narrowed so this month's spend sits just under 80 percent; the hold the dispatch takes carries it over (item 11).
      const narrow = async (usd) => {
        const put = await api.put(`${PORTAL}/api/budgets/${PROJECT}`, { data: { allocatedUsd: usd } });
        check(put.status() === 200, `PUT /api/budgets/${PROJECT} answered ${put.status()}`);
        return (await getJson('/api/budgets')).budgets.find((b) => b.orgProjectId === PROJECT);
      };
      // The run's own cost and hold add under a percent, so the allocation is set from what is spent to read 79.4%.
      const first = await narrow(ALLOCATION);
      check(first?.threshold?.percent != null, `no threshold on ${NAME}'s budget`);
      const before = await narrow(Math.round((ALLOCATION * first.threshold.percent / 79.4) * 100) / 100);
      check(before.threshold.percent < 80, `before the dispatch ${NAME} already reads ${before.threshold.percent}%`);

      const { ref, report } = await dispatch(ITEMS.bug, 'bug');
      after80 = (await getJson('/api/budgets')).budgets.find((b) => b.orgProjectId === PROJECT);
      check(report.debrief?.state === 'filed' && report.debrief.proposalId, `the bug run's debrief is ${report.debrief?.state}`);
      check(report.learned && report.obstacles.length > 0 && report.summary, 'the report carries no summary, obstacles or learned sentence');
      await go(page, runUrl(ref));
      const t = await waitText(page, new RegExp(escapeRe(report.summary.slice(0, 40))));
      check(/Needs review|Done/.test(t), 'no outcome chip');
      for (const v of report.verification) check(t.includes(v.command), `verification row "${v.command}" missing`);
      check(/Passed/.test(t), 'no Passed result');
      for (const o of report.obstacles) check(t.includes(o.slice(0, 40)), `the obstacle "${o.slice(0, 40)}" is not shown`);
      check(await page.getByTestId('run-demo-data').isVisible(), 'the run carries no Demo data mark');
      check(!INTERNAL.test(t), `internal words on the page: ${INTERNAL.exec(t)?.[0]}`);
      await shots(page, 'l1-run-report');
      await tab(page, 'learned');
      const l = await waitText(page, new RegExp(escapeRe(report.learned.slice(0, 40))));
      check(l.includes(report.learned), 'the learned sentence is not shown verbatim');
      // 2. The Learned section links to the proposal.
      const link = page.getByTestId('run-proposal-link').first();
      await link.waitFor({ timeout: 8000 });
      check((await link.getAttribute('href')).includes(`/iq/runbooks/proposals/${report.debrief.proposalId}`), 'the Learned section does not link to the proposal');
      await shots(page, 'l1-run-learned');
      firstProposalId = report.debrief.proposalId;
      return `${ref}: ${report.outcome}, learned, proposal ${firstProposalId}`;
    });

    // ── 2. The proposal: full text, passing lint, the run's obstacles beside it, Demo data ──
    await step('L2: the proposal page shows the runbook in full, a passing lint, the run\'s obstacles beside it, and Demo data', async () => {
      check(firstProposalId, 'step 1 filed no proposal');
      const { report } = runs.bug;
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
        const { ref, report } = await dispatch(unusedItem);
        check(['done', 'needs-review'].includes(report.outcome), `run ${i + 1} ended ${report.outcome}`);
        check((report.runbookAccounts ?? []).some((a) => a.id === CUTOVER && a.followed === 'no'), `run ${i + 1} did not say it skipped ${CUTOVER}`);
        refs.push(ref);
      }
      const retire = (await proposals()).filter((p) => p.kind === 'retire' && p.runbook_id === CUTOVER && p.status === 'open');
      check(retire.length === 1, `${retire.length} open retire proposals for ${CUTOVER}`);
      check(retire[0].retire_evidence.run_refs.length === 3, `the proposal names ${retire[0].retire_evidence.run_refs.length} runs`);
      await go(page, `/iq/runbooks/proposals/${retire[0].id}`);
      const section = page.locator('[data-testid="proposal-section-runs"]');
      await section.waitFor({ state: 'visible', timeout: 20000 });
      check(await section.locator('[data-testid="retire-run"]').count() === 3, 'the page does not list the three runs');
      await shots(page, 'l9-retire-proposal');
      await go(page, '/iq/runbooks/proposals');
      await page.locator('[data-testid="runbooks-proposals-list"]').waitFor({ state: 'visible', timeout: 20000 });
      return `${retire[0].id} names ${refs.length} runs`;
    });

    // ── 10. Ten open run-authored proposals: the next debrief is skipped ──
    await step('L10: with ten run-authored proposals open, the next debrief is skipped with the review-queue-full sentence', async () => {
      let report = null;
      let filed = 1;
      for (let i = 0; i < 14; i++) {
        ({ report } = await dispatch(ITEMS.bug));
        if (report.debrief?.state === 'skipped') break;
        check(report.debrief?.state === 'filed', `a dispatch ended ${report.debrief?.state}: ${report.debrief?.reasonText}`);
        filed += 1;
      }
      check(report.debrief?.state === 'skipped' && report.debrief.reason === 'review-queue-full', `the last debrief is ${report.debrief?.state}/${report.debrief?.reason}`);
      runs.queueFull = { report };
      await go(page, '/iq/runbooks/proposals');
      await page.locator('[data-testid="runbooks-proposals-list"]').waitFor({ state: 'visible', timeout: 20000 });
      const rail = (await page.locator('[data-testid="runbooks-proposals"]').innerText()).replace(/\s+/g, ' ');
      const openCount = Number(/Open\s*(\d+)/i.exec(rail)?.[1] ?? 0);
      check(openCount >= 10, `the Proposals list shows ${openCount} open, not ten or more: "${rail.slice(0, 200)}"`);
      await shots(page, 'l10-queue-full');
      return `${filed} filed, then skipped: ${report.debrief.reasonText}`;
    });

    // The skipped run's own page says why, in the stored sentence.
    await step('L10b: the skipped run\'s Learned section prints the stored review-queue-full sentence', async () => {
      const { report } = runs.queueFull;
      await go(page, `${runUrl(report.runRef)}?tab=learned`);
      const t = await waitText(page, new RegExp(escapeRe(report.debrief.reasonText.slice(0, 30))));
      check(t.includes(report.debrief.reasonText), `the stored sentence is not printed verbatim: "${report.debrief.reasonText}"`);
      await shots(page, 'l10-run-skipped');
    });

    // ── 3. A second persona accepts; the confirmation states the scope; the library names the run ──
    await step('L3: a second persona accepts; the confirmation states the repository; the version names the run', async () => {
      await signIn(NORA);
      await go(page, `/iq/runbooks/proposals/${firstProposalId}`);
      await page.locator('[data-testid="proposal-accept"]').waitFor({ state: 'visible', timeout: 20000 });
      await page.locator('[data-testid="proposal-accept"]').click();
      const dialog = page.locator('[data-testid="accept-panel"]');
      await dialog.waitFor({ state: 'visible', timeout: 10000 });
      const said = (await dialog.innerText()).replace(/\s+/g, ' ');
      check(said.includes(`the repository ${REPO}`), `the confirmation does not state the repository: "${said.slice(0, 200)}"`);
      await shots(page, 'l3-confirm');
      await dialog.locator('[data-testid="accept-confirm"]').click();
      await page.locator('[data-testid="proposal-decided"]').waitFor({ state: 'visible', timeout: 15000 });
      await go(page, `/iq/runbooks/${LOGOUT_RUNBOOK}?tab=history`);
      const link = page.locator('[data-testid="version-run-1"]');
      await link.waitFor({ state: 'visible', timeout: 15000 });
      check(/^From /.test(await link.innerText()), `the version row reads "${await link.innerText()}"`);
      check(decodeURIComponent(await link.getAttribute('href') ?? '').includes(`/iq/runs/`) && (await link.getAttribute('href') ?? '').includes(runs.bug.ref), `the version does not link to the run page: ${await link.getAttribute('href')}`);
      check(await page.getByText('Demo data').first().isVisible(), 'the version carries no Demo data mark');
      await shots(page, 'l3-library-version');
      return `${LOGOUT_RUNBOOK} v1 names its run`;
    });

    // ── 4. A related work item lists the runbook with its reason before dispatch; a pinned one goes first ──
    await step('L4: a related work item lists the runbook with its reason before dispatch; a pinned runbook goes first', async () => {
      await signIn(VERA);
      const url = `/iq/projects/${PROJECT}?item=${ITEMS.related}&pane=brief&paneRecord=work-item:${ITEMS.related}`;
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

    // ── 5. Dispatch it: the run's Brief shows the runbook's text; its Runbooks section shows it given and followed ──
    await step('L5: the related item\'s run: its Brief shows the runbook\'s text, and its Runbooks section shows it given and followed', async () => {
      // The preview gives at most two runbooks and a pin takes one slot, so the pin is lifted for the dispatch.
      await go(page, `/iq/projects/${PROJECT}?item=${ITEMS.related}&pane=brief&paneRecord=work-item:${ITEMS.related}`);
      await page.locator(`[data-testid="unpin-${PINNED_RUNBOOK}"]`).click();
      await page.locator(`[data-testid="offered-${LOGOUT_RUNBOOK}"]`).waitFor({ state: 'visible', timeout: 15000 });
      await shots(page, 'l5-preview-unpinned');
      const { ref, report } = await dispatch(ITEMS.related, 'related');
      check(report.runbooksOffered.some((o) => o.id === LOGOUT_RUNBOOK), 'the report does not record the logout runbook as given');
      await go(page, `${runUrl(ref)}?tab=brief`);
      const t = await waitText(page, /Clear the legacy shim cookie|shim cookie/i, 25000);
      check(/Roll back|Steps/.test(t), 'the runbook text is not whole in the brief');
      await shots(page, 'l5-run-brief');
      await tab(page, 'runbooks');
      const rb = await waitText(page, /Followed it/);
      check(/labels session/.test(rb), 'the reason it was given is not shown');
      await shots(page, 'l5-run-runbooks');
      return `${ref} was given ${LOGOUT_RUNBOOK} and followed it`;
    });

    // ── 6. The runbook's page lists the run, its health is proven, and the evidence line counts it ──
    await step('L6: the runbook\'s page lists the run that followed it, its health is proven, and the evidence line counts it', async () => {
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
      const e = (await getJson('/api/runbooks/evidence')).evidence;
      check(lineText.includes(`${e.runsGiven} of ${e.runs} runs were given a runbook`) && lineText.includes(`${e.runsSaidFollowed} of those ${e.runsGiven} said they followed one`),
        `the evidence line does not carry the API's counts (${e.runsGiven} of ${e.runs} given, ${e.runsSaidFollowed} followed): "${lineText.slice(0, 260)}"`);
      check(e.runsSaidFollowed >= 1, 'no run is counted as having followed a runbook');
      await shots(page, 'l6-library-evidence');
      return lineText.slice(0, 200);
    });

    // ── 7. The dashboard item: given nothing, and Learned says why there was no debrief ──
    await step('L7: the dashboard item: given nothing, and Learned says why there was no debrief, in the stored sentence', async () => {
      const { ref, report } = await dispatch(ITEMS.dashboard, 'dashboard');
      check(report.debrief?.state === 'skipped' && report.debrief.reasonText, `the dashboard debrief is ${JSON.stringify(report.debrief?.state)}`);
      await go(page, `${runUrl(ref)}?tab=runbooks`);
      await waitText(page, /This run was given no runbook/);
      await tab(page, 'learned');
      const t = await waitText(page, new RegExp(escapeRe(report.debrief.reasonText.slice(0, 30))));
      check(t.includes(report.debrief.reasonText), `the stored sentence is not printed verbatim: "${report.debrief.reasonText}"`);
      await shots(page, 'l7-run-learned-skipped');
      return report.debrief.reasonText;
    });

    // ── 8. The cold-start bug fails; dispatched again, its second run's brief shows the first attempt ──
    await step('L8: the cold-start bug twice: the second run shows the first attempt\'s outcome and obstacles under previous attempts', async () => {
      const first = await dispatch(ITEMS.cold, 'cold1');
      const second = await dispatch(ITEMS.cold, 'cold2');
      check(first.report.outcome === 'failed' && second.report.outcome === 'failed', 'both cold-start runs should have failed');
      check(first.report.failureCode === 'needs_gpu_pool' && second.report.failureCode === 'needs_gpu_pool',
        'the structured failure code must not include the error message');
      await go(page, `${runUrl(second.ref)}?tab=brief`);
      const t = await waitText(page, /Previous attempts/, 25000);
      check(t.includes(first.report.obstacles[0].slice(0, 40)), "the first attempt's obstacle is not in the second run's brief");
      check(/Failed/.test(t), "the first attempt's outcome is not in the second run's brief");
      check(t.includes('needs_gpu_pool') && !t.includes('needs_gpu_pool_'), "the previous attempt lost its structured failure code");
      await shots(page, 'l8-run-brief-previous-attempts');
      await tab(page, 'report');
      const rep = await waitText(page, new RegExp(escapeRe(second.report.summary.slice(0, 30))));
      check(/Failed/.test(rep), 'the failed outcome is not shown on the second run');
      return `${second.ref} lists ${first.ref} under previous attempts`;
    });

    // ── 11. The bell holds one item for the 80 percent crossing, and it opens the Budgets row with its mark ──
    await step('L11: Auth Migration crossed 80% of its allocation: one bell item for Vera, and it opens the Budgets row', async () => {
      check(after80?.threshold?.reached >= 80, `after the first dispatch ${NAME} read ${after80?.threshold?.percent}% (reached ${after80?.threshold?.reached})`);
      await go(page, '/iq/projects');
      const want = new RegExp(`^${NAME} has used 80%`);
      const { texts } = await bellItems(page, want);
      check(texts.length === 1, `the bell holds ${texts.length} item(s) for ${NAME} at 80%: ${JSON.stringify(texts)}`);
      await page.keyboard.press('Escape');
      const again = await bellItems(page, want, 5000);
      check(again.texts.length === 1, `after a wait the bell holds ${again.texts.length} item(s) for ${NAME} at 80%`);
      await again.panel.getByText(want).first().click();
      await page.waitForURL(new RegExp(`/admin/budgets\\?.*row=${PROJECT}`), { timeout: 15000 });
      const row = page.locator('[data-testid="budgets-initiatives-table"] [data-selected]');
      await row.first().waitFor({ state: 'visible', timeout: 15000 });
      check(await row.count() === 1, `${await row.count()} highlighted rows on Budgets`);
      const rowText = (await row.first().innerText()).replace(/\s+/g, ' ');
      check(rowText.includes(NAME), `the highlighted row is not ${NAME}: "${rowText.slice(0, 120)}"`);
      const mark = row.first().locator('[data-testid^="threshold-"]');
      check(await mark.count() >= 1, `the ${NAME} row shows no threshold mark: "${rowText.slice(0, 160)}"`);
      check(/80%|100%|%/.test(await mark.first().innerText()), `the mark reads "${await mark.first().innerText()}"`);
      for (const width of [1440, 1280, 390]) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        await sleep(500);
        await page.screenshot({ path: path.join(SHOTS, `l11-budgets-row-${width}.png`), fullPage: false });
      }
      await page.setViewportSize({ width: 1440, height: 900 });
      return `bell: ${texts[0]}`;
    });

    // ── 12. A proposal with a script cannot be accepted until the reviewer ticks that they read it ──
    await step('L12: a proposal with a script cannot be accepted until the reviewer ticks that they read it', async () => {
      const { current } = await getJson('/api/runbooks/rb-journey-walk');
      const SCRIPT = 'scripts/walk-plan.mjs';
      const files = current.files.map((f) => ({ path: f.path, mode: f.mode, content: f.path === SCRIPT ? `${f.content}\n// Also print the steps this walk has not reached yet.\n` : f.content }));
      await signIn(VERA);
      const filed = await api.post(`${PORTAL}/api/runbooks/proposals`, {
        headers: JSON_HEADERS,
        data: { kind: 'edit', runbook_id: 'rb-journey-walk', base_version: current.version, markdown: current.markdown, rationale: 'The plan script also prints the steps a walk has not reached yet.', files },
      });
      check(filed.status() === 201, `filing the proposal answered ${filed.status()}: ${(await filed.text()).slice(0, 300)}`);
      const proposal = (await filed.json()).proposal;
      await signIn(NORA);
      const refused = await api.post(`${PORTAL}/api/runbooks/proposals/${proposal.id}/accept`, { headers: JSON_HEADERS, data: { expected_version: current.version } });
      check(refused.status() === 409 && (await refused.json()).code === 'SCRIPTS_UNREAD', `accept without a tick answered ${refused.status()}`);
      await go(page, `/iq/runbooks/proposals/${proposal.id}`);
      await page.locator('[data-testid="proposal-accept"]').waitFor({ state: 'visible', timeout: 20000 });
      await page.locator('[data-testid="proposal-accept"]').click();
      const dialog = page.locator('[data-testid="accept-panel"]');
      await dialog.waitFor({ state: 'visible', timeout: 10000 });
      const confirm = dialog.locator('[data-testid="accept-confirm"]');
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

    // ── R1. A run that sent no report block says it did not report ──
    await step('R1: a run that sent no report block says it did not report', async () => {
      // Starting a run with no work item is a codebase administrator's action.
      await signIn({ userId: 'u-hr', role: 'hr-admin' });
      const list = (await getJson('/api/agent-projects')).projects ?? [];
      const project = list.find((p) => p.repoFullName === REPO);
      check(project, `no codebase for ${REPO}`);
      const sent = await api.post(`${PORTAL}/api/agent-projects/${project.id}/runs`, {
        headers: JSON_HEADERS, data: { prompt: 'Look around the repository and report back.', model: HAIKU },
      });
      await signIn(VERA);
      check(sent.status() === 202, `starting a run with no work item answered ${sent.status()}: ${(await sent.text()).slice(0, 200)}`);
      const ref = (await sent.json()).run.id;
      const report = await until(`the report of ${ref}`, async () => {
        const got = await api.get(`${PORTAL}/api/runs/${encodeURIComponent(ref)}/report`);
        return got.status() === 200 ? (await got.json()).report : null;
      }, 60000);
      check(report.selfReport === 'missing', `the silent run's selfReport is ${report.selfReport}`);
      runs.silent = { ref, report };
      await go(page, runUrl(ref));
      await waitText(page, /This run did not report\./);
      await shots(page, 'r1-run-did-not-report');
      return ref;
    });

    // ── R2. The Runs list: every run newest first; the filters narrow it; a dot marks the filed runbook ──
    await step('R2: the Runs list: every run newest first; filters narrow it; a dot marks the filed runbook', async () => {
      const all = (await getJson('/api/run-reports?limit=200')).reports;
      check(all.length >= dispatched + 1, `${all.length} reports stored after ${dispatched} dispatches and one silent run`);
      await go(page, '/iq/runs');
      const rows = page.getByTestId('run-row-link');
      await until('the rows', async () => await rows.count() > 0, 15000);
      const t = await bodyText(page);
      check(!INTERNAL.test(t), `internal words on the list: ${INTERNAL.exec(t)?.[0]}`);
      check(all[0].runRef === runs.silent.ref, 'the newest run is not first in the API');
      await shots(page, 'r2-runs-list');
      const count = async (q) => { await go(page, `/iq/runs${q}`); await sleep(1200); return page.getByTestId('run-row-link').count(); };
      const failed = all.filter((x) => x.outcome === 'failed').length;
      const filed = all.filter((x) => x.debrief?.state === 'filed').length;
      const auth = all.filter((x) => x.initiativeId === PROJECT).length;
      check(failed >= 2 && await count('?outcome=failed') === failed, `outcome=failed should list the ${failed} failed runs`);
      check(await count('?debrief=filed') === Math.min(filed, 50) && filed >= 5, `debrief=filed should list the ${filed} runs that filed a runbook`);
      check(await page.getByTestId('iq-runs-table').locator('[aria-label="Filed a runbook proposal"]').count() >= 1, 'no learned dot on a filed run');
      await shots(page, 'r2-runs-list-filed');
      check(await count(`?initiative=${PROJECT}`) === Math.min(auth, 50), `the ${NAME} filter should narrow to its ${auth} runs`);
      check(await count('?executor=fleet') === 0, 'executor=fleet (queue) should be empty');
      check(/No run matches these filters/.test(await bodyText(page)), 'an empty filter does not say so');
      check(await count('?debrief=skipped') >= 1, 'debrief=skipped should list the runs that skipped it');
      check(errors.length === 0, `page errors: ${errors.join(' | ')}`);
      return `${all.length} runs: ${failed} failed, ${filed} filed`;
    });

    // ── R3. The rails lead to the Runs list ──
    await step('R3: Automate and the initiative lead to the Runs list', async () => {
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
      await (await railEntry('Runs')).click();
      await page.waitForURL(/\/iq\/runs\?executor=fleet/, { timeout: 10000 });
      await go(page, `/iq/projects/${PROJECT}?tab=agents`);
      await page.getByTestId('initiative-runs-link').first().waitFor({ timeout: 15000 });
      await page.getByTestId('initiative-runs-link').first().click();
      await page.waitForURL(new RegExp(`/iq/runs\\?initiative=${PROJECT}`), { timeout: 10000 });
      // The old Local compute and Computer Lab URLs land on the one Computers page (lane E5), and the old
      // Local compute runs view lands on the Runs list filtered to your machines.
      await go(page, '/admin/devbox');
      await page.waitForURL(/\/iq\/computers/, { timeout: 10000 });
      await page.getByTestId('local-runs-link').first().waitFor({ timeout: 10000 });
      await go(page, '/iq/local-compute?view=runs');
      await page.waitForURL(/\/iq\/runs\?executor=local/, { timeout: 10000 });
    });
    // R4 is deliberately a browser fixture: the default mock has no microVM executor.
    // It covers the control, URL persistence and Demo data mark, not a cloud dispatch.
    await step('R4: MicroVM filter: labelled browser fixtures, selection, reload and clearing', async () => {
      await verifyMicrovmFilter(page, PORTAL, shots);
      return 'browser-only fixture; real microVM execution remains unverified';
    });
  } finally {
    await browser.close();
  }
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'learning-loop.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
  console.log(`learning-loop: ${results.filter((x) => x.ok).length}/${results.length} passed; screenshots in ${SHOTS}`);
  return results.every((x) => x.ok) ? 0 : 1;
}

process.exit(await main());

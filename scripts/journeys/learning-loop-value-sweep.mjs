#!/usr/bin/env node
// The value sweep's six surfaces (docs/next-steps.md, "Value sweep (11 November 2026)", items 1 to 6), walked in a
// browser on the default mock world with no model and no dispatch:
//   1 threads between records     2 proposal notices     3 New runbook     4 the initiative's Learning tab
//   5 "Passed over" on a work item     6 Recurring obstacles
// Items 7 to 14 are walked as well:
//   7 Retry on a failed queue job's run     8 the bot page's firings   9 restoring a retired runbook
//   10 searching runs, here and globally    11 who a proposal would reach   12 My work
//   13 Budgets grouped by bot, with entries 14 New initiative
// The mock is reset first, so every run starts from the seeds and the walk is repeatable (the New runbook step files
// proposals into the mock; the next reset drops them).
//
//   cd portal && npm run journey:value-sweep [-- --shots <dir> --out <dir>]
//
// Exit codes as learning-loop.mjs: 0 every step passed, 1 a step failed, 2 the stack is unreachable.
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
const OUT = flag('--out') ?? process.env.OUT_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'value-sweep-'));
const SHOTS = flag('--shots') ?? path.join(OUT, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

const VERA = { userId: 'u-vera', role: 'org-leader' };
const SIENNA = { userId: 'u-release', role: 'org-leader' };
const PROJECT = 'p-auth-migration';
const NAME = 'Auth Migration';
const RUN = 'sess-auth-03';
const ITEM = 'wi-auth-e1-b4';
const CSRF_RUNBOOK = 'rb-auth-pr-csrf-gate';
const PROPOSAL = 'prop-tenant-cutover-callback';
const NORA = { userId: 'u-nora', role: 'sme' };
const THEO = { userId: 'u-theo', role: 'member' };
const FAILED_JOB = 'job-inf-maint-4';
const BOT = '697c6a52-72e2-57f7-8e44-062ab9935336';
const BOT_JOB = 'job-auth-maint-1';
const RETIRED_RUNBOOK = 'rb-journey-walk';
const BELL = '[data-testid="activity-bell"]';
const GOOD_BODY = '## Use when\n\n- A test flips between runs on one commit.\n\n## Steps\n\n1. **Rerun it on the old commit**\n   ```sh\n   npm test -- --runInBand\n   ```\n   Expect the same failure to come back\n\n## Verify\n\n- The flake reproduces or the test passes ten times in a row\n';
const BAD_BODY = GOOD_BODY.replace('Rerun it on the old commit', 'Rerun it on the old commit (+3 more)');

class StepFailure extends Error {}
const check = (cond, msg) => { if (!cond) throw new StepFailure(msg); };
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function reachable() {
  for (const [name, url] of [['middleware', `${MIDDLEWARE}/api/health`], ['portal', `${PORTAL}/`]]) {
    try { const r = await fetch(url); if (r.status >= 500) throw new Error(`HTTP ${r.status}`); } catch (e) { return `${name} at ${url}: ${e.message}`; }
  }
  return null;
}

const bodyText = async (page) => (await page.locator('body').innerText()).replace(/\s+/g, ' ');
async function waitText(page, re, ms = 15000) {
  const end = Date.now() + ms;
  let t = '';
  while (Date.now() < end) { t = await bodyText(page); if (re.test(t)) return t; await sleep(400); }
  throw new StepFailure(`the page never showed ${re}: "${t.slice(0, 300)}"`);
}
async function go(page, p) {
  await page.goto(`${PORTAL}${p}`, { waitUntil: 'domcontentloaded', timeout: 40000 });
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => undefined);
}
async function shot(page, name) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await sleep(400);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false });
}
/** One screenshot at 1440 and one at 1280 for a new surface; the viewport goes back to 1440 afterwards. */
async function shotPair(page, name) {
  for (const width of [1440, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await sleep(500);
    await page.screenshot({ path: path.join(SHOTS, `${name}-${width}.png`), fullPage: false });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}
/** The page must not show a crash, a leaked JavaScript value or a sentence like "1 runs". */
async function noGarbage(page, label) {
  const t = await bodyText(page);
  check(!/\bundefined\b|\bNaN\b|\[object Object\]|\bnull\b/.test(t), `${label} shows a leaked value: ${/(.{20}(undefined|NaN|\[object Object\]|\bnull\b).{20})/.exec(t)?.[0]}`);
  check(!/\b1 (runs|firings|entries|proposals|work items|initiatives)\b/.test(t), `${label} has a plural error: ${/\b1 (runs|firings|entries|proposals|work items|initiatives)\b/.exec(t)?.[0]}`);
  check(!/something went wrong|unexpected error/i.test(t), `${label} shows an error boundary`);
}
/** No table (or the page itself) may run past its box at 1440 or 1280 wide. */
async function noOverflow(page, label) {
  for (const width of [1440, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await sleep(400);
    const bad = await page.evaluate(() => {
      const out = [];
      if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 1) out.push('page');
      for (const el of document.querySelectorAll('table')) {
        const box = el.closest('[class*="overflow"]') ?? el.parentElement;
        if (box && el.scrollWidth > box.clientWidth + 1 && getComputedStyle(box).overflowX === 'visible') out.push(`table ${el.closest('[data-testid]')?.getAttribute('data-testid') ?? ''}`);
      }
      return out;
    });
    check(bad.length === 0, `${label} overflows at ${width}: ${bad.join(', ')}`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}
const landed = (page, re, ms = 10000) => page.waitForURL((u) => re.test(u.pathname + u.search), { timeout: ms }).catch(() => { throw new StepFailure(`expected a URL matching ${re}, at ${page.url()}`); });

async function bellItems(page, re, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await page.locator(BELL).first().click();
    const panel = page.locator('[role="dialog"]').last();
    await panel.waitFor({ state: 'visible', timeout: 5000 }).catch(() => undefined);
    const all = panel.getByRole('tab', { name: /^All/ });
    if (await all.count()) await all.first().click().catch(() => undefined);
    const lines = (await panel.innerText().catch(() => '')).split('\n').filter((l) => re.test(l));
    if (lines.length > 0) return { panel, lines };
    await page.keyboard.press('Escape');
    await sleep(1000);
  }
  return { panel: null, lines: [] };
}

async function main() {
  const down = await reachable();
  if (down) { console.error(`value-sweep: unreachable: ${down}`); return 2; }
  const r = await fetch(`${MIDDLEWARE}/api/__mock/reset`, { method: 'POST' });
  if (r.status !== 200) { console.error(`value-sweep: POST /api/__mock/reset answered ${r.status}`); return 2; }

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const api = ctx.request;
  const results = [];
  const errors = [];
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));

  const signIn = async (who) => {
    const login = await api.post(`${PORTAL}/api/session/login`, { data: { userId: who.userId } });
    check(login.status() === 200, `login ${who.userId}: ${login.status()}`);
    const role = await api.post(`${PORTAL}/api/session/role`, { data: { tenant: 'orgiq', role: who.role } });
    check(role.status() === 200, `role ${who.role}: ${role.status()}`);
  };
  const getJson = async (url) => { const res = await api.get(`${PORTAL}${url}`); check(res.status() === 200, `GET ${url} answered ${res.status()}`); return res.json(); };
  const workTitle = async (id) => {
    const board = await getJson('/api/graph/work?limit=200');
    const title = (Array.isArray(board) ? board : []).find((w) => w.id === id)?.title;
    check(title, `the work board holds no title for ${id}`);
    return title;
  };
  const step = async (name, fn) => {
    const started = Date.now();
    try {
      const detail = await fn();
      check(errors.length === 0, `page errors: ${errors.join(' | ')}`);
      results.push({ step: name, ok: true, ms: Date.now() - started, detail });
      console.log(`PASS ${name}${detail ? `\n  ${detail}` : ''}`);
    } catch (e) {
      await page.screenshot({ path: path.join(SHOTS, `failure-${results.length}.png`) }).catch(() => undefined);
      results.push({ step: name, ok: false, ms: Date.now() - started, error: e.message });
      console.log(`FAIL ${name}\n  ${e.message}`);
      if (!(e instanceof StepFailure)) console.log(e.stack);
      errors.length = 0;
    }
  };

  try {
    await signIn(VERA);

    // ── 1. Threads between records ──
    await step('1: the run page links to its initiative, work item and the item\'s other runs', async () => {
      const run = (await getJson(`/api/runs/${RUN}/report`)).report;
      check(run.workItemId === ITEM, `${RUN} belongs to ${run.workItemId}`);
      await go(page, `/iq/runs/${RUN}`);
      await page.getByTestId('run-initiative-link').waitFor({ timeout: 15000 });
      const links = await page.getByTestId('run-links').innerText();
      check(links.includes(NAME), `the initiative link does not name ${NAME}: ${links}`);
      await shot(page, '1-run-page');
      await page.getByTestId('run-initiative-link').click();
      await landed(page, new RegExp(`^/iq/projects/${PROJECT}`));
      await go(page, `/iq/runs/${RUN}`);
      await page.getByTestId('run-work-item-link').click();
      await landed(page, new RegExp(`^/iq/projects/${PROJECT}\\?.*item=${ITEM}`));
      await go(page, `/iq/runs/${RUN}`);
      await page.getByTestId('run-item-runs-link').click();
      await landed(page, new RegExp(`^/iq/runs\\?.*workItem=${ITEM}`));
      const title = await workTitle(ITEM);
      const t = await waitText(page, new RegExp(escapeRe(title)));
      const expected = (await getJson(`/api/run-reports?workItem=${ITEM}&limit=50`)).reports.length;
      check(expected >= 1, 'the API holds no run for the work item');
      await page.getByTestId('run-row-link').first().waitFor({ timeout: 15000 });
      check(await page.getByTestId('run-row-link').count() === expected, `the filtered list should hold ${expected} run(s)`);
      check(!t.includes(ITEM), 'the work-item filter shows the bare id');
      return `${expected} run(s) of ${ITEM}`;
    });
    await step('1: the work item\'s Previous attempts open their run, and All runs opens Runs filtered by the item', async () => {
      await go(page, `/iq/projects/${PROJECT}?tab=work&item=${ITEM}`);
      await page.getByRole('button', { name: /Open brief preview in side pane/ }).click();
      await page.getByTestId('previous-attempts').waitFor({ timeout: 15000 });
      const link = page.getByTestId('previous-attempt-run').first();
      await link.waitFor({ timeout: 10000 });
      await link.click();
      await landed(page, new RegExp(`^/iq/runs/(job%3A|job:)?${RUN}`));
      await go(page, `/iq/projects/${PROJECT}?tab=work&item=${ITEM}`);
      await page.getByRole('button', { name: /Open brief preview in side pane/ }).click();
      await page.getByTestId('all-runs-of-item').click();
      await landed(page, new RegExp(`^/iq/runs\\?.*workItem=${ITEM}`));
      await page.getByTestId('run-row-link').first().waitFor({ timeout: 15000 });
      await waitText(page, new RegExp(escapeRe(await workTitle(ITEM))));
    });
    await step('1: a runbook\'s "Runs given this runbook" opens Runs filtered by that runbook', async () => {
      await go(page, `/iq/runbooks/${CSRF_RUNBOOK}`);
      await page.getByTestId('runbook-runs-link').click();
      await landed(page, new RegExp(`^/iq/runs\\?.*runbook=${CSRF_RUNBOOK}`));
      const expected = (await getJson(`/api/run-reports?runbook=${CSRF_RUNBOOK}&limit=50`)).reports.length;
      check(expected >= 1, 'no run was given the runbook');
      await page.getByTestId('run-row-link').first().waitFor({ timeout: 15000 });
      check(await page.getByTestId('run-row-link').count() === expected, `the list should hold ${expected} run(s)`);
      const t = await waitText(page, /Runbook/);
      check(!t.includes(CSRF_RUNBOOK), `the runbook filter shows the bare id ${CSRF_RUNBOOK}`);
      return `${expected} run(s)`;
    });

    // ── 2. Proposal notices ──
    await step('2: the reviewer\'s bell holds the waiting-for-review notice and it opens the proposal; the rail counts it', async () => {
      await signIn(SIENNA);
      await go(page, '/iq/projects');
      const expected = (await getJson('/api/runbooks/proposals/review-count')).count;
      check(expected >= 1, `review-count is ${expected}`);
      const work = await getJson('/api/work/summary');
      const total = (work.jobs?.awaiting_review ?? 0) + (work.proposals?.pending ?? 0) + expected;
      // The Initiatives entry of the primary rail carries the needs-you count after its label.
      const rail = page.locator('a, button, [role="link"]').filter({ hasText: /^Initiatives\s*\d+$/ }).first();
      await rail.waitFor({ timeout: 15000 });
      const shown = Number((await rail.innerText()).replace(/\D/g, ''));
      check(shown === total, `the rail shows ${shown}, expected ${total} (review-count ${expected})`);
      const { panel, lines } = await bellItems(page, /waiting for review/i);
      check(panel && lines.length > 0, 'the bell holds no "waiting for review" notice');
      await shot(page, '2-bell');
      await panel.getByText(/waiting for review/i).first().click();
      await landed(page, new RegExp(`^/iq/runbooks/proposals/${PROPOSAL}`));
      return `${lines[0]}; rail ${shown}`;
    });

    // ── 3. New runbook ──
    await step('3: Library "New runbook": fill, file, land on the proposal page; a body that fails lint shows the server\'s lint inline', async () => {
      await signIn(VERA);
      const fill = async (body) => {
        await go(page, '/iq/runbooks');
        await page.getByTestId('new-runbook-open-form').click();
        await page.getByTestId('new-runbook').waitFor({ timeout: 10000 });
        await page.getByTestId('new-runbook-name').fill('Rerun a flaky test with its own diff');
        await page.getByTestId('new-runbook-description').fill('Rerun a flaky test with the diff that introduced it applied, so you can tell a flake from a regression.');
        const scope = page.getByTestId('new-runbook-scope-ref');
        if ((await scope.evaluate((e) => e.tagName)) === 'SELECT') await scope.selectOption({ label: NAME });
        else { await scope.click(); await page.getByRole('option', { name: NAME, exact: true }).click(); }
        await page.getByTestId('suggest-markdown').fill(body);
        await page.getByTestId('suggest-rationale').fill('Every flaky-test report starts this way and nobody has written it down.');
      };
      await fill(GOOD_BODY);
      await shot(page, '3-new-runbook-form');
      await page.getByTestId('new-runbook-submit').click();
      await landed(page, /^\/iq\/runbooks\/proposals\/[^/]+$/);
      await waitText(page, /Rerun a flaky test with its own diff/);

      await fill(BAD_BODY);
      const filing = page.waitForResponse((x) => x.url().endsWith('/api/runbooks/proposals') && x.request().method() === 'POST');
      await page.getByTestId('new-runbook-submit').click();
      const res = await filing;
      const sent = await res.json();
      const messages = (sent.proposal?.lint ?? []).filter((f) => f.severity === 'error').map((f) => f.message);
      check(messages.length > 0, `the server found no lint error (status ${res.status()})`);
      const filed = page.getByTestId('new-runbook-filed');
      await filed.waitFor({ timeout: 10000 });
      const shown = await filed.innerText();
      for (const m of messages) check(shown.includes(m), `the lint message is not shown inline: "${m}" in "${shown.slice(0, 200)}"`);
      return `${messages.length} lint message(s) shown`;
    });

    // ── 4. The initiative's Learning tab ──
    await step('4: Learning tab: three tables with rows; a run row opens the run', async () => {
      await go(page, `/iq/projects/${PROJECT}?tab=learning`);
      await page.getByTestId('initiative-learning').waitFor({ timeout: 15000 });
      for (const id of ['runs', 'runbooks', 'proposals']) {
        const rows = page.getByTestId(`learning-${id}-table`).locator('tbody tr');
        await rows.first().waitFor({ timeout: 15000 });
        check(await rows.count() >= 1, `the ${id} table is empty`);
      }
      const t = await bodyText(page);
      check(!/\bsess-auth-\d+\b/.test(t) && !/\bwi-auth-e\d-\w+\b/.test(t), `a bare run or work item id on the Learning tab: ${/(sess-auth-\d+|wi-auth-e\d-\w+)/.exec(t)?.[0]}`);
      await noOverflow(page, 'the Learning tab');
      await shot(page, '4-learning-tab');
      await page.getByTestId('learning-runs-table').getByTestId('run-row-link').first().click();
      await landed(page, /^\/iq\/runs\/[^/]+$/);
    });
    await step('4: the overview\'s Needs attention shows the failed-runs line and it opens the Learning tab', async () => {
      await go(page, `/iq/projects/${PROJECT}`);
      const row = page.getByTestId('overview-learning-attention').getByText(/failed in the last seven days/);
      await row.waitFor({ timeout: 15000 });
      await row.click();
      await landed(page, new RegExp(`^/iq/projects/${PROJECT}\\?.*tab=learning`));
      await page.getByTestId('initiative-learning').waitFor({ timeout: 15000 });
    });
    await step('4: the Agents tab\'s runs show an outcome', async () => {
      await go(page, `/iq/projects/${PROJECT}?tab=agents`);
      await page.getByTestId('initiative-agents').waitFor({ timeout: 15000 });
      const chips = page.getByTestId('agents-run-report');
      await chips.first().waitFor({ timeout: 15000 });
      const text = (await chips.first().innerText()).trim();
      check(text.length > 0, 'the outcome chip is empty');
      await chips.first().click();
      await landed(page, /^\/iq\/runs\/[^/]+$/);
      return text;
    });

    // ── 5. Passed over ──
    await step('5: the work item panel lists a passed-over runbook with a reason sentence', async () => {
      const preview = await getJson(`/api/work-items/${ITEM}/brief-preview`);
      check(preview.passed_over.length >= 1, `${ITEM} has no passed-over runbook in the seeds`);
      await go(page, `/iq/projects/${PROJECT}?tab=work&item=${ITEM}`);
      await page.getByRole('button', { name: /Open brief preview in side pane/ }).click();
      const section = page.getByTestId('passed-over-runbooks');
      await section.waitFor({ timeout: 15000 });
      const first = preview.passed_over[0];
      const entry = page.getByTestId(`passed-over-${first.id}`);
      const text = await entry.innerText();
      check(text.includes(first.reason) && /[.]$/.test(first.reason.trim()), `no reason sentence under the passed-over runbook: ${text}`);
      check(!text.includes(first.id), `the raw runbook id ${first.id} is shown`);
      await noOverflow(page, 'the work item panel');
      await shot(page, '5-passed-over');
      return `${preview.passed_over.length} passed over; first: ${first.reason}`;
    });

    // ── 6. Recurring obstacles ──
    await step('6: Recurring obstacles: the CSRF row shows 4 runs; a run link opens the run; "Write a runbook for this" fills the form', async () => {
      await go(page, '/iq/runbooks/obstacles');
      await page.getByTestId('runbooks-obstacles').waitFor({ timeout: 15000 });
      const row = page.locator('tbody tr').filter({ hasText: /CSRF check failed/ }).first();
      await row.waitFor({ timeout: 15000 });
      const cells = (await row.locator('td').allInnerTexts()).map((c) => c.trim());
      check(cells.includes('4'), `the CSRF row does not show 4 runs: ${cells.join(' | ')}`);
      await noOverflow(page, 'the obstacles table');
      await shot(page, '6-recurring-obstacles');
      await row.getByTestId('obstacle-run-link').first().click();
      await landed(page, /^\/iq\/runs\/(job%3A|job:)?sess-auth-\d+/);
      await go(page, '/iq/runbooks/obstacles');
      const again = page.locator('tbody tr').filter({ hasText: /CSRF check failed/ }).first();
      await again.getByTestId('obstacle-write-runbook').click();
      await landed(page, /^\/iq\/runbooks\?.*new=1/);
      await page.getByTestId('new-runbook').waitFor({ timeout: 10000 });
      const description = await page.getByTestId('new-runbook-description').inputValue();
      check(/CSRF check failed/.test(description), `the description is not filled from the obstacle: "${description}"`);
      const scope = page.getByTestId('new-runbook-scope-ref');
      const value = /^(SELECT|INPUT)$/.test(await scope.evaluate((e) => e.tagName)) ? await scope.inputValue() : await scope.innerText();
      check(/orgiq-auth-service/.test(value), `the scope is not filled: "${value}"`);
      return description.slice(0, 60);
    });

    // ── 7. Retry a failed queue job from its run page ──
    await step('7: a failed queue job\'s run page offers Retry to a persona holding the capability; the retry links to the new attempt; others see none', async () => {
      await signIn(NORA);
      const failed = (await getJson(`/api/runs/${encodeURIComponent(`job:${FAILED_JOB}`)}`)).run;
      check(failed.status === 'failed' && failed.context.table === 'agent_jobs', `${FAILED_JOB} is ${failed.status} in ${failed.context.table}`);
      await go(page, `/iq/runs/${encodeURIComponent(`job:${FAILED_JOB}`)}`);
      const retry = page.getByTestId('run-retry');
      await retry.waitFor({ timeout: 15000 });
      await noGarbage(page, 'the failed run page');
      await shotPair(page, '7-failed-run-retry');
      await retry.click();
      const banner = page.getByTestId('run-retried');
      await banner.waitFor({ timeout: 15000 });
      check(/new attempt is queued/i.test(await banner.innerText()), `the banner does not report a new attempt: ${await banner.innerText()}`);
      await page.getByTestId('run-retried-link').click();
      await landed(page, /^\/iq\/runs\/job-[0-9a-f-]+/);
      await page.getByTestId('run-page').waitFor({ timeout: 15000 });
      // A done queue job has nothing to retry; a persona without the capability sees no button on the failed one.
      await go(page, `/iq/runs/${encodeURIComponent('job:job-auth-maint-1')}`);
      await page.getByTestId('run-page').waitFor({ timeout: 15000 });
      await sleep(1500);
      check(await page.getByTestId('run-retry').count() === 0, 'a completed job shows Retry');
      await signIn(VERA);
      await go(page, `/iq/runs/${encodeURIComponent(`job:${FAILED_JOB}`)}`);
      await page.getByTestId('run-page').waitFor({ timeout: 15000 });
      await sleep(1500);
      check(await page.getByTestId('run-retry').count() === 0, 'a persona without ManageDevbox sees Retry');
      return `${FAILED_JOB} retried as sme; org-leader sees no Retry`;
    });

    // ── 8. The bot page ──
    await step('8: the bot page: a firing with a report shows its outcome and opens the run; the thirty-day line; "Spend by bot" opens Budgets by bot', async () => {
      await signIn(VERA);
      const reports = (await getJson(`/api/run-reports?runRefs=${BOT_JOB}`)).reports;
      check(reports.length === 1, `${BOT_JOB} has ${reports.length} reports`);
      await go(page, `/admin/bots/${BOT}`);
      const chip = page.getByTestId('bot-run-report').first();
      await chip.waitFor({ timeout: 20000 });
      const outcome = (await chip.innerText()).trim();
      check(outcome.length > 0, 'the outcome chip is empty');
      const line = await page.getByTestId('bot-run-summary').innerText();
      check(/Last 30 days: \d+ firings?/.test(line) && /\d+ with a report/.test(line) && /Billed (\$|unknown|—)/.test(line), `the thirty-day line reads "${line}"`);
      await noGarbage(page, 'the bot page');
      await noOverflow(page, 'the bot page');
      await shotPair(page, '8-bot-page');
      await chip.click();
      await landed(page, new RegExp(`^/iq/runs/(job%3A|job:)?${BOT_JOB}`));
      await go(page, `/admin/bots/${BOT}`);
      await page.getByTestId('bot-run-spend-report').waitFor({ timeout: 20000 });
      await page.getByTestId('bot-run-spend-report').click();
      await landed(page, /^\/admin\/budgets\?.*group=bot/);
      await page.getByTestId('spend-group-table').waitFor({ timeout: 20000 });
      // A persona who may not see Budgets is not offered the link.
      await signIn(NORA);
      await go(page, `/admin/bots/${BOT}`);
      await page.getByTestId('bot-run-summary').waitFor({ timeout: 20000 });
      check(await page.getByTestId('bot-run-spend-report').count() === 0, 'an sme is offered the Spend by bot link');
      return `${outcome}; ${line.slice(0, 90)}`;
    });

    // ── 9. Restore a retired runbook ──
    await step('9: retire a runbook, propose restoring it with a reason, the proposer cannot accept it, another reviewer does, and the record shows the restore', async () => {
      await signIn(VERA);
      const retire = await api.post(`${PORTAL}/api/runbooks/${RETIRED_RUNBOOK}/retire`, { data: { reason: 'Replaced by the journey runner.' } });
      check(retire.status() === 200, `retiring ${RETIRED_RUNBOOK}: ${retire.status()}`);
      await signIn(NORA);
      await go(page, `/iq/runbooks/${RETIRED_RUNBOOK}`);
      await page.getByTestId('runbook-retired').waitFor({ timeout: 15000 });
      await page.getByTestId('restore-open').click();
      await page.getByTestId('restore-form').waitFor({ timeout: 5000 });
      await shotPair(page, '9-restore-form');
      await page.getByTestId('restore-form').getByRole('textbox').fill('The journey runner is retired and we walk journeys by hand again next quarter.');
      await page.getByTestId('restore-submit').click();
      await page.getByTestId('restore-filed').waitFor({ timeout: 15000 });
      await page.getByTestId('restore-filed').getByRole('button', { name: /Open the proposal/ }).click();
      await landed(page, /^\/iq\/runbooks\/proposals\/[^/]+$/);
      const proposalPath = new URL(page.url()).pathname;
      await page.getByTestId('proposal-review').waitFor({ timeout: 15000 });
      await sleep(1500);
      check(await page.getByTestId('proposal-accept').count() === 0, 'the proposer is offered Accept on their own restore');
      await noGarbage(page, 'the restore proposal');
      await shotPair(page, '9-restore-proposal-review');
      const own = await api.post(`${PORTAL}/api/runbooks/proposals/${proposalPath.split('/').pop()}/accept`, { data: {} });
      check(own.status() === 403 || own.status() === 409, `the proposer's own accept answered ${own.status()}`);
      await signIn(VERA);
      await go(page, proposalPath);
      await page.getByTestId('proposal-accept').waitFor({ timeout: 15000 });
      await page.getByTestId('proposal-accept').click();
      await page.getByTestId('accept-confirm').click();
      await waitText(page, /Accepted/);
      await go(page, `/iq/runbooks/${RETIRED_RUNBOOK}`);
      const restored = page.getByTestId('runbook-restored');
      await restored.waitFor({ timeout: 15000 });
      check(await page.getByTestId('runbook-retired').count() === 0, 'the runbook still shows as retired');
      const t = await restored.innerText();
      check(/journey runner is retired/.test(t) && /Vera/.test(t), `the restore line reads "${t}"`);
      const rb = (await getJson(`/api/runbooks/${RETIRED_RUNBOOK}`)).runbook;
      check(rb.status === 'published', `the runbook is ${rb.status}`);
      return t;
    });

    // ── 10. Search runs ──
    await step('10: Runs search narrows on the server (q= in the URL); global search finds runs and opens one; a persona who cannot list runs gets none', async () => {
      await signIn(VERA);
      await go(page, '/iq/runs');
      await page.getByTestId('run-row-link').first().waitFor({ timeout: 15000 });
      const before = await page.getByTestId('run-row-link').count();
      const asked = page.waitForResponse((x) => /\/api\/run-reports\?.*q=CSRF/.test(x.url()), { timeout: 15000 });
      asked.catch(() => undefined);
      const box = page.getByPlaceholder(/Search run summaries/).first();
      if (!(await box.isVisible())) await page.getByRole('main').getByRole('button', { name: /search/i }).first().click();
      await box.fill('CSRF');
      await asked;
      await landed(page, /^\/iq\/runs\?.*q=CSRF/);
      const expected = (await getJson('/api/run-reports?q=CSRF&limit=50')).reports.length;
      check(expected >= 1 && expected < before, `CSRF matches ${expected} of ${before} runs`);
      const end = Date.now() + 10000;
      while (Date.now() < end && await page.getByTestId('run-row-link').count() !== expected) await sleep(300);
      check(await page.getByTestId('run-row-link').count() === expected, `the list should hold ${expected} run(s)`);
      await noGarbage(page, 'the Runs search');
      await shotPair(page, '10-runs-search');
      const more = page.getByTestId('iq-runs-load-more');
      let paged = 'one page only';
      if (await more.count()) { await more.click(); paged = 'older runs loaded'; }
      // Global search.
      await go(page, '/iq/search?q=CSRF');
      await waitText(page, /CSRF/);
      const found = (await getJson('/api/search?q=CSRF&limit=50')).results.filter((r) => r.type === 'run');
      check(found.length >= 1, 'global search holds no run for CSRF');
      const hit = page.getByTestId('search-results').getByText(new RegExp(escapeRe(found[0].title))).first();
      await hit.waitFor({ timeout: 20000 });
      await shotPair(page, '10-global-search-runs');
      await hit.click();
      await landed(page, /^\/iq\/runs\/[^/]+/, 15000);
      await page.getByTestId('run-page').waitFor({ timeout: 15000 });
      // A persona who cannot list runs.
      await signIn(THEO);
      const none = (await getJson('/api/search?q=CSRF&limit=50')).results.filter((r) => r.type === 'run');
      check(none.length === 0, `a member got ${none.length} run result(s)`);
      await go(page, '/iq/search?q=CSRF');
      await waitText(page, /CSRF/);
      await sleep(1500);
      check(!(await bodyText(page)).includes(found[0].title), 'a member sees a run title in global search');
      return `${expected} of ${before} runs match; ${found.length} in global search; ${paged}`;
    });

    // ── 11. Who a proposal would reach ──
    await step('11: the open proposal\'s review page lists "Would be given to" with a work item that opens', async () => {
      await signIn(SIENNA);
      const reach = (await getJson(`/api/runbooks/proposals/${PROPOSAL}`)).reach;
      check(reach && reach.items.length >= 1, 'the proposal read carries no reach');
      await go(page, `/iq/runbooks/proposals/${PROPOSAL}`);
      const table = page.getByTestId('proposal-reach-table');
      await table.waitFor({ timeout: 15000 });
      check(await page.getByText(/Would be given to/).count() >= 1, 'no "Would be given to" heading');
      const rows = table.locator('tbody tr');
      check(await rows.count() >= 1, 'the reach table is empty');
      const t = await bodyText(page);
      check(!reach.items.some((i) => t.includes(i.id)), 'the reach table shows a bare work item id');
      await noOverflow(page, 'the proposal reach');
      for (const width of [1440, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        await sleep(500);
        const clipped = await page.evaluate(() => {
          const section = document.querySelector('[data-testid="proposal-section-reach"]');
          const edge = section ? section.getBoundingClientRect().right : 0;
          return [...document.querySelectorAll('[data-testid="proposal-reach-table"] th, [data-testid="proposal-reach-table"] td')]
            .filter((c) => c.getBoundingClientRect().right > edge + 1).map((c) => (c.textContent ?? '').trim().slice(0, 30));
        });
        check(clipped.length === 0, `the reach table runs past its section at ${width}: ${clipped.join(' | ')}`);
      }
      await page.setViewportSize({ width: 1440, height: 900 });
      await noGarbage(page, 'the proposal review');
      await page.getByTestId('proposal-section-reach').scrollIntoViewIfNeeded();
      await sleep(400);
      await shotPair(page, '11-proposal-reach');
      await page.getByTestId('reach-work-item').first().click();
      await landed(page, /^\/iq\/projects\/[^/?]+\?.*item=wi-/);
      return `${reach.items.length} work item(s)`;
    });

    // ── 12. My work ──
    await step('12: My work as the SME: rows across more than one initiative, the filter narrows, a row opens the work item, the rail entry sits between Initiatives and Decisions', async () => {
      await signIn(NORA);
      const mine = await getJson('/api/graph/work?assignee=me&status=in_progress,in_review,open&limit=200');
      const initiativeOf = (w) => w.projectId ?? w.initiativeId ?? w.project_id;
      check(new Set(mine.map(initiativeOf)).size >= 2, 'the SME has open work in one initiative only');
      await go(page, '/iq/my-work');
      const rows = page.getByTestId('iq-my-work-table').locator('tbody tr');
      await rows.first().waitFor({ timeout: 15000 });
      const all = await rows.count();
      check(all === mine.length, `the table holds ${all} rows, the API ${mine.length}`);
      const names = new Set((await page.getByTestId('my-work-initiative').allInnerTexts()).map((x) => x.trim()));
      check(names.size >= 2, `rows span ${names.size} initiative(s)`);
      const t = await bodyText(page);
      check(!/\bwi-[a-z0-9-]+\b/.test(t) && !/\bp-[a-z]+-[a-z]+\b/.test(t), `a raw id on My work: ${/(wi-[a-z0-9-]+|p-[a-z]+-[a-z]+)/.exec(t)?.[0]}`);
      await noGarbage(page, 'My work');
      await noOverflow(page, 'My work');
      await shotPair(page, '12-my-work');
      // The rail: Initiatives, My work, Decisions in that order.
      const labels = await page.evaluate(() => [...document.querySelectorAll('nav a, nav button, aside a, aside button, [role="navigation"] a')].map((e) => (e.textContent ?? '').trim().replace(/\s*\d+$/, '')).filter(Boolean));
      const at = (l) => labels.findIndex((x) => x === l);
      check(at('Initiatives') >= 0 && at('My work') > at('Initiatives') && at('Decisions') > at('My work') && at('Decisions') - at('Initiatives') === 2, `the rail reads ${labels.slice(0, 14).join(' | ')}`);
      // The filter row narrows the list.
      await go(page, '/iq/my-work?initiative=p-auth-migration');
      await rows.first().waitFor({ timeout: 15000 });
      await sleep(600);
      const narrowed = await rows.count();
      const expected = mine.filter((w) => initiativeOf(w) === 'p-auth-migration').length;
      check(narrowed === expected && narrowed < all, `the initiative filter left ${narrowed} of ${all} (expected ${expected})`);
      await rows.first().locator('td').nth(1).click();
      await landed(page, /^\/iq\/projects\/p-auth-migration\?.*item=wi-/);
      return `${all} rows across ${names.size} initiatives; filter leaves ${narrowed}`;
    });

    // ── 13. Budgets grouped by bot ──
    await step('13: Budgets by bot: the total equals the initiative grouping\'s; a group opens its entries; a bot run entry opens its run; an unknown cost reads "unknown"', async () => {
      await signIn(VERA);
      const initiative = (await getJson('/api/spend/report?groupBy=initiative&period=30d')).totals;
      const bot = (await getJson('/api/spend/report?groupBy=bot&period=30d')).totals;
      check(Math.abs(initiative.knownUsd - bot.knownUsd) < 0.00005 && initiative.entries === bot.entries && initiative.unknownCount === bot.unknownCount,
        `initiative ${JSON.stringify(initiative)} vs bot ${JSON.stringify(bot)}`);
      await go(page, '/admin/budgets?group=bot&period=30d');
      const table = page.getByTestId('spend-group-table');
      await table.waitFor({ timeout: 20000 });
      const shown = await bodyText(page);
      check(shown.includes(bot.knownUsd.toFixed(2)), `the page does not show the total ${bot.knownUsd.toFixed(2)}`);
      await noGarbage(page, 'Budgets by bot');
      const bots = (await getJson('/api/bots')).bots ?? (await getJson('/api/bots'));
      const authBot = bots.find((b) => b.id === BOT);
      const row = table.locator('tbody tr').filter({ hasText: new RegExp(escapeRe(authBot.name)) }).first();
      await row.waitFor({ timeout: 10000 });
      await row.locator('td').nth(1).click();
      const entries = page.getByTestId('spend-entries-table');
      await entries.waitFor({ timeout: 15000 });
      check(await entries.locator('tbody tr').count() >= 1, 'the open group lists no entries');
      await noOverflow(page, 'Budgets by bot');
      await shotPair(page, '13-budgets-by-bot-entries');
      const listed = await getJson(`/api/spend/entries?groupBy=bot&period=30d&key=${BOT}&limit=200`);
      const unknown = listed.entries.filter((e) => e.costUsd == null);
      const eText = await entries.innerText();
      if (unknown.length > 0) check(/unknown/.test(eText) && !/\$0\.0+(\s|$)/.test(eText), 'an unknown cost does not read "unknown"');
      await entries.getByTestId('spend-entry-run').first().click();
      await landed(page, /^\/iq\/runs\/(job%3A|job:)?job-/);
      return `total ${bot.knownUsd.toFixed(2)} over ${bot.entries} entries; ${unknown.length ? `${unknown.length} unknown cost(s) read unknown` : 'the default world holds no unknown-cost entry to read'}`;
    });

    // ── 14. Create an initiative ──
    await step('14: New initiative: filled in as an org leader it opens an empty initiative whose tabs all render; a duplicate name in another case is refused inline; a member is not offered it', async () => {
      await signIn(VERA);
      await go(page, '/iq/projects');
      await page.getByTestId('new-initiative').waitFor({ timeout: 20000 });
      await page.getByTestId('new-initiative').click();
      await page.getByTestId('new-initiative-form').waitFor({ timeout: 10000 });
      await page.getByTestId('new-initiative-name').fill('Vendor Portal Rollout');
      await page.getByTestId('new-initiative-summary').fill('Move the vendor-facing portal onto the shared identity service and retire the old sign-in.');
      await shotPair(page, '14-new-initiative-form');
      await page.getByTestId('new-initiative-submit').click();
      await landed(page, /^\/iq\/projects\/(?!p-auth)[^/?]+/);
      const id = decodeURIComponent(new URL(page.url()).pathname.split('/').pop());
      await waitText(page, /Vendor Portal Rollout/);
      await sleep(1500);
      await shotPair(page, '14-new-initiative-overview');
      const tabs = ['overview', 'work', 'docs', 'decisions', 'agents', 'learning', 'contributors', 'activity'];
      for (const tab of tabs) {
        await go(page, `/iq/projects/${encodeURIComponent(id)}?tab=${tab}`);
        await waitText(page, /Vendor Portal Rollout/);
        await sleep(1200);
        await noGarbage(page, `the new initiative's ${tab} tab`);
        check((await bodyText(page)).trim().length > 80, `the ${tab} tab renders nothing`);
      }
      // A duplicate name in another letter case.
      await go(page, '/iq/projects');
      await page.getByTestId('new-initiative').click();
      await page.getByTestId('new-initiative-name').fill('VENDOR PORTAL ROLLOUT');
      await page.getByTestId('new-initiative-submit').click();
      const link = page.getByTestId('new-initiative-existing');
      await link.waitFor({ timeout: 10000 });
      check(/already|exists|same name|taken/i.test(await bodyText(page)), 'the refusal does not say the name is taken');
      await link.click();
      await landed(page, new RegExp(`^/iq/projects/${escapeRe(encodeURIComponent(id))}`));
      // A member is not offered the action.
      await signIn(THEO);
      await go(page, '/iq/projects');
      await page.getByTestId('initiatives-page').waitFor({ timeout: 20000 });
      await sleep(1500);
      check(await page.getByTestId('new-initiative').count() === 0, 'a member is offered New initiative');
      return `created ${id}; ${tabs.length} tabs render`;
    });
  } finally {
    await browser.close();
  }
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'learning-loop-value-sweep.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
  const fails = results.filter((x) => !x.ok).length;
  console.log(`value-sweep: ${results.length - fails}/${results.length} passed; fails=${fails}; screenshots in ${SHOTS}`);
  return fails === 0 ? 0 : 1;
}

process.exit(await main());

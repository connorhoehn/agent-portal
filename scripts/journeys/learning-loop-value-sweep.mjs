#!/usr/bin/env node
// The value sweep's six surfaces (docs/next-steps.md, "Value sweep (11 November 2026)", items 1 to 6), walked in a
// browser on the default mock world with no model and no dispatch:
//   1 threads between records     2 proposal notices     3 New runbook     4 the initiative's Learning tab
//   5 "Passed over" on a work item     6 Recurring obstacles
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

#!/usr/bin/env node
// The learning loop journey (docs/learning-loop-design.md, "Acceptance"). One step so far, acceptance item 9:
// an initiative crossing 80 percent of its allocation produces ONE bell notification for its owner, and the bell
// opens the Budgets row with its 80% mark.
//
// Vera owns Auth Migration in the Halyard story and is an org leader, so she can read Budgets. The step narrows
// the allocation to $9.80 against ~$7.76 spent this month (79%), dispatches the logout cookie bug (the hold at
// reserve carries the initiative over 80%), and then reads the bell as Vera would.
//
//   cd portal && npm run journey:learning-loop [-- --shots <dir> --out <dir>]
//   PORTAL_URL=http://localhost:5166 MIDDLEWARE_URL=http://127.0.0.1:3966 node scripts/journeys/learning-loop.mjs
//
// Screenshots of the Budgets page at 1440, 1280 and 390 wide go to --shots (default <out>/shots).
// Exit codes as scripts/journeys/demo-moments.mjs: 0 every step passed, 1 a step failed, 2 the stack is unreachable.
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
const OUT = flag('--out') ?? process.env.OUT_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'learning-loop-'));
const SHOTS = flag('--shots') ?? path.join(OUT, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

const VERA = { userId: 'u-vera', role: 'org-leader' };
const P = 'p-auth-migration';
const NAME = 'Auth Migration';
const BUG_ID = 'wi-auth-e2-b3';
const HAIKU = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
const ALLOCATION = 9.8;
// The header's Activity bell (components/shell/ActivityBell.tsx): the user-addressed inbox lib/social-notify.ts feeds.
const BELL = '[data-testid="activity-bell"]';

class StepFailure extends Error {}
const check = (cond, msg) => { if (!cond) throw new StepFailure(msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/** The bell's items for this initiative's 80% crossing, read off the open panel (polled: they arrive over the socket). */
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
  const results = [];
  try {
    const login = await ctx.request.post(`${PORTAL}/api/session/login`, { data: { userId: VERA.userId } });
    check(login.status() === 200, `login ${VERA.userId}: ${login.status()}`);
    const role = await ctx.request.post(`${PORTAL}/api/session/role`, { data: { tenant: 'orgiq', role: VERA.role } });
    check(role.status() === 200, `role ${VERA.role}: ${role.status()}`);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));

    const step = 'L9: Auth Migration crosses 80% of its allocation: one bell item for Vera, and it opens the Budgets row';
    const started = Date.now();
    try {
      // 1. The allocation, narrowed so this month's spend sits just under 80%.
      const put = await ctx.request.put(`${PORTAL}/api/budgets/${P}`, { data: { allocatedUsd: ALLOCATION } });
      check(put.status() === 200, `PUT /api/budgets/${P} answered ${put.status()}`);
      const before = (await (await ctx.request.get(`${PORTAL}/api/budgets`)).json()).budgets.find((b) => b.orgProjectId === P);
      check(before?.threshold?.percent != null && before.threshold.percent < 80, `before the dispatch ${NAME} already reads ${before?.threshold?.percent}%`);

      // 2. A dispatch: the hold taken at reserve carries the initiative past 80%. The allocation brake is confirmed,
      //    as the dispatch deck would after showing it; thresholds never block a reservation.
      const sent = await ctx.request.post(`${PORTAL}/api/bots/dispatch-work`, {
        data: { workItemId: BUG_ID, model: HAIKU, confirmOverAllocation: true, confirmOverEnvelope: true, confirmOverUserBudget: true },
      });
      check(sent.status() === 202 || sent.status() === 200, `POST /api/bots/dispatch-work answered ${sent.status()}: ${(await sent.text()).slice(0, 200)}`);
      const after = (await (await ctx.request.get(`${PORTAL}/api/budgets`)).json()).budgets.find((b) => b.orgProjectId === P);
      check(after?.threshold?.reached >= 80, `after the dispatch ${NAME} reads ${after?.threshold?.percent}% (reached ${after?.threshold?.reached})`);

      // 3. The bell: exactly one item for the 80% crossing, however many readers (reserve, settle, the sweep) saw it.
      await go(page, '/iq/projects');
      const want = new RegExp(`^${NAME} has used 80%`);
      const { texts } = await bellItems(page, want);
      check(texts.length === 1, `the bell holds ${texts.length} item(s) for ${NAME} at 80%: ${JSON.stringify(texts)}`);
      await sleep(3000); // a late second announcement would land here
      await page.keyboard.press('Escape');
      const again = await bellItems(page, want, 5000);
      check(again.texts.length === 1, `after a wait the bell holds ${again.texts.length} item(s) for ${NAME} at 80%`);

      // 4. The item opens Budgets on its row, with the 80% mark.
      await again.panel.getByText(want).first().click();
      await page.waitForURL(new RegExp(`/admin/budgets\\?.*row=${P}`), { timeout: 15000 });
      const row = page.locator('[data-testid="budgets-initiatives-table"] [data-selected]');
      await row.first().waitFor({ state: 'visible', timeout: 15000 });
      check(await row.count() === 1, `${await row.count()} highlighted rows on Budgets`);
      const rowText = (await row.first().innerText()).replace(/\s+/g, ' ');
      check(rowText.includes(NAME), `the highlighted row is not ${NAME}: "${rowText.slice(0, 120)}"`);
      const mark = row.first().locator('[data-testid="threshold-near"]');
      check(await mark.count() === 1, `the ${NAME} row shows no near-cap mark: "${rowText.slice(0, 160)}"`);
      check(/80%/.test(await mark.innerText()), `the mark reads "${await mark.innerText()}", not 80%`);
      check(errors.length === 0, `page errors: ${errors.join(' | ')}`);

      for (const width of [1440, 1280, 390]) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        await sleep(500);
        await page.screenshot({ path: path.join(SHOTS, `budgets-row-${width}.png`), fullPage: false });
      }
      results.push({ step, ok: true, ms: Date.now() - started, mark: after.threshold, bell: texts[0] });
      console.log(`PASS ${step}\n  bell: ${texts[0]}\n  mark: ${after.threshold.percent}% (reached ${after.threshold.reached})`);
    } catch (e) {
      await page.screenshot({ path: path.join(SHOTS, 'failure.png') }).catch(() => undefined);
      results.push({ step, ok: false, ms: Date.now() - started, error: e.message });
      console.log(`FAIL ${step}\n  ${e.message}`);
      if (!(e instanceof StepFailure)) console.log(e.stack);
    }
  } finally {
    await browser.close();
  }
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'learning-loop.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
  console.log(`learning-loop: ${results.filter((x) => x.ok).length}/${results.length} passed; screenshots in ${SHOTS}`);
  return results.every((x) => x.ok) ? 0 : 1;
}

process.exit(await main());

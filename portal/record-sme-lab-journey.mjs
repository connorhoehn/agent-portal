// Record the SME's governed journey: sign in → pick a work item on an
// initiative → dispatch it → watch the computer work in Computer Lab → split
// the view.
//
// Why these specific choices, so the next person does not have to rediscover
// them:
//
//   * The protagonist is Nora DaSilva, not the demo user. The picker's "Enter
//     Org as SME" keeps the `demo-user` identity, which holds no sprint grant —
//     and `decideGrantScopedDispatch` is a HARD 403 before any money gate. Nora
//     is the seeded SME with an active grant on Auth Migration, so she is the
//     only identity for whom this journey can legitimately succeed.
//   * The initiative is Auth Migration because the seeded fleet names its boxes
//     `auth-migration-1/2`, so the computer and the work visibly belong to the
//     same initiative on screen.
//   * Headed, not headless: `useFetch` pauses its polls when the tab reports
//     `visibilityState === 'hidden'`, which automated Chrome often does, and the
//     lab's fleet poll is what refreshes the status column.
//   * The lab dwell is deliberately longer than FLEET_POLL_MS (15s) so at least
//     one fleet poll lands while the box is running. The tail pane is an
//     EventSource and streams immediately either way; the status column is the
//     part that needs a poll.
//
// Run with the middleware in mock mode AND `MOCK_BOT_RUNS=0` — otherwise the
// ambient mock runner (lib/mock-bot-runner.ts) claims idle boxes round-robin
// and narrates unrelated scripted jobs onto them, which both competes for the
// box this dispatch wants and makes the recording incoherent.

import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PORTAL = process.env.PORTAL_URL ?? 'http://localhost:5183';
const DESKTOP = process.env.OUT_DIR ?? join(homedir(), 'Desktop');
const RAW = join(DESKTOP, 'orgiq-recording-raw');
const SHOTS = join(DESKTOP, 'orgiq-sme-lab-shots');

// The initiative Nora holds a grant on, and an open bug on it. Both are seeded
// (schema/seeds/generate_program_seed.py), so they survive a mock reset.
const INITIATIVE = { id: 'p-auth-migration', name: 'Auth Migration' };
const WORK_ITEM = { id: 'wi-auth-e2-b3', match: /legacy shim cookie/i };

mkdirSync(RAW, { recursive: true });
mkdirSync(SHOTS, { recursive: true });

const beats = [];
let step = 0;
const beat = async (page, name, note) => {
  step += 1;
  const label = `${String(step).padStart(2, '0')}-${name}`;
  try {
    await page.screenshot({ path: join(SHOTS, `${label}.png`) });
  } catch { /* a screenshot failing must not end the journey */ }
  beats.push({ step, name, note: note ?? null, url: page.url() });
  console.log(`  ▸ ${label}${note ? ` — ${note}` : ''}`);
};

const browser = await chromium.launch({ channel: 'chrome', headless: false, slowMo: 120 });
const context = await browser.newContext({
  viewport: { width: 1600, height: 1000 },
  recordVideo: { dir: RAW, size: { width: 1600, height: 1000 } },
});
const page = await context.newPage();
page.on('pageerror', (e) => console.log(`  ! pageerror: ${e.message.slice(0, 140)}`));

// Talk to the BFF through the page so every call carries the session cookie the
// UI just minted — a separate fetch would be a separate, anonymous session.
const api = (path, init) => page.evaluate(
  async ([p, i]) => {
    const res = await fetch(p, { credentials: 'include', ...(i ?? {}) });
    const text = await res.text();
    try { return { status: res.status, body: JSON.parse(text) }; }
    catch { return { status: res.status, body: text.slice(0, 300) }; }
  },
  [path, init],
);

try {
  // ── 1. Sign in as the SME ─────────────────────────────────────────────────
  console.log('\n[1] Signing in as the SME');
  await page.goto(`${PORTAL}/select`, { waitUntil: 'networkidle' });
  await beat(page, 'workspace-picker', 'the account + role chooser');

  await page.getByRole('tab', { name: /Sign in as/i }).click();
  await page.waitForTimeout(600);
  await beat(page, 'sign-in-as-tab', 'switching identity, not just role');

  await page.getByRole('button', { name: 'Sign in as Nora DaSilva' }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/select'), { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(2500);
  await beat(page, 'signed-in-as-sme', 'Nora DaSilva · SME in Org');

  const who = await api('/api/session/capabilities');
  console.log(`      session: HTTP ${who.status}`);

  // ── 2. Find the work item on the initiative ──────────────────────────────
  console.log('[2] Opening the initiative and its work board');
  await page.goto(`${PORTAL}/iq/projects`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await beat(page, 'initiatives', 'the initiatives Nora can see');

  // Click through when the card is findable; fall back to the direct route so a
  // card-layout change cannot end the recording before its subject.
  const card = page.getByText(INITIATIVE.name, { exact: false }).first();
  if (await card.isVisible().catch(() => false)) {
    await card.click().catch(() => {});
    await page.waitForTimeout(2000);
  }
  if (!page.url().includes(INITIATIVE.id)) {
    await page.goto(`${PORTAL}/iq/projects/${INITIATIVE.id}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
  }
  await beat(page, 'initiative-detail', INITIATIVE.name);

  for (const name of [/^Work$/i, /Work/i]) {
    const tab = page.getByRole('tab', { name }).first();
    if (await tab.isVisible().catch(() => false)) { await tab.click().catch(() => {}); break; }
  }
  await page.waitForTimeout(2000);
  await beat(page, 'work-board', 'the backlog for this initiative');

  // Narrow to open work: the bug we want is on the second epic, below the fold
  // of an unfiltered 7-item board.
  const openFilter = page.getByRole('button', { name: /^Open$/ }).first();
  if (await openFilter.isVisible().catch(() => false)) {
    await openFilter.click().catch(() => {});
    await page.waitForTimeout(1500);
    await beat(page, 'open-work', 'filtered to what is actually dispatchable');
  }

  // Scope to the ROW, never to the page. A page-wide `▶ Run` would dispatch
  // whichever item happened to be first, and a page-wide /Run|Estimate/ is how
  // an earlier version of this script opened the assignee dropdown instead.
  const cell = page.getByText(WORK_ITEM.match).first();
  await cell.scrollIntoViewIfNeeded().catch(() => {});
  const row = cell.locator('xpath=ancestor::tr[1]');
  await beat(page, 'work-item', `${WORK_ITEM.id} — the bug we are about to dispatch`);

  // ── 3. Dispatch it, through the governed chain ────────────────────────────
  // ▶ Run → Authorize → Authorize run, plus a "Dispatch anyway" if one of the
  // three money brakes (run budget / allocation / envelope) refuses first. Each
  // of those is a real 409 naming its own confirm flag; clicking through them is
  // the governance, not a formality.
  console.log('[3] Dispatching through the UI');
  let dispatched = false;
  const runChip = row.getByRole('button', { name: /Run/ }).first();
  if (await runChip.isVisible().catch(() => false)) {
    await runChip.click().catch(() => {});
    await page.waitForTimeout(2500);
    await beat(page, 'estimate-drawer', 'the forecast, before anything spends');

    for (const label of [/^Authorize$/, /^Authorize run$/, /^Dispatch anyway$/]) {
      const btn = page.getByRole('button', { name: label }).first();
      if (await btn.isVisible().catch(() => false)) {
        await btn.click().catch(() => {});
        await page.waitForTimeout(2000);
        await beat(page, `confirm-${String(label).replace(/[^a-z]+/gi, '-')}`, 'authorizing the spend');
        dispatched = true;
      }
    }
    if (dispatched) {
      await page.waitForTimeout(1500);
      await beat(page, 'dispatched', 'accepted — 202, the run is live');
    }
  }

  // Fall back to the endpoint the drawer posts to. Same gates, same 403/409s —
  // this skips the chrome, not the governance.
  if (!dispatched) {
    console.log('      UI control not reachable; posting the same request the drawer posts');
    const res = await api('/api/bots/dispatch-work', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workItemId: WORK_ITEM.id, model: 'claude-sonnet-5' }),
    });
    console.log(`      dispatch-work → HTTP ${res.status}`);
    dispatched = res.status === 202;
    await beat(page, 'dispatched-via-api', `HTTP ${res.status}`);
  }

  // ── 4. Which computer picked it up ───────────────────────────────────────
  let boxId = null;
  for (let i = 0; i < 12 && !boxId; i += 1) {
    const runs = await api('/api/bots/active-runs');
    const live = (runs.body?.runs ?? []).find((r) => r.workItemId === WORK_ITEM.id);
    boxId = live?.outcome?.boxId ?? null;
    if (!boxId) await page.waitForTimeout(700);
  }
  console.log(`[4] Box working this item: ${boxId ?? '(none reported)'}`);

  // ── 5. Watch it work in Computer Lab ─────────────────────────────────────
  console.log('[5] Computer Lab');
  await page.goto(`${PORTAL}/admin/devbox${boxId ? `?box=${boxId}` : ''}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);
  await beat(page, 'computer-lab', boxId ? `focused on ${boxId}` : 'the fleet');

  // A second dispatch, now that the camera is already pointing at the lab: the
  // fleet taking on more work is the thing the split view is FOR, and it also
  // keeps something running long enough for a fleet poll to land.
  const second = await api('/api/bots/dispatch-work', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workItemId: 'wi-auth-e2-s2', model: 'claude-sonnet-5' }),
  });
  console.log(`      second dispatch (wi-auth-e2-s2) → HTTP ${second.status}`);

  await page.waitForTimeout(6000);
  await beat(page, 'working', 'tail streaming — the agent narrating its run');

  // ── 6. Split the view ────────────────────────────────────────────────────
  // ⌘⏎ is DEFAULT_KEYMAP's `split-right` ("New pane beside this one"), read off
  // the installed dist rather than guessed.
  console.log('[6] Splitting the pane (⌘⏎)');
  await page.locator('body').click({ position: { x: 1100, y: 600 } }).catch(() => {});
  await page.waitForTimeout(500);
  await page.keyboard.press('Meta+Enter');
  await page.waitForTimeout(3000);
  await beat(page, 'split-view', 'two panes side by side');

  await page.waitForTimeout(9000);
  await beat(page, 'split-working', 'both panes, work landing');

  // ── 7. Let it settle ─────────────────────────────────────────────────────
  console.log('[7] Letting the runs settle');
  await page.waitForTimeout(10000);
  await beat(page, 'settled', 'runs complete, cost recorded on the box');

  const boxes = await api('/api/devbox/boxes');
  const seen = (boxes.body?.boxes ?? []).map((b) => ({
    id: b.id, label: b.label, status: b.status,
    task: (b.currentTask ?? '').slice(0, 60), spendUsd: b.spendUsd ?? null,
  }));
  console.log('[8] Fleet as the SME sees it:');
  seen.forEach((b) => console.log(`      ${b.id} ${String(b.status).padEnd(9)} ${JSON.stringify(b.task)} $${b.spendUsd ?? '-'}`));
  writeFileSync(join(SHOTS, 'journey.json'), JSON.stringify({ beats, boxId, fleet: seen }, null, 2));
} catch (err) {
  console.error(`\n✗ journey failed at step ${step}: ${err.message}`);
  await page.screenshot({ path: join(SHOTS, 'ZZ-failure.png') }).catch(() => {});
} finally {
  const video = page.video();
  await context.close();  // the video is only finalized on context close
  if (video) {
    const out = join(DESKTOP, 'orgiq-sme-computer-lab.webm');
    await video.saveAs(out).catch((e) => console.error(`  video save failed: ${e.message}`));
    console.log(`\n🎥 ${out}`);
  }
  console.log(`🖼  ${SHOTS}`);
  await browser.close();
}

import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { loginAs } from './realSession';

// The assessment team scorecard's header, rail and discussion pane (the user,
// 2026-10-07, on /assessment/teams/TEAM-005): "I just need to better get
// things into rows together so I can have more space for the content and then
// the chat… Find a dimension really should be dropped… the Discussion tab is
// not going to work — it should be a right pane like the other tenants."
//
// - One library PageHeader in rows: the title row, then the coverage as one
//   line of facts (the verified level's progress bar inline on it), then the
//   tabs. Trail top → tabs bottom ≤ 150px comfortable, ≤ 96px compact
//   (Activity), at 1440×900.
// - No "Find a dimension" search and no separate coverage bar; the dimension
//   rail is flush against the shell rail (no radius, at the content column's edge, right
//   under the tabs) and 264px; its rows move with the arrow keys.
// - No Discussion tab: the team discussion is the shell's right pane, open by
//   default; `?tab=discussion` lands on Certification with it open. Exactly
//   one composer on the page, in the content column.
//
// PARITY_BASE_URL=http://127.0.0.1:5183 (the shared dev:mock stack); SH_SHOTS=<dir> saves screenshots.

const BASE = () => process.env.PARITY_BASE_URL ?? 'http://127.0.0.1:5183';
const TEAM = 'TEAM-005';
const SHOTS = process.env.SH_SHOTS;

async function open(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, baseURL: BASE() });
  await loginAs(context, 'u-asha', BASE());
  expect((await context.request.post('/api/session/tenant', { data: { tenant: 'assessment' } })).status(), 'enter assessment').toBe(200);
  return context.newPage();
}

type Box = { top: number; bottom: number; left: number; right: number; width: number; height: number; mid: number };
const box = (l: Locator): Promise<Box> => l.evaluate((el) => {
  const b = el.getBoundingClientRect();
  return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, width: b.width, height: b.height, mid: b.top + b.height / 2 };
});

const header = (page: Page) => page.getByTestId('page-header').first();
const trail = (page: Page) => page.getByRole('navigation', { name: 'Breadcrumb' }).first();
const headerTabs = (page: Page) => header(page).getByRole('tablist').first();
const rail = (page: Page) => page.getByTestId('assessment-dimension-master-detail').locator('nav[aria-label="Explorer"]').first();

async function scorecard(page: Page, query = '') {
  await page.goto(`/assessment/teams/${TEAM}${query}`);
  await expect(header(page)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('scorecard-status')).toBeVisible();
}

test('the header is rows: ≤150px comfortable, ≤96px compact; the facts and the level progress share one row', async ({ browser }) => {
  test.setTimeout(90_000);
  const page = await open(browser);
  await scorecard(page);
  await expect(header(page)).toHaveAttribute('data-density', 'comfortable');
  const facts = page.getByTestId('scorecard-facts');
  await expect(facts).toBeVisible();
  const comfortable = (await box(headerTabs(page))).bottom - (await box(trail(page))).top;
  test.info().annotations.push({ type: 'measure', description: `comfortable: trail → tabs bottom ${Math.round(comfortable)}px` });
  expect(comfortable, 'comfortable header block (trail → tabs)').toBeLessThanOrEqual(150);

  // Four facts, one line: every cluster and the level's progress bar on the same row.
  const clusters = facts.getByTestId('stat-strip-cluster');
  await expect(clusters).toHaveCount(4);
  await expect(facts).toContainText('5/17');
  const mids = await Promise.all([0, 1, 2, 3].map(async (i) => (await box(clusters.nth(i))).mid));
  const progress = await box(facts.getByTestId('stat-strip-progress').first());
  for (const mid of [...mids, progress.mid]) expect(Math.abs(mid - mids[0]!), 'one row (same y within 2px)').toBeLessThanOrEqual(2);
  // The title row holds the status line and the actions; the facts row sits right under it.
  const status = await box(page.getByTestId('scorecard-status'));
  const title = await box(header(page).locator('h1'));
  expect(Math.abs(status.mid - title.mid), 'status · updated on the title row').toBeLessThanOrEqual(4);
  // The certification sentences live in the title's info card.
  await header(page).getByRole('button', { name: `About ${await header(page).locator('h1').innerText()}` }).focus();
  await expect(page.getByTestId('page-header-description-card')).toContainText('Working toward Level');
  await expect(page.getByTestId('page-header-description-card').getByTestId('evidence-coverage')).toBeVisible();
  await page.keyboard.press('Escape');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/scorecard-certification.png` });

  await scorecard(page, '?tab=activity');
  await expect(header(page)).toHaveAttribute('data-density', 'compact', { timeout: 30_000 });
  const compact = (await box(headerTabs(page))).bottom - (await box(trail(page))).top;
  test.info().annotations.push({ type: 'measure', description: `compact: trail → tabs bottom ${Math.round(compact)}px` });
  expect(compact, 'compact header block (trail → tabs)').toBeLessThanOrEqual(96);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/scorecard-activity.png` });
  await page.context().close();
});

test('no Find a dimension, no coverage bar; the dimension rail is flush, 264px, grouped, and moves with the arrow keys', async ({ browser }) => {
  test.setTimeout(90_000);
  const page = await open(browser);
  await scorecard(page);
  await expect(page.getByRole('textbox', { name: /find a dimension/i })).toHaveCount(0);
  await expect(page.getByPlaceholder(/find a dimension/i)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Assessment progress & evidence coverage/ })).toHaveCount(0);

  const r = await box(rail(page));
  const tabs = await box(headerTabs(page));
  const column = await box(page.locator('#main-content'));
  const radius = await rail(page).evaluate((el) => parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0);
  test.info().annotations.push({ type: 'measure', description: `rail x=${r.left} w=${r.width} top=${r.top} (tabs bottom ${tabs.bottom}) radius=${radius}` });
  expect(Math.abs(r.width - 264), 'rail width').toBeLessThanOrEqual(2);
  expect(radius, 'rail radius').toBeLessThanOrEqual(2);
  expect(Math.abs(r.left - column.left), 'rail flush against the shell rail (the content column edge)').toBeLessThanOrEqual(2);
  expect(r.top - tabs.bottom, 'rail right under the tabs').toBeLessThanOrEqual(2);
  expect(r.top - tabs.bottom).toBeGreaterThanOrEqual(-1);
  await expect(rail(page).getByRole('radio', { name: /^Open claims/ })).toBeVisible();

  // Grouped by where each dimension stands; ArrowDown moves between rows, Enter opens one.
  const rows = rail(page).locator('[data-row-id]');
  await expect(rows.first()).toBeVisible();
  expect(await rows.count()).toBeGreaterThanOrEqual(10);
  await expect(rail(page)).toContainText('Claims to verify');
  const first = rows.first().getByRole('button').first();
  await first.focus();
  await page.keyboard.press('ArrowDown');
  const focusedRow = await page.evaluate(() => document.activeElement?.closest('[data-row-id]')?.getAttribute('data-row-id') ?? null);
  const firstRow = await rows.first().getAttribute('data-row-id');
  expect(focusedRow, 'ArrowDown moved to the next row').not.toBeNull();
  expect(focusedRow).not.toBe(firstRow);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('assessment-dimension-master-detail')).toContainText(`Dimension ${String(Number(focusedRow)).padStart(2, '0')}`);
  await page.context().close();
});

test('Discussion is the right pane: no tab, open by default, ?tab=discussion opens it, one composer in the content column', async ({ browser }) => {
  test.setTimeout(90_000);
  const page = await open(browser);
  await scorecard(page);
  await expect(headerTabs(page).getByRole('tab', { name: 'Discussion' })).toHaveCount(0);
  const pane = page.getByTestId('page-conversation-pane');
  await expect(page.getByTestId('team-discussion')).toBeVisible({ timeout: 20_000 });
  await expect(pane).toBeVisible();

  // One input: the dimension composer, in the content column; the pane draws the thread only.
  await expect(page.getByTestId('dimension-composer')).toBeVisible({ timeout: 20_000 });
  const inputs = page.locator('[data-testid$="composer-input"]:visible');
  await expect(inputs).toHaveCount(1);
  expect(await inputs.first().evaluate((el) => !!el.closest('#main-content')), 'the composer is in the content column').toBe(true);
  expect(await inputs.first().evaluate((el) => !!el.closest('[data-testid="page-conversation-pane"]')), 'not in the pane').toBe(false);
  const content = await box(page.locator('#main-content'));
  const paneBox = await box(pane);
  test.info().annotations.push({ type: 'measure', description: `content column ${Math.round(content.width)}px, pane ${Math.round(paneBox.width)}px` });
  expect(paneBox.left).toBeGreaterThanOrEqual(content.right - 2);

  // Collapse it, then the retired ?tab=discussion brings it back on Certification.
  await pane.getByRole('button', { name: 'Collapse discussion' }).click();
  await expect(page.getByTestId('team-discussion')).toBeHidden();
  await page.goto(`/assessment/teams/${TEAM}?tab=discussion`);
  await expect(page.getByTestId('team-discussion')).toBeVisible({ timeout: 20_000 });
  await expect(page).not.toHaveURL(/tab=discussion/);
  await expect(headerTabs(page).getByRole('tab', { name: 'Certification' })).toHaveAttribute('aria-selected', 'true');

  // Off Certification the team composer in the content column is the input (2.438.3) — still exactly one on screen.
  await headerTabs(page).getByRole('tab', { name: 'Stories' }).click();
  await expect(page.getByTestId('team-discussion-composer').locator('[data-testid$="composer-input"]')).toBeVisible({ timeout: 10_000 });
  await expect(pane.locator('[data-testid$="composer-input"]')).toHaveCount(0);
  await expect(page.locator('[data-testid$="composer-input"]:visible')).toHaveCount(1);
  await page.context().close();
});

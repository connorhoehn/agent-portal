import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { loginAs } from './realSession';

// Header density (ui-components 2.437.0, the library PageHeader / ScopeHeader
// with useHeaderDensity), 2026-10-07. The user: "The title section becomes a
// little too big when I have rich content, like node graphs or chat dialogues."
//
// - Rich content (a graph, a canvas, a conversation) gets the compact header:
//   the trail, ONE row (title 14/600, status, info, owner/SME avatars,
//   actions) and the tabs — at most 96px — and the canvas keeps at least 70%
//   of the content column.
// - Lists and records keep the comfortable header (20px title, description,
//   the labelled people row).
// - The chevron collapses the header into the trail and is remembered across
//   a reload (per device, per rich/plain content); Overview is not affected.
// - In compact the description is reachable from the title's info card by
//   keyboard.
//
// PARITY_BASE_URL=http://127.0.0.1:5183; HD_SHOTS=<dir> also saves screenshots.

const BASE = () => process.env.PARITY_BASE_URL ?? test.info().project.use.baseURL ?? 'http://127.0.0.1:5183';
const PID = 'p-observability';
const SHOTS = process.env.HD_SHOTS;

async function open(browser: Browser, user: string, tenant: 'orgiq' | 'assessment' | 'pipelines' = 'orgiq', role?: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, baseURL: BASE() });
  await loginAs(context, user, BASE());
  if (tenant !== 'orgiq') expect((await context.request.post('/api/session/tenant', { data: { tenant } })).status(), `enter ${tenant}`).toBe(200);
  if (role) expect((await context.request.post('/api/session/role', { data: { role } })).status(), `switch to ${role}`).toBe(200);
  return context.newPage();
}

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

type Box = { top: number; bottom: number; height: number };
async function box(locator: Locator): Promise<Box> {
  return locator.evaluate((el) => { const b = el.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, height: b.height }; });
}
async function type(locator: Locator) {
  return locator.evaluate((el) => ({ size: getComputedStyle(el).fontSize, weight: getComputedStyle(el).fontWeight }));
}

async function initiative(page: Page, tab: string) {
  await page.goto(`/iq/projects/${PID}?scope=all&tab=${tab}`);
  await expect(page.getByTestId('initiative-header')).toBeVisible({ timeout: 30_000 });
}

test('initiative Activity: one-row compact header ≤ 96px, the canvas ≥ 70% of the column; Overview comfortable', async ({ browser }) => {
  test.setTimeout(120_000);
  const page = await open(browser, 'u-release', 'orgiq', 'org-leader');

  await initiative(page, 'overview');
  const header = page.getByTestId('initiative-header');
  await expect(header).toHaveAttribute('data-density', 'comfortable');
  expect(await type(header.locator('h1'))).toEqual({ size: '20px', weight: '600' });
  const description = (await header.locator('p').first().innerText()).trim();
  expect(description.length, 'the comfortable header shows the description').toBeGreaterThan(10);
  await expect(header.getByTestId('initiative-header-people')).toContainText('Owner');
  const comfortable = await box(header);
  expect(comfortable.height, 'the comfortable header').toBeGreaterThan(150);
  await shot(page, 'overview');

  await initiative(page, 'activity');
  await expect(header).toHaveAttribute('data-density', 'compact');
  await expect(header).toHaveAttribute('data-collapsed', 'false');
  const canvas = page.getByTestId('initiative-activity');
  await expect(canvas).toBeVisible();
  await page.waitForTimeout(500);
  const h = await box(header);
  const c = await box(canvas);
  test.info().annotations.push({ type: 'measure', description: `activity header ${h.height}px (overview ${comfortable.height}px), canvas ${c.height}px of ${c.bottom - h.top}px` });
  expect(h.height, 'trail + one row + tabs').toBeLessThanOrEqual(96);
  expect(c.height / (c.bottom - h.top), 'the canvas share of the content column').toBeGreaterThanOrEqual(0.7);
  // One row: the title, the status, the people and the actions share a line.
  const row = header.getByTestId('initiative-header-row');
  expect((await box(row)).height).toBeLessThanOrEqual(28);
  expect(await type(header.locator('h1'))).toEqual({ size: '14px', weight: '600' });
  for (const part of ['initiative-header-status', 'initiative-header-people', 'initiative-header-actions']) {
    await expect(row.getByTestId(part)).toBeVisible();
  }
  await expect(header.locator('p')).toHaveCount(0);
  // Names are in the avatars' accessible names (and tooltips), not text.
  await expect(row.getByRole('img', { name: /, Owner$/ })).toBeVisible();
  await shot(page, 'activity-compact');

  // The description by keyboard: focus the title's info glyph.
  await header.getByTestId('initiative-details-trigger').focus();
  const card = page.getByTestId('initiative-details-card');
  await expect(card).toBeVisible();
  await expect(card).toContainText(description.slice(0, 40));
  await expect(page.getByTestId('initiative-details-trigger')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(card).toBeHidden();
  await page.context().close();
});

test('the chevron folds the header into the trail and is remembered across a reload; Overview keeps its header', async ({ browser }) => {
  test.setTimeout(120_000);
  const page = await open(browser, 'u-release', 'orgiq', 'org-leader');
  await initiative(page, 'activity');
  const header = page.getByTestId('initiative-header');
  await header.getByRole('button', { name: 'Collapse header' }).click();
  await expect(header).toHaveAttribute('data-collapsed', 'true');
  await expect(header.locator('h1')).toHaveCount(0);
  await expect(header.getByTestId('initiative-header-fold-crumbs')).toContainText('Observability Platform');
  await expect(header.getByRole('tab', { name: 'Activity' })).toBeVisible();
  await expect(header.getByTestId('initiative-header-actions')).toBeVisible();
  const folded = await box(header);
  test.info().annotations.push({ type: 'measure', description: `collapsed header ${folded.height}px` });
  expect(folded.height).toBeLessThanOrEqual(80);
  await shot(page, 'activity-collapsed');

  await page.reload();
  await expect(header).toHaveAttribute('data-collapsed', 'true', { timeout: 30_000 });

  await header.getByRole('tab', { name: 'Overview' }).click();
  await expect(header).toHaveAttribute('data-collapsed', 'false');
  await expect(header).toHaveAttribute('data-density', 'comfortable');
  await header.getByRole('tab', { name: 'Activity' }).click();
  await expect(header).toHaveAttribute('data-collapsed', 'true');

  await header.getByRole('button', { name: 'Expand header' }).click();
  await expect(header).toHaveAttribute('data-collapsed', 'false');
  await expect(header).toHaveAttribute('data-density', 'compact');
  await page.reload();
  await expect(header).toHaveAttribute('data-collapsed', 'false', { timeout: 30_000 });
  await expect(header).toHaveAttribute('data-density', 'compact');
  await page.context().close();
});

test('Search: Connections is a graph (compact 40px row), Results a list (the full row)', async ({ browser }) => {
  test.setTimeout(90_000);
  const page = await open(browser, 'u-release', 'orgiq', 'org-leader');
  await page.goto('/iq/search?tab=connections');
  const header = page.getByTestId('search-header');
  await expect(header).toHaveAttribute('data-density', 'compact', { timeout: 30_000 });
  expect((await box(header)).height).toBeLessThanOrEqual(40);
  expect(await type(header.getByTestId('search-header-title'))).toEqual({ size: '14px', weight: '600' });
  await shot(page, 'search-connections');
  await page.goto('/iq/search?tab=results');
  await expect(header).toHaveAttribute('data-density', 'comfortable', { timeout: 30_000 });
  await page.context().close();
});

test('Communication: an open conversation gets the compact title row; collapsing folds it into the trail', async ({ browser }) => {
  test.setTimeout(120_000);
  const page = await open(browser, 'u-vera');
  await page.goto('/iq/communication/channels');
  const content = page.getByTestId('communication-content');
  await expect(content).toBeVisible({ timeout: 30_000 });
  const channel = page.getByTestId('social-chat-rail-list-channels').getByTestId('conversation-row').first();
  await expect(channel).toBeVisible({ timeout: 20_000 });
  await channel.click();
  const title = content.locator('[data-page-title] [data-density]');
  await expect(title).toHaveAttribute('data-density', 'compact', { timeout: 30_000 });
  expect(await type(title.locator('h1'))).toEqual({ size: '14px', weight: '600' });
  await shot(page, 'communication-compact');
  await title.getByRole('button', { name: 'Collapse header' }).click();
  await expect(content.locator('[data-page-title]')).toHaveCount(0);
  await expect(page.getByTestId('page-trail')).toContainText('Communication');
  await page.getByTestId('page-trail').getByRole('button', { name: 'Expand header' }).click();
  await expect(content.locator('[data-page-title]')).toHaveCount(1);
  await page.context().close();
});

test('assessment scorecard: Activity compact (the facts in the info card), Certification comfortable', async ({ browser }) => {
  test.setTimeout(120_000);
  const page = await open(browser, 'u-asha', 'assessment');
  await page.goto('/assessment/teams/TEAM-006?tab=scorecard');
  // The scorecard is a flush page (2026-10-07): its PageHeader carries the trail and the tabs,
  // so the header box is the whole block (e2e/scorecard-header.spec.ts measures it row by row).
  const header = page.getByTestId('page-header').first();
  await expect(header).toHaveAttribute('data-density', 'comfortable', { timeout: 30_000 });
  await expect(header.getByTestId('page-header-meta')).toBeVisible();
  const full = await box(header);
  const crumbsTop = (await box(header.getByTestId('page-header-crumbs'))).top;
  expect(full.bottom - crumbsTop, 'comfortable: trail → tabs').toBeLessThanOrEqual(150);
  await shot(page, 'scorecard-certification');
  await page.goto('/assessment/teams/TEAM-006?tab=activity');
  await expect(header).toHaveAttribute('data-density', 'compact', { timeout: 30_000 });
  const compact = await box(header);
  test.info().annotations.push({ type: 'measure', description: `scorecard header ${full.height}px → ${compact.height}px` });
  // Trail → tabs (the header's own top padding aside).
  expect(compact.bottom - (await box(header.getByTestId('page-header-crumbs'))).top, 'compact: trail → tabs').toBeLessThanOrEqual(96);
  await header.getByRole('button', { name: /^About / }).focus();
  await expect(page.getByTestId('page-header-description-card')).toContainText('verified');
  await shot(page, 'scorecard-activity');
  await page.context().close();
});

test('pipelines run: Activity compact, the run view comfortable', async ({ browser }) => {
  test.setTimeout(120_000);
  const page = await open(browser, 'u-kofi', 'pipelines');
  const list = await (await page.request.get('/api/pipelines/runs?limit=50')).json();
  const run = (list.runs as Array<{ id: string }>)[0];
  test.skip(!run, 'no seeded run');
  await page.goto(`/pipelines/runs/${encodeURIComponent(run!.id)}`);
  const header = page.getByTestId('page-header').first();
  await expect(header).toHaveAttribute('data-density', 'comfortable', { timeout: 30_000 });
  const full = await box(header);
  await page.goto(`/pipelines/runs/${encodeURIComponent(run!.id)}?tab=activity`);
  await expect(header).toHaveAttribute('data-density', 'compact', { timeout: 30_000 });
  const compact = await box(header);
  test.info().annotations.push({ type: 'measure', description: `run header ${full.height}px → ${compact.height}px` });
  expect(compact.height).toBeLessThanOrEqual(28);
  await shot(page, 'run-activity');
  await page.context().close();
});

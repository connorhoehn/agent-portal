import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { loginAs } from './realSession';

// The initiative page at the four-pane width (primary rail, Initiatives rail,
// a ~630px content column, the Discussion pane) on a 1440px screen, 2026-10-07:
//
// - the header degrades by its own width: title and inline status on one
//   full-width line, actions as one compact row (Start call · ⋯ narrow; search
//   icon · Start call · code icon · ⋯ wide), no Status deck at any width;
// - the Agents tab is one table of runs (work item, agent, outcome, spend,
//   when, logs) under one compact control row — no stacked boxes, no Activity
//   panel — and a member sees the runs too;
// - every tab panel starts one gap under the tab strip (16px panel padding;
//   measured to the first content box, so text leading adds a few px).

const PID = 'p-llm-platform';
const ITEM = 'wi-llm-e2-s1';
const BASE = () => process.env.PARITY_BASE_URL ?? test.info().project.use.baseURL ?? 'http://127.0.0.1:5183';

async function open(browser: Browser, user: string, role: string | null, width = 1440): Promise<Page> {
  const context = await browser.newContext({ viewport: { width, height: 900 }, baseURL: BASE() });
  await loginAs(context, user, BASE());
  const page = await context.newPage();
  if (role) expect((await page.request.post('/api/session/role', { data: { role } })).status(), `switch to ${role}`).toBe(200);
  return page;
}

async function goto(page: Page, query: string) {
  await page.goto(`/iq/projects/${PID}?scope=all&${query}`);
  await expect(page.getByTestId('initiative-header')).toBeVisible({ timeout: 20_000 });
  // The Discussion pane is the fourth pane this layout is about.
  await expect(page.getByTestId('page-conversation-pane-title')).toBeVisible({ timeout: 20_000 });
}

type Type = { size: string; weight: string };
async function typeOf(locator: Locator): Promise<Type> {
  await expect(locator).toBeVisible();
  return locator.evaluate((el) => ({ size: getComputedStyle(el).fontSize, weight: getComputedStyle(el).fontWeight }));
}

/** Tab strip bottom → top of the first content box under it: the first
 *  element below the strip that carries text, is a control/table, or is a
 *  framed box. */
async function gapUnderTabs(page: Page, scope: string, column: string): Promise<{ gap: number; what: string }> {
  return page.evaluate(({ scope, column }) => {
    const root = document.querySelector(`[data-testid="${scope}"]`)!;
    const tabs = root.querySelector('[role="tablist"]')!;
    const tb = tabs.getBoundingClientRect();
    const col = document.querySelector(`[data-testid="${column}"]`)!;
    let best: { top: number; what: string } | null = null;
    for (const el of col.querySelectorAll('*')) {
      if (tabs.contains(el) || el.contains(tabs)) continue;
      const b = el.getBoundingClientRect();
      if (!b.height || !b.width || b.top < tb.bottom - 0.5 || b.left < tb.left - 40 || b.left > tb.right) continue;
      const cs = getComputedStyle(el);
      const text = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim());
      const control = /^(INPUT|BUTTON|TABLE|svg|CANVAS|IMG|TEXTAREA)$/.test(el.tagName);
      // A framed box (a card, a table frame) is content; a background alone is
      // a wrapper.
      const painted = ['top', 'right', 'bottom', 'left'].every((s) => parseFloat(cs.getPropertyValue(`border-${s}-width`)) > 0);
      if (!text && !control && !painted) continue;
      if (!best || b.top < best.top) best = { top: b.top, what: `${el.tagName} ${(el.textContent ?? '').trim().slice(0, 24)}` };
    }
    return { gap: best ? Math.round(best.top - tb.bottom) : -1, what: best?.what ?? 'nothing' };
  }, { scope, column });
}

test('four-pane header: one-line title with inline status, one compact action row, overflow holds the rest', async ({ browser }) => {
  test.setTimeout(120_000);
  const page = await open(browser, 'u-release', 'org-leader');
  await goto(page, 'tab=agents');
  const header = page.getByTestId('initiative-header');
  // The library PageHeader (2.437): its title row wraps the actions under the
  // title when the column is narrow — asserted by geometry below, not by a
  // test-only attribute.
  await expect(header.locator('h1')).toBeVisible();

  const title = header.locator('h1');
  const lines = await title.evaluate((el) => el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight));
  expect(lines, 'title on one line').toBeLessThan(1.5);
  const status = header.getByTestId('initiative-header-status');
  const statusBox = await status.evaluate((el) => ({ border: getComputedStyle(el).borderTopWidth, top: el.getBoundingClientRect().top, bottom: el.getBoundingClientRect().bottom }));
  const titleBox = (await title.boundingBox())!;
  expect(statusBox.border, 'status is inline text, not a bordered box').toBe('0px');
  expect(statusBox.top).toBeGreaterThanOrEqual(titleBox.y - 2);
  expect(statusBox.bottom).toBeLessThanOrEqual(titleBox.y + titleBox.height + 2);

  // One compact row: Start call and the overflow, nothing clipped.
  const actions = header.getByTestId('initiative-header-actions');
  const headerBox = (await header.boundingBox())!;
  const buttons = actions.locator('button:visible');
  const boxes = await buttons.evaluateAll((els) => els.map((el) => { const b = el.getBoundingClientRect(); return { l: b.left, r: b.right, c: b.top + b.height / 2, w: el.scrollWidth, cw: el.clientWidth }; }));
  expect(boxes.length).toBeGreaterThanOrEqual(2);
  for (const b of boxes) {
    expect(b.l).toBeGreaterThanOrEqual(headerBox.x);
    expect(b.r).toBeLessThanOrEqual(headerBox.x + headerBox.width + 0.5);
    expect(b.w, 'button content not clipped').toBeLessThanOrEqual(b.cw + 1);
  }
  const centers = boxes.map((b) => b.c);
  expect(Math.max(...centers) - Math.min(...centers), 'one row').toBeLessThan(6);
  await expect(actions.getByRole('button', { name: /Start call/ })).toBeVisible();
  await expect(header.getByText('Search in this initiative', { exact: true })).toHaveCount(0);
  await expect(header.getByText('Status deck')).toHaveCount(0);
  await expect(header.getByRole('button', { name: 'Search in this initiative' })).toHaveCount(0);
  await expect(header.getByRole('button', { name: 'Repository' })).toHaveCount(0);

  await header.getByTestId('initiative-header-menu-trigger').click();
  const menu = page.getByTestId('initiative-header-menu');
  await expect(menu.getByRole('menuitem', { name: 'Search in this initiative' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Repository' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Status deck' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.context().close();
});

test('wide header: search icon · Start call · code icon · ⋯ on the title row, no Status deck', async ({ browser }) => {
  test.setTimeout(90_000);
  const page = await open(browser, 'u-release', 'org-leader', 1920);
  await goto(page, 'tab=overview');
  const header = page.getByTestId('initiative-header');
  const actions = header.getByTestId('initiative-header-actions');
  await expect(actions.getByRole('button', { name: 'Search in this initiative' })).toBeVisible();
  await expect(actions.getByRole('button', { name: 'Repository' })).toBeVisible();
  await expect(actions.getByRole('button', { name: /Start call/ })).toBeVisible();
  await expect(header.getByText('Search in this initiative', { exact: true })).toHaveCount(0);
  await expect(header.getByText('Status deck')).toHaveCount(0);
  const h1 = (await header.locator('h1').boundingBox())!;
  const act = (await actions.boundingBox())!;
  expect(Math.abs((act.y + act.height / 2) - (h1.y + h1.height / 2)), 'actions share the title row').toBeLessThan(12);
  await page.context().close();
});

test('Agents tab: one table of runs under one control row, at the body type step', async ({ browser }) => {
  test.setTimeout(90_000);
  const page = await open(browser, 'u-release', 'org-leader');
  await goto(page, 'tab=agents');
  const section = page.getByTestId('initiative-agents');
  const table = section.getByTestId('initiative-agents-runs');
  await expect(table).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('initiative-workspace').getByRole('heading', { name: /^activity$/i })).toHaveCount(0);
  await expect(page.getByTestId('initiative-workspace').getByText(/^(delivered by|outcomes)$/i)).toHaveCount(0);

  // Exactly one bordered list region: the runs table.
  const framed = await section.evaluate((root) => [...root.querySelectorAll('*')].filter((el) => {
    const cs = getComputedStyle(el), b = el.getBoundingClientRect();
    return b.height > 80 && ['Top', 'Right', 'Bottom', 'Left'].every((s) => parseFloat(cs.getPropertyValue(`border-${s.toLowerCase()}-width`)) > 0);
  }).length);
  expect(framed, 'one bordered region').toBe(1);
  expect(await section.locator('table').count()).toBe(1);

  // The cron runs list with their bot and outcome, not just "cron". Rows group by
  // work item with the bots' standing missions last (agentRunsModel.ts), so a
  // mission is found by its bot, and it sits below the dispatched rows.
  const rows = table.locator('tbody tr');
  expect(await rows.count()).toBeGreaterThanOrEqual(1);
  const mission = rows.filter({ hasText: 'llm-evals-nightly' }).first();
  await expect(mission).toBeVisible();
  await expect(mission).toContainText('No work item');
  await expect(mission.getByTestId('agents-run-logs')).toHaveAttribute('href', /\/iq\/work\/job-/);
  await expect(rows.last()).toContainText(/No work item/);

  // One control row: view switch and window side by side.
  const view = (await section.getByTestId('initiative-agents-view').boundingBox())!;
  const range = (await section.getByTestId('initiative-agents-range').boundingBox())!;
  expect(Math.abs(view.y - range.y)).toBeLessThan(2);

  // The Agents tab names the section: no heading repeats it (the user, 2026-11-02); the meta and the switches share the first row.
  await expect(section.getByRole('heading')).toHaveCount(0);
  // The meta (spend, and the repo links a steward sees) shares the control row or wraps under it; it never sits below the table.
  const meta = (await section.getByTestId('initiative-agents-meta').boundingBox())!;
  const tableBox = (await table.boundingBox())!;
  expect(meta.y).toBeGreaterThanOrEqual(view.y - 2);
  expect(meta.y + meta.height).toBeLessThanOrEqual(tableBox.y + 1);
  // Type: 14/400 body, 12/400 meta.
  expect(await typeOf(rows.first().locator('td').nth(2).locator('span').first())).toEqual({ size: '14px', weight: '400' });
  expect(await typeOf(rows.first().getByTestId('agents-run-agent'))).toEqual({ size: '12px', weight: '400' });
  expect(await typeOf(section.getByTestId('initiative-agents-meta'))).toEqual({ size: '12px', weight: '400' });
  // The spend in the meta line is the listed rows' sum.
  const costs = await rows.locator('td:nth-child(3)').allInnerTexts();
  const sum = costs.reduce((s, c) => s + Number(c.replace(/[^0-9.]/g, '') || 0), 0);
  await expect(section.getByTestId('initiative-agents-meta')).toContainText(`$${sum.toFixed(2)} agent spend over ${costs.length} run`);
  await page.context().close();
});

test('a member sees the runs, with no roster note above the table', async ({ browser }) => {
  test.setTimeout(90_000);
  const page = await open(browser, 'u-release', 'member');
  await goto(page, 'tab=agents');
  const section = page.getByTestId('initiative-agents');
  const rows = section.getByTestId('initiative-agents-runs').locator('tbody tr');
  const mission = rows.filter({ hasText: 'llm-evals-nightly' }).first();
  await expect(mission).toBeVisible({ timeout: 20_000 });
  expect(await rows.count()).toBeGreaterThanOrEqual(1);
  await expect(section.getByText(/not visible to this role/i)).toHaveCount(0);

  // Logs opens the run's log in the right pane (detail goes far right), and
  // its Open page the job page — both of which a member may read (session floor).
  const logs = mission.getByTestId('agents-run-logs');
  const href = (await logs.getAttribute('href'))!;
  const jobId = decodeURIComponent(href.split('/').pop()!);
  expect((await page.request.get(`/api/work/jobs/${encodeURIComponent(jobId)}`)).status()).toBe(200);
  await logs.click();
  await expect(page.getByTestId('initiative-pane').getByRole('tablist', { name: 'Pane sections' }).getByRole('tab', { selected: true })).toHaveText('Log');
  await page.getByTestId('initiative-log-open-page').click();
  await expect(page).toHaveURL(new RegExp(`/iq/work/${jobId}$`));
  await expect(page.locator('main h1').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/Forbidden|not allowed|Failed to load/i)).toHaveCount(0);
  await expect(page.locator('main')).toContainText('llm-evals-nightly');
  await page.context().close();
});

test('every tab panel starts one gap under its tab strip', async ({ browser }) => {
  test.setTimeout(150_000);
  const page = await open(browser, 'u-release', 'org-leader');
  const gaps: Record<string, number> = {};
  for (const tab of ['overview', 'work', 'decisions', 'agents', 'contributors']) {
    await goto(page, `tab=${tab}`);
    await page.waitForTimeout(1_500);
    const g = await gapUnderTabs(page, 'initiative-header', 'initiative-workspace');
    gaps[tab] = g.gap;
    console.log(`gap ${tab}: ${g.gap}px (${g.what})`);
  }
  await goto(page, `tab=work&item=${ITEM}`);
  const detail = page.getByTestId('work-item-detail');
  await expect(detail).toBeVisible({ timeout: 20_000 });
  for (const label of ['Brief', 'Discussion', 'Activity']) {
    await detail.getByRole('tab', { name: new RegExp(`^${label}`) }).click();
    await page.waitForTimeout(800);
    const g = await gapUnderTabs(page, 'work-item-detail', 'work-item-detail');
    gaps[`item ${label}`] = g.gap;
    console.log(`gap item ${label}: ${g.gap}px (${g.what})`);
  }
  const values = Object.values(gaps);
  expect(Math.min(...values), JSON.stringify(gaps)).toBeGreaterThanOrEqual(14);
  expect(Math.max(...values), JSON.stringify(gaps)).toBeLessThanOrEqual(22);
  expect(gaps['contributors']!, 'Contributors no deeper than Work').toBeLessThanOrEqual(gaps['work']! + 2);
  expect(gaps['agents']!, 'Agents no deeper than Work').toBeLessThanOrEqual(gaps['work']! + 2);
  // The owner's change control sits in the header, not as a row above the table.
  await goto(page, 'tab=contributors');
  await expect(page.getByTestId('initiative-header-people').getByRole('button', { name: 'Change who runs this initiative' })).toBeVisible();
  await page.context().close();
});

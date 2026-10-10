import { expect, test, type Page } from '@playwright/test';
import { loginAs } from './realSession';

// Activity is its own tab on an initiative (2026-10-07: "should not be buried
// like that"): the library canvas fills the content column with its timeline row
// on top; Overview keeps only a compact Recent activity list and no canvas.

const PID = 'p-observability';
const BASE = () => process.env.PARITY_BASE_URL ?? test.info().project.use.baseURL ?? 'http://127.0.0.1:5183';

async function open(browser: import('@playwright/test').Browser): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, baseURL: BASE() });
  await loginAs(context, 'u-theo', BASE());
  return context.newPage();
}

test('Activity is a tab with a full-height canvas and the timeline row on top', async ({ browser }) => {
  const page = await open(browser);
  await page.goto(`/iq/projects/${PID}?scope=all&tab=activity`);
  const tab = page.getByTestId('initiative-header').getByRole('tab', { name: /^Activity/ });
  await expect(tab).toBeVisible({ timeout: 20_000 });
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  const root = page.getByTestId('initiative-activity');
  await expect(root).toBeVisible();
  const canvas = root.locator('.react-flow').first();
  await expect(canvas).toBeVisible({ timeout: 20_000 });
  // The content column under the header: from the tab strip's bottom to the footer.
  const strip = (await page.getByTestId('initiative-header').getByRole('tablist').boundingBox())!;
  const columnHeight = 853 - (strip.y + strip.height);
  const rightEdge = (await root.boundingBox())!.x + (await root.boundingBox())!.width;
  const lastTab = (await tab.boundingBox())!;
  expect(lastTab.x + lastTab.width, 'the Activity tab is not clipped by the pane').toBeLessThanOrEqual(rightEdge);
  const c = (await canvas.boundingBox())!;
  const r = (await root.boundingBox())!;
  console.log('columnHeight', columnHeight, 'root', r, 'canvas', c);
  expect(c.height).toBeGreaterThanOrEqual(0.6 * columnHeight);
  // Timeline row: a visible control (range/following) above the canvas' top half.
  const timeline = root.getByText(/Following now|Full day|Now/).first();
  await expect(timeline).toBeVisible();
  const t = (await timeline.boundingBox())!;
  console.log('timeline', t);
  expect(t.y).toBeLessThan(r.y + 120);
  // One scroll region: the page does not scroll to reach the canvas bottom.
  expect(c.y + c.height).toBeLessThanOrEqual(900);
});

test('Overview has Recent activity and no canvas; Open Activity goes to the tab', async ({ browser }) => {
  const page = await open(browser);
  await page.goto(`/iq/projects/${PID}?scope=all`);
  await expect(page.getByTestId('overview-recent-activity')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.react-flow')).toHaveCount(0);
  expect(await page.getByTestId('overview-recent-activity-list').getByRole('button').count()).toBeLessThanOrEqual(5);
  await page.getByTestId('overview-open-activity').click();
  await expect(page).toHaveURL(/tab=activity/);
  await expect(page.getByTestId('initiative-activity')).toBeVisible();
});

test('cursors still render on the Activity tab', async ({ browser, request }) => {
  const health = await request.get('/api/health').then(r => r.json()).catch(() => null) as { realtime?: { gateway?: string } } | null;
  test.skip(health?.realtime?.gateway !== 'on', 'gateway off');
  const a = await open(browser); const b = await open(browser);
  for (const p of [a, b]) {
    await p.goto(`/iq/projects/${PID}?scope=all&tab=activity`);
    await expect(p.getByTestId('initiative-activity').locator('.react-flow').first()).toBeVisible({ timeout: 20_000 });
  }
  const box = (await a.getByTestId('initiative-activity').locator('.react-flow').first().boundingBox())!;
  await expect(async () => {
    await a.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.4, { steps: 4 });
    await a.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5, { steps: 4 });
    await expect(b.getByTestId('cursor-overlay-pointer')).toHaveCount(1, { timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
});

import { expect, test, type Page } from '@playwright/test';
import { openAsClone } from './realSession';

const workUrl = '/iq/projects/p-observability?scope=all&tab=work&item=wi-obs-e2-b4';
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

for (const theme of ['light', 'dark']) test(`work layout and dedicated brief: ${theme}`, async ({ browser }) => {
  test.setTimeout(90_000);
  const writes: string[] = [];
  const person = await openAsClone(browser, 'u-release', {
    role: 'org-leader', expectTenant: 'orgiq', landing: null, viewport: { width: 1680, height: 1050 },
    prepare: async context => {
      await context.addInitScript(value => { localStorage.setItem('orgiq:preferences:v1', JSON.stringify({ theme: value })); localStorage.setItem('shell.conversation-pane.open', '0'); }, theme);
      await context.route('**/api/**', route => {
        if (['GET', 'HEAD', 'OPTIONS'].includes(route.request().method())) return route.continue();
        writes.push(route.request().url()); return route.abort();
      });
    },
  });
  try {
    const page = person.page;
    await page.goto(workUrl);
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme === 'dark')).toBe(theme === 'dark');
    const rail = page.getByTestId('explorer-layout-rail');
    const list = page.getByTestId('initiative-work-rail');
    await expect(list).toHaveAttribute('data-layout', 'rail');
    await expect(page.getByTestId('focused-work-navigation').getByText('In progress', { exact: true })).toHaveCount(0);
    const metadata = list.locator('[data-testid*="-row-meta-"]').first();
    await expect(metadata).toBeVisible();
    expect((await metadata.boundingBox())!.height).toBeGreaterThanOrEqual(20);
    const before = (await rail.boundingBox())!.width;
    await page.getByRole('button', { name: 'Widen work items' }).click();
    await expect.poll(async () => (await rail.boundingBox())!.width).toBeGreaterThan(before + 180);
    const separator = page.getByRole('separator', { name: 'Resize work items' });
    await separator.focus(); await page.keyboard.press('ArrowLeft');
    const resized = (await rail.boundingBox())!.width;
    await page.reload();
    await expect.poll(async () => (await rail.boundingBox())!.width).toBeCloseTo(resized, 0);
    await page.getByRole('button', { name: 'Reset work items width' }).click();
    await noOverflow(page);
    await page.screenshot({ path: test.info().outputPath(`work-${theme}.png`) });
    const toggle = page.getByTestId('work-item-brief-preview').getByRole('button');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const pane = page.getByTestId('initiative-pane');
    await expect(pane.getByTestId('brief-document')).toBeVisible();
    await expect(pane.getByRole('tablist')).toHaveCount(0);
    expect((await pane.boundingBox())!.width).toBeGreaterThan(900);
    await toggle.click();
    await expect(pane).toBeHidden();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await page.setViewportSize({ width: 900, height: 1000 });
    await expect(pane).toBeVisible();
    await expect(page.getByTestId('work-item-detail')).toBeHidden();
    await noOverflow(page);
    await page.screenshot({ path: test.info().outputPath(`brief-900-${theme}.png`) });
    await page.getByRole('button', { name: 'Close brief preview', exact: true }).click();
    await expect(toggle).toBeFocused();
    await page.setViewportSize({ width: 1680, height: 1050 });
    await page.getByTestId('initiative-details-trigger').click();
    await expect(page.getByTestId('initiative-pane-tab-details')).toHaveAttribute('aria-selected', 'true');
    await expect(pane).not.toContainText('Initiative details');
    await pane.getByRole('button', { name: /Open work item ORG-OBS-11/ }).click();
    await expect(pane).toBeHidden();
    await expect(page.getByTestId('work-item-detail')).toBeFocused();
    await expect(page).toHaveURL(/item=wi-obs-e2-b4/);
    await page.goto(workUrl.replace('wi-obs-e2-b4', 'wi-obs-e3-s1'));
    await page.getByTestId('initiative-details-trigger').click();
    await pane.getByRole('button', { name: /Open work item ORG-OBS-11/ }).click();
    await expect(page).toHaveURL(/item=wi-obs-e2-b4/);
    await expect(pane).toBeHidden();
    await expect(page.getByRole('heading', { level: 1, name: 'Stop duplicate alerts during a dependency outage' })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Show work items' }).click();
    await expect(page.getByTestId('mobile-work-navigation')).toBeVisible();
    await noOverflow(page);
    expect(writes).toEqual([]); expect(person.errors).toEqual([]);
  } finally { await person.close(); }
});

test('Design and Decisions share the initiative rail and content gutters', async ({ browser }) => {
  test.setTimeout(90_000);
  const person = await openAsClone(browser, 'u-release', { role: 'org-leader', expectTenant: 'orgiq', landing: null, viewport: { width: 1440, height: 1000 } });
  try {
    const page = person.page;
    const dimensions: { rail: number; gutter: number }[] = [];
    for (const path of ['/iq/projects?nav=section', '/iq/decisions?nav=section']) {
      await page.goto(path);
      const rail = page.locator('nav[aria-label="Explorer"]');
      await expect(rail).toBeVisible();
      const r = (await rail.boundingBox())!;
      const heading = page.getByRole('heading', { level: 1 }).first();
      await expect(heading).toBeVisible();
      dimensions.push({ rail: r.width, gutter: (await heading.boundingBox())!.x - r.x - r.width });
      await noOverflow(page);
      await page.screenshot({ path: test.info().outputPath(path.includes('decisions') ? 'decisions.png' : 'initiatives.png') });
    }
    expect(dimensions[1].rail).toBeCloseTo(dimensions[0].rail, 0);
    expect(dimensions[1].gutter).toBeCloseTo(dimensions[0].gutter, 0);
    for (const width of [1440, 900]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto('/iq/designs/des-auth-rotation?status=awaiting_input');
      await expect(page.locator('[data-catalog-navigation="combined"]')).toBeVisible();
      await expect(page.locator('nav[aria-label="Explorer"]')).toHaveCount(1);
      await expect(page.getByRole('heading', { level: 1, name: 'Session token rotation on tenant switch' })).toBeVisible();
      await expect(page.getByTestId('design-thread').locator('[data-variant="inline"]').first()).toBeVisible();
      await noOverflow(page);
      await page.screenshot({ path: test.info().outputPath(`design-${width}.png`) });
    }
    expect(person.errors).toEqual([]);
  } finally { await person.close(); }
});

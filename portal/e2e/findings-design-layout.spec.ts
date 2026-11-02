import { expect, test } from '@playwright/test';
import { openAsClone } from './realSession';

for (const theme of ['light', 'dark']) test(`Findings hierarchy and Design information pane: ${theme}`, async ({ browser }) => {
  test.setTimeout(120_000);
  const writes: string[] = [];
  const actor = await openAsClone(browser, 'u-release', {
    role: 'org-leader', expectTenant: 'orgiq', landing: null, viewport: { width: 1440, height: 1000 },
    prepare: async context => {
      await context.addInitScript(theme => {
        localStorage.setItem('orgiq:preferences:v1', JSON.stringify({ theme }));
        localStorage.setItem('shell.conversation-pane.open', '0');
      }, theme);
      await context.route('**/api/**', route => {
        if (['GET', 'HEAD', 'OPTIONS'].includes(route.request().method())) return route.continue();
        writes.push(route.request().url()); return route.abort();
      });
    },
  });
  try {
    const page = actor.page; page.setDefaultTimeout(15_000);
    await page.goto('/iq/work/findings');
    await expect(page.getByRole('tab', { name: 'Findings', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme === 'dark')).toBe(theme === 'dark');
    await expect(page.getByRole('tablist', { name: 'Finding status' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Failed runs' })).toHaveCount(0);
    const { findings } = await (await page.request.get('/api/work/findings?status=open&limit=200')).json();
    if (findings.length) {
      const row = page.locator(`[id="finding-${findings[0].id}"]`);
      await expect(row).toBeVisible();
      await expect(row.getByText(findings[0].title, { exact: true })).toHaveCSS('font-size', '14px');
    }
    await page.getByRole('tab', { name: /^Failed runs/ }).click();
    await expect(page.getByRole('heading', { name: 'Failed runs' })).toBeVisible();
    await expect(page.getByRole('tablist', { name: 'Finding status' })).toHaveCount(0);
    await page.getByRole('tab', { name: 'Findings', exact: true }).click();
    for (const width of [1440, 900]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: test.info().outputPath(`findings-${width}-${theme}.png`) });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/iq/designs/des-obs-dashboards?nav=section');
    await expect(page.getByRole('heading', { name: 'RED dashboards from span metrics', exact: true })).toBeVisible();
    const trail = page.locator('[data-catalog-navigation] [data-ui-breadcrumbs]');
    await expect(trail).toContainText('Designs');
    await expect(trail).not.toContainText('All designs');
    expect(await trail.locator('li').allTextContents()).toHaveLength(2);
    const row = page.getByRole('button', { name: 'RED dashboards from span metrics', exact: true });
    const group = page.getByRole('button', { name: /^Ideating 1/ });
    const firstInk = async (locator: typeof row) => locator.evaluate(el => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) if (walker.currentNode.textContent?.trim()) {
        const range = document.createRange(); range.selectNodeContents(walker.currentNode); return range.getBoundingClientRect().left;
      }
      return -1;
    });
    expect(Math.abs(await firstInk(row) - await firstInk(group))).toBeLessThanOrEqual(1);
    await page.getByRole('button', { name: 'Design details', exact: true }).click();
    await expect(page.getByTestId('design-details-pane')).toBeVisible();
    await expect(page.getByTestId('design-details-pane')).toContainText('People');
    await expect(page.getByTestId('design-thread')).not.toContainText('In this thread');
    for (const width of [1440, 900]) {
      await page.setViewportSize({ width, height: 1000 });
      if (width === 900) {
        // The measured pane policy folds on crossing the fit breakpoint.
        const toggle = page.getByRole('button', { name: 'Design details', exact: true });
        await expect(toggle).toHaveAttribute('aria-expanded', 'false');
        await toggle.click();
      }
      await expect(page.getByTestId('design-details-pane')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: test.info().outputPath(`design-${width}-${theme}.png`) });
    }
    expect(writes).toEqual([]); expect(actor.errors).toEqual([]);
  } finally { await actor.close(); }
});

import { test, expect } from '@playwright/test';
import { openAsClone } from './realSession';

test('Contacts keeps query, refresh and presence together above the roster', async ({ browser }) => {
  const reader = await openAsClone(browser, 'u-rachel', { tenant: 'social', landing: null, preJoin: 'remembered', label: 'compact-contacts-read-only' });
  const { page } = reader;
  const writes: string[] = [];
  await page.route('**/api/**', route => {
    const request = route.request();
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method()) || /\/(token|ticket)$/.test(new URL(request.url()).pathname)) return route.continue();
    writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
    return route.abort();
  });
  try {
    await page.goto('/social/contacts');
    const table = page.getByTestId('social-contacts-table');
    await expect(table.locator('tbody tr').first()).toBeVisible();
    for (const width of [1440, 900]) for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      const toolbar = page.getByRole('toolbar', { name: 'Contact filters', exact: true });
      const controls = toolbar.locator('[data-toolbar-controls]');
      await expect(controls.getByRole('button', { name: 'Refresh', exact: true })).toBeVisible();
      await expect(controls.getByTestId('social-contacts-here')).toContainText('Here now');
      const heading = (await page.getByRole('heading', { name: 'Contacts', exact: true }).boundingBox())!;
      const list = (await table.boundingBox())!;
      expect(list.y - heading.y - heading.height).toBeLessThanOrEqual(110);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
      await page.screenshot({ path: test.info().outputPath(`contacts-${width}-${theme}.png`) });
    }
    const search = page.getByRole('textbox', { name: 'Search contacts', exact: true });
    await search.fill('no-such-contact-layout-check');
    await expect(page.getByText('No person matches these filters.', { exact: true })).toBeVisible();
    await search.fill('');
    await page.getByRole('toolbar', { name: 'Contact filters', exact: true }).getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(table.locator('tbody tr').first()).toBeVisible();
    expect(writes).toEqual([]);
  } finally { await reader.close(); }
});

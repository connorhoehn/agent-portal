import { test, expect } from '@playwright/test';
import { openAsClone } from './realSession';

test('runbook review keeps code intact and navigates real sections', async ({ browser }) => {
  const reader = await openAsClone(browser, 'u-operator', { tenant: 'orgiq', landing: null, preJoin: 'remembered', label: 'runbook-review-read-only' });
  const { page } = reader;
  await page.route('**/api/**', route => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(route.request().method()) || /\/(token|ticket)$/.test(new URL(route.request().url()).pathname)) return route.continue();
    return route.abort();
  });
  try {
    // The proposal can arrive before its merge-target lookup. Do not reveal a
    // five-entry contents list and later insert a sixth entry under the reader.
    let releaseLibrary!: () => void;
    const libraryReady = new Promise<void>(resolve => { releaseLibrary = resolve; });
    const libraryUrl = '**/api/runbooks?status=draft,published,retired&limit=200';
    await page.route(libraryUrl, async route => { await libraryReady; await route.continue(); });
    await page.goto('/iq/runbooks/proposals/prop-tenant-cutover-callback');
    await expect(page.getByTestId('loading-state')).toBeVisible();
    await expect(page.getByTestId('proposal-contents')).toHaveCount(0);
    releaseLibrary();
    await expect(page.getByTestId('proposal-contents').getByRole('button')).toHaveCount(6);
    await page.unroute(libraryUrl);
    for (const theme of ['light', 'dark']) for (const width of [1440, 900]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto('/iq/runbooks/proposals/prop-tenant-cutover-callback');
      await page.evaluate(theme => { localStorage.setItem('theme', theme); document.documentElement.dataset.theme = theme; }, theme);
      const contents = page.getByTestId('proposal-contents');
      await expect(contents).toBeVisible();
      await contents.getByRole('button', { name: '2. Document changes', exact: true }).click();
      await expect(page.getByRole('heading', { name: '2. Document changes', exact: true })).toBeFocused();
      const diff = page.getByTestId('proposal-diff');
      const table = diff.locator('[data-ui-table-rows="code-diff"]');
      await expect(table).toBeVisible();
      const before = await table.textContent();
      const scroll = diff.locator('[data-ui-diff-scroll]');
      await scroll.evaluate(el => { el.scrollLeft = el.scrollWidth; });
      expect(await scroll.evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
      expect(await table.textContent()).toBe(before);
      const fileToggle = diff.locator('button[aria-expanded]');
      await fileToggle.click();
      await expect(table).toHaveCount(0);
      await diff.locator('button[title="SAML to Cognito migration.md"]').click();
      await expect(table).toBeVisible();
      expect(await table.textContent()).toBe(before);
      const nav = page.getByTestId('proposal-section-navigation');
      await nav.getByRole('button', { name: 'Next section', exact: true }).click();
      await expect(page.getByRole('heading', { name: '3. Review checks', exact: true })).toBeFocused();
      await nav.getByRole('button', { name: 'Previous section', exact: true }).click();
      await expect(page.getByRole('heading', { name: '2. Document changes', exact: true })).toBeFocused();
      await nav.getByRole('button', { name: 'Back to contents', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'On this page', exact: true })).toBeFocused();
      await page.goto('/iq/runbooks/rb-tenant-cutover');
      const host = page.getByTestId('collection-command-host');
      await host.locator('[contenteditable=true]').click();
      const help = host.getByRole('button', { name: /^Available .* commands$/ });
      await help.click();
      await expect(page.getByRole('dialog', { name: /^Available .* commands$/ })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog', { name: /^Available .* commands$/ })).toBeHidden();
    }
    expect(reader.errors).toEqual([]);
  } finally { await reader.close(); }
});

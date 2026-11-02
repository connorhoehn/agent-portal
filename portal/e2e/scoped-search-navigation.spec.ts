import { test, expect } from '@playwright/test';
import { openAsClone } from './realSession';

test('scoped search shows one list and preserves initiative context across content types', async ({ browser }) => {
  const reader = await openAsClone(browser, 'u-rachel', { tenant: 'orgiq', landing: null, preJoin: 'remembered', label: 'scoped-search-read-only' });
  const { page } = reader;
  const writes: string[] = [];
  await page.route('**/api/**', route => {
    const request = route.request();
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method()) || /\/(token|ticket)$/.test(new URL(request.url()).pathname)) return route.continue();
    writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
    return route.abort();
  });
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/iq/search?scope=p-llm-platform');
    const results = page.getByTestId('search-results');
    await expect(results.locator('[data-record-key]').first()).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('scoped-search-initial.png') });
    await expect(results.locator('[data-group]')).toHaveCount(1);
    await expect(results.locator('[data-group]')).toHaveAttribute('data-group', 'work');
    const response = await page.request.get('/api/search?scope=p-llm-platform&type=work&limit=100');
    expect(response.ok()).toBe(true);
    const work = await response.json();
    expect(work.results.length).toBeGreaterThan(0);
    expect(work.results.every((record: { sourceRefs?: Array<{ type: string; id: string }> }) =>
      record.sourceRefs?.some(ref => ref.type === 'initiative' && ref.id === 'p-llm-platform'))).toBe(true);
    await expect(page.getByTestId('search-trail')).toContainText('LLM Application Platform');
    const rail = page.getByTestId('search-type-rail');
    await rail.getByRole('link', { name: /^People/ }).click();
    await expect(results.locator('[data-group]')).toHaveAttribute('data-group', 'person');
    await expect(results.locator('[data-record-key^="work:"]')).toHaveCount(0);
    await rail.getByRole('link', { name: /^All results/ }).click();
    await expect(results.locator('[data-group]')).toHaveCount(1);
    await expect(results.locator('[data-group]')).toHaveAttribute('data-group', 'all');
    expect(new URL(page.url()).searchParams.get('scope')).toBe('p-llm-platform');
    await page.reload();
    await expect(results.locator('[data-group]')).toHaveAttribute('data-group', 'all');
    await page.goBack();
    await expect(results.locator('[data-group]')).toHaveAttribute('data-group', 'person');
    for (const width of [1440, 900]) for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      await page.waitForTimeout(300); // Let token color transitions settle before visual evidence.
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
      await page.screenshot({ path: test.info().outputPath(`scoped-search-${width}-${theme}.png`) });
    }
    // A type with no matching records stays an empty typed view; it never
    // silently falls back to a different collection or clears the scope.
    await page.goto('/iq/search?scope=p-llm-platform&type=work&q=no-such-work-navigation-check');
    await expect(results).toContainText('No matching work');
    await expect(results.locator('[data-record-key]')).toHaveCount(0);
    expect(new URL(page.url()).searchParams.get('scope')).toBe('p-llm-platform');
    expect(writes).toEqual([]);
    expect(reader.errors).toEqual([]);
  } finally { await reader.close(); }
});

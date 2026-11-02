import { test, expect } from '@playwright/test';
import { openAsClone } from './realSession';

test('Work command inputs show their own keyboard focus in both themes', async ({ browser }) => {
  const reader = await openAsClone(browser, 'u-operator', { tenant: 'orgiq', landing: null, preJoin: 'remembered', label: 'work-command-focus-read-only' });
  const { page } = reader;
  await page.route('**/api/**', route => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(route.request().method()) || /\/(token|ticket)$/.test(new URL(route.request().url()).pathname)) return route.continue();
    return route.abort();
  });
  try {
    for (const theme of ['light', 'dark']) for (const path of [
      '/iq/work/job-inf-maint-1', '/iq/designs/des-obs-dashboards', '/iq/decisions/d-cognito-cutover',
    ]) {
      await page.goto(path);
      const editor = page.locator('[data-testid="job-composer-input"], [data-testid="collection-command-input-input"]');
      await expect(editor).toBeVisible();
      await page.evaluate(theme => { localStorage.setItem('theme', theme); document.documentElement.dataset.theme = theme; }, theme);
      await page.waitForTimeout(300);
      // Walk from the document with real Tab events, so :focus-visible is
      // exercised as a keyboard user encounters the initially compact input.
      let found = false;
      for (let step = 0; step < 90; step++) {
        await page.keyboard.press('Tab');
        if (await editor.evaluate(node => node === document.activeElement)) { found = true; break; }
      }
      expect(found, `${path} keyboard reachability`).toBe(true);
      await expect.poll(() => editor.evaluate(node => {
        const style = getComputedStyle(node);
        return node.matches(':focus-visible') && style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 2;
      })).toBe(true);
      await page.keyboard.type('Unsent focus check');
      await expect(editor).toContainText('Unsent focus check');
      await expect.poll(() => editor.evaluate(node => parseFloat(getComputedStyle(node).outlineWidth))).toBeGreaterThanOrEqual(2);
      await page.keyboard.press('Meta+A');
      await page.keyboard.press('Backspace');
    }
    expect(reader.errors).toEqual([]);
  } finally { await reader.close(); }
});

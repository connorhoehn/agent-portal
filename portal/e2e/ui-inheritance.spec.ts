import { test, expect } from '@playwright/test';
import { signIn } from './realSession';
import { chooseOption } from './selectOption';

test('collection controls and table spacing inherit shared tokens in the live shell', async ({ page }) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  const cdp = await page.context().newCDPSession(page); await cdp.send('Performance.enable');
  await signIn(page, 'u-kofi', { tenant: 'pipelines' });
  await page.addInitScript(() => localStorage.setItem('theme', 'dark'));
  await page.goto('/pipelines/runs');
  await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
  const toolbar = page.getByRole('toolbar', { name: 'Run filters' });
  await expect(toolbar).toBeVisible();
  await expect(toolbar.getByRole('combobox')).toHaveCount(0);
  const filters = toolbar.getByRole('button', { name: 'Filters', exact: true });
  const refresh = toolbar.getByRole('button', { name: 'Refresh', exact: true });
  await expect(refresh).toBeEnabled();
  expect((await refresh.boundingBox())?.height).toBe(28);
  expect((await filters.boundingBox())?.height).toBe(28);
  await filters.click();
  await expect(page.getByRole('combobox', { name: 'Status', exact: true })).toBeVisible();
  await chooseOption(page.getByRole('combobox', { name: 'Status', exact: true }), 'running');
  await expect(toolbar.getByRole('button', { name: 'Filters (1 active)' })).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Run filters' })).toHaveCount(0);
  const info = toolbar.getByRole('button', { name: 'About these results' });
  if (await info.count()) {
    await info.click(); await expect(page.getByRole('dialog', { name: 'About these results' })).toContainText('no run id'); await page.keyboard.press('Escape');
  }
  await page.screenshot({ path: test.info().outputPath('runs-dark.png') });
  // A single shell token changes controls on two independent routes and table insets.
  for (const route of ['runs', 'definitions']) {
    await page.goto('/pipelines/' + route);
    const action = page.getByRole('toolbar').getByRole('button', { name: 'Refresh', exact: true });
    await expect(action).toBeVisible();
    await page.evaluate(() => { document.documentElement.style.setProperty('--ui-control-sm', '32px'); document.documentElement.style.setProperty('--ui-table-inset', '20px'); });
    expect((await action.boundingBox())?.height).toBe(32);
    const cell = page.getByRole('table').locator('thead th').first();
    expect(await cell.evaluate(el => getComputedStyle(el).paddingLeft)).toBe('20px');
    await page.evaluate(() => { document.documentElement.style.removeProperty('--ui-control-sm'); document.documentElement.style.removeProperty('--ui-table-inset'); });
    await page.setViewportSize({ width: 900, height: 800 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: test.info().outputPath(route + '-narrow.png') });
  }
  await test.info().attach('cdp-metrics', { body: JSON.stringify(await cdp.send('Performance.getMetrics')), contentType: 'application/json' });
  await cdp.detach(); expect(errors).toEqual([]);
});

test('Work and Social reuse the collection and composer surfaces with live data', async ({ page }) => {
  test.setTimeout(90_000);
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await signIn(page, 'u-operator', { tenant: 'orgiq' });
  await page.goto('/iq/runs');
  await expect(page.getByRole('toolbar', { name: 'Run filters' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Filters', exact: true })).toBeVisible();
  expect((await page.getByRole('toolbar').getByRole('button', { name: 'Refresh', exact: true }).boundingBox())?.height).toBe(28);
  for (const route of ['/iq/search', '/iq/projects/p-design-system-api']) {
    await page.goto(route);
    const surface = page.locator('[data-composer-surface]');
    await expect(surface).toHaveCount(1); await expect(surface).toBeVisible();
    await expect(surface.locator('[contenteditable=true]')).toHaveCount(1);
    const before = await surface.evaluate(el => getComputedStyle(el).paddingLeft);
    expect(before).toBe('16px');
    await page.evaluate(() => document.documentElement.style.setProperty('--ui-content-gutter', '24px'));
    expect(await surface.evaluate(el => getComputedStyle(el).paddingLeft)).toBe('24px');
    const decoration = await surface.evaluate(el => ({ background: getComputedStyle(el, '::before').backgroundImage, left: getComputedStyle(el, '::before').left, right: getComputedStyle(el, '::before').right }));
    expect(decoration.background).not.toBe('none'); expect(parseFloat(decoration.left)).toBeLessThanOrEqual(0); expect(parseFloat(decoration.right)).toBeLessThanOrEqual(0);
    await page.evaluate(() => document.documentElement.style.removeProperty('--ui-content-gutter'));
    await page.screenshot({ path: test.info().outputPath(route.includes('search') ? 'work-search.png' : 'initiative.png') });
  }
  await signIn(page, 'u-theo', { tenant: 'social' });
  await page.goto('/social/contacts');
  await expect(page.locator('[data-collection-page]')).toBeVisible();
  await expect(page.getByRole('toolbar', { name: 'Table controls' })).toBeVisible();
  await page.goto('/social/dms/social%3Adm%3Au-mira%3Au-theo');
  const surface = page.locator('[data-composer-surface]');
  await expect(surface).toHaveCount(1); await expect(surface).toBeVisible();
  expect(await surface.evaluate(el => getComputedStyle(el).paddingLeft)).toBe('16px');
  await page.screenshot({ path: test.info().outputPath('social-dm.png') });
  expect(errors).toEqual([]);
});


test('Assessment inherits the same controls through its shared pipeline ledger', async ({ page }) => {
  await signIn(page, 'u-operator', { tenant: 'assessment' });
  await page.goto('/assessment/runs');
  await expect(page.getByTestId('assessment-pipeline-runs')).toBeVisible();
  const toolbar = page.getByRole('toolbar', { name: 'Run filters' });
  await expect(toolbar).toBeVisible();
  const filters = toolbar.getByRole('button', { name: 'Filters', exact: true });
  expect((await filters.boundingBox())?.height).toBe(28);
  await page.evaluate(() => document.documentElement.style.setProperty('--ui-control-sm', '32px'));
  expect((await filters.boundingBox())?.height).toBe(32);
  await filters.click();
  await expect(page.getByRole('combobox', { name: 'Status', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Run filters' })).toHaveCount(0);
});

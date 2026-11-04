import { test, expect } from '@playwright/test';
import { openAsClone } from './realSession';

for (const itemId of ['wi-obs-e3-s1', 'wi-obs-e2-b4']) test(`Work item ${itemId}: compact choices, preview pane and movable Today strip`, async ({ browser }) => {
  const writes: string[] = [];
  const person = await openAsClone(browser, 'u-release', {
    role: 'org-leader', expectTenant: 'orgiq', landing: null,
    viewport: { width: 1680, height: 1050 }, consoleErrors: true,
    prepare: async context => {
      await context.route('**/api/**', route => {
        const request = route.request();
        if (['GET', 'HEAD', 'OPTIONS'].includes(request.method())) return route.continue();
        writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
        return route.abort();
      });
    },
  });
  try {
    const page = person.page;
    await page.goto(`/iq/projects/p-observability?scope=all&tab=work&item=${itemId}`);
    const composer = page.getByTestId('initiative-composer');
    const input = composer.locator('.ProseMirror');
    const prompt = composer.locator('[data-composer-prompt]');
    await page.getByTestId('initiative-header-menu-trigger').click();
    await page.getByTestId('work-item-prepare-job').click();
    await expect(composer.locator('[data-composer-prompt-option="cap"]')).toBeVisible();
    await expect(composer.locator('[data-composer-prompt-option]:focus')).toHaveCount(1);
    await expect(input).toHaveCount(0);
    await expect(composer.getByRole('toolbar')).toHaveCount(0);
    await page.keyboard.press('3');
    await expect(prompt).toHaveAttribute('data-composer-prompt-kind', 'choice');
    await expect(prompt).toContainText('Run cap');
    await expect(composer.locator('[data-composer-prompt-option="forecast"]')).toBeVisible();
    await page.keyboard.press('2');
    await expect(prompt).toContainText('Dispatch with these settings?');
    await expect(input).toHaveCount(0);
    await composer.screenshot({ path: test.info().outputPath('work-item-cap-chosen.png') });
    await composer.getByRole('button', { name: 'Hide', exact: true }).click();
    await expect(input).toBeFocused();
    await page.getByRole('button', { name: 'Open brief preview in side pane' }).click();
    await expect(page).toHaveURL(/pane=brief/);
    const pane = page.getByTestId('initiative-pane-brief');
    await expect(pane.getByTestId('brief-document')).toBeVisible();
    await expect(page.getByTestId('work-item-detail').getByTestId('brief-document')).toHaveCount(0);
    // The brief's reading surface owns the scroll (b82ab2a9), not the pane body around it.
    const reader = pane.getByTestId('brief-markdown-workspace');
    await expect(reader).toHaveAttribute('data-reading-presentation', 'pane');
    expect(await pane.evaluate(el => getComputedStyle(el).overflowY)).not.toBe('auto');
    expect(await reader.evaluate(el => ['auto', 'scroll'].includes(getComputedStyle(el).overflowY))).toBe(true);
    await expect(page.getByTestId('initiative-pane').getByRole('tablist')).toHaveCount(0);
    const toggle = page.getByTestId('work-item-brief-preview').getByRole('button');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await toggle.click();
    await expect(pane).toBeHidden();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await expect(pane.getByTestId('brief-document')).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('work-item-brief-pane.png') });
    // Drag to the header, reload to prove device persistence, then use the
    // same grip's keyboard action to restore the footer.
    const grip = page.getByRole('button', { name: 'Move Today strip to header' });
    await expect(grip).toBeVisible();
    const start = (await grip.boundingBox())!;
    await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
    await page.mouse.down();
    await page.mouse.move(start.x + 15, start.y - 20, { steps: 5 });
    const target = page.locator('[data-today-drop-zone="header"]');
    await expect(target).toBeVisible();
    const end = (await target.boundingBox())!;
    await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 12 });
    await page.mouse.up();
    await expect(page.locator('.shell-header').getByTestId('footer-today')).toBeVisible();
    await page.reload();
    await expect(page.locator('.shell-header').getByTestId('footer-today')).toBeVisible();
    for (const width of [1440, 900]) {
      await page.setViewportSize({ width, height: 1050 });
      const header = page.locator('.shell-header');
      const ticker = header.getByTestId('footer-today');
      await expect(ticker).toBeVisible();
      const box = (await ticker.boundingBox())!;
      const boundary = (await header.boundingBox())!;
      expect(box.x).toBeGreaterThan(boundary.x);
      expect(box.x + box.width).toBeLessThanOrEqual(boundary.x + boundary.width);
      expect(box.y + box.height).toBeLessThanOrEqual(boundary.y + boundary.height);
    }
    const moveBack = page.getByRole('button', { name: 'Move Today strip to footer' });
    await moveBack.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('shell-footer').getByTestId('footer-today')).toBeVisible();
    expect(writes).toEqual([]);
    expect(person.errors).toEqual([]);
  } finally { await person.close(); }
});

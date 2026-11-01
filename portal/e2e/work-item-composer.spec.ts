import { test, expect } from '@playwright/test';
import { openAsClone } from './realSession';

test('the reported Work item accepts cap choices without clicking into the agent composer', async ({ browser }) => {
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
    await page.goto('/iq/projects/p-observability?scope=all&tab=work&item=wi-obs-e3-s1');
    const composer = page.getByTestId('initiative-composer');
    const input = composer.locator('.ProseMirror');
    const prompt = composer.locator('[data-composer-prompt]');
    await page.getByTestId('initiative-header-menu-trigger').click();
    await page.getByTestId('work-item-prepare-job').click();
    await expect(composer.locator('[data-composer-prompt-option="cap"]')).toBeVisible();
    await expect(input).toBeFocused();
    await page.keyboard.press('3');
    await expect(prompt).toHaveAttribute('data-composer-prompt-kind', 'choice');
    await expect(prompt).toContainText('Run cap');
    await expect(composer.locator('[data-composer-prompt-option="forecast"]')).toBeVisible();
    await page.keyboard.press('2');
    await expect(prompt).toContainText('Dispatch with these settings?');
    await expect(input).toHaveText('');
    await composer.screenshot({ path: test.info().outputPath('work-item-cap-chosen.png') });
    expect(writes).toEqual([]);
    expect(person.errors).toEqual([]);
  } finally { await person.close(); }
});

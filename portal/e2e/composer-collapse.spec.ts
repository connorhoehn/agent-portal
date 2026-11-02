import { expect, test } from '@playwright/test';
import { openAsClone } from './realSession';
for (const theme of ['light','dark']) for (const width of [1440,900]) {
  test(`Work composer can fold an unsent draft: ${theme}/${width}`, async ({ browser }) => {
    const actor = await openAsClone(browser, 'u-rachel', { tenant: 'orgiq', landing: null, viewport: { width, height: 1000 }, prepare: async context => {
      await context.addInitScript(theme => localStorage.setItem('orgiq:preferences:v1', JSON.stringify({ theme })), theme);
    } });
    try {
      const { page } = actor;
      await page.goto('/iq/projects/p-observability?scope=all&tab=work');
      const dock = page.getByTestId('initiative-composer');
      const input = dock.locator('[contenteditable=true]').first();
      await input.fill('Keep this unsent review note.');
      const before = (await dock.boundingBox())!.height;
      await dock.getByRole('button', { name: 'Collapse composer' }).click();
      const expand = dock.getByRole('button', { name: 'Expand composer' });
      await expect(expand).toBeVisible();
      await expect(expand).toBeFocused();
      await expect(input).toBeHidden();
      const folded = (await dock.boundingBox())!.height;
      expect(folded).toBeLessThan(70);
      expect(before - folded).toBeGreaterThan(50);
      await page.screenshot({ path: test.info().outputPath(`composer-${theme}-${width}-folded.png`) });
      await expand.press('Enter');
      await expect(input).toBeFocused();
      await expect(input).toHaveText('Keep this unsent review note.');
      expect(actor.errors).toEqual([]);
    } finally { await actor.close(); }
  });
}

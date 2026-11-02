import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { measureDOM } from '../../.claude/skills/ui-dom-audit/scripts/measure.mjs';
const fullContract = JSON.parse(readFileSync(new URL('../../.claude/skills/ui-dom-audit/references/work-ui.contract.json', import.meta.url), 'utf8'));
const contract = { ...fullContract, rules: fullContract.rules.filter((rule: { id: string }) => ['call.gallery.tile-width', 'composer.folded.height'].includes(rule.id)) };

for (const theme of ['light', 'dark']) for (const width of [1440, 900, 540]) {
  test(`call gallery and right sidebar: ${theme}/${width}`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width, height: 850 });
    await page.route('**/__hangout-gallery', route => route.fulfill({ contentType: 'text/html', body: '<html><head><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true;</script></head><body><div id="root"></div><script type="module" src="/e2e/fixtures/hangout-gallery.tsx"></script></body></html>' }));
    await page.goto('/__hangout-gallery');
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    const sidebar = page.getByTestId('hangout-call-sidebar');
    const gallery = page.getByTestId('hangout-gallery');
    await expect(sidebar).toBeVisible();
    if (width >= 900) expect((await sidebar.boundingBox())!.x).toBeGreaterThanOrEqual((await gallery.boundingBox())!.x + (await gallery.boundingBox())!.width - 1);
    const reports = [];
    for (const count of [1,2,6,12]) {
      await page.getByRole('button', { name: `${count} people`, exact: true }).click();
      const tiles = page.getByTestId('call-dock-tile-row').locator('[data-peer-id]');
      await expect(tiles).toHaveCount(count);
      for (const tile of await tiles.all()) {
        const box = (await tile.boundingBox())!;
        expect(box.width).toBeLessThanOrEqual(416.5);
        expect(Math.abs(box.width / box.height - 16/9)).toBeLessThan(0.02);
      }
      const controls = page.getByTestId('call-dock-controls');
      const box = (await controls.boundingBox())!;
      expect(box.y + box.height).toBeLessThanOrEqual(850);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
      const measured = await page.evaluate(measureDOM, { contract, selectors: {} });
      expect(measured.issues).toEqual([]);
      reports.push({ count, measured, tile: await tiles.first().boundingBox(), controls: box });
      if (count === 1 || count === 6) await page.screenshot({ path: test.info().outputPath(`gallery-${theme}-${width}-${count}.png`) });
    }
    // Opening chat does not replace or remount the gallery's media.
    await page.getByTestId('media-0').evaluate(el => el.setAttribute('data-same-sink', 'yes'));
    await sidebar.getByRole('tab', { name: 'Conversation' }).click();
    await expect(sidebar.getByRole('textbox').first()).toBeVisible();
    await expect(page.getByTestId('media-0')).toHaveAttribute('data-same-sink', 'yes');
    await page.getByRole('button', { name: 'Close call sidebar' }).click();
    await expect(sidebar).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Conversation', exact: true })).toBeFocused();
    await page.getByRole('button', { name: 'Conversation', exact: true }).click();
    await expect(sidebar).toBeVisible();
    await sidebar.getByRole('button', { name: 'Close call sidebar' }).press('Escape');
    await expect(sidebar).toHaveCount(0);
    expect(errors).toEqual([]);
    await test.info().attach('gallery-geometry', { body: JSON.stringify(reports), contentType: 'application/json' });
  });
}

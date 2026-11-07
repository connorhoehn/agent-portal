import { test, expect } from './cdpTest';
import { measureDOM } from './lib/ui-dom-audit/measure.mjs';

test('compact call columns fit narrow and wide hosts with one or several participants', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/__compact-call-dock', route => route.fulfill({ contentType: 'text/html', body: '<html><head><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true;</script></head><body><div id="root"></div><script type="module" src="/e2e/fixtures/compact-call-dock.tsx"></script></body></html>' }));
  await page.goto('/__compact-call-dock');
  const reports = [];
  const dock = page.getByTestId('call-dock');
  for (const theme of ['light', 'dark']) for (const width of [1100, 700, 360]) {
    await page.setViewportSize({ width, height: 700 });
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    for (const count of [1, 6]) {
      if (count === 6) await page.getByRole('button', { name: 'Toggle participants' }).click();
      for (const phase of ['active', 'connecting', 'reconnecting']) {
        await page.getByRole('button', { name: phase, exact: true }).click();
        await expect(dock).toHaveAttribute('data-layout', 'compact');
        const box = await dock.boundingBox();
        const maxHeight = width >= 700 ? (phase === 'reconnecting' ? 130 : 110) : 170;
        expect(box!.height, `${theme} ${width} ${count} ${phase}`).toBeLessThanOrEqual(maxHeight);
        const report = await page.evaluate(measureDOM, { contract: { version: 1, rules: [
          { id: 'call.viewport', kind: 'viewport' },
          { id: 'call.controls-fit', kind: 'within', selector: '[data-testid="call-dock-controls"]', anchor: '[data-testid="call-dock-compact-columns"]', ancestor: true },
          { id: 'call.text-overlap', kind: 'text-overlap', selector: '[data-testid="call-dock"]' },
          { id: 'call.text-clipped', kind: 'text-clipped', selector: '[data-testid="call-dock"]' },
        ] }, selectors: {} });
        expect(report.issues, `${theme} ${width} ${count} ${phase}`).toEqual([]);
        reports.push({ theme, width, count, phase, height: box!.height, ...report });
        if (phase === 'active') await page.screenshot({ path: test.info().outputPath(`call-${theme}-${width}-${count}.png`) });
      }
      if (count === 6) await page.getByRole('button', { name: 'Toggle participants' }).click();
    }
    await page.getByRole('button', { name: 'active', exact: true }).click();
    await dock.getByTestId('call-dock-more').click();
    await expect(page.getByRole('menu')).toBeVisible();
    await page.getByRole('menuitem', { name: 'Call settings', exact: true }).click();
    await expect(page.getByRole('menu')).toHaveCount(0);
  }
  await test.info().attach('compact-call-audit', { body: JSON.stringify(reports, null, 2), contentType: 'application/json' });
  expect(errors).toEqual([]);
});

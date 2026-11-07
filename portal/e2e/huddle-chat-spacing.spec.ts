import { test, expect } from './cdpTest';
import { measureDOM } from './lib/ui-dom-audit/measure.mjs';

test('shared chat stays compact in empty, short and historical conversations', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/__huddle-chat-spacing', route => route.fulfill({ contentType: 'text/html', body: '<html><head><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true;</script></head><body><div id="root"></div><script type="module" src="/e2e/fixtures/huddle-chat-spacing.tsx"></script></body></html>' }));
  await page.goto('/__huddle-chat-spacing');
  const reports = [];
  for (const theme of ['light', 'dark']) for (const width of [700, 360]) {
    await page.setViewportSize({ width, height: 760 });
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    for (const scenario of ['empty', 'single', 'consecutive', 'history']) {
      await page.getByRole('button', { name: scenario, exact: true }).click();
      const days = page.getByTestId('chat-day-separator');
      await expect(days).toHaveCount(scenario === 'empty' ? 0 : scenario === 'history' ? 2 : 1);
      if (scenario !== 'empty') {
        const [day, log] = await Promise.all([days.first().boundingBox(), page.getByRole('log').boundingBox()]);
        expect(day!.y - log!.y).toBeLessThanOrEqual(2);
        if (scenario === 'history') await expect(days.last()).toHaveAttribute('data-day-label', 'Today');
      }
      if (scenario === 'consecutive') {
        const rows = await page.getByTestId('message-row-content').all();
        const [first, second] = await Promise.all(rows.map(row => row.boundingBox()));
        expect(second!.y - first!.y - first!.height).toBeLessThanOrEqual(8);
        const metadata = await page.getByTestId('message-row-header').boundingBox();
        expect(first!.y - metadata!.y - metadata!.height).toBeLessThanOrEqual(6);
        expect(metadata!.height).toBeLessThanOrEqual(24);
        await expect(page.getByTestId('message-row-header')).toHaveCount(1);
        await page.getByTestId('chat-message').last().hover();
        await page.getByTestId('chat-message').last().getByRole('button', { name: 'Message actions', exact: true }).click();
        const menu = page.getByRole('dialog', { name: 'Message actions', exact: true });
        await expect(menu).toBeVisible();
        const box = await menu.boundingBox();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(width);
        await menu.getByRole('button', { name: 'More reactions', exact: true }).click();
        const picker = page.getByTestId('reaction-picker-popover');
        await expect(picker).toBeVisible();
        await picker.getByTestId('reaction-picker-item').first().click();
        await expect(picker).toHaveCount(0);
        await page.keyboard.press('Escape');
        await expect(menu).toHaveCount(0);
      }
      const report = await page.evaluate(measureDOM, { contract: { version: 1, rules: [
        { id: 'chat.text-overlap', kind: 'text-overlap', selector: '[data-testid="chat-spacing-frame"]' },
        { id: 'chat.text-clipped', kind: 'text-clipped', selector: '[data-testid="chat-spacing-frame"]' },
        { id: 'chat.rows-fit', kind: 'within', selector: '[data-testid="chat-message"]', anchor: '[role="log"]', ancestor: true, axes: ['x'] },
      ] }, selectors: {} });
      expect(report.issues, `${theme} ${width} ${scenario}`).toEqual([]);
      reports.push({ theme, width, scenario, ...report });
      if (scenario === 'consecutive') await page.screenshot({ path: test.info().outputPath(`chat-${theme}-${width}.png`) });
    }
  }
  await test.info().attach('chat-spacing-audit', { body: JSON.stringify(reports, null, 2), contentType: 'application/json' });
  expect(errors).toEqual([]);
});

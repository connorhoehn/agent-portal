import { test, expect } from '@playwright/test';

// Actual packed controls and the portal's composer CSS; no call signalling or
// recording. The fixture owns and closes its canvas media streams.
test('embedded call controls retain spacing and count badges stay inside their buttons', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/__meeting-composer*', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body><div id="root"></div>
    <script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true;
    </script><script type="module" src="/e2e/fixtures/composer-call-media.tsx"></script></body></html>` }));
  await page.goto('/__meeting-composer?meeting=1');
  await expect(page.getByTestId('meeting-toolbar-people-count')).toBeVisible();
  for (const theme of ['light', 'dark']) for (const width of [1440, 900, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(theme => { document.documentElement.setAttribute('data-theme', theme); document.documentElement.classList.toggle('dark', theme === 'dark'); }, theme);
    const media = page.getByTestId('shell-call-media');
    await media.screenshot({ path: test.info().outputPath(`meeting-${theme}-${width}.png`) });
    const geometry = await media.evaluate(root => {
      const header = root.querySelector('[data-testid="fixture-call-dock-header"]')!.getBoundingClientRect();
      const dock = root.querySelector('[data-testid="fixture-call-dock"]')!.getBoundingClientRect();
      const badges = [...root.querySelectorAll('[data-ui-badge="count"]')].map(node => {
        const b = node.getBoundingClientRect(), owner = node.closest('button')!.getBoundingClientRect();
        return { left: b.left - owner.left, right: owner.right - b.right, top: b.top - owner.top, bottom: owner.bottom - b.bottom };
      });
      return { inset: header.top - dock.top, badges };
    });
    expect(geometry.inset).toBeGreaterThanOrEqual(8);
    for (const badge of geometry.badges) for (const margin of Object.values(badge)) expect(margin).toBeGreaterThanOrEqual(0);
    const toolbar = page.getByTestId('meeting-toolbar');
    if ((await toolbar.boundingBox())!.width < 820) {
      await expect(toolbar).toHaveAttribute('data-layout', 'phone');
      await page.getByTestId('meeting-toolbar-more').click();
      await expect(page.getByRole('menuitem', { name: 'People (1)', exact: true })).toBeVisible();
      await page.keyboard.press('Escape');
    } else {
      const before = await page.getByTestId('meeting-toolbar-people').boundingBox();
      const next = await page.getByTestId('meeting-toolbar-raise').boundingBox();
      expect(before!.x + before!.width).toBeLessThanOrEqual(next!.x);
    }
  }
  expect(errors).toEqual([]);
});

import { test, expect } from '@playwright/test';
test.use({ baseURL: process.env.PARITY_BASE_URL ?? 'http://127.0.0.1:5263' });
async function fixture(page: import('@playwright/test').Page, suffix = '') {
  await page.route('**/api/**', route => route.abort());
  await page.route('**/__preview-recovery**', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body><div id="root"></div><script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script><script type="module" src="/e2e/fixtures/deck-preview-recovery.tsx"></script></body></html>` }));
  await page.goto('/__preview-recovery' + suffix);
}
test('StrictMode cleanup does not leave the exact slide stuck rendering', async ({ page }) => {
  await fixture(page);
  await expect(page.getByTestId('preview-state')).toHaveText('Ready');
});
test('a stalled preview becomes retryable and the same slide can recover', async ({ page }) => {
  await page.clock.install();
  await fixture(page, '?hang=1');
  await expect(page.getByTestId('preview-state')).toHaveText('Loading');
  await page.clock.runFor(46_000);
  await expect(page.getByTestId('preview-state')).toContainText('took too long');
  await page.getByRole('button', { name: 'Retry preview' }).click();
  await page.clock.runFor(1_000);
  await expect(page.getByTestId('preview-state')).toHaveText('Ready');
});

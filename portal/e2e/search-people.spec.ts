import { expect, test } from '@playwright/test';

test('shared people rows use portraits and confirmed presence, with honest unknown and broken-avatar fallback', async ({ page }) => {
  test.setTimeout(90_000);
  let writes = 0;
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', route => { if (!['GET', 'HEAD'].includes(route.request().method())) writes++; return route.abort(); });
  await page.route('**/broken-avatar.jpg', route => route.fulfill({ status: 404, body: '' }));
  await page.route('**/__search-people', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script><script type="module" src="/e2e/fixtures/search-people.tsx"></script></body></html>' }));
  await page.goto('/__search-people');
  const layla = page.locator('[data-record-key="person:p-008"]');
  const unknown = page.locator('[data-record-key="person:unknown"]');
  const portrait = layla.locator('img');
  await expect(portrait).toHaveAttribute('src', '/avatars/photos/p-008.jpg');
  await expect.poll(() => portrait.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
  await expect(layla).toContainText('Engineer · Platform · Online');
  await expect(unknown.locator('img')).toHaveCount(0);
  await expect(unknown).not.toContainText('No self-disclosed');
  await expect(page.getByText('Private inferred text')).toHaveCount(0);
  await page.getByRole('button', { name: 'away', exact: true }).click();
  await expect(layla).toContainText('Engineer · Platform · Away');
  for (const state of ['offline', 'unknown', 'disconnected']) {
    await page.getByRole('button', { name: state, exact: true }).click();
    await expect(layla).not.toContainText(/Online|Away|last online/i);
  }
  await page.getByRole('button', { name: 'wrong-name', exact: true }).click();
  await expect(layla.locator('img')).toHaveCount(0);
  await page.getByRole('button', { name: 'broken', exact: true }).click();
  await expect(layla.locator('img')).toHaveCount(0);
  await expect(layla).toContainText('LH');
  await page.getByRole('button', { name: 'online', exact: true }).click();
  await expect(layla.locator('img')).toHaveAttribute('src', '/avatars/photos/p-008.jpg');
  await page.screenshot({ path: test.info().outputPath('search-people.png') });
  expect(writes).toBe(0);
  expect(errors).toEqual([]);
});

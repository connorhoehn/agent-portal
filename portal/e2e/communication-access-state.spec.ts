import { test, expect } from './cdpTest';

test.use({ baseURL: 'http://localhost:5183', viewport: { width: 1440, height: 900 }, actionTimeout: 5_000, navigationTimeout: 10_000 });

test('Communication access states are compact and actionable without empty-inbox claims', async ({ page }) => {
  const errors: string[] = [], writes: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.method() !== 'GET') writes.push(request.url()); });
  await page.route('**/__communication-access', route => route.fulfill({ contentType: 'text/html', body: '<html><head><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => (type) => type; window.__vite_plugin_react_preamble_installed__ = true;</script></head><body><div id="root"></div><script type="module" src="/e2e/fixtures/communication-access.tsx"></script></body></html>' }));
  await page.goto('/__communication-access');
  const card = page.getByTestId('communication-access-state');
  await expect(card).toHaveAttribute('data-state', 'loading');
  await expect(card).toContainText('Checking Communication access');
  await expect(card.getByRole('button')).toHaveCount(0);
  await page.getByTestId('show-invalid').click();
  await expect(card.getByRole('heading', { name: 'Sign in again', exact: true })).toBeVisible();
  await card.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByTestId('callback-count')).toHaveText('Sign ins 1; retries 0');
  await page.screenshot({ path: test.info().outputPath('communication-invalid-wide.png') });
  await page.getByTestId('show-unavailable').click();
  await expect(card).toContainText('Your access could not be confirmed');
  await expect(card.getByRole('button', { name: 'Sign in', exact: true })).toHaveCount(0);
  await card.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByTestId('callback-count')).toHaveText('Sign ins 1; retries 1');
  await page.getByTestId('show-signed-out').click();
  await expect(card).toContainText('Sign in to Communication');
  await expect(card).not.toContainText(/Ask an admin|No messages|No conversations|Not one of your groups/);
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.screenshot({ path: test.info().outputPath('communication-signed-out-narrow.png') });
  const bounds = await card.boundingBox();
  expect(bounds).toBeTruthy(); expect(bounds!.width).toBeLessThanOrEqual(560); expect(bounds!.height).toBeLessThan(180);
  expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(1024);
  expect(writes).toEqual([]); expect(errors).toEqual([]);
});

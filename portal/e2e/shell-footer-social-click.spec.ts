// The footer's Social button goes to the tenant's Communication plane (or
// /social/channels in Social) when the user holds a Social grant, and keeps the
// panel otherwise. Pure target logic: src/components/shell/__tests__/socialEntryModel.test.ts.
import { test, expect } from '@playwright/test';
import { signIn } from './realSession';

test.use({ baseURL: process.env.PARITY_BASE_URL ?? 'http://127.0.0.1:5183', viewport: { width: 1680, height: 940 } });

async function enter(page: import('@playwright/test').Page, userId: string, tenant: string, to: string) {
  await signIn(page, userId, { tenant });
  await page.goto(to);
  await expect(page.getByTestId('shell-footer')).toHaveCount(1);
}

test('orgiq with a Social grant: Social opens /iq/communication', async ({ page }) => {
  await enter(page, 'u-rachel', 'orgiq', '/settings');
  await page.getByTestId('shell-social-open').click();
  await expect(page).toHaveURL(/\/iq\/communication/);
  await expect(page.getByTestId('embedded-social-panel')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open the Social tenant' })).toBeVisible();
});

test('Social: opens /social/channels and hides the tenant door', async ({ page }) => {
  await enter(page, 'u-mira', 'social', '/social/people');
  await page.getByTestId('shell-social-open').click();
  await expect(page).toHaveURL(/\/social\/channels/);
  await expect(page.getByTestId('shell-social-workspace')).toHaveCount(0);
});

test('no Social grant: no navigation, no tenant door', async ({ page }) => {
  await enter(page, 'u-kofi', 'pipelines', '/pipelines/runs');
  const before = new URL(page.url()).pathname;
  const open = page.getByTestId('shell-social-open');
  if (await open.count()) await open.click();
  expect(new URL(page.url()).pathname).toBe(before);
  await expect(page.getByTestId('shell-social-workspace')).toHaveCount(0);
});

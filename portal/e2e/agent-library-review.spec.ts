import { test, expect } from '@playwright/test';

test('legacy promotion deep links land on Runbooks Proposals', async ({ page }) => {
  await page.goto('/iq/library');
  await page.goto('/iq/promotions/promo-aurora-cold-start?status=all');
  await expect(page).toHaveURL(/\/iq\/runbooks\/proposals/);
});

test('library deep links retain asset inputs, versions and usage under Build', async ({ page }) => {
  await page.goto('/iq/library/lib-stakeholder-email');
  await expect(page.getByTestId('catalog-explorer')).toBeVisible();
  await expect(page.getByText('Contract', { exact: true })).toBeVisible();
  await expect(page.getByText('Health & usage', { exact: true })).toBeVisible();
  await expect(page.getByTestId('section-crumbs').getByText('Build', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Agent library', exact: true }).first()).toBeVisible();
  await expect(page).toHaveURL(/\/iq\/library\/lib-stakeholder-email$/);
});

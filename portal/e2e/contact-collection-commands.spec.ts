import { test, expect } from '@playwright/test';
import { signIn } from './realSession';

test('contact commands synchronize filters without contacting anyone', async ({ page }) => {
  await signIn(page, 'u-operator', { tenant: 'social' });
  const mutations: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (/\/api\/social\//.test(request.url()) && request.method() !== 'GET') mutations.push(request.url());
  });
  await page.goto('/social/contacts');
  const host = page.getByTestId('collection-command-host');
  const input = host.locator('[contenteditable="true"]');
  const status = page.getByTestId('collection-command-result');
  const command = async (text: string) => { await input.fill(text); await input.press('Enter'); };
  await expect(host).toBeVisible();
  await command('search contacts for "Farah"');
  await expect(page.getByRole('textbox', { name: 'Search contacts', exact: true })).toHaveValue('Farah');
  await command('show offline contacts');
  await expect(status).toContainText('Presence filter: offline');
  await command('show offline contacts from last week');
  await expect(status).toContainText('No changes');
  await expect(page.getByRole('textbox', { name: 'Search contacts', exact: true })).toHaveValue('Farah');
  await command('reset filters');
  await expect(page.getByRole('textbox', { name: 'Search contacts', exact: true })).toHaveValue('');
  await expect(status).toContainText('cleared');
  await page.getByRole('button', { name: 'Available contacts commands', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Available contacts commands', exact: true })).toBeVisible();
  expect(mutations).toEqual([]);
  expect(errors).toEqual([]);
});

import { test, expect, type Page } from '@playwright/test';
import { signIn } from './realSession';

async function command(page: Page, text: string) {
  const input = page.getByTestId('collection-command-host').locator('[contenteditable="true"]');
  await input.fill(text);
  await input.press('Enter');
}

test('run commands update the real table and reject unsupported qualifiers without mutations', async ({ page }) => {
  await signIn(page, 'u-operator', { tenant: 'pipelines' });
  const errors: string[] = [];
  const mutations: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (/\/api\/pipelines\//.test(request.url()) && request.method() !== 'GET') mutations.push(request.url());
  });
  await page.goto('/pipelines/runs');
  await expect(page.getByTestId('collection-command-host')).toBeVisible();
  const failed = page.waitForResponse(response => response.url().includes('/api/pipelines/runs?') && new URL(response.url()).searchParams.get('status') === 'failed' && response.ok());
  await command(page, 'show failed runs');
  await failed;
  await expect(page.getByTestId('collection-command-result')).toContainText('status: failed');
  await command(page, 'search titles for "auth"');
  await expect(page.getByRole('textbox', { name: 'Search loaded run titles', exact: true })).toHaveValue('auth');
  await command(page, 'show running runs from last week');
  await expect(page.getByTestId('collection-command-result')).toContainText('No changes were made');
  await expect(page.getByRole('textbox', { name: 'Search loaded run titles', exact: true })).toHaveValue('auth');
  await command(page, 'reset filters');
  await expect(page.getByRole('textbox', { name: 'Search loaded run titles', exact: true })).toHaveValue('');
  await expect(page.getByTestId('collection-command-result')).toContainText('cleared');
  await page.getByRole('button', { name: 'Available runs commands', exact: true }).click();
  await expect(page.getByText('show failed runs', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.screenshot({ path: test.info().outputPath('runs-composer.png') });
  expect(mutations).toEqual([]);
  expect(errors).toEqual([]);
});

test('cancellation requires confirmation and reaches only the selected existing endpoint', async ({ page }) => {
  await signIn(page, 'u-operator', { tenant: 'pipelines' });
  const run = { id: 'job:command-test', definitionId: 'agent:test', tenant: 'orgiq', status: 'running',
    triggeredBy: null, triggerType: 'manual', startedAt: null, finishedAt: null, costUsd: null,
    context: { tenant: 'orgiq', title: 'Command confirmation fixture', kind: 'agent', table: 'agent_jobs',
      id: 'command-test', sourceStatus: 'running', sources: [] } };
  await page.route('**/api/pipelines/runs?*', route => route.fulfill({ json: { runs: [run], total: 1, limit: 200, offset: 0, unavailable: [] } }));
  const cancellations: string[] = [];
  // Test transport only: no live run is cancelled by acceptance tests.
  await page.route('**/api/pipelines/runs/*/cancel', route => {
    cancellations.push(route.request().url());
    return route.fulfill({ json: { status: 'cancelled' } });
  });
  await page.goto('/pipelines/runs');
  await expect(page.getByTestId('pipelines-runs-table')).toContainText(run.context.title);
  await command(page, 'cancel job:command-test');
  const dialog = page.getByRole('dialog', { name: 'Cancel this run?' });
  await expect(dialog).toBeVisible();
  expect(cancellations).toEqual([]);
  await dialog.getByRole('button', { name: 'Keep it', exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(cancellations).toEqual([]);
  await command(page, 'cancel job:command-test');
  await dialog.getByRole('button', { name: 'Cancel run', exact: true }).click();
  await expect(page.getByTestId('collection-command-result')).toContainText('Cancellation recorded');
  expect(cancellations).toHaveLength(1);
  expect(new URL(cancellations[0]).pathname).toBe('/api/pipelines/runs/job%3Acommand-test/cancel');
});

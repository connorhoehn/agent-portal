import { test, expect } from '@playwright/test';
import { signIn } from './realSession';

// Uses real session and read paths. The one deterministic approval row is an
// intercepted read fixture, never a created or decided server-side approval.
test('pipeline registries and approvals share bounded table commands', async ({ page }) => {
  await signIn(page, 'u-operator', { tenant: 'pipelines' });
  const mutations: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (/\/api\/pipelines\//.test(request.url()) && request.method() !== 'GET') mutations.push(request.url());
  });
  for (const collection of ['agents', 'bots', 'commands', 'approvals']) {
    await page.goto(`/pipelines/${collection}`);
    const host = page.getByTestId('collection-command-host');
    const input = host.locator('[contenteditable="true"]');
    const status = page.getByTestId('collection-command-result');
    const search = page.getByRole('textbox', { name: `Search ${collection}`, exact: true });
    const command = async (text: string) => { await input.fill(text); await input.press('Enter'); };
    await expect(host).toBeVisible();
    await command(`search ${collection} for "audit missing record"`);
    await expect(search).toHaveValue('audit missing record');
    await command(collection === 'approvals' ? 'approve all' : `pause all ${collection}`);
    await expect(status).toContainText('No changes were made');
    await expect(search).toHaveValue('audit missing record');
    await command('reset filters');
    await expect(search).toHaveValue('');
    await expect(status).toContainText('cleared');
    await page.getByRole('button', { name: `Available ${collection} commands`, exact: true }).click();
    await expect(page.getByRole('dialog', { name: `Available ${collection} commands`, exact: true })).toBeVisible();
  }
  expect(mutations).toEqual([]);
  expect(errors).toEqual([]);
});

test('opening an approval command reviews one visible step without recording a decision', async ({ page }) => {
  await signIn(page, 'u-operator', { tenant: 'pipelines' });
  const decisions: string[] = [];
  page.on('request', request => {
    if (/\/api\/pipelines\/approvals/.test(request.url()) && request.method() !== 'GET') decisions.push(request.url());
  });
  await page.route('**/api/pipelines/approvals', route => {
    if (route.request().method() !== 'GET') return route.continue();
    return route.fulfill({ json: { approvals: [{
      id: 'audit-review-fixture', type: 'pipeline.approval.requested', source: 'agent_jobs', sourceId: 'audit-job',
      runId: null, stepId: 'review', definitionId: null, title: 'Audit isolated review',
      question: 'Review the isolated browser test fixture.', detail: null, requestedAt: '2026-10-12T10:00:00Z',
      requiredRoles: ['operator'], rolesDefaulted: false, contextTenant: 'pipelines', decidedThrough: 'job review',
    }], total: 1, unavailable: [] } });
  });
  await page.goto('/pipelines/approvals');
  await expect(page.getByTestId('pipelines-approvals-table')).toContainText('Audit isolated review');
  const input = page.getByTestId('collection-command-host').locator('[contenteditable="true"]');
  const command = async (text: string) => { await input.fill(text); await input.press('Enter'); };
  await command('search approvals for hidden');
  await command('open audit-review-fixture');
  await expect(page.getByTestId('collection-command-result')).toContainText('No matching record');
  await expect(page.getByTestId('pipelines-approval-record')).not.toBeVisible();
  await command('reset filters');
  await command('open audit-review-fixture');
  await expect(page.getByTestId('pipelines-approval-record')).toBeVisible();
  await expect(page.getByTestId('pipelines-approval-record')).toContainText('Review the isolated browser test fixture.');
  expect(decisions).toEqual([]);
});

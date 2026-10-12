import { test, expect, type Page } from '@playwright/test';
import { signIn } from './realSession';

async function command(page: Page, text: string) {
  const input = page.getByTestId('collection-command-host').locator('[contenteditable="true"]');
  await input.fill(text);
  await input.press('Enter');
}

// A single authenticated session avoids revoking another collection's cookie
// while exercising real catalog responses. All commands below are read-only.
test('pipeline collection commands synchronize search and filters with real tables', async ({ page }) => {
  test.setTimeout(90_000);
  await signIn(page, 'u-operator', { tenant: 'pipelines' });
  const errors: string[] = [];
  const mutations: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (/\/api\/pipelines\//.test(request.url()) && !['GET', 'HEAD', 'OPTIONS'].includes(request.method())) mutations.push(request.url());
  });
  const cases = [
    { name: 'definitions', toolbar: 'Definition filters', table: 'pipelines-definitions-table', filter: 'bot', label: 'Bot', serverKind: 'bot' },
    { name: 'runbooks', toolbar: 'Runbook filters', table: 'pipelines-runbooks-table', filter: 'needs dry-run', label: 'Needs dry-run' },
    { name: 'queues', toolbar: 'Queue filters', table: 'pipeline-queues-table', filter: 'dead-letter', label: 'Dead-letter' },
    { name: 'artifacts', toolbar: 'Artifact filters', table: 'pipelines-artifacts-table', filter: 'trace', label: 'Trace', serverKind: 'trace' },
  ];
  for (const entry of cases) {
    await test.step(entry.name, async () => {
      const endpoint = `/api/pipelines/${entry.name}`;
      const initialRead = page.waitForResponse(response => new URL(response.url()).pathname === endpoint && response.ok());
      await page.goto(`/pipelines/${entry.name}`);
      await initialRead;
      const host = page.getByTestId('collection-command-host');
      const status = page.getByTestId('collection-command-result');
      const toolbar = page.getByRole('toolbar', { name: entry.toolbar, exact: true });
      const search = page.getByRole('textbox', { name: `Search ${entry.name}`, exact: true });
      await expect(host).toBeVisible();
      await command(page, `search ${entry.name} for "__audit_no_record_729f__"`);
      await expect(search).toHaveValue('__audit_no_record_729f__');
      await expect(page.getByTestId(entry.table)).toContainText(/No .*match/);

      const kindRead = entry.serverKind ? page.waitForResponse(response => {
        const url = new URL(response.url());
        return url.pathname === endpoint && url.searchParams.get('kind') === entry.serverKind && response.ok();
      }) : undefined;
      await command(page, `show ${entry.filter} ${entry.name}`);
      if (kindRead) await kindRead;
      await expect(status).toContainText(`Filter: ${entry.filter.replaceAll('-', ' ')}`);
      await expect(toolbar.getByText(entry.label, { exact: true })).toBeVisible();
      await expect(search).toHaveValue('__audit_no_record_729f__');

      await command(page, `show ${entry.filter} ${entry.name} from last week`);
      await expect(status).toContainText('No changes were made');
      await expect(toolbar.getByText(entry.label, { exact: true })).toBeVisible();
      await expect(search).toHaveValue('__audit_no_record_729f__');

      const resetRead = entry.serverKind ? page.waitForResponse(response => {
        const url = new URL(response.url());
        return url.pathname === endpoint && !url.searchParams.has('kind') && response.ok();
      }) : undefined;
      await command(page, 'reset filters');
      if (resetRead) await resetRead;
      await expect(search).toHaveValue('');
      await expect(status).toContainText('Search and filters cleared');
      await expect(toolbar.getByText(entry.label, { exact: true })).toHaveCount(0);

      const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === endpoint && response.ok());
      await command(page, 'refresh');
      await refreshed;
      await expect(status).toContainText(`Refreshing ${entry.name}`);
      await host.locator('[contenteditable="true"]').focus();
      await page.getByRole('button', { name: `Available ${entry.name} commands`, exact: true }).click();
      const help = page.getByRole('dialog', { name: `Available ${entry.name} commands`, exact: true });
      await expect(help).toBeVisible();
      await expect(help).toContainText(`show ${entry.filter} ${entry.name}`);
      await page.keyboard.press('Escape');
    });
  }
  expect(mutations).toEqual([]);
  expect(errors).toEqual([]);
});

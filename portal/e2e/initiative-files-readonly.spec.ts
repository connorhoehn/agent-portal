import { writeFile } from 'node:fs/promises';
import { test, expect } from './cdpTest';
import { signIn } from './realSession';
test.use({ baseURL: 'http://localhost:5183', viewport: { width: 1440, height: 1000 } });
test('project files show the saved presentation with bounded cards and a unified toolbar', async ({ page }) => {
  const principal = await signIn(page, 'u-nora', { expectTenant: 'orgiq', expectRole: 'sme' });
  const errors: string[] = [], writes: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { const path = new URL(request.url()).pathname;
    if (request.method() !== 'GET' && /\/(messages|join|start|transcribe|reprocess|revise|revisions|reset)(\/|$)/.test(path)) writes.push(`${request.method()} ${path}`); });
  await page.goto('/iq/projects/p-observability?scope=all&pane=discussion&tab=docs');
  const files = page.getByTestId('initiative-files'); await expect(files).toBeVisible();
  await expect(files.getByText('Loading project files…')).toHaveCount(0, { timeout: 20000 });
  await expect(files.getByTestId('initiative-files-toolbar').getByRole('button', { name: 'Open workspace' })).toBeVisible();
  const saved = files.getByTestId('initiative-file').filter({ hasText: 'Observability review' });
  await expect(saved).toBeVisible();
  const cards = await files.getByTestId('initiative-file').evaluateAll(elements => elements.map(e => ({ width: e.getBoundingClientRect().width, height: e.getBoundingClientRect().height })));
  expect(cards.length).toBeGreaterThan(0); expect(cards.every(card => card.width <= 322 && card.height <= 150)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('files-cards-wide.png') });
  await files.getByRole('button', { name: 'List', exact: true }).click(); await expect(files.getByTestId('initiative-files-list')).toBeVisible();
  await files.getByLabel('File type').selectOption('presentation'); await expect(files.getByTestId('initiative-file')).toHaveCount(1);
  await files.getByLabel('Search project files').fill('no matching fixture text'); await expect(files.getByText('No matching files', { exact: true })).toBeVisible();
  await files.getByLabel('Search project files').fill(''); await files.getByRole('button', { name: 'Cards', exact: true }).click();
  await page.setViewportSize({ width: 1024, height: 768 }); await expect(saved).toBeVisible();
  const bounds = await files.evaluate(e => ({ width: e.clientWidth, scrollWidth: e.scrollWidth })); expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.width + 1);
  await page.screenshot({ path: test.info().outputPath('files-cards-narrow.png') });
  await saved.click(); await expect(page).toHaveURL(/\/iq\/decks\/idk-42e8a3f0-0595-40d7-9afd-65f79cfaf843/);
  expect(errors).toEqual([]); expect(writes).toEqual([]);
  await writeFile(test.info().outputPath('files-readonly.json'), JSON.stringify({ principal: { sub: principal.sub, tenant: principal.tenant, role: principal.role }, cards, bounds, errors, writes, nativeReadOnly: true }, null, 2));
});

test('one unavailable work-item document source preserves other linked project documents', async ({ page }) => {
  await signIn(page, 'u-nora', { expectTenant: 'orgiq', expectRole: 'sme' });
  let denied = false;
  await page.route('**/api/graph/work-items/*/documents', async route => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-2)!);
    if (!denied) { denied = true; await route.fulfill({ status: 503, body: 'Isolated unavailable-source fixture' }); return; }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ workItemId: id, documents: [{ id: 'fixture-project-brief', title: 'Linked project brief', source: 'confluence', sourceUri: null, ingestedAt: null }] }) });
  });
  await page.goto('/iq/projects/p-observability?tab=docs');
  const files = page.getByTestId('initiative-files');
  await expect(files.getByText('Some documents could not be read.', { exact: false })).toBeVisible();
  await expect(files.getByTestId('initiative-file').filter({ hasText: 'Linked project brief' })).toHaveCount(1);
  await expect(files.getByTestId('initiative-file').filter({ hasText: 'Observability review' })).toHaveCount(1);
  await files.getByLabel('File type').selectOption('document');
  await expect(files.getByTestId('initiative-file')).toHaveCount(1);
});

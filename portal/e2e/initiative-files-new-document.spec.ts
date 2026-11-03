// The Docs tab's New › Document (2026-11-02): a steward titles a page, it opens
// on its own page where they write and save it, and it lists under Docs. Runs
// as a clone inside a scoped mock world, so the shared demo state keeps no page.
import { expect, test } from '@playwright/test';
import { openAsClone } from './realSession';

const OUT = '../.scratch/work-documents-2026-11-02';
for (const theme of ['light', 'dark'] as const) test(`New › Document writes a page into the initiative (${theme})`, async ({ browser }) => {
  test.setTimeout(120_000);
  const person = await openAsClone(browser, 'u-release', { tenant: 'orgiq', landing: null, preJoin: 'remembered', label: `new-document-${theme}`, scope: 'default',
    prepare: async context => { await context.addInitScript(t => { try { localStorage.setItem('theme', t); } catch {} }, theme); } });
  const { page } = person;
  try {
    expect((await page.request.post('/api/session/role', { data: { role: 'org-leader' } })).status()).toBe(200);
    await page.goto('/iq/projects/p-auth-migration?scope=all&tab=docs');
    await page.evaluate(t => document.documentElement.setAttribute('data-theme', t), theme);
    const files = page.getByTestId('initiative-files');
    await expect(files).toBeVisible();
    await expect(files.getByText('Loading project files…')).toHaveCount(0, { timeout: 20_000 });
    await files.getByRole('button', { name: 'New file' }).click();
    await page.screenshot({ path: `${OUT}/new-menu-${theme}.png`, clip: { x: 0, y: 0, width: 1440, height: 520 } });
    await page.getByRole('menuitem', { name: /^Document/ }).click();
    await expect(page).toHaveURL(/\/iq\/documents\/wdoc-/, { timeout: 15_000 });
    const doc = page.getByTestId('workspace-document-page');
    await expect(doc).toContainText('Untitled page');
    await expect(doc.getByTestId('workspace-document-empty')).toBeVisible();
    await doc.getByTestId('workspace-document-write').click();
    await doc.getByTestId('workspace-document-title').fill('Tenant cutover notes');
    await doc.getByTestId('workspace-document-body').fill('# Cutover order\n\n1. Legacy SSO tenants first.\n2. Then the rest, one per day.');
    await doc.getByTestId('workspace-document-save').click();
    await expect(doc.getByTestId('workspace-document-view')).toContainText('Cutover order', { timeout: 15_000 });
    await expect(doc.getByRole('heading', { name: 'Cutover order' })).toBeVisible();
    await expect(doc.getByRole('heading', { name: 'Tenant cutover notes' })).toBeVisible();
    await page.screenshot({ path: `${OUT}/document-page-${theme}.png`, clip: { x: 0, y: 0, width: 1440, height: 640 } });
    // Back under Docs: the page lists first, as a document, with its edit time.
    await page.goBack();
    await expect(files).toBeVisible();
    await expect(files.getByText('Loading project files…')).toHaveCount(0, { timeout: 20_000 });
    const card = files.getByTestId('initiative-file').filter({ hasText: 'Tenant cutover notes' });
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card).toContainText(/Page · edited/);
    await page.screenshot({ path: `${OUT}/docs-tab-${theme}.png`, clip: { x: 0, y: 0, width: 1440, height: 640 } });
    expect(person.errors).toEqual([]);
  } finally { await person.close(); }
});
test('a member sees no New menu and the server refuses a write', async ({ browser }) => {
  const person = await openAsClone(browser, 'u-theo', { tenant: 'orgiq', landing: null, preJoin: 'remembered', label: 'new-document-member', scope: 'default' });
  try {
    await person.page.goto('/iq/projects/p-auth-migration?scope=all&tab=docs');
    const files = person.page.getByTestId('initiative-files');
    await expect(files).toBeVisible();
    await expect(files.getByText('Loading project files…')).toHaveCount(0, { timeout: 20_000 });
    await expect(files.getByRole('button', { name: 'New file' })).toHaveCount(0);
    const refused = await person.page.request.post('/api/graph/projects/p-auth-migration/workspace-documents', { data: { title: 'Nope' } });
    expect(refused.status()).toBe(403);
  } finally { await person.close(); }
});

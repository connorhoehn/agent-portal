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
    await expect(page.locator('main nav').filter({ hasText: 'Initiatives' }).first()).toContainText(/Initiatives.*Auth Migration.*Tenant cutover notes/s);
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

test('New › Whiteboard opens an Excalidraw canvas in the initiative, and Save keeps a stroke across a reload', async ({ browser }) => {
  test.setTimeout(150_000);
  const person = await openAsClone(browser, 'u-release', { tenant: 'orgiq', landing: null, preJoin: 'remembered', label: 'new-whiteboard', scope: 'default' });
  const { page } = person;
  try {
    expect((await page.request.post('/api/session/role', { data: { role: 'org-leader' } })).status()).toBe(200);
    await page.goto('/iq/projects/p-auth-migration?scope=all&tab=docs');
    const files = page.getByTestId('initiative-files');
    await expect(files.getByText('Loading project files…')).toHaveCount(0, { timeout: 20_000 });
    await files.getByRole('button', { name: 'New file' }).click();
    await page.getByRole('menuitem', { name: /^Whiteboard/ }).click();
    await expect(page).toHaveURL(/\/iq\/documents\/wdoc-/, { timeout: 15_000 });
    const board = page.getByTestId('workspace-whiteboard-page');
    await expect(board).toContainText('Untitled whiteboard');
    const canvas = board.locator('.excalidraw');
    await expect(canvas).toBeVisible({ timeout: 30_000 });
    await expect(board.getByTestId('workspace-whiteboard-save')).toBeDisabled();
    // Draw one rectangle: the rectangle tool, then a drag on the canvas.
    const box = (await canvas.boundingBox())!;
    await canvas.click({ position: { x: box.width / 2, y: box.height / 2 } });
    await page.keyboard.press('r');
    await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6, { steps: 8 });
    await page.mouse.up();
    await expect(board.getByTestId('workspace-whiteboard-save')).toBeEnabled({ timeout: 10_000 });
    await page.screenshot({ path: `${OUT}/whiteboard-drawn.png`, clip: { x: 0, y: 0, width: 1440, height: 800 } });
    await board.getByTestId('workspace-whiteboard-save').click();
    await expect(board.getByTestId('workspace-whiteboard-save')).toHaveText('Saved', { timeout: 15_000 });
    const read = await page.request.get(new URL(page.url()).pathname.replace('/iq/documents/', '/api/graph/documents/'));
    expect((await read.json()).scene.length).toBeGreaterThan(20);
    await page.reload();
    await expect(board.locator('.excalidraw')).toBeVisible({ timeout: 30_000 });
    await expect(board.getByTestId('workspace-whiteboard-save')).toBeDisabled();
    expect(await board.locator('.excalidraw canvas').count()).toBeGreaterThan(0);
    await page.goto('/iq/projects/p-auth-migration?scope=all&tab=docs');
    await expect(files.getByText('Loading project files…')).toHaveCount(0, { timeout: 20_000 });
    await expect(files.getByTestId('initiative-file').filter({ hasText: 'Untitled whiteboard' })).toContainText(/Whiteboard · edited/);
    expect(person.errors).toEqual([]);
  } finally { await person.close(); }
});

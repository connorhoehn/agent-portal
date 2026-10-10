import { loginAs } from './realSession';
import { test, expect } from './cdpTest';
test.use({ viewport: { width: 1440, height: 900 }, baseURL: process.env.PARITY_BASE_URL ?? 'http://localhost:5261' });
test.describe.configure({ mode: 'serial' });
const WORK = 'wi-auth-e2-b3', DOC = 'postmortem-p-auth-migration';
const TITLE = 'Postmortem: auth token cache invalidation race (Auth Migration)';
const API = `/api/graph/work-items/${WORK}/documents`;
const DESTINATION = '/iq/projects/p-auth-migration?tab=work&item=wi-auth-e2-b3';
test('an explicit document association saves, survives reload, opens the exact corpus record and removes without deleting it', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } });
  const page = await context.newPage(), errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await loginAs(context, 'u-rachel', baseURL);
    expect((await page.request.delete(`${API}/${DOC}`)).status()).toBe(200);
    await page.goto(DESTINATION); await expect(page.getByTestId('work-item-detail')).toBeVisible();
    const section = page.getByTestId('work-document-links');
    await expect(section.getByRole('button', { name: 'Add link', exact: true })).toBeVisible();
    await section.getByRole('button', { name: 'Add link', exact: true }).click();
    const picker = page.getByTestId('linked-items-picker');
    await picker.getByRole('textbox', { name: 'Search documents' }).fill('auth token');
    const persisted = page.waitForResponse(response => response.url().endsWith(`${API}/${DOC}`) && response.request().method() === 'PUT');
    await picker.getByText(TITLE, { exact: true }).click(); const receipt = await persisted;
    expect(receipt.status()).toBe(201); expect(receipt.request().postData()).toBeNull();
    await expect(section.getByTestId(`linked-item-${DOC}`)).toContainText(TITLE);
    await page.reload(); await expect(section.getByTestId(`linked-item-${DOC}`)).toContainText(TITLE);
    const snapshot = await page.request.get(API); expect(snapshot.status()).toBe(200);
    expect((await snapshot.json()).documents.find((doc: { id: string }) => doc.id === DOC)).toMatchObject({ linkedBy: 'u-rachel', href: `/iq/documents/${DOC}` });
    await section.getByTestId(`linked-item-${DOC}`).getByRole('button', { name: TITLE, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/iq/documents/${DOC}$`));
    await expect(page.getByTestId('document-record-page')).toContainText(TITLE);
    await expect(page.getByTestId('document-record-page')).toContainText('s3://');
    await expect(page.getByRole('button', { name: 'Open source', exact: true })).toHaveCount(0);
    await page.goBack(); await expect(page).toHaveURL(new RegExp('item=wi-auth-e2-b3$'));
    await section.getByRole('button', { name: `Remove link to "${TITLE}"`, exact: true }).click();
    await expect(section.getByTestId(`linked-item-${DOC}`)).toHaveCount(0);
    expect((await page.request.get(`/api/graph/documents/${DOC}`)).status()).toBe(200);
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});
test('a work reader sees a saved canonical document and has no association mutation controls', async ({ browser, baseURL }) => {
  const author = await browser.newContext({ baseURL }), reader = await browser.newContext({ baseURL });
  const page = await reader.newPage();
  try {
    await loginAs(author, 'u-rachel', baseURL);
    expect((await author.request.put(`${API}/${DOC}`)).status()).toBe(201);
    await loginAs(reader, 'u-vera', baseURL);
    await page.goto(DESTINATION); const section = page.getByTestId('work-document-links');
    await expect(section.getByTestId(`linked-item-${DOC}`)).toContainText(TITLE);
    await expect(section.getByRole('button', { name: 'Add link', exact: true })).toHaveCount(0);
    await expect(section.getByRole('button', { name: /Remove link/ })).toHaveCount(0);
    expect((await page.request.put(`${API}/${DOC}`)).status()).toBe(403);
    await section.getByTestId(`linked-item-${DOC}`).getByRole('button', { name: TITLE, exact: true }).click();
    await expect(page.getByTestId('document-record-page')).toContainText(TITLE);
    expect((await author.request.delete(`${API}/${DOC}`)).status()).toBe(200);
    await page.reload(); await expect(page.getByTestId('document-record-page')).toContainText(TITLE);
    expect((await page.request.get('/api/graph/documents/deleted-document')).status()).toBe(404);
    await page.goto('/iq/documents/deleted-document');
    await expect(page.getByTestId('document-record-page')).toContainText('Document record not found');
  } finally { await author.request.delete(`${API}/${DOC}`); await Promise.all([author.close(), reader.close()]); }
});
test('a held association receipt cannot restore the old work context after navigation', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL }), page = await context.newPage();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let arrived = false;
  try {
    await loginAs(context, 'u-rachel', baseURL);
    await page.request.delete(`${API}/${DOC}`);
    await page.route(`**${API}/${DOC}`, async route => {
      if (route.request().method() !== 'PUT') { await route.continue(); return; }
      const response = await route.fetch(); expect(response.status()).toBe(201); arrived = true;
      await held; await route.fulfill({ response });
    });
    await page.goto(DESTINATION); const section = page.getByTestId('work-document-links');
    await section.getByRole('button', { name: 'Add link', exact: true }).click();
    const picker = page.getByTestId('linked-items-picker');
    await picker.getByRole('textbox', { name: 'Search documents' }).fill('auth token');
    await picker.getByText(TITLE, { exact: true }).click(); await expect.poll(() => arrived).toBe(true);
    await expect(section).toContainText('Saving document association');
    await page.getByTestId('initiative-all-work').click();
    await page.getByText('Refresh loop when a grant is revoked mid-session', { exact: true }).click();
    await expect(page).toHaveURL(/item=wi-auth-e1-b4/);
    release(); await expect(section).toContainText('No documents linked yet');
    await expect(section.getByTestId(`linked-item-${DOC}`)).toHaveCount(0);
    await expect(section.getByRole('button', { name: 'Add link', exact: true })).toBeVisible();
    expect((await (await page.request.get(API)).json()).documents.some((doc: { id: string }) => doc.id === DOC)).toBe(true);
  } finally { release(); await page.request.delete(`${API}/${DOC}`).catch(() => undefined); await context.close(); }
});

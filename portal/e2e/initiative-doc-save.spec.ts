// `/doc` Save in an initiative Discussion (2026-11-03): the private page card,
// then "Save as document" creates a Work page through the Docs tab's own
// store (POST /api/graph/projects/:id/workspace-documents), the thread posts
// its reference, and the page opens on /iq/documents/:id. Runs as a clone of
// the initiative's SME; the one chat line it sends is the draft's source.
import { expect, test } from '@playwright/test';
import { openAsClone } from './realSession';
import { chooseComposerMode } from './conversationViews';

const OUT = '../.scratch/work-documents-2026-11-02';
test('/doc Save in the initiative Discussion writes a Work page the reader can open', async ({ browser, request }) => {
  test.setTimeout(150_000);
  const health = await request.get('/api/health').then(r => r.json()).catch(() => null) as { realtime?: { gateway?: string } } | null;
  test.skip(health?.realtime?.gateway !== 'on', 'the middleware is unreachable or REALTIME_GATEWAY is not on');
  const nora = await openAsClone(browser, 'u-nora', { tenant: 'orgiq', landing: null, preJoin: 'remembered', label: 'doc-save', viewport: { width: 1440, height: 900 } });
  const { page } = nora;
  try {
    await page.goto('/iq/projects/p-auth-migration');
    await expect(page.getByTestId('initiative-live-discussion')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('scope-discussion-panel-offline')).toHaveCount(0, { timeout: 15_000 });
    const composer = page.getByTestId('initiative-workspace').getByTestId('initiative-composer');
    // The composer opens on Chat here; only an Agent-mode composer needs the switch.
    if (await composer.getByRole('button', { name: 'Composer mode: Agent', exact: true }).isVisible().catch(() => false)) await chooseComposerMode(page, composer, 'Agent', 'Chat');
    const input = composer.getByTestId('rich-chat-composer-input');
    await expect(input).toBeEditable({ timeout: 20_000 });
    const stamp = Date.now().toString(36);
    // The page is written from the readable thread, which the seed already fills; nothing is sent first.
    await expect(page.getByTestId('chat-message').first()).toBeVisible({ timeout: 15_000 });
    await input.click();
    await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.press('Backspace');
    await page.keyboard.type(`/doc Cutover notes ${stamp}`);
    await page.keyboard.press('Enter');
    const card = page.getByTestId('conversation-doc-card');
    await expect(card.getByTestId('conversation-doc-preview')).toBeVisible({ timeout: 45_000 });
    await page.screenshot({ path: `${OUT}/doc-card.png` });
    const created = page.waitForResponse(r => /\/api\/graph\/projects\/p-auth-migration\/workspace-documents$/.test(r.url()) && r.request().method() === 'POST');
    const saved = page.waitForResponse(r => /\/doc\/runs\/[^/]+\/save$/.test(r.url()) && r.request().method() === 'POST');
    await card.getByTestId('conversation-doc-save').click();
    const createdBody = await (await created).json() as { document: { id: string; title: string; markdown: string; href: string } };
    expect(createdBody.document.id).toMatch(/^wdoc-/);
    expect(createdBody.document.title).toContain(`Cutover notes ${stamp}`);
    expect(createdBody.document.markdown.length).toBeGreaterThan(20);
    const savedBody = await (await saved).json() as { saveTarget: string; metadata: { documents: Array<{ id: string }> } };
    expect(savedBody.saveTarget).toBe('document');
    expect(savedBody.metadata.documents[0]?.id).toBe(createdBody.document.id);
    await expect(page.getByTestId('conversation-doc-card')).toHaveCount(0, { timeout: 25_000 });
    const reference = page.getByTestId('chat-message').filter({ hasText: `Page: Cutover notes ${stamp}` }).first();
    await expect(reference).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: `${OUT}/doc-reference.png` });
    // The page the reference names reads back with the draft's body, and lists under Docs.
    const read = await page.request.get(`/api/graph/documents/${createdBody.document.id}`);
    expect(read.status()).toBe(200);
    expect((await read.json()).markdown).toBe(createdBody.document.markdown);
    await page.goto(createdBody.document.href);
    const doc = page.getByTestId('workspace-document-page');
    await expect(doc).toContainText(`Cutover notes ${stamp}`);
    await expect(doc.getByTestId('workspace-document-view')).toBeVisible();
    await expect(page.locator('main nav').filter({ hasText: 'Initiatives' }).first()).toContainText(/Initiatives.*Auth Migration.*Cutover notes/s);
    await page.screenshot({ path: `${OUT}/doc-saved-page.png`, clip: { x: 0, y: 0, width: 1440, height: 640 } });
    await page.goto('/iq/projects/p-auth-migration?scope=all&tab=docs');
    const files = page.getByTestId('initiative-files');
    await expect(files.getByText('Loading project files…')).toHaveCount(0, { timeout: 20_000 });
    await expect(files.getByTestId('initiative-file').filter({ hasText: `Cutover notes ${stamp}` })).toBeVisible({ timeout: 15_000 });
    expect(nora.errors).toEqual([]);
  } finally { await nora.close(); }
});

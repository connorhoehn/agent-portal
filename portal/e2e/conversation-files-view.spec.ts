import { test, expect, type Browser } from '@playwright/test';
import { openAs } from './realSession';
import { chooseComposerMode, composerFileInput, openConversationView } from './conversationViews';

// The Files view of a conversation: a file uploaded in one session is listed in
// another member's Files tab and downloads; a non-member's list request is 403
// (GET /api/uploads?channel=). Headless, against a dev:mock stack whose BFF is
// its own gateway (PARITY_BASE_URL, default http://127.0.0.1:5183).
test.use({ viewport: { width: 1440, height: 900 }, baseURL: process.env.PARITY_BASE_URL ?? 'http://127.0.0.1:5183' });

const INITIATIVE = '/iq/projects/p-auth-migration';
const CHANNEL = 'orgiq:initiative:p-auth-migration';

async function signedIn(browser: Browser, baseURL: string | undefined, userId: string) {
  const { page, context } = await openAs(browser, userId, { baseURL, viewport: { width: 1440, height: 900 } });
  return { page, context };
}

test('a file uploaded by one member is listed and downloadable in another member\'s Files view', async ({ browser, baseURL }) => {
  test.setTimeout(150_000);
  const nora = await signedIn(browser, baseURL, 'u-nora');
  const rachel = await signedIn(browser, baseURL, 'u-rachel');
  const outsider = await signedIn(browser, baseURL, 'u-farah');
  try {
    for (const { page } of [nora, rachel]) {
      await page.goto(INITIATIVE);
      await expect(page.getByTestId('initiative-live-discussion')).toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId('scope-discussion-panel-offline')).toHaveCount(0, { timeout: 15_000 });
    }
    const name = `files-${Date.now().toString(36)}.pdf`;
    // The page's one composer is docked in the content column (2.438.3): Chat → the Discussion takes files.
    const composer = nora.page.getByTestId('initiative-workspace').getByTestId('initiative-composer');
    await chooseComposerMode(nora.page, composer, 'Agent', 'Chat');
    const input = composer.getByTestId('rich-chat-composer-input');
    await input.click();
    await nora.page.keyboard.press('ControlOrMeta+a'); await nora.page.keyboard.press('Backspace');
    const toggle = composer.getByTestId('rich-chat-composer-format-toggle');
    if (await toggle.isVisible().catch(() => false) && (await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click();
    await composer.locator('input[type="file"]').first().setInputFiles({ name, mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 hello') });
    await input.click();
    await nora.page.keyboard.type(`Files view ${name}`); await nora.page.keyboard.press('Enter');
    await expect(rachel.page.getByTestId('chat-message').filter({ hasText: `Files view ${name}` })).toHaveCount(1, { timeout: 15_000 });

    await openConversationView(rachel.page, 'scope-discussion-panel-pins', 'files');
    const panel = rachel.page.getByTestId('scope-discussion-panel');
    await expect(panel.getByText(name, { exact: true }).locator('visible=true')).toBeVisible({ timeout: 10_000 });

    const list = await rachel.page.request.get(`/api/uploads?channel=${encodeURIComponent(CHANNEL)}`);
    expect(list.status()).toBe(200);
    const body = await list.json() as { files: Array<{ name: string; url: string }> };
    const file = body.files.find(f => f.name === name)!;
    const download = await rachel.page.request.get(file.url);
    expect(download.status()).toBe(200);
    expect(await download.text()).toContain('%PDF-1.4 hello');

    // An assessment-only session holds no seat in the orgiq tenant: the list answers 404, never a name.
    const refused = await outsider.page.request.get(`/api/uploads?channel=${encodeURIComponent(CHANNEL)}`);
    expect([403, 404]).toContain(refused.status());
    expect(await refused.text()).not.toContain(name);
  } finally { await nora.context.close(); await rachel.context.close(); await outsider.context.close(); }
});

// Social: #general's Documents/Files view (?view=files) lists a member's upload with name, size and sender,
// it downloads, and a session with no Social grant is refused.
test('Social: a file u-lena uploads to #general is listed and downloadable for u-sana; u-hr is refused', async ({ browser, baseURL }) => {
  test.setTimeout(150_000);
  const social = 'social:ch:general';
  const lena = await signedIn(browser, baseURL, 'u-lena');
  const sana = await signedIn(browser, baseURL, 'u-sana');
  const hr = await signedIn(browser, baseURL, 'u-hr');
  try {
    for (const { page } of [lena, sana]) {
      await page.goto('/social/channels/general');
      await expect(page.getByTestId('social-chat-composer-input')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText('The realtime gateway is not connected')).toHaveCount(0, { timeout: 15_000 });
    }
    const name = `social-files-${Date.now().toString(36)}.pdf`;
    const body = '%PDF-1.4 social hello';
    await lena.page.getByTestId('social-chat-composer-input').click();
    await lena.page.locator('input[type="file"]').first().setInputFiles({ name, mimeType: 'application/pdf', buffer: Buffer.from(body) });
    await lena.page.getByTestId('social-chat-composer-input').click();
    await lena.page.keyboard.type(`Social files ${name}`); await lena.page.keyboard.press('Enter');
    await expect(sana.page.getByTestId('chat-message').filter({ hasText: `Social files ${name}` })).toHaveCount(1, { timeout: 15_000 });

    await sana.page.goto('/social/channels/general?view=files');
    await expect(sana.page.getByText(name, { exact: true }).locator('visible=true').first()).toBeVisible({ timeout: 15_000 });

    const list = await sana.page.request.get(`/api/uploads?channel=${encodeURIComponent(social)}`);
    expect(list.status()).toBe(200);
    const files = (await list.json() as { files: Array<Record<string, unknown>> }).files;
    const file = files.find(f => f.name === name)!;
    expect(file).toBeTruthy();
    expect(Number(file.size ?? file.bytes)).toBeGreaterThan(0);
    expect(JSON.stringify(file)).toMatch(/u-lena|Lena/);
    const download = await sana.page.request.get(file.url as string);
    expect(download.status()).toBe(200);
    expect(await download.text()).toContain(body);

    const refused = await hr.page.request.get(`/api/uploads?channel=${encodeURIComponent(social)}`);
    expect([403, 404]).toContain(refused.status());
    expect(await refused.text()).not.toContain(name);
  } finally { await lena.context.close(); await sana.context.close(); await hr.context.close(); }
});

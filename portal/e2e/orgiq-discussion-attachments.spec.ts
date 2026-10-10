import { test, expect, type Browser, type Page } from '@playwright/test';
import { chooseComposerMode } from './conversationViews';
import { openAs } from './realSession';

// A file attached in an orgiq initiative discussion (gateway upload feature +
// /api/uploads) appears for a second user, who can download it. Headless; run
// against a dev:mock stack whose BFF is its own gateway (PARITY_BASE_URL).
test.use({ viewport: { width: 1440, height: 900 }, ...(process.env.PARITY_BASE_URL ? { baseURL: process.env.PARITY_BASE_URL } : {}) });

const INITIATIVE = '/iq/projects/p-auth-migration';

async function person(browser: Browser, baseURL: string | undefined, userId: string) {
  const { page, context } = await openAs(browser, userId, { baseURL, viewport: { width: 1440, height: 900 } });
  return { page, context };
}
async function open(page: Page) {
  await page.goto(INITIATIVE);
  await expect(page.getByTestId('initiative-live-discussion')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('scope-discussion-panel-offline')).toHaveCount(0, { timeout: 15_000 });
}

test('an attachment posted by an SME shows for a member', async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const nora = await person(browser, baseURL, 'u-nora');
  const rachel = await person(browser, baseURL, 'u-rachel');
  try {
    await open(nora.page); await open(rachel.page);
    const name = `plan-${Date.now().toString(36)}.pdf`;
    // The page's one composer is docked in the content column (2.438.3): Chat → the Discussion takes files.
    const composer = nora.page.getByTestId('initiative-workspace').getByTestId('initiative-composer');
    await chooseComposerMode(nora.page, composer, 'Agent', 'Chat');
    const input = composer.getByTestId('rich-chat-composer-input');
    await input.click(); // the toolbar mounts on focus
    await nora.page.keyboard.press('ControlOrMeta+a'); await nora.page.keyboard.press('Backspace');
    const toggle = composer.getByTestId('rich-chat-composer-format-toggle');
    if (await toggle.isVisible().catch(() => false) && (await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click();
    await composer.locator('input[type="file"]').first().setInputFiles({ name, mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 hello') });
    await input.click();
    await nora.page.keyboard.type(`Plan attached ${name}`); await nora.page.keyboard.press('Enter');
    await expect(composer).toBeVisible();
    await expect(rachel.page.getByTestId('chat-message').filter({ hasText: `Plan attached ${name}` })).toHaveCount(1, { timeout: 15_000 });
    await expect(rachel.page.getByText(name).first()).toBeVisible({ timeout: 10_000 });
  } finally { await nora.context.close(); await rachel.context.close(); }
});

import { test, expect, type Browser, type Page } from '@playwright/test';
import { openAs } from './realSession';

// Two sessions against the shared app (no mock reset): Sana sits in #general while Lena
// DMs her; Sana's rail row and badge move within 2 s without navigating. And a bad
// `/summarize` range is explained in the thread's alert.
test.use({ viewport: { width: 1440, height: 900 }, baseURL: process.env.PARITY_BASE_URL ?? 'http://127.0.0.1:5183' });
test.describe.configure({ mode: 'serial' });

async function person(browser: Browser, baseURL: string | undefined, userId: string, path: string) {
  const { page, context } = await openAs(browser, userId, { baseURL, viewport: { width: 1440, height: 900 }, url: path });
  const input = page.getByTestId('social-chat-composer-input');
  await expect(input).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('The realtime gateway is not connected', { exact: false })).toHaveCount(0, { timeout: 15_000 });
  await expect(input).toBeEditable({ timeout: 15_000 });
  return { page, context };
}
async function say(page: Page, text: string) {
  await page.getByTestId('social-chat-composer-input').click();
  await page.keyboard.type(text); await page.keyboard.press('Enter');
}

test('a DM moves the recipient\'s rail row and badge while she is in another chat', async ({ browser, baseURL }) => {
  test.setTimeout(90_000);
  const lobby = 'social:dm:u-lena:u-sana';
  const lena = await person(browser, baseURL, 'u-lena', `/social/dms/${encodeURIComponent(lobby)}`);
  const sana = await person(browser, baseURL, 'u-sana', '/social/channels/general');
  try {
    const row = sana.page.getByTestId('social-chat-rail').locator(`[data-testid="conversation-row"][data-channel="${lobby}"]`);
    const text = `rail-live ${Date.now()}`;
    await say(lena.page, text);
    await expect(row).toContainText(text, { timeout: 2_000 });
    await expect(row.getByTestId('conversation-unread')).toBeVisible({ timeout: 2_000 });
    await expect(sana.page).toHaveURL(/\/social\/channels\/general/);
  } finally { await lena.context.close(); await sana.context.close(); }
});

test('/summarize with a bad range explains itself', async ({ browser, baseURL }) => {
  test.setTimeout(60_000);
  const sana = await person(browser, baseURL, 'u-sana', '/social/channels/general');
  try {
    await say(sana.page, '/summarize last banana');
    await expect(sana.page.getByText('Give a range like', { exact: false })).toBeVisible({ timeout: 5_000 });
    await expect(sana.page.getByTestId('social-summary-card')).toHaveCount(0);
  } finally { await sana.context.close(); }
});

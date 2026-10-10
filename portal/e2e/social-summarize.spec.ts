import { test, expect, type Browser, type Page } from '@playwright/test';
import { openAs } from './realSession';

// /summarize in a Social channel: a private run card, a reviewable summary
// with verbatim quotes, and an explicit "Post to conversation". Headless;
// run against the dev:mock stack (MOCK_AURORA + MOCK_AGENTCORE).
test.use({ viewport: { width: 1440, height: 900 }, ...(process.env.PARITY_BASE_URL ? { baseURL: process.env.PARITY_BASE_URL } : {}) });
test.describe.configure({ mode: 'serial' });

async function person(browser: Browser, baseURL: string | undefined, userId: string, path = '/social/channels/general') {
  const { page, context, errors } = await openAs(browser, userId, { baseURL, viewport: { width: 1440, height: 900 }, url: path });
  await expect(page.getByTestId('social-chat-composer-input')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('The realtime gateway is not connected', { exact: false })).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByTestId('social-chat-composer-input')).toBeEditable({ timeout: 15_000 });
  return { page, context, errors };
}

async function reset(browser: Browser, baseURL: string | undefined) {
  const context = await browser.newContext({ baseURL });
  try {
    const page = await context.newPage(); await page.goto('/');
    expect((await page.request.post('/api/__mock/reset', { data: {} })).status()).toBe(200);
  } finally { await context.close(); }
}

async function say(page: Page, text: string) {
  await page.getByTestId('social-chat-composer-input').click();
  await page.keyboard.type(text); await page.keyboard.press('Enter');
}
const message = (page: Page, text: string) => page.getByTestId('chat-message').filter({ hasText: text });

test.beforeEach(async ({ browser, baseURL }) => { await reset(browser, baseURL); });
test.afterEach(async ({ browser, baseURL }) => { await reset(browser, baseURL); });

test('the summary is private until its author posts it, and the posted quotes are real messages', async ({ browser, baseURL }) => {
  test.setTimeout(90_000);
  const sana = await person(browser, baseURL, 'u-sana');
  const mira = await person(browser, baseURL, 'u-mira');
  try {
    await say(sana.page, '/summarize 24h');
    const card = sana.page.getByTestId('social-summary-card');
    await expect(card).toBeVisible();
    // Since ui-components 2.413.0 the card is a rich localMessage: the library draws the private note beside the body, not inside the card.
    await expect(card.locator('xpath=ancestor::*[@data-testid="chat-local-message"]').getByTestId('chat-local-message-note')).toContainText('Only you can see this');
    await expect(card.getByTestId('social-summary-result')).toBeVisible({ timeout: 15_000 });
    await expect(card.getByTestId('social-summary-result')).toContainText('Sources');
    // The command was not sent as a message, and nobody else sees the card.
    await expect(message(sana.page, '/summarize')).toHaveCount(0);
    await expect(mira.page.getByTestId('social-summary-card')).toHaveCount(0);
    await expect(mira.page.getByText('Highlights')).toHaveCount(0);
    // Posting is the explicit act.
    await card.getByTestId('social-summary-post').click();
    await expect(sana.page.getByTestId('social-summary-card')).toHaveCount(0);
    await expect(message(mira.page, 'Highlights')).toHaveCount(1, { timeout: 10_000 });
    await expect(message(mira.page, 'Sources')).toHaveCount(1);
    expect(sana.errors).toEqual([]);
    expect(mira.errors).toEqual([]);
  } finally { await sana.context.close(); await mira.context.close(); }
});

test('Dismiss drops the card without posting, and a bad range explains itself', async ({ browser, baseURL }) => {
  test.setTimeout(60_000);
  const sana = await person(browser, baseURL, 'u-sana');
  try {
    await say(sana.page, '/summarize last banana');
    await expect(sana.page.getByText('Give a range like', { exact: false })).toBeVisible();
    await expect(sana.page.getByTestId('social-summary-card')).toHaveCount(0);
    // The failed command keeps its draft; replace it.
    await sana.page.getByTestId('social-chat-composer-input').click();
    await sana.page.keyboard.press('ControlOrMeta+A'); await sana.page.keyboard.press('Backspace');
    await say(sana.page, '/summarize');
    const card = sana.page.getByTestId('social-summary-card');
    await expect(card.getByTestId('social-summary-result')).toBeVisible({ timeout: 15_000 });
    await card.getByTestId('social-summary-dismiss').click();
    await expect(card).toHaveCount(0);
    await expect(message(sana.page, 'Highlights')).toHaveCount(0);
  } finally { await sana.context.close(); }
});

test('a non-member cannot summarize a private channel, even by calling the API', async ({ browser, baseURL }) => {
  const sana = await person(browser, baseURL, 'u-sana');
  try {
    const denied = await sana.page.request.post('/api/chat/commands/summarize/run', { data: { channel: 'social:ch:moderators', text: '' } });
    expect([401, 403]).toContain(denied.status());
  } finally { await sana.context.close(); }
});

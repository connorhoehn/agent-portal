import { test, expect, type Browser, type Page } from '@playwright/test';
import { openAs } from './realSession';

// /diagram and /doc in a Social channel: a private run card, a reviewable result
// (the library's NodeGraph with verbatim sources; the page draft preview), and
// the explicit act that shares it — "Post to conversation" for a diagram, "Save
// as document" for a page (a file attached through the conversation's upload
// path). Headless; run against the dev:mock stack (MOCK_AURORA + MOCK_AGENTCORE).
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

test('/diagram: the card is private, draws the thread, and nothing posts until Post', async ({ browser, baseURL }) => {
  test.setTimeout(90_000);
  const sana = await person(browser, baseURL, 'u-sana');
  const mira = await person(browser, baseURL, 'u-mira');
  try {
    await say(sana.page, '/diagram release flow');
    const card = sana.page.getByTestId('social-diagram-card');
    await expect(card).toBeVisible();
    // Since ui-components 2.413.0 the card is a rich localMessage: the library draws the private note beside the body, not inside the card.
    await expect(card.locator('xpath=ancestor::*[@data-testid="chat-local-message"]').getByTestId('chat-local-message-note')).toContainText('Only you can see this');
    await expect(card.getByTestId('social-diagram-graph')).toBeVisible({ timeout: 15_000 });
    await expect(card.getByTestId('social-diagram-sources')).toContainText('Sources');
    // The command was not sent as a message, and nobody else sees the card.
    await expect(message(sana.page, '/diagram')).toHaveCount(0);
    await expect(mira.page.getByTestId('social-diagram-card')).toHaveCount(0, { timeout: 25_000 });
    await expect(message(mira.page, 'Diagram: release flow')).toHaveCount(0);
    // Posting is the explicit act: the outline and the .drawio file arrive.
    await card.getByTestId('social-diagram-post').click();
    await expect(sana.page.getByTestId('social-diagram-card')).toHaveCount(0, { timeout: 25_000 });
    await expect(message(mira.page, 'Diagram: release flow')).toHaveCount(1, { timeout: 15_000 });
    await expect(message(mira.page, 'release-flow.drawio')).toHaveCount(1);
    expect(sana.errors).toEqual([]);
    expect(mira.errors).toEqual([]);
  } finally { await sana.context.close(); await mira.context.close(); }
});

test('/doc: preview the page, Save as document attaches it, and Dismiss posts nothing', async ({ browser, baseURL }) => {
  test.setTimeout(90_000);
  const sana = await person(browser, baseURL, 'u-sana');
  const mira = await person(browser, baseURL, 'u-mira');
  try {
    await say(sana.page, '/doc Runbook');
    const card = sana.page.getByTestId('social-doc-card');
    await expect(card.getByTestId('social-doc-preview')).toBeVisible({ timeout: 15_000 });
    await expect(card.getByTestId('social-doc-preview')).toContainText('Runbook');
    await expect(card.getByTestId('social-doc-sources')).toContainText('Sources');
    await expect(card.getByTestId('social-doc-post')).toHaveCount(0); // a page is saved, never posted as a bare draft
    // Dismiss drops it without posting.
    await card.getByTestId('social-doc-dismiss').click();
    await expect(card).toHaveCount(0);
    await expect(message(mira.page, 'Page: Runbook')).toHaveCount(0);
    // Again, and save.
    await sana.page.getByTestId('social-chat-composer-input').click();
    await say(sana.page, '/doc Runbook');
    const again = sana.page.getByTestId('social-doc-card');
    await expect(again.getByTestId('social-doc-preview')).toBeVisible({ timeout: 15_000 });
    await expect(mira.page.getByTestId('social-doc-card')).toHaveCount(0);
    await again.getByTestId('social-doc-save').click();
    await expect(sana.page.getByTestId('social-doc-card')).toHaveCount(0, { timeout: 25_000 });
    await expect(message(mira.page, 'Page: Runbook')).toHaveCount(1, { timeout: 15_000 });
    await expect(message(mira.page, 'Runbook.md')).toHaveCount(1);
    expect(sana.errors).toEqual([]);
    expect(mira.errors).toEqual([]);
  } finally { await sana.context.close(); await mira.context.close(); }
});

test('both commands are offered in the composer menu beside /summarize and /deck', async ({ browser, baseURL }) => {
  test.setTimeout(60_000);
  const sana = await person(browser, baseURL, 'u-sana');
  try {
    await sana.page.getByTestId('social-chat-composer-input').click();
    await sana.page.keyboard.type('/');
    for (const trigger of ['/summarize', '/deck', '/diagram', '/doc']) await expect(sana.page.getByText(trigger, { exact: true }).first()).toBeVisible();
  } finally { await sana.context.close(); }
});

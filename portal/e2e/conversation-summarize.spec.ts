import { test, expect, type Browser, type Page } from '@playwright/test';
import { openAs } from './realSession';
import { openConversationView } from './conversationViews';

// /summarize beyond Social (middleware routes/conversation-summarize.ts):
// a pipelines run discussion end to end in the UI (private card, verbatim
// quotes, explicit "Post to conversation", nobody else sees the card), plus
// the per-tenant authority over the wire: a reader of each tenant's
// conversation is admitted, a caller standing in another tenant is refused,
// and someone else's run is a 404. Headless; run against a dev:mock stack
// whose BFF is its own gateway (MOCK_AURORA + MOCK_AGENTCORE).
test.use({ viewport: { width: 1440, height: 900 }, ...(process.env.PARITY_BASE_URL ? { baseURL: process.env.PARITY_BASE_URL } : {}) });
test.describe.configure({ mode: 'serial' });

async function person(browser: Browser, baseURL: string | undefined, userId: string) {
  const { page, context, errors } = await openAs(browser, userId, { baseURL, viewport: { width: 1440, height: 900 } });
  return { page, context, errors };
}

async function reset(browser: Browser, baseURL: string | undefined) {
  const context = await browser.newContext({ baseURL });
  try {
    const page = await context.newPage(); await page.goto('/');
    expect((await page.request.post('/api/__mock/reset', { data: {} })).status()).toBe(200);
  } finally { await context.close(); }
}

const COMPOSER = 'pipeline-discussion-panel-composer-input';
async function openRun(page: Page, runId: string) {
  await page.goto(`/pipelines/runs/${encodeURIComponent(runId)}`);
  const input = page.getByTestId(COMPOSER);
  await expect(input).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('pipeline-discussion-panel-offline')).toHaveCount(0, { timeout: 15_000 });
  await expect(input).toBeEditable({ timeout: 15_000 });
}
async function say(page: Page, text: string) {
  await page.getByTestId(COMPOSER).click();
  await page.keyboard.type(text); await page.keyboard.press('Enter');
}
const message = (page: Page, text: string) => page.getByTestId('chat-message').filter({ hasText: text });

async function react(page: Page, text: string) {
  const row = message(page, text);
  await row.hover();
  await row.getByTestId('message-actions').getByRole('button', { name: /^React / }).first().click();
}

test.beforeEach(async ({ browser, baseURL }) => { await reset(browser, baseURL); });
test.afterEach(async ({ browser, baseURL }) => { await reset(browser, baseURL); });

test('the tenant composer offers an @ menu of the people who share the tenant, and a picked name is sent', async ({ browser, baseURL }) => {
  test.setTimeout(90_000);
  const kofi = await person(browser, baseURL, 'u-kofi');
  try {
    const runs = (await (await kofi.page.request.get('/api/pipelines/runs')).json()).runs as Array<{ id: string }>;
    await openRun(kofi.page, runs[0]!.id);
    await kofi.page.getByTestId(COMPOSER).click();
    await kofi.page.keyboard.type('Looping in @Ines');
    await expect(kofi.page.locator('[role="listbox"], [role="option"]').first()).toBeVisible({ timeout: 10_000 });
    await kofi.page.keyboard.press('Enter');
    const stamp = Date.now().toString(36);
    await kofi.page.keyboard.type(` please review ${stamp}`);
    await kofi.page.keyboard.press('Enter');
    await expect(message(kofi.page, `please review ${stamp}`)).toHaveCount(1, { timeout: 10_000 });
    await expect(message(kofi.page, `please review ${stamp}`)).toContainText(/@Ines/);
  } finally { await kofi.context.close(); }
});

test('a pipelines run discussion: the summary is private until its author posts it', async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const kofi = await person(browser, baseURL, 'u-kofi');
  const ines = await person(browser, baseURL, 'u-ines');
  try {
    const runs = (await (await kofi.page.request.get('/api/pipelines/runs')).json()).runs as Array<{ id: string }>;
    const runId = runs[0]!.id;
    await openRun(kofi.page, runId);
    await openRun(ines.page, runId);
    const stamp = Date.now().toString(36);
    await say(ines.page, `Retry budget looks fine ${stamp}.`);
    await expect(message(kofi.page, `Retry budget looks fine ${stamp}`)).toHaveCount(1, { timeout: 10_000 });
    // Reactions: the reader's reaction reaches the author's open page.
    await react(kofi.page, `Retry budget looks fine ${stamp}`);
    await expect(ines.page.getByTestId('reaction-chip').first()).toBeVisible({ timeout: 10_000 });
    await say(kofi.page, '/summarize');
    const card = kofi.page.getByTestId('conversation-summary-card');
    await expect(card).toBeVisible({ timeout: 15_000 });
    // Since ui-components 2.413.0 the card is a rich localMessage: the library draws the private note beside the body, not inside the card.
    await expect(card.locator('xpath=ancestor::*[@data-testid="chat-local-message"]').getByTestId('chat-local-message-note')).toContainText('Only you can see this');
    await expect(card.getByTestId('conversation-summary-result')).toBeVisible({ timeout: 15_000 });
    await expect(card.getByTestId('conversation-summary-result')).toContainText(`Retry budget looks fine ${stamp}`);
    // The command is not a message, and nobody else sees the card.
    await expect(message(kofi.page, '/summarize')).toHaveCount(0);
    await expect(ines.page.getByTestId('conversation-summary-card')).toHaveCount(0);
    await expect(message(ines.page, 'Highlights')).toHaveCount(0);
    await card.getByTestId('conversation-summary-post').click();
    await expect(kofi.page.getByTestId('conversation-summary-card')).toHaveCount(0);
    await expect(message(ines.page, 'Highlights')).toHaveCount(1, { timeout: 10_000 });
    await expect(message(ines.page, 'Sources')).toHaveCount(1);
    expect(kofi.errors).toEqual([]);
    expect(ines.errors).toEqual([]);
  } finally { await kofi.context.close(); await ines.context.close(); }
});

test('per tenant: a reader is admitted, another tenant is refused, someone else\'s run is a 404', async ({ browser, baseURL }) => {
  test.setTimeout(60_000);
  const cases = [
    { reader: 'u-kofi', channel: 'pipelines:def:summarize-e2e', prefix: 'psm', outsider: 'u-mia' },
    { reader: 'u-mia', channel: 'orgiq:initiative:p-auth-migration', prefix: 'osm', outsider: 'u-kofi' },
  ];
  for (const c of cases) {
    const reader = await person(browser, baseURL, c.reader);
    const outsider = await person(browser, baseURL, c.outsider);
    try {
      const started = await reader.page.request.post('/api/conversations/summarize/run', { data: { channel: c.channel } });
      expect(started.status()).toBe(202);
      const { runId } = await started.json() as { runId: string };
      expect(runId.startsWith(`${c.prefix}-`)).toBe(true);
      await expect.poll(async () => (await (await reader.page.request.get(`/api/conversations/summarize/runs/${runId}`)).json()).phase,
        { timeout: 15_000 }).toBe('completed');
      expect((await outsider.page.request.post('/api/conversations/summarize/run', { data: { channel: c.channel } })).status()).toBe(403);
      expect((await outsider.page.request.get(`/api/conversations/summarize/runs/${runId}`)).status()).toBe(404);
      expect((await reader.page.request.post('/api/conversations/summarize/run', { data: { channel: 'social:ch:general' } })).status()).toBe(400);
    } finally { await reader.context.close(); await outsider.context.close(); }
  }
});

// Shared pins on a pipelines run discussion (middleware routes/chat-pins.ts
// `tenantPinAccess`; the run family reads and publishes under ViewPipelines).
const pinned = (page: Page, text: string) => page.getByTestId('pinned-message').filter({ hasText: text });
const pinsTab = (page: Page) => ({ click: () => openConversationView(page, 'pipeline-discussion-panel-pins', 'pins') });

test('a pipelines run discussion: a pin is shared live and Jump returns to the message', async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const kofi = await person(browser, baseURL, 'u-kofi');
  const ines = await person(browser, baseURL, 'u-ines');
  try {
    const runs = (await (await kofi.page.request.get('/api/pipelines/runs')).json()).runs as Array<{ id: string }>;
    const runId = runs[0]!.id;
    await openRun(kofi.page, runId);
    await openRun(ines.page, runId);
    await pinsTab(kofi.page).click();
    await expect(kofi.page.getByText('Nothing pinned yet')).toBeVisible();
    const text = `Pin the retry budget ${Date.now().toString(36)}`;
    await say(ines.page, text);
    const row = message(ines.page, text);
    await expect(row).toHaveCount(1, { timeout: 10_000 });
    await row.hover();
    await row.getByRole('button', { name: 'Pin to channel', exact: true }).click();
    await expect(pinned(kofi.page, text)).toBeVisible({ timeout: 10_000 });
    await pinned(kofi.page, text).getByRole('button', { name: /^Go to the pinned message/ }).click();
    await expect(kofi.page.getByTestId('pipeline-discussion-panel-pins-tab-chat')).toHaveAttribute('aria-checked', 'true');
    await expect(message(kofi.page, text)).toBeVisible();
    await pinsTab(kofi.page).click();
    await pinned(kofi.page, text).getByRole('button', { name: 'Unpin', exact: true }).click();
    await expect(kofi.page.getByText('Nothing pinned yet')).toBeVisible();
    expect(kofi.errors).toEqual([]); expect(ines.errors).toEqual([]);
  } finally { await kofi.context.close(); await ines.context.close(); }
});

test('pins per tenant over the wire: a writer pins from the stored original, another tenant is refused', async ({ browser, baseURL }) => {
  test.setTimeout(90_000);
  const cases = [
    { writer: 'u-kofi', channel: 'pipelines:def:pins-e2e', outsider: 'u-mia' },
    { writer: 'u-nora', channel: 'orgiq:work:wi-auth-e2-b3', outsider: 'u-kofi' },
    { writer: 'u-farah', channel: 'assessment:doc:page:100002', outsider: 'u-kofi' },
  ];
  for (const c of cases) {
    const writer = await person(browser, baseURL, c.writer);
    const outsider = await person(browser, baseURL, c.outsider);
    try {
      const pins = `/api/chat/pins?channel=${encodeURIComponent(c.channel)}`;
      expect((await writer.page.request.get(pins)).status()).toBe(200);
      // Unknown original: nothing to pin, whatever the body claims.
      expect((await writer.page.request.post('/api/chat/pins', { data: { channel: c.channel, messageId: 'no-such-message', text: 'forged', author: 'forged' } })).status()).toBe(404);
      expect((await outsider.page.request.get(pins)).status()).toBe(403);
      expect((await outsider.page.request.post('/api/chat/pins', { data: { channel: c.channel, messageId: 'no-such-message' } })).status()).toBe(403);
      expect((await outsider.page.request.get(`/api/chat/message?channel=${encodeURIComponent(c.channel)}&messageId=x`)).status()).toBe(403);
    } finally { await writer.context.close(); await outsider.context.close(); }
  }
});

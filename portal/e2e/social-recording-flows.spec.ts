import { test, expect, type Browser, type Page } from '@playwright/test';
import { openAs } from './realSession';
import { chooseOption } from './selectOption';

// Slice 7 (docs/agentic-flows-migration.md): a recorded call's transcript as the
// source of `/summarize` and `/deck` in the call's direct message, through the
// library's command argument menu, and the Recordings pane's Summarize action.
// Headless; run against the dev:mock stack (MOCK_AURORA + MOCK_AGENTCORE) with
// the BFF as its own gateway (PARITY_BASE_URL). Seeded: Lena and Sana's recorded
// call (`mock-rec-dm-lena-sana`) and two town-hall room calls.
test.use({ viewport: { width: 1440, height: 900 }, ...(process.env.PARITY_BASE_URL ? { baseURL: process.env.PARITY_BASE_URL } : {}) });
test.describe.configure({ mode: 'serial' });

const DM = 'social:dm:u-lena:u-sana';
const DM_PATH = `/social/dms/${encodeURIComponent(DM)}`;
const REC = 'mock-rec-dm-lena-sana';

async function person(browser: Browser, baseURL: string | undefined, userId: string, path = DM_PATH, withComposer = true) {
  const { page, context, errors } = await openAs(browser, userId, { baseURL, viewport: { width: 1440, height: 900 }, url: path });
  if (withComposer) {
    await expect(page.getByTestId('social-chat-composer-input')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('The realtime gateway is not connected', { exact: false })).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByTestId('social-chat-composer-input')).toBeEditable({ timeout: 15_000 });
  }
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
const decksOf = async (page: Page) => (await (await page.request.get('/api/chat/decks')).json()) as Array<{ id: string }>;

test.beforeEach(async ({ browser, baseURL }) => { await reset(browser, baseURL); });
test.afterEach(async ({ browser, baseURL }) => { await reset(browser, baseURL); });

test('/summarize offers the call in the argument menu; the card quotes the transcript and posts only on request', async ({ browser, baseURL }) => {
  test.setTimeout(90_000);
  const sana = await person(browser, baseURL, 'u-sana');
  const lena = await person(browser, baseURL, 'u-lena');
  try {
    await sana.page.getByTestId('social-chat-composer-input').click();
    await sana.page.keyboard.type('/summarize ');
    // The library's argument menu lists this conversation's recordings.
    const row = sana.page.getByText(`--from recording:${REC}`);
    await expect(row).toBeVisible({ timeout: 10_000 });
    await row.click();
    await expect(sana.page.getByTestId('social-chat-composer-input')).toContainText(`--from recording:${REC}`);
    await sana.page.keyboard.press('Enter');
    const card = sana.page.getByTestId('social-summary-card');
    await expect(card.getByTestId('social-summary-result')).toBeVisible({ timeout: 15_000 });
    await expect(card.getByTestId('social-summary-result')).toContainText('Lena Brandt');
    await expect(card.getByTestId('social-summary-result')).toContainText('Sources');
    // Since ui-components 2.413.0 the card is a rich localMessage: the library draws the private note beside the body, not inside the card.
    await expect(card.locator('xpath=ancestor::*[@data-testid="chat-local-message"]').getByTestId('chat-local-message-note')).toContainText('Only you can see this');
    // Nothing is sent, and the other person sees nothing until Post.
    await expect(message(sana.page, '/summarize')).toHaveCount(0);
    await expect(lena.page.getByTestId('social-summary-card')).toHaveCount(0);
    await expect(message(lena.page, 'Highlights')).toHaveCount(0);
    await card.getByTestId('social-summary-post').click();
    await expect(sana.page.getByTestId('social-summary-card')).toHaveCount(0);
    await expect(message(lena.page, 'Highlights')).toHaveCount(1, { timeout: 10_000 });
    await expect(message(lena.page, 'Sources')).toHaveCount(1);
    expect(sana.errors).toEqual([]);
    expect(lena.errors).toEqual([]);
  } finally { await sana.context.close(); await lena.context.close(); }
});

test('/deck --from recording previews privately, cites the call, and saves only on request', async ({ browser, baseURL }) => {
  test.setTimeout(90_000);
  const sana = await person(browser, baseURL, 'u-sana');
  try {
    await say(sana.page, `/deck Call recap --from recording:${REC} --preview`);
    const card = sana.page.getByTestId('social-deck-card');
    await expect(card).toBeVisible();
    await expect(card.getByTestId('social-deck-privacy')).toContainText('Preview only');
    await expect(card.getByTestId('social-deck-view')).toBeVisible({ timeout: 20_000 });
    await expect(card.locator('[data-testid^="social-deck-slide-"]').first()).toBeVisible();
    expect(await decksOf(sana.page)).toHaveLength(0);
    await card.getByTestId('social-deck-save').click();
    await expect(card.getByTestId('social-deck-open')).toBeVisible({ timeout: 10_000 });
    const decks = await decksOf(sana.page);
    expect(decks).toHaveLength(1);
    // The saved revision's slides cite the recording's segments.
    const detail = await (await sana.page.request.get(`/api/chat/decks/${decks[0]!.id}`)).json() as { activeRevisionId: string };
    const spec = await (await sana.page.request.get(`/api/chat/decks/${decks[0]!.id}/revisions/${detail.activeRevisionId}/spec`)).json() as { spec?: { slides: Array<{ sources: Array<{ documentId: string }> }> }; slides?: Array<{ sources: Array<{ documentId: string }> }> };
    const slides = spec.spec?.slides ?? spec.slides ?? [];
    expect(slides.flatMap(s => s.sources.map(x => x.documentId)).some(id => id.startsWith(`recording:${REC}#`))).toBe(true);
    expect(sana.errors).toEqual([]);
  } finally { await sana.context.close(); }
});

test('Recordings pane: Summarize opens the call\'s conversation with the private card; a room call has no conversation', async ({ browser, baseURL }) => {
  test.setTimeout(90_000);
  const sana = await person(browser, baseURL, 'u-sana', `/social/recordings?recording=${REC}`, false);
  try {
    await expect(sana.page.getByTestId('social-recording-detail')).toBeVisible({ timeout: 20_000 });
    await sana.page.getByTestId('social-recording-summarize').click();
    await expect(sana.page).toHaveURL(/\/social\/dms\//);
    const card = sana.page.getByTestId('social-summary-card');
    await expect(card.getByTestId('social-summary-result')).toBeVisible({ timeout: 20_000 });
    await expect(card.getByTestId('social-summary-result')).toContainText('Lena Brandt');
    // The one-shot parameter is consumed: a reload does not run it again.
    await expect(sana.page).not.toHaveURL(/summarizeRecording/);
    expect(sana.errors).toEqual([]);
  } finally { await sana.context.close(); }
});

// A room has no chat: the private card is drawn by the Recordings pane and Post goes to a channel the requester picks.
test('Recordings pane: a room call\'s summary is a private card in the pane; Post goes to the chosen channel only', async ({ browser, baseURL }) => {
  test.setTimeout(90_000);
  const sana = await person(browser, baseURL, 'u-sana', '/social/recordings?recording=mock-rec-town-hall-1', false);
  const lena = await person(browser, baseURL, 'u-lena', '/social/channels/general');
  try {
    await expect(sana.page.getByTestId('social-recording-detail')).toBeVisible({ timeout: 20_000 });
    await expect(sana.page.getByTestId('social-recording-summarize')).toBeEnabled();
    await sana.page.getByTestId('social-recording-summarize').click();
    const card = sana.page.getByTestId('social-summary-card');
    await expect(card.getByTestId('social-summary-result')).toBeVisible({ timeout: 20_000 });
    await expect(card.getByTestId('social-summary-result')).toContainText('Moderation volume');
    await expect(card).toContainText('Only you can see this');
    await expect(sana.page).toHaveURL(/\/social\/recordings/);
    // Nobody else sees anything until Post, and Post needs a target.
    await expect(message(lena.page, 'Highlights')).toHaveCount(0);
    await card.getByTestId('social-summary-post').click();
    await expect(card).toContainText('Choose where to post');
    await chooseOption(sana.page.getByTestId('social-room-summary-target'), { label: '# General' });
    await card.getByTestId('social-summary-post').click();
    await expect(sana.page.getByTestId('social-summary-card')).toHaveCount(0, { timeout: 15_000 });
    await expect(message(lena.page, 'Highlights')).toHaveCount(1, { timeout: 10_000 });
    expect(sana.errors).toEqual([]);
    expect(lena.errors).toEqual([]);
  } finally { await sana.context.close(); await lena.context.close(); }
});

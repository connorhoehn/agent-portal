import { test, expect, type Browser, type Page } from '@playwright/test';
import { openAs } from './realSession';
import { chooseComposerMode, openConversationView } from './conversationViews';

// The orgiq initiative and work-item discussion (gateway families
// orgiq:initiative:<id> / orgiq:work:<id>): live chat between two users, a
// separate thread per work item, a private /summarize card, and a read-only
// composer for a member without DispatchAgentRun. Each discussion is the
// shell's right conversation pane (the library SidePane), the fourth column,
// not a section of the page. Headless; run against a dev:mock stack whose BFF
// is its own gateway (PARITY_BASE_URL).
test.use({ viewport: { width: 1440, height: 900 }, ...(process.env.PARITY_BASE_URL ? { baseURL: process.env.PARITY_BASE_URL } : {}) });
test.describe.configure({ mode: 'serial' });

const INITIATIVE = '/iq/projects/p-auth-migration';
const ITEM = `${INITIATIVE}?tab=work&item=wi-auth-e2-b3&view=comments`;

const signedIn = (browser: Browser, baseURL: string | undefined, userId: string) =>
  openAs(browser, userId, { baseURL, viewport: { width: 1440, height: 900 } });

// The page's ONE composer is docked in the content column (2026-10-07); the pane is the thread.
const pageComposer = (page: Page) => page.getByTestId('initiative-workspace').getByTestId('initiative-composer');
const message = (page: Page, text: string) => page.getByTestId('chat-message').filter({ hasText: text });
async function open(page: Page, url: string, section: string) {
  await page.goto(url);
  await expect(page.getByTestId('page-conversation-pane').getByTestId(section)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('scope-discussion-panel-offline')).toHaveCount(0, { timeout: 15_000 });
}
async function react(page: Page, text: string) {
  const row = message(page, text);
  await row.hover({ timeout: 10_000 });
  await row.getByTestId('message-actions').getByRole('button', { name: /^React / }).first().click({ timeout: 10_000 });
}
/** The page's one input is the content column's composer (Chat → the Discussion); the pane shows the thread. */
async function sayOnItem(page: Page, text: string) {
  const dock = pageComposer(page);
  await chooseComposerMode(page, dock, 'Agent', 'Chat');
  await expect(dock.getByRole('combobox', { name: 'Chat recipient' })).toHaveValue('discussion');
  const input = dock.getByTestId('rich-chat-composer-input');
  await input.click();
  await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.press('Backspace');
  await page.keyboard.type(text); await page.keyboard.press('Enter');
}
async function say(page: Page, text: string) {
  await expect(pageComposer(page).getByTestId('rich-chat-composer-input')).toHaveAttribute('contenteditable', 'true', { timeout: 15_000 });
  await sayOnItem(page, text);
}

test.beforeEach(async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  try { const page = await context.newPage(); await page.goto('/'); expect((await page.request.post('/api/__mock/reset', { data: {} })).status()).toBe(200); }
  finally { await context.close(); }
});

test('two users chat live on an initiative; a work item has its own thread; /summarize is private', async ({ browser, baseURL }) => {
  test.setTimeout(150_000);
  const nora = await signedIn(browser, baseURL, 'u-nora');
  const rachel = await signedIn(browser, baseURL, 'u-rachel');
  try {
    await open(nora.page, INITIATIVE, 'initiative-live-discussion');
    await open(rachel.page, INITIATIVE, 'initiative-live-discussion');
    const stamp = Date.now().toString(36);
    await say(rachel.page, `Cutover window is Friday ${stamp}.`);
    await expect(message(nora.page, `Cutover window is Friday ${stamp}`)).toHaveCount(1, { timeout: 10_000 });

    // Work item: its own channel — the initiative message is not there.
    await open(nora.page, ITEM, 'work-item-live-discussion');
    await open(rachel.page, ITEM, 'work-item-live-discussion');
    await expect(message(nora.page, `Cutover window is Friday ${stamp}`)).toHaveCount(0);
    await expect(nora.page.getByTestId('page-conversation-pane').locator('[contenteditable="true"]'), 'the pane is the thread: the one input is the page composer').toHaveCount(0);
    await sayOnItem(nora.page, `Shim cookie repro attached ${stamp}.`);
    await expect(message(rachel.page, `Shim cookie repro attached ${stamp}`)).toHaveCount(1, { timeout: 10_000 });

    // Reactions reach the other open page.
    await react(rachel.page, `Shim cookie repro attached ${stamp}`);
    await expect(nora.page.getByTestId('reaction-chip').first()).toBeVisible({ timeout: 10_000 });

    // /summarize: a private card for the requester only.
    await sayOnItem(rachel.page, '/summarize');
    const card = rachel.page.getByTestId('conversation-summary-card');
    await expect(card).toBeVisible({ timeout: 15_000 });
    // Since ui-components 2.413.0 the card is a rich localMessage: the library draws the private note beside the body, not inside the card.
    await expect(card.locator('xpath=ancestor::*[@data-testid="chat-local-message"]').getByTestId('chat-local-message-note')).toContainText('Only you can see this');
    await expect(card.getByTestId('conversation-summary-result')).toContainText(`Shim cookie repro attached ${stamp}`, { timeout: 15_000 });
    await expect(nora.page.getByTestId('conversation-summary-card')).toHaveCount(0);
    expect(nora.errors).toEqual([]);
    expect(rachel.errors).toEqual([]);
  } finally { await nora.context.close(); await rachel.context.close(); }
});

test('a member without DispatchAgentRun sees the history and a read-only composer with the reason', async ({ browser, baseURL }) => {
  test.setTimeout(90_000);
  const nora = await signedIn(browser, baseURL, 'u-nora');
  const theo = await signedIn(browser, baseURL, 'u-theo');
  try {
    await open(nora.page, INITIATIVE, 'initiative-live-discussion');
    const stamp = Date.now().toString(36);
    await say(nora.page, `Readable by members ${stamp}.`);
    await open(theo.page, INITIATIVE, 'initiative-live-discussion');
    await expect(message(theo.page, `Readable by members ${stamp}`)).toHaveCount(1, { timeout: 10_000 });
    await expect(theo.page.getByTestId('scope-discussion-panel-read-only')).toContainText('not post to it');
    // The reader's page composer offers no post to the discussion (Chat says why).
    await expect(theo.page.getByTestId('page-conversation-pane').locator('[contenteditable="true"]')).toHaveCount(0);
    // Reactions publish under DispatchAgentRun, so a reader gets no picker.
    await message(theo.page, `Readable by members ${stamp}`).hover();
    await expect(theo.page.getByTestId('message-actions').getByRole('button', { name: /^React / })).toHaveCount(0);
    expect(theo.errors).toEqual([]);
  } finally { await nora.context.close(); await theo.context.close(); }
});

// Shared pins on the initiative discussion (middleware routes/chat-pins.ts
// `tenantPinAccess`): read authority to list and Jump, DispatchAgentRun to pin.
const pinned = (page: Page, text: string) => page.getByTestId('pinned-message').filter({ hasText: text });
const pinsTab = (page: Page) => ({ click: () => openConversationView(page, 'scope-discussion-panel-pins', 'pins') });

test('a pin is shared live, Jump finds the message, and a reader gets a read-only Pinned view', async ({ browser, baseURL }) => {
  test.setTimeout(150_000);
  const nora = await signedIn(browser, baseURL, 'u-nora');
  const rachel = await signedIn(browser, baseURL, 'u-rachel');
  const theo = await signedIn(browser, baseURL, 'u-theo');
  try {
    await open(nora.page, INITIATIVE, 'initiative-live-discussion');
    await open(rachel.page, INITIATIVE, 'initiative-live-discussion');
    await pinsTab(rachel.page).click();
    await expect(rachel.page.getByText('Nothing pinned yet')).toBeVisible();
    const text = `Pin the cutover checklist ${Date.now().toString(36)}`;
    await say(nora.page, text);
    const row = message(nora.page, text);
    await expect(row).toHaveCount(1, { timeout: 10_000 });
    await row.hover();
    await row.getByRole('button', { name: 'Pin to channel', exact: true }).click();
    // Live on the other open page, with the server's own author and pinner.
    await expect(pinned(rachel.page, text)).toBeVisible({ timeout: 10_000 });
    const listed = await (await rachel.page.request.get('/api/chat/pins?channel=orgiq%3Ainitiative%3Ap-auth-migration')).json();
    expect(listed.pins[0]).toMatchObject({ pinnedBy: 'u-nora', preview: text });
    expect(listed.pins[0].sentAt).toBeTruthy();
    // Survives reload; Jump returns to Chat with the message on screen.
    await rachel.page.reload();
    await expect(rachel.page.getByTestId('scope-discussion-panel-offline')).toHaveCount(0, { timeout: 15_000 });
    await pinsTab(rachel.page).click();
    await pinned(rachel.page, text).getByRole('button', { name: /^Go to the pinned message/ }).click();
    await expect(rachel.page.getByTestId('scope-discussion-panel-pins-tab-chat')).toHaveAttribute('aria-checked', 'true');
    await expect(message(rachel.page, text)).toBeVisible();

    // A member without DispatchAgentRun: sees the pin, cannot pin or unpin.
    await open(theo.page, INITIATIVE, 'initiative-live-discussion');
    await message(theo.page, text).hover();
    await expect(message(theo.page, text).getByRole('button', { name: 'Pin to channel', exact: true })).toHaveCount(0);
    await pinsTab(theo.page).click();
    await expect(pinned(theo.page, text)).toBeVisible();
    await expect(pinned(theo.page, text).getByRole('button', { name: 'Unpin', exact: true })).toHaveCount(0);
    const forged = await theo.page.request.post('/api/chat/pins', { data: { channel: 'orgiq:initiative:p-auth-migration', messageId: listed.pins[0].messageId, text: 'x', author: 'x' } });
    expect(forged.status()).toBe(403);

    // The pinner unpins; the reader's Pinned view empties live.
    await pinsTab(nora.page).click();
    await pinned(nora.page, text).getByRole('button', { name: 'Unpin', exact: true }).click();
    await expect(theo.page.getByText('Nothing pinned yet')).toBeVisible({ timeout: 10_000 });
    expect(nora.errors).toEqual([]); expect(rachel.errors).toEqual([]); expect(theo.errors).toEqual([]);
  } finally { await nora.context.close(); await rachel.context.close(); await theo.context.close(); }
});

import { test, expect, type Browser, type Page } from '@playwright/test';
import { openAs } from './realSession';

// /deck in a Social channel (docs/agentic-flows-migration.md slice 5): a private
// run card, `--preview` that stores nothing until "Save deck", the saved deck in
// the library PresentationEditor with presence for the conversation's members,
// and an explicit "Post to conversation". Headless; run against the dev:mock
// stack (MOCK_AURORA + MOCK_AGENTCORE) with the BFF as its own gateway
// (PARITY_BASE_URL, e.g. http://127.0.0.1:5296 with the BFF on :3096).
test.use({ viewport: { width: 1440, height: 900 }, ...(process.env.PARITY_BASE_URL ? { baseURL: process.env.PARITY_BASE_URL } : {}) });
test.describe.configure({ mode: 'serial' });

async function person(browser: Browser, baseURL: string | undefined, userId: string, path = '/social/channels/general', tenant?: string) {
  const { context, page, errors } = await openAs(browser, userId, { baseURL, viewport: { width: 1440, height: 900 }, tenant, url: path });
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
const decksOf = async (page: Page) => (await (await page.request.get('/api/chat/decks')).json()) as Array<{ id: string }>;

test.beforeEach(async ({ browser, baseURL }) => { await reset(browser, baseURL); });
test.afterEach(async ({ browser, baseURL }) => { await reset(browser, baseURL); });

test('--preview shows the slides privately and stores nothing until Save deck', async ({ browser, baseURL }) => {
  test.setTimeout(90_000);
  const sana = await person(browser, baseURL, 'u-sana');
  const mira = await person(browser, baseURL, 'u-mira');
  try {
    await say(sana.page, '/deck Community call — Thursday --preview');
    const card = sana.page.getByTestId('social-deck-card');
    await expect(card).toBeVisible();
    await expect(card.getByTestId('social-deck-privacy')).toContainText('Preview only');
    await expect(card.getByTestId('social-deck-view')).toBeVisible({ timeout: 20_000 });
    await expect(card.locator('[data-testid^="social-deck-slide-"]').first()).toBeVisible();
    // The command was not sent as a message, nobody else sees the card, and nothing is stored.
    await expect(message(sana.page, '/deck')).toHaveCount(0);
    await expect(mira.page.getByTestId('social-deck-card')).toHaveCount(0);
    expect(await decksOf(sana.page)).toHaveLength(0);
    await expect(card.getByTestId('social-deck-post')).toHaveCount(0);
    // Save deck is the one write; then Open and Post appear.
    await card.getByTestId('social-deck-save').click();
    await expect(card.getByTestId('social-deck-open')).toBeVisible({ timeout: 10_000 });
    await expect(card.getByTestId('social-deck-save')).toHaveCount(0);
    expect(await decksOf(sana.page)).toHaveLength(1);
    expect(sana.errors).toEqual([]);
    expect(mira.errors).toEqual([]);
  } finally { await sana.context.close(); await mira.context.close(); }
});


test('a saved deck opens in the editor; a member who may post edits it too (one deck write rule), an outsider cannot, and the owner sees presence', async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const sana = await person(browser, baseURL, 'u-sana');
  try {
    await say(sana.page, '/deck Release notes');
    const card = sana.page.getByTestId('social-deck-card');
    await expect(card.getByTestId('social-deck-open')).toBeVisible({ timeout: 20_000 });
    await card.getByTestId('social-deck-open').click();
    await expect(sana.page).toHaveURL(/\/social\/decks\/sdeck-/);
    const url = sana.page.url();
    await expect(sana.page.getByTestId('social-deck-editor')).toBeVisible({ timeout: 20_000 });
    await expect(sana.page.getByTestId('social-deck-shell')).toContainText('Release notes');

    const mira = await person(browser, baseURL, 'u-mira');
    try {
      await mira.page.goto(url);
      // A current member holding PostMessage gets the editor (deckWriteAuthority); a reader would get the viewer.
      await expect(mira.page.getByTestId('social-deck-editor')).toBeVisible({ timeout: 20_000 });
      await expect(mira.page.getByText('Release notes').first()).toBeVisible();
      // The owner sees the member arrive on the deck's presence channel.
      await expect(sana.page.getByTestId('social-deck-shell-byline').getByTestId('presence-avatar').first()).toBeVisible({ timeout: 20_000 });
      // The member can download the .pptx through the BFF.
      const deckId = url.split('/').pop()!;
      const file = await mira.context.request.get(`/api/chat/decks/${deckId}/revisions/${(await (await mira.context.request.get(`/api/chat/decks/${deckId}`)).json()).activeRevisionId}/file`);
      expect(file.status()).toBe(200);
      expect(file.headers()['content-type']).toContain('presentationml');
      expect(mira.errors).toEqual([]);
    } finally { await mira.context.close(); }

    // Someone outside #general (Lena's private channel is not it; u-farah is a member, so use a deck from #moderators).
    const lena = await person(browser, baseURL, 'u-lena', '/social/channels/moderators');
    try {
      await say(lena.page, '/deck Moderation review');
      await expect(lena.page.getByTestId('social-deck-open')).toBeVisible({ timeout: 20_000 });
      const modDeck = (await decksOf(lena.page))[0]!.id;
      const outsider = await person(browser, baseURL, 'u-sana');
      try {
        expect((await outsider.context.request.get(`/api/chat/decks/${modDeck}`)).status()).toBe(404);
        await outsider.page.goto(`/social/decks/${modDeck}`);
        await expect(outsider.page.getByText("Couldn't open the deck")).toBeVisible({ timeout: 15_000 });
        await expect(outsider.page.getByTestId('social-deck-editor')).toHaveCount(0);
      } finally { await outsider.context.close(); }
    } finally { await lena.context.close(); }
    expect(sana.errors).toEqual([]);
  } finally { await sana.context.close(); }
});

test('the owner instructs the agent on a slide: one new revision opens in the editor; a member and a stale or replayed request are handled', async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const sana = await person(browser, baseURL, 'u-sana');
  const mira = await person(browser, baseURL, 'u-mira');
  try {
    await say(sana.page, '/deck Release notes');
    await expect(sana.page.getByTestId('social-deck-open')).toBeVisible({ timeout: 20_000 });
    const deckId = (await decksOf(sana.page))[0]!.id;
    const before = await (await sana.page.request.get(`/api/chat/decks/${deckId}`)).json();
    await sana.page.goto(`/social/decks/${deckId}`);
    await expect(sana.page.getByTestId('social-deck-editor')).toBeVisible({ timeout: 20_000 });
    await sana.page.getByTestId('social-deck-editor-slide-select-overview').click();
    await sana.page.getByTestId('deck-composer-input').click();
    await sana.page.keyboard.type('Add speaker notes');
    const revised = sana.page.waitForResponse(r => /\/api\/chat\/decks\/[^/]+\/revise$/.test(r.url()) && r.request().method() === 'POST');
    await sana.page.getByTestId('deck-composer-send').click();
    const response = await revised;
    expect(response.status()).toBe(201);
    const sent = JSON.parse(response.request().postData() ?? '{}');
    expect(sent).toMatchObject({ slideId: 'overview', baseRevisionId: before.activeRevisionId, requestId: expect.stringMatching(/^req-/) });
    const body = await response.json();
    expect(body).toMatchObject({ revisionId: expect.stringMatching(/^srev-/), replayed: false });
    const after = await (await sana.page.request.get(`/api/chat/decks/${deckId}`)).json();
    expect(after.revisions).toHaveLength(before.revisions.length + 1);
    expect(after.activeRevisionId).toBe(body.revisionId);
    expect(after.revisions[0].producedBy).toBe('agent:social');
    await expect(sana.page.getByTestId('deck-composer-status')).toBeVisible();

    const replay = await sana.page.request.post(`/api/chat/decks/${deckId}/revise`, { data: sent });
    expect(replay.status()).toBe(200);
    expect(await replay.json()).toMatchObject({ revisionId: body.revisionId, replayed: true });
    const stale = await sana.page.request.post(`/api/chat/decks/${deckId}/revise`, { data: { instruction: 'Add speaker notes', baseRevisionId: before.activeRevisionId } });
    expect(stale.status()).toBe(409);
    // A current member who may post revises too (one write rule); a non-member never reaches the deck.
    expect((await mira.page.request.post(`/api/chat/decks/${deckId}/revise`, { data: { instruction: 'Add speaker notes', baseRevisionId: body.revisionId } })).status()).toBe(201);
    await mira.page.goto(`/social/decks/${deckId}`);
    await expect(mira.page.getByTestId('deck-composer-input')).toBeVisible({ timeout: 20_000 });
    expect(sana.errors).toEqual([]);
    expect(mira.errors).toEqual([]);
  } finally { await sana.context.close(); await mira.context.close(); }
});

test('a deck that cites an initiative page revises its cited slide from the page the reviser can read now', async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const theo = await person(browser, baseURL, 'u-theo', '/social/channels/general', 'social');
  try {
    await say(theo.page, '/deck Plan review #initiative:p-soc2');
    await expect(theo.page.getByTestId('social-deck-open')).toBeVisible({ timeout: 20_000 });
    const deckId = (await decksOf(theo.page))[0]!.id;
    const before = await (await theo.page.request.get(`/api/chat/decks/${deckId}`)).json();
    const revise = await theo.page.request.post(`/api/chat/decks/${deckId}/revise`, {
      data: { instruction: 'Add speaker notes', baseRevisionId: before.activeRevisionId, requestId: `req-cited-${Date.now()}` },
    });
    expect(revise.status()).toBe(201);
    const { revisionId } = await revise.json();
    const spec = await (await theo.page.request.get(`/api/chat/decks/${deckId}/revisions/${revisionId}/spec`)).json();
    const pages = spec.slides.find((s: { id: string }) => s.id === 'pages');
    expect(pages.sources.map((x: { documentId: string }) => x.documentId)).toContain('social-page:initiative:p-soc2');
    expect(pages.bullets.join(' ')).toContain('Initiative:');
    // A stale base is still refused.
    expect((await theo.page.request.post(`/api/chat/decks/${deckId}/revise`, { data: { instruction: 'Shorter', baseRevisionId: before.activeRevisionId } })).status()).toBe(409);
    expect(theo.errors).toEqual([]);
  } finally { await theo.context.close(); }
});


test('Post to conversation sends the .pptx as an attachment, and only when asked', async ({ browser, baseURL }) => {
  test.setTimeout(90_000);
  const sana = await person(browser, baseURL, 'u-sana');
  const mira = await person(browser, baseURL, 'u-mira');
  try {
    await say(sana.page, '/deck Standup recap');
    const card = sana.page.getByTestId('social-deck-card');
    await expect(card.getByTestId('social-deck-post')).toBeVisible({ timeout: 20_000 });
    await expect(message(mira.page, 'Shared deck')).toHaveCount(0);
    await card.getByTestId('social-deck-post').click();
    await expect(card.getByTestId('social-deck-posted')).toBeVisible({ timeout: 20_000 });
    await expect(message(mira.page, 'Shared deck: Standup recap')).toHaveCount(1, { timeout: 15_000 });
    expect(sana.errors).toEqual([]);
    expect(mira.errors).toEqual([]);
  } finally { await sana.context.close(); await mira.context.close(); }
});


test('bad input explains itself and starts nothing', async ({ browser, baseURL }) => {
  test.setTimeout(60_000);
  const sana = await person(browser, baseURL, 'u-sana');
  try {
    await say(sana.page, '/deck Review --from transcript');
    await expect(sana.page.getByText('Pick a recording to build from', { exact: false })).toBeVisible();
    await expect(sana.page.getByTestId('social-deck-card')).toHaveCount(0);
    expect(await decksOf(sana.page)).toHaveLength(0);
  } finally { await sana.context.close(); }
});

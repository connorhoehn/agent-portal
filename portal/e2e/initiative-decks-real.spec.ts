import { readFileSync } from 'node:fs';
import { loginAs } from './realSession';
import { chooseComposerMode } from './conversationViews';
import { type Browser, type BrowserContext, type Page } from '@playwright/test';
import { test, expect } from './cdpTest';

// Browser half for docs/agentic-flows-migration.md slice 6 (orgiq initiative
// status deck). Real BFF + session + Cedar; mock fixtures; MOCK_AGENTCORE
// supplies the deterministic narrative. Headless, against the dev:mock stack
// (PARITY_BASE_URL, e.g. http://127.0.0.1:5299 with the BFF on :3099).
//
//   u-mia   (orgiq: program-owner)  budget reader: builds with budget figures, edits, downloads
//   u-vera  (orgiq: org-leader)     budget reader: second editor, presence, stale-save 409
//   u-nora  (orgiq: sme)            may build but cannot read budgets: no money slide, cannot open a budget deck
//   u-theo  (orgiq: member)         reads the initiative page; no build form

test.use({ viewport: { width: 1440, height: 900 }, ...(process.env.PARITY_BASE_URL ? { baseURL: process.env.PARITY_BASE_URL } : {}) });
test.describe.configure({ mode: 'serial' });

const PID = 'p-auth-migration';
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
type Person = { context: BrowserContext; page: Page; errors: string[] };

async function open(browser: Browser, baseURL: string | undefined, userId: string, role: string): Promise<Person> {
  const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await loginAs(context, userId, baseURL, true);
  const switched = await context.request.post('/api/session/role', { data: { role } });
  expect(switched.status(), `${userId} role switch`).toBe(200);
  return { context, page, errors };
}

const api = async (p: Person, path: string) => {
  const response = await p.context.request.get(`/api/initiative-decks${path}`);
  expect(response.status(), path).toBe(200);
  return response.json();
};
const thumbs = (page: Page) => page.locator('[data-testid^="initiative-deck-editor-slide-thumb-"]');
const bullets = (spec: { slides: Array<{ id: string; bullets?: string[] }> }, id: string) => (spec.slides.find(s => s.id === id)?.bullets ?? []).join('\n');

let budgetDeckId = '';
let plainDeckId = '';

test.beforeAll(async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  expect((await context.request.post('/api/__mock/reset', { data: {} })).status(), 'mock reset').toBe(200);
  await context.close();
});
test.afterAll(async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  await context.request.post('/api/__mock/reset', { data: {} });
  await context.close();
});

// The header's Status deck button is gone (2026-10-07): an initiative deck is
// built with `/deck` in the page's composer, docked in the content column. The
// command answers with a private card; its Open goes to /iq/decks/:id.
async function slashDeck(page: Page, title: string) {
  await expect(page.getByTestId('initiative-header')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('page-conversation-pane-title')).toBeVisible({ timeout: 20_000 });
  const input = page.getByTestId('initiative-workspace').getByTestId('initiative-composer').locator('[contenteditable="true"]');
  await expect(input).toHaveCount(1, { timeout: 20_000 });
  await input.click();
  // The page composer may carry its prefill: start from an empty draft.
  await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.press('Backspace');
  await page.keyboard.type(`/deck ${title}`);
  await page.keyboard.press('Enter');
}
const createdDeck = (page: Page) => page.waitForResponse(r => /\/api\/initiative-decks\/projects\/[^/]+$/.test(r.url()) && r.request().method() === 'POST');

test('(a) a program owner builds a status deck from the initiative page; every slide plus Sources shows, numbers equal the initiative and the ledger', async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const mia = await open(browser, baseURL, 'u-mia', 'program-owner');
  try {
    await mia.page.goto(`/iq/projects/${PID}`);
    const created = createdDeck(mia.page);
    await slashDeck(mia.page, 'Auth Migration status');
    const response = await created;
    expect(response.status(), await response.text()).toBe(201);
    const body = await response.json();
    expect(body).toMatchObject({ deckId: expect.stringMatching(/^idk-/), revisionId: expect.stringMatching(/^irev-/), includesBudget: true, narrative: { requested: true } });
    budgetDeckId = body.deckId;
    // In the page composer's Agent mode /deck opens the built deck at once; in
    // Chat (the thread's own command) it answers with a private card whose Open goes there.
    const card = mia.page.getByTestId('tenant-deck-card');
    const deckUrl = new RegExp(`/iq/decks/${budgetDeckId}$`);
    await expect.poll(async () => deckUrl.test(mia.page.url()) || await card.isVisible(), { timeout: 20_000 }).toBe(true);
    if (!deckUrl.test(mia.page.url())) await card.getByTestId('tenant-deck-open').click();
    await expect(mia.page).toHaveURL(deckUrl);
    await expect(mia.page.getByTestId('initiative-deck-editor')).toBeVisible({ timeout: 30_000 });

    const spec = await api(mia, `/${budgetDeckId}/revisions/${body.revisionId}/spec`);
    type Node = { status: string; children?: Node[] };
    const flatten = (nodes: Node[]): Node[] => nodes.flatMap(n => [n, ...flatten(n.children ?? [])]);
    const items = flatten(await (await mia.context.request.get(`/api/graph/projects/${PID}/work`)).json() as Node[]);
    const open_ = items.filter(i => i.status !== 'done' && i.status !== 'cancelled').length;
    expect(bullets(spec, 'summary')).toContain(`Work items: ${items.length} total · ${open_} open · ${items.filter(i => i.status === 'done').length} done`);
    const ledger = await (await mia.context.request.get('/api/budgets')).json() as { budgets: Array<{ orgProjectId: string; allocatedUsd: number | null; spentThisPeriodUsd: number }> };
    const row = ledger.budgets.find(b => b.orgProjectId === PID)!;
    expect(bullets(spec, 'budget')).toContain(`Monthly allocation: $${row.allocatedUsd!.toFixed(2)}`);
    expect(bullets(spec, 'budget')).toContain(`Spent this period: $${row.spentThisPeriodUsd.toFixed(2)} across`);
    await expect(thumbs(mia.page)).toHaveCount(spec.slides.length + 1);
    await expect(mia.page.getByTestId('initiative-deck-editor-slide-generated-sources')).toBeVisible();
    expect(mia.errors).toEqual([]);
  } finally { await mia.context.close(); }
});

test('(b) Download returns a .pptx attachment', async ({ browser, baseURL }) => {
  test.setTimeout(60_000);
  expect(budgetDeckId, 'deck from (a)').not.toBe('');
  const mia = await open(browser, baseURL, 'u-mia', 'program-owner');
  try {
    await mia.page.goto(`/iq/decks/${budgetDeckId}`);
    await expect(mia.page.getByTestId('initiative-deck-editor')).toBeVisible({ timeout: 30_000 });
    const [response, download] = await Promise.all([
      mia.page.waitForResponse(r => /\/revisions\/[^/]+\/file$/.test(r.url())),
      mia.page.waitForEvent('download'),
      mia.page.getByRole('button', { name: /Download/ }).click(),
    ]);
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toBe(PPTX);
    expect(response.headers()['content-disposition']).toMatch(/^attachment; filename="[a-z0-9-]+-v\d+\.pptx"$/);
    expect(readFileSync((await download.path())!).subarray(0, 2).toString('latin1')).toBe('PK');
  } finally { await mia.context.close(); }
});

test('(c) a manual edit saves a revision; a save from a stale base shows the newer-version banner', async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const first = await open(browser, baseURL, 'u-mia', 'program-owner');
  const second = await open(browser, baseURL, 'u-vera', 'org-leader');
  try {
    const before = await api(first, `/${budgetDeckId}`);
    for (const p of [first, second]) {
      await p.page.goto(`/iq/decks/${budgetDeckId}`);
      await expect(p.page.getByTestId('initiative-deck-editor')).toBeVisible({ timeout: 30_000 });
      await p.page.getByTestId('initiative-deck-editor-slide-select-summary').click();
      await expect(p.page.getByTestId('initiative-deck-editor-slide-title')).toBeVisible();
    }
    // Keep the second editor dirty before the first save; a clean editor now
    // follows saved revisions, so merely opening it earlier is not a stale draft.
    await second.page.getByTestId('initiative-deck-editor-slide-title').fill('Summary (stale edit)');
    await first.page.getByTestId('initiative-deck-editor-slide-title').fill('Summary (edited by hand)');
    await first.page.getByRole('button', { name: /^Save as v/ }).click();
    await expect.poll(async () => (await api(first, `/${budgetDeckId}`)).revisions.length, { timeout: 15_000 }).toBe(before.revisions.length + 1);
    const saved = await api(first, `/${budgetDeckId}`);
    expect(saved.revisions[0].producedBy).toBe('person:u-mia');

    await expect(second.page.getByTestId('initiative-deck-editor-slide-title')).toHaveValue('Summary (stale edit)');
    const stale = second.page.waitForResponse(r => /\/api\/initiative-decks\/[^/]+\/revisions$/.test(r.url()) && r.request().method() === 'POST');
    await second.page.getByRole('button', { name: /^Save as v/ }).click();
    const response = await stale;
    expect(response.status()).toBe(409);
    expect(await response.json()).toMatchObject({ activeRevisionId: saved.activeRevisionId });
    await expect(second.page.getByTestId('initiative-deck-conflict')).toBeVisible();
    expect((await api(second, `/${budgetDeckId}`)).revisions).toHaveLength(before.revisions.length + 1);
    for (const p of [first, second]) expect(p.errors).toEqual([]);
  } finally { await Promise.all([first.context.close(), second.context.close()]); }
});

test('(d) an SME builds a deck with no budget figure, cannot see or open the budget deck, and may share the plain one', async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  expect(budgetDeckId, 'deck from (a)').not.toBe('');
  const nora = await open(browser, baseURL, 'u-nora', 'sme');
  try {
    await nora.page.goto(`/iq/projects/${PID}`);
    // The server decides the budget tier: an SME's /deck carries no figure.
    const created = createdDeck(nora.page);
    await slashDeck(nora.page, 'Auth Migration status');
    const response = await created;
    expect(response.status()).toBe(201);
    const body = await response.json();
    expect(body.includesBudget).toBe(false);
    plainDeckId = body.deckId;
    // Agent mode opens the deck at once; Chat answers with a private card (see (a)).
    const deckUrl = new RegExp(`/iq/decks/${plainDeckId}$`);
    const card = nora.page.getByTestId('tenant-deck-card');
    await expect.poll(async () => deckUrl.test(nora.page.url()) || await card.isVisible(), { timeout: 20_000 }).toBe(true);
    if (!deckUrl.test(nora.page.url())) await card.getByTestId('tenant-deck-open').click();
    await expect(nora.page.getByTestId('initiative-deck-editor')).toBeVisible({ timeout: 30_000 });

    const spec = await api(nora, `/${plainDeckId}/revisions/${body.revisionId}/spec`);
    expect(spec.slides.map((s: { id: string }) => s.id)).not.toContain('budget');
    expect(JSON.stringify(spec)).not.toMatch(/allocation|Maintenance floor/i);
    // Social share is offered for a deck with no budget figure (Nora holds a social grant).
    await expect(nora.page.getByTestId('deck-share-open')).toBeVisible();

    // The budget deck is not found for her: API and page.
    expect((await nora.context.request.get(`/api/initiative-decks/${budgetDeckId}`)).status()).toBe(404);
    expect((await nora.context.request.get(`/api/initiative-decks/${budgetDeckId}/revisions/${body.revisionId}/file`)).status()).toBe(404);
    expect((await (await nora.context.request.get(`/api/initiative-decks?projectId=${PID}`)).json()).map((d: { id: string }) => d.id)).toEqual([plainDeckId]);
    await nora.page.goto(`/iq/decks/${budgetDeckId}`);
    await expect(nora.page.getByText("Couldn't open the deck")).toBeVisible({ timeout: 20_000 });
    await expect(nora.page.getByTestId('initiative-deck-editor')).toHaveCount(0);
    expect(nora.errors).toEqual([]);
  } finally { await nora.context.close(); }
});

test('(e) a deck with budget figures is not offered for Social sharing; a member sees the plain deck but no build form', async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const vera = await open(browser, baseURL, 'u-vera', 'org-leader');
  const theo = await open(browser, baseURL, 'u-theo', 'member');
  try {
    await vera.page.goto(`/iq/decks/${budgetDeckId}`);
    await expect(vera.page.getByTestId('initiative-deck-editor')).toBeVisible({ timeout: 30_000 });
    await expect(vera.page.getByTestId('initiative-deck-budget-notice')).toBeVisible();
    await expect(vera.page.getByTestId('deck-share-open')).toHaveCount(0);

    // A member lists only the plain deck and cannot build one: the server
    // refuses the create, and the page never offers a build control.
    expect((await (await theo.context.request.get(`/api/initiative-decks?projectId=${PID}`)).json()).map((d: { id: string }) => d.id)).toEqual([plainDeckId]);
    expect((await theo.context.request.post(`/api/initiative-decks/projects/${PID}`, { data: {} })).status()).toBe(403);
    await theo.page.goto(`/iq/projects/${PID}`);
    await expect(theo.page.getByTestId('initiative-header')).toBeVisible({ timeout: 20_000 });
    await expect(theo.page.getByText('Status deck')).toHaveCount(0);
    await theo.page.goto(`/iq/decks/${plainDeckId}`);
    // Read-only: the editor drops to the viewer (slides, Download), with no edit or Save control.
    await expect(theo.page.getByRole('button', { name: /Download/ })).toBeVisible({ timeout: 30_000 });
    await expect(theo.page.getByText('Slide 1 of 7')).toBeVisible();
    await expect(theo.page.getByTestId('initiative-deck-editor-slide-title')).toHaveCount(0);
    await expect(theo.page.getByRole('button', { name: /^Save as v/ })).toHaveCount(0);
    for (const p of [vera, theo]) expect(p.errors).toEqual([]);
  } finally { await Promise.all([vera.context.close(), theo.context.close()]); }
});

test('(f) two budget readers on one deck: presence on the head and filmstrip, follow moves the follower', async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const mia = await open(browser, baseURL, 'u-mia', 'program-owner');
  const vera = await open(browser, baseURL, 'u-vera', 'org-leader');
  try {
    for (const p of [mia, vera]) {
      await p.page.goto(`/iq/decks/${budgetDeckId}`);
      await expect(p.page.getByTestId('initiative-deck-editor')).toBeVisible({ timeout: 30_000 });
    }
    const selects = (p: Person) => p.page.locator('[data-testid^="initiative-deck-editor-slide-select-"]');
    expect(await selects(vera).count()).toBeGreaterThan(2);

    await selects(vera).nth(1).click();
    const headAvatar = mia.page.getByTestId('initiative-deck-shell-byline').getByTestId('presence-avatar');
    await expect(headAvatar.first()).toBeVisible({ timeout: 20_000 });
    await expect(mia.page.locator('[data-testid^="initiative-deck-editor-slide-viewers-"]').getByTestId('presence-avatar').first()).toBeVisible({ timeout: 20_000 });

    await selects(mia).nth(0).click();
    await headAvatar.first().hover();
    await mia.page.getByRole('button', { name: 'Follow', exact: true }).click();
    await expect(mia.page.getByTestId('follow-bar')).toBeVisible();
    await vera.page.getByTestId('initiative-deck-editor-slide-select-summary').click();
    await mia.page.getByTestId('follow-bar-stop').click();
    await expect(mia.page.getByTestId('follow-bar')).toHaveCount(0);
    for (const p of [mia, vera]) expect(p.errors).toEqual([]);
  } finally { await Promise.all([mia.context.close(), vera.context.close()]); }
});

test('(g) instruct: the agent box revises one slide inline and the page opens the new revision; a member is refused and a stale or replayed request is safe', async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  expect(budgetDeckId, 'deck from (a)').not.toBe('');
  const mia = await open(browser, baseURL, 'u-mia', 'program-owner');
  const theo = await open(browser, baseURL, 'u-theo', 'member');
  try {
    const before = await api(mia, `/${budgetDeckId}`);
    await mia.page.goto(`/iq/decks/${budgetDeckId}`);
    await expect(mia.page.getByTestId('initiative-deck-editor')).toBeVisible({ timeout: 30_000 });
    await mia.page.getByTestId('initiative-deck-editor-slide-select-summary').click();
    await mia.page.getByTestId('deck-composer-input').click();
    await mia.page.keyboard.type('Add speaker notes');
    const revised = mia.page.waitForResponse(r => /\/api\/initiative-decks\/[^/]+\/revise$/.test(r.url()) && r.request().method() === 'POST');
    await mia.page.getByTestId('deck-composer-send').click();
    const response = await revised;
    expect(response.status()).toBe(201);
    const sent = JSON.parse(response.request().postData() ?? '{}');
    expect(sent).toMatchObject({ slideId: 'summary', baseRevisionId: before.activeRevisionId, requestId: expect.stringMatching(/^req-/) });
    const body = await response.json();
    expect(body).toMatchObject({ revisionId: expect.stringMatching(/^irev-/), replayed: false });

    const after = await api(mia, `/${budgetDeckId}`);
    expect(after.revisions).toHaveLength(before.revisions.length + 1);
    expect(after.activeRevisionId).toBe(body.revisionId);
    expect(after.revisions[0].producedBy).toBe('agent:orgiq');
    await expect(mia.page.getByTestId('deck-composer-status')).toBeVisible();
    // The page opens the new revision: its Download targets the active revision.
    const file = mia.page.waitForResponse(r => r.url().includes(`/revisions/${after.activeRevisionId}/file`));
    await Promise.all([mia.page.waitForEvent('download'), mia.page.getByRole('button', { name: /Download/ }).click()]);
    expect((await file).status()).toBe(200);

    // The same request id replays; the old base is a 409 naming the head; a member is refused.
    const replay = await mia.context.request.post(`/api/initiative-decks/${budgetDeckId}/revise`, { data: sent });
    expect(replay.status()).toBe(200);
    expect(await replay.json()).toMatchObject({ revisionId: body.revisionId, replayed: true });
    const stale = await mia.context.request.post(`/api/initiative-decks/${budgetDeckId}/revise`, { data: { instruction: 'Add speaker notes', baseRevisionId: before.activeRevisionId } });
    expect(stale.status()).toBe(409);
    expect(await stale.json()).toMatchObject({ activeRevisionId: body.revisionId });
    expect((await theo.context.request.post(`/api/initiative-decks/${budgetDeckId}/revise`, { data: { instruction: 'Add speaker notes', baseRevisionId: body.revisionId } })).status()).toBe(403);
    expect((await api(mia, `/${budgetDeckId}`)).revisions).toHaveLength(before.revisions.length + 1);
    expect(mia.errors).toEqual([]);
  } finally { await Promise.all([mia.context.close(), theo.context.close()]); }
});

test('(h) /deck from the initiative Discussion builds the status deck: private card, Open / Revise… / Post; a member composer is read-only and the build is a 403', async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const nora = await open(browser, baseURL, 'u-nora', 'sme');
  const theo = await open(browser, baseURL, 'u-theo', 'member');
  const goDiscussion = async (p: Person) => {
    await p.page.goto(`/iq/projects/${PID}`);
    await expect(p.page.getByTestId('initiative-live-discussion')).toBeVisible({ timeout: 20_000 });
    await expect(p.page.getByTestId('scope-discussion-panel-offline')).toHaveCount(0, { timeout: 15_000 });
    // The page composer, in Chat → the Discussion: `/deck` is then the thread's own command (a private card).
    const dock = p.page.getByTestId('initiative-workspace').getByTestId('initiative-composer');
    await chooseComposerMode(p.page, dock, 'Agent', 'Chat');
    await dock.getByTestId('rich-chat-composer-input').click();
    await p.page.keyboard.press('ControlOrMeta+a'); await p.page.keyboard.press('Backspace');
  };
  try {
    await goDiscussion(nora);
    const created = nora.page.waitForResponse(r => /\/api\/initiative-decks\/projects\/[^/]+$/.test(r.url()) && r.request().method() === 'POST');
    await nora.page.keyboard.type('/deck Thread status'); await nora.page.keyboard.press('Enter');
    const response = await created;
    expect(response.status()).toBe(201);
    const body = await response.json();
    const card = nora.page.getByTestId('tenant-deck-card');
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.getByTestId('tenant-deck-view')).toBeVisible({ timeout: 30_000 });
    await expect(card.getByTestId('tenant-deck-open')).toBeVisible();
    await expect(card.getByTestId('tenant-deck-revise')).toBeVisible();
    // An SME holds no budget tier: the deck has no budget figures, so it may be posted.
    await expect(card.getByTestId('tenant-deck-post')).toBeVisible();
    await expect(theo.page.getByTestId('tenant-deck-card')).toHaveCount(0);
    await card.getByTestId('tenant-deck-open').click();
    await expect(nora.page).toHaveURL(new RegExp(`/iq/decks/${body.deckId}$`));
    expect(nora.errors).toEqual([]);

    // A member's Discussion composer is read-only with its reason, so /deck cannot even be typed; the server refuses a forged build too.
    await theo.page.goto(`/iq/projects/${PID}`);
    await expect(theo.page.getByTestId('scope-discussion-panel-read-only')).toBeVisible({ timeout: 20_000 });
    await expect(theo.page.getByTestId('tenant-deck-card')).toHaveCount(0);
    expect((await theo.context.request.post(`/api/initiative-decks/projects/${PID}`, { data: {} })).status()).toBe(403);
  } finally { await Promise.all([nora.context.close(), theo.context.close()]); }
});

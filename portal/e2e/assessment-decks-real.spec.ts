import { readFileSync } from 'node:fs';
import { loginAs } from './realSession';
import { type Browser, type BrowserContext, type Page } from '@playwright/test';
import { test, expect } from './cdpTest';

// Judge browser half for docs/assessment-deck-goal.md. The BFF, session,
// Cedar gates, deck store (mock fixture), assessment runs, gateway chat and
// /api/uploads are real; MOCK_AGENTCORE supplies the deterministic narrative.
// Run against the dev:mock:social stack (PARITY_BASE_URL, default :5183).
//
//   assessor u-asha  (assessment: assessor)        builds, instructs, edits, downloads
//   u-farah          (lead-assessor; member of #design-reviews) shares to Social
//   u-theo           (member of #design-reviews)    sees and downloads the attachment
//   u-vera           (social participant, NOT in #design-reviews) is refused
// The expanded seed (mock/social-history.ts) put every social grant holder in
// #general, so #general has no non-member to refuse; the casting is pinned by
// middleware/src/lib/__tests__/deck-share-spec-cast.test.ts.

test.use({ viewport: { width: 1440, height: 900 }, ...(process.env.PARITY_BASE_URL ? { baseURL: process.env.PARITY_BASE_URL } : {}) });
test.describe.configure({ mode: 'serial' });

const TEAM = 'TEAM-001';
const ASSESSED_DIMENSIONS = 15; // TEAM-001: 17 rubric dimensions, 1 approved N/A, 1 not yet scored
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const SOURCE_CHANNEL = { slug: 'design-reviews', label: '#Design reviews' };

type Person = { context: BrowserContext; page: Page; errors: string[] };

async function open(browser: Browser, baseURL: string | undefined, userId: string): Promise<Person> {
  const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await loginAs(context, userId, baseURL, true);
  return { context, page, errors };
}

async function switchTenant(person: Person, tenant: string) {
  const response = await person.context.request.post('/api/session/tenant', { data: { tenant } });
  expect(response.status(), `${tenant} tenant switch`).toBe(200);
  expect((await (await person.context.request.get('/api/session/me')).json()).tenant).toBe(tenant);
}

const api = async (person: Person, path: string) => {
  const response = await person.context.request.get(`/api/assessment${path}`);
  expect(response.status(), path).toBe(200);
  return response.json();
};

const thumbs = (page: Page) => page.locator('[data-testid^="deck-editor-slide-thumb-"]');

let deckId = '';

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

test('(a) an assessor creates a review deck; the run completes and the editor shows every assessed dimension plus the generated Sources slide', async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const asha = await open(browser, baseURL, 'u-asha');
  try {
    await asha.page.goto(`/assessment/teams/${TEAM}`);
    await asha.page.getByRole('button', { name: /^Actions for/ }).click();
    await asha.page.getByRole('menuitem', { name: 'Create review deck' }).click();
    const created = asha.page.waitForResponse(r => /\/api\/assessment\/teams\/[^/]+\/decks$/.test(r.url()) && r.request().method() === 'POST');
    await asha.page.getByTestId('create-deck-submit').click();
    const response = await created;
    expect(response.status()).toBe(202);
    const body = await response.json();
    expect(body).toMatchObject({ deckId: expect.stringMatching(/^deck-/), runId: expect.any(String) });
    deckId = body.deckId;
    await expect(asha.page).toHaveURL(new RegExp(`/assessment/decks/${deckId}$`));

    await expect(asha.page.getByTestId('deck-editor')).toBeVisible({ timeout: 45_000 });
    await expect(asha.page.getByTestId('deck-run-failed')).toHaveCount(0);

    const detail = await api(asha, `/decks/${deckId}`);
    expect(detail.revisions).toHaveLength(1);
    expect(detail.activeRevisionId).toBe(detail.revisions[0].id);
    expect(detail.pendingRun).toBeUndefined();
    expect(detail.lastRun).toMatchObject({ status: 'completed', command: 'draft-review-deck' });
    const spec = await api(asha, `/decks/${deckId}/revisions/${detail.activeRevisionId}/spec`);
    const dimensionSlides = spec.slides.filter((s: { id: string }) => /^dim-/.test(s.id));
    expect(dimensionSlides).toHaveLength(ASSESSED_DIMENSIONS);
    for (const id of ['title', 'executive-summary', 'overview', 'overall-summary', 'recommendations', 'next-steps']) {
      expect(spec.slides.map((s: { id: string }) => s.id), `summary slide ${id}`).toContain(id);
    }

    // One thumbnail per spec slide plus the generated, non-editable Sources slide.
    await expect(thumbs(asha.page)).toHaveCount(spec.slides.length + 1);
    await expect(asha.page.getByTestId('deck-editor-slide-generated-sources')).toBeVisible();
    await expect(asha.page.getByTestId('deck-editor-slide-select-dim-1')).toBeVisible();
    expect(asha.errors).toEqual([]);
  } finally { await asha.context.close(); }
});

test('(b) instructing the agent on one slide writes a new active revision', async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  expect(deckId, 'deck from (a)').not.toBe('');
  const asha = await open(browser, baseURL, 'u-asha');
  try {
    const before = await api(asha, `/decks/${deckId}`);
    await asha.page.goto(`/assessment/decks/${deckId}`);
    await expect(asha.page.getByTestId('deck-editor')).toBeVisible({ timeout: 30_000 });
    await asha.page.getByTestId('deck-editor-slide-select-dim-1').click();
    const input = asha.page.getByTestId('deck-composer-input');
    await input.click();
    await asha.page.keyboard.type('Tighten the bullets');
    const revised = asha.page.waitForResponse(r => /\/decks\/[^/]+\/revise$/.test(r.url()) && r.request().method() === 'POST');
    await asha.page.getByTestId('deck-composer-send').click();
    const response = await revised;
    expect(response.status()).toBe(202);
    expect(JSON.parse(response.request().postData() ?? '{}')).toMatchObject({ slideId: 'dim-1', baseRevisionId: before.activeRevisionId });

    await expect.poll(async () => (await api(asha, `/decks/${deckId}`)).revisions.length, { timeout: 40_000 }).toBe(before.revisions.length + 1);
    const after = await api(asha, `/decks/${deckId}`);
    expect(after.revisions[0].id).toBe(after.activeRevisionId);
    expect(after.activeRevisionId).not.toBe(before.activeRevisionId);
    expect(after.revisions[0].producedBy).toBe(after.lastRun.runId);
    expect(after.lastRun).toMatchObject({ status: 'completed', command: 'revise-review-deck' });
    // The page opens the new revision: its Download targets the active revision.
    await expect(asha.page.getByTestId('deck-run-progress')).toHaveCount(0, { timeout: 15_000 });
    const file = asha.page.waitForResponse(r => r.url().includes(`/revisions/${after.activeRevisionId}/file`));
    const [download] = await Promise.all([asha.page.waitForEvent('download'), asha.page.getByRole('button', { name: /Download/ }).click()]);
    expect((await file).status()).toBe(200);
    expect(download.suggestedFilename()).toMatch(/^[a-z0-9-]+-v2\.pptx$/);
    expect(asha.errors).toEqual([]);
  } finally { await asha.context.close(); }
});

test('(c) Download returns a .pptx attachment', async ({ browser, baseURL }) => {
  test.setTimeout(60_000);
  const asha = await open(browser, baseURL, 'u-asha');
  try {
    await asha.page.goto(`/assessment/decks/${deckId}`);
    await expect(asha.page.getByTestId('deck-editor')).toBeVisible({ timeout: 30_000 });
    const [response, download] = await Promise.all([
      asha.page.waitForResponse(r => /\/revisions\/[^/]+\/file$/.test(r.url())),
      asha.page.waitForEvent('download'),
      asha.page.getByRole('button', { name: /Download/ }).click(),
    ]);
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toBe(PPTX);
    expect(response.headers()['content-disposition']).toMatch(/^attachment; filename="[a-z0-9-]+-v\d+\.pptx"$/);
    // A navigation download has no readable response body: read the saved file.
    const bytes = readFileSync((await download.path())!);
    expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK');
    expect(download.suggestedFilename()).toMatch(/\.pptx$/);
  } finally { await asha.context.close(); }
});

test('(d) a manual edit saves a revision; a save from a stale base shows the newer-version banner', async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const first = await open(browser, baseURL, 'u-asha');
  const second = await open(browser, baseURL, 'u-asha');
  try {
    const before = await api(first, `/decks/${deckId}`);
    for (const p of [first, second]) {
      await p.page.goto(`/assessment/decks/${deckId}`);
      await expect(p.page.getByTestId('deck-editor')).toBeVisible({ timeout: 30_000 });
      await p.page.getByTestId('deck-editor-slide-select-next-steps').click();
      await expect(p.page.getByTestId('deck-editor-slide-title')).toBeVisible();
    }
    // The first context edits the title and saves.
    await first.page.getByTestId('deck-editor-slide-title').fill('Next steps (edited by hand)');
    await first.page.getByRole('button', { name: /^Save as v/ }).click();
    await expect.poll(async () => (await api(first, `/decks/${deckId}`)).revisions.length, { timeout: 15_000 }).toBe(before.revisions.length + 1);
    const saved = await api(first, `/decks/${deckId}`);
    expect(saved.revisions[0].producedBy).toBe('person:u-asha');
    const spec = await api(first, `/decks/${deckId}/revisions/${saved.activeRevisionId}/spec`);
    expect(spec.slides.find((s: { id: string }) => s.id === 'next-steps').title).toBe('Next steps (edited by hand)');
    await expect(first.page.getByTestId('deck-conflict')).toHaveCount(0);

    // The second context still holds the old base: its save is a 409.
    await second.page.getByTestId('deck-editor-slide-title').fill('Next steps (stale edit)');
    const stale = second.page.waitForResponse(r => /\/decks\/[^/]+\/revisions$/.test(r.url()) && r.request().method() === 'POST');
    await second.page.getByRole('button', { name: /^Save as v/ }).click();
    const response = await stale;
    expect(response.status()).toBe(409);
    expect(await response.json()).toMatchObject({ activeRevisionId: saved.activeRevisionId });
    await expect(second.page.getByTestId('deck-conflict')).toBeVisible();
    await expect(second.page.getByTestId('deck-conflict')).toContainText('newer version');
    expect((await api(second, `/decks/${deckId}`)).revisions).toHaveLength(before.revisions.length + 1);
    for (const p of [first, second]) expect(p.errors).toEqual([]);
  } finally { await Promise.all([first.context.close(), second.context.close()]); }
});

test('(e) a reader without ScoreAssessment sees the editor read-only', async () => {
  // Every assessment role (assessor, lead-assessor, program-lead) is granted
  // ScoreAssessment in middleware/seeds/roles/assessment/*.cedar, and the only
  // other grant holder is admin; no seeded identity can read decks without
  // being able to edit them. The read-only path is covered by the 403 on
  // POST /decks/:id/revisions in the middleware suites and `deckReadOnly` in
  // the portal node:test suite.
  test.skip(true, 'no assessment role lacks ScoreAssessment');
});

test('(f) Share to Social: a channel member downloads the attachment, a non-member is refused', async ({ browser, baseURL }) => {
  test.setTimeout(180_000);
  expect(deckId, 'deck from (a)').not.toBe('');
  const farah = await open(browser, baseURL, 'u-farah');
  const theo = await open(browser, baseURL, 'u-theo');
  const vera = await open(browser, baseURL, 'u-vera');
  try {
    await farah.page.goto(`/assessment/decks/${deckId}`);
    await expect(farah.page.getByTestId('deck-editor')).toBeVisible({ timeout: 30_000 });
    await expect(farah.page.getByTestId('deck-share-open')).toBeVisible();
    await farah.page.getByTestId('deck-share-open').click();
    const dialog = farah.page.getByTestId('deck-share-dialog');
    await expect(dialog).toBeVisible();
    // Only conversations she is a member of are offered: #General and #Design reviews, not #Moderators.
    await expect(dialog.getByText('#Moderators')).toHaveCount(0);
    await dialog.getByText(SOURCE_CHANNEL.label, { exact: true }).click();
    await farah.page.getByTestId('deck-share-next').click();
    await expect(dialog).toContainText(SOURCE_CHANNEL.label);
    await expect(dialog).toContainText('Everyone who is a member');
    // Chat history can outlive a mock reset (Dynamo-backed), so the note is unique to this run.
    const note = `Northstar review deck ${Date.now()}`;
    await dialog.getByRole('textbox').fill(note);
    const uploaded = farah.page.waitForResponse(r => r.url().includes('/api/uploads') && r.request().method() !== 'GET', { timeout: 30_000 });
    await expect(farah.page.getByTestId('deck-share-confirm')).toBeEnabled({ timeout: 20_000 });
    await farah.page.getByTestId('deck-share-confirm').click();
    const upload = await uploaded;
    expect(upload.status()).toBeLessThan(300);
    const href = new URL(upload.url()).pathname; // GET /api/uploads/:id serves the file the PUT stored
    expect(href).toMatch(/^\/api\/uploads\/[^/]+$/);
    await expect(farah.page.getByTestId('deck-share-done')).toBeVisible({ timeout: 30_000 });

    // A member of the source channel opens the channel in the social tenant and sees the message.
    await switchTenant(theo, 'social');
    await theo.page.goto(`/social/channels/${SOURCE_CHANNEL.slug}`);
    const panel = theo.page.getByTestId('social-chat-panel');
    await expect(panel).toBeVisible({ timeout: 20_000 });
    const message = panel.getByTestId('chat-message').filter({ hasText: note });
    await expect(message).toHaveCount(1, { timeout: 20_000 });
    await expect(message).toContainText('Farah Osei');
    await expect(message).toContainText(/\.pptx/);
    await expect(message).toContainText(/\d+(\.\d+)? KB/);
    const member = await theo.context.request.get(href);
    expect(member.status(), 'channel member downloads').toBe(200);
    expect(member.headers()['content-type']).toContain('presentationml');
    expect((await member.body()).subarray(0, 2).toString('latin1')).toBe('PK');

    // A social participant outside the source channel holds the URL but not the membership.
    await switchTenant(vera, 'social');
    expect((await vera.context.request.get(href)).status(), 'non-member is refused').toBe(403);
    for (const p of [farah, theo, vera]) expect(p.errors).toEqual([]);
  } finally { await Promise.all([farah.context.close(), theo.context.close(), vera.context.close()]); }
});

test('(g) two assessors on one deck: presence on the head and filmstrip, follow moves the follower to the followed slide', async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  expect(deckId, 'deck from (a)').not.toBe('');
  const asha = await open(browser, baseURL, 'u-asha');
  const jonas = await open(browser, baseURL, 'u-jonas');
  try {
    await switchTenant(jonas, 'assessment');
    await asha.page.goto(`/assessment/decks/${deckId}`);
    await jonas.page.goto(`/assessment/decks/${deckId}`);
    await expect(asha.page.getByTestId('deck-editor')).toBeVisible({ timeout: 30_000 });
    await expect(jonas.page.getByTestId('deck-editor')).toBeVisible({ timeout: 30_000 });

    // Jonas stands on dim-2; Asha sees his avatar on that thumbnail.
    await jonas.page.getByTestId('deck-editor-slide-select-dim-2').click();
    await expect(asha.page.getByTestId('deck-shell-byline').getByTestId('presence-avatar').filter({ hasText: 'JL' })).toBeVisible({ timeout: 20_000 });
    await expect(asha.page.getByTestId('deck-editor-slide-viewers-dim-2').getByTestId('presence-avatar')).toBeVisible({ timeout: 20_000 });

    // Asha follows Jonas: the follow bar shows and her stage lands on dim-2, then tracks him to dim-3.
    await asha.page.getByTestId('deck-editor-slide-select-dim-1').click();
    await asha.page.getByTestId('deck-shell-byline').getByTestId('presence-avatar').filter({ hasText: 'JL' }).hover();
    await asha.page.getByRole('button', { name: 'Follow', exact: true }).click();
    await expect(asha.page.getByTestId('follow-bar')).toBeVisible();
    await expect(asha.page.getByRole('figure', { name: /^Slide 5 of \d+/ })).toBeVisible({ timeout: 10_000 });
    await jonas.page.getByTestId('deck-editor-slide-select-dim-3').click();
    await expect(asha.page.getByRole('figure', { name: /^Slide 6 of \d+/ })).toBeVisible({ timeout: 10_000 });
    await asha.page.getByTestId('follow-bar-stop').click();
    await expect(asha.page.getByTestId('follow-bar')).toHaveCount(0);
    for (const p of [asha, jonas]) expect(p.errors).toEqual([]);
  } finally { await Promise.all([asha.context.close(), jonas.context.close()]); }
});

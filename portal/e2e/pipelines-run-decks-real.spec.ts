import { readFileSync } from 'node:fs';
import { loginAs } from './realSession';
import { type Browser, type BrowserContext, type Page } from '@playwright/test';
import { test, expect } from './cdpTest';

// Browser half for docs/agentic-flows-migration.md slice 3 (pipelines run
// report deck). Real BFF + session + Cedar; mock fixtures; MOCK_AGENTCORE
// supplies the deterministic narrative. Headless, against the dev:mock stack
// (PARITY_BASE_URL, e.g. http://127.0.0.1:5261 with the BFF on :3061).
//
//   u-kofi   (pipelines: operator)  builds from a run, edits, downloads
//   u-ines   (pipelines: author)    also holds RunPipeline
//   u-operator (admin everywhere)   is offered Share to Social; u-kofi is not
//                                   (the pipelines cast holds no social grant)

test.use({ viewport: { width: 1440, height: 900 }, ...(process.env.PARITY_BASE_URL ? { baseURL: process.env.PARITY_BASE_URL } : {}) });
test.describe.configure({ mode: 'serial' });

const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
type Person = { context: BrowserContext; page: Page; errors: string[] };

async function open(browser: Browser, baseURL: string | undefined, userId: string): Promise<Person> {
  const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await loginAs(context, userId, baseURL, true);
  const switched = await context.request.post('/api/session/tenant', { data: { tenant: 'pipelines' } });
  expect(switched.status(), 'pipelines tenant switch').toBe(200);
  return { context, page, errors };
}

const api = async (p: Person, path: string) => {
  const response = await p.context.request.get(`/api/pipelines${path}`);
  expect(response.status(), path).toBe(200);
  return response.json();
};
const thumbs = (page: Page) => page.locator('[data-testid^="run-deck-editor-slide-thumb-"]');

let runId = '';
let deckId = '';
let facts: { stepsTotal: number; status: string };

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

test('(a) an operator builds a run report from the run detail page; the editor shows every slide plus Sources, numbers equal the run', async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const kofi = await open(browser, baseURL, 'u-kofi');
  try {
    const list = await api(kofi, '/runs?limit=200');
    for (const r of list.runs as Array<{ id: string; status: string }>) {
      const steps = (await api(kofi, `/runs/${encodeURIComponent(r.id)}/steps`)).steps as unknown[];
      if (steps.length > 0) { runId = r.id; facts = { stepsTotal: steps.length, status: r.status }; break; }
    }
    expect(runId, 'a run with steps in the mock projection').not.toBe('');

    await kofi.page.goto(`/pipelines/runs/${encodeURIComponent(runId)}`);
    await expect(kofi.page.getByTestId('pipeline-run-decks')).toBeVisible({ timeout: 20_000 });
    await kofi.page.getByTestId('run-deck-generate').click();
    await kofi.page.getByTestId('run-deck-narrative').click();
    const created = kofi.page.waitForResponse(r => /\/api\/pipelines\/runs\/[^/]+\/decks$/.test(r.url()) && r.request().method() === 'POST');
    await kofi.page.getByTestId('run-deck-submit').click();
    const response = await created;
    expect(response.status()).toBe(201);
    const body = await response.json();
    expect(body).toMatchObject({ deckId: expect.stringMatching(/^pdeck-/), revisionId: expect.stringMatching(/^prev-/), narrative: { requested: true } });
    deckId = body.deckId;
    await expect(kofi.page).toHaveURL(new RegExp(`/pipelines/decks/${deckId}$`));
    await expect(kofi.page.getByTestId('run-deck-editor')).toBeVisible({ timeout: 30_000 });

    const spec = await api(kofi, `/decks/${deckId}/revisions/${body.revisionId}/spec`);
    const summary = spec.slides.find((s: { id: string }) => s.id === 'summary').bullets.join('\n');
    expect(summary).toContain(`Status: ${facts.status}`);
    expect(summary).toContain(`Steps: ${facts.stepsTotal} total`);
    await expect(thumbs(kofi.page)).toHaveCount(spec.slides.length + 1);
    await expect(kofi.page.getByTestId('run-deck-editor-slide-generated-sources')).toBeVisible();
    expect(kofi.errors).toEqual([]);
  } finally { await kofi.context.close(); }
});

test('(b) Download returns a .pptx attachment', async ({ browser, baseURL }) => {
  test.setTimeout(60_000);
  expect(deckId, 'deck from (a)').not.toBe('');
  const kofi = await open(browser, baseURL, 'u-kofi');
  try {
    await kofi.page.goto(`/pipelines/decks/${deckId}`);
    await expect(kofi.page.getByTestId('run-deck-editor')).toBeVisible({ timeout: 30_000 });
    const [response, download] = await Promise.all([
      kofi.page.waitForResponse(r => /\/revisions\/[^/]+\/file$/.test(r.url())),
      kofi.page.waitForEvent('download'),
      kofi.page.getByRole('button', { name: /Download/ }).click(),
    ]);
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toBe(PPTX);
    expect(response.headers()['content-disposition']).toMatch(/^attachment; filename="[a-z0-9-]+-v\d+\.pptx"$/);
    expect(readFileSync((await download.path())!).subarray(0, 2).toString('latin1')).toBe('PK');
  } finally { await kofi.context.close(); }
});

test('(c) a manual edit saves a revision; a save from a stale base shows the newer-version banner', async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const first = await open(browser, baseURL, 'u-kofi');
  const second = await open(browser, baseURL, 'u-ines');
  try {
    const before = await api(first, `/decks/${deckId}`);
    for (const p of [first, second]) {
      await p.page.goto(`/pipelines/decks/${deckId}`);
      await expect(p.page.getByTestId('run-deck-editor')).toBeVisible({ timeout: 30_000 });
      await p.page.getByTestId('run-deck-editor-slide-select-summary').click();
      await expect(p.page.getByTestId('run-deck-editor-slide-title')).toBeVisible();
    }
    await first.page.getByTestId('run-deck-editor-slide-title').fill('Summary (edited by hand)');
    await first.page.getByRole('button', { name: /^Save as v/ }).click();
    await expect.poll(async () => (await api(first, `/decks/${deckId}`)).revisions.length, { timeout: 15_000 }).toBe(before.revisions.length + 1);
    const saved = await api(first, `/decks/${deckId}`);
    expect(saved.revisions[0].producedBy).toBe('person:u-kofi');

    await second.page.getByTestId('run-deck-editor-slide-title').fill('Summary (stale edit)');
    const stale = second.page.waitForResponse(r => /\/decks\/[^/]+\/revisions$/.test(r.url()) && r.request().method() === 'POST');
    await second.page.getByRole('button', { name: /^Save as v/ }).click();
    const response = await stale;
    expect(response.status()).toBe(409);
    expect(await response.json()).toMatchObject({ activeRevisionId: saved.activeRevisionId });
    await expect(second.page.getByTestId('run-deck-conflict')).toBeVisible();
    expect((await api(second, `/decks/${deckId}`)).revisions).toHaveLength(before.revisions.length + 1);
    for (const p of [first, second]) expect(p.errors).toEqual([]);
  } finally { await Promise.all([first.context.close(), second.context.close()]); }
});

test('(d) Share to Social is offered to a holder of a social grant and hidden from the pipelines-only cast', async ({ browser, baseURL }) => {
  test.setTimeout(90_000);
  const kofi = await open(browser, baseURL, 'u-kofi');
  const admin = await open(browser, baseURL, 'u-operator');
  try {
    await kofi.page.goto(`/pipelines/decks/${deckId}`);
    await expect(kofi.page.getByTestId('run-deck-editor')).toBeVisible({ timeout: 30_000 });
    await expect(kofi.page.getByTestId('deck-share-open')).toHaveCount(0);

    await admin.page.goto(`/pipelines/decks/${deckId}`);
    await expect(admin.page.getByTestId('run-deck-editor')).toBeVisible({ timeout: 30_000 });
    await admin.page.getByTestId('deck-share-open').click();
    await expect(admin.page.getByTestId('deck-share-dialog')).toBeVisible();
    for (const p of [kofi, admin]) expect(p.errors).toEqual([]);
  } finally { await Promise.all([kofi.context.close(), admin.context.close()]); }
});

test('(e) two pipelines users on one report: presence on the head and filmstrip, follow moves the follower', async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  expect(deckId, 'deck from (a)').not.toBe('');
  const kofi = await open(browser, baseURL, 'u-kofi');
  const ines = await open(browser, baseURL, 'u-ines');
  try {
    for (const p of [kofi, ines]) {
      await p.page.goto(`/pipelines/decks/${deckId}`);
      await expect(p.page.getByTestId('run-deck-editor')).toBeVisible({ timeout: 30_000 });
    }
    const selects = (p: Person) => p.page.locator('[data-testid^="run-deck-editor-slide-select-"]');
    expect(await selects(ines).count()).toBeGreaterThan(2);

    // Ines stands on the second slide; Kofi sees her avatar on the head and on that thumbnail.
    await selects(ines).nth(1).click();
    const headAvatar = kofi.page.getByTestId('run-deck-shell-byline').getByTestId('presence-avatar');
    await expect(headAvatar.first()).toBeVisible({ timeout: 20_000 });
    await expect(kofi.page.locator('[data-testid^="run-deck-editor-slide-viewers-"]').getByTestId('presence-avatar').first()).toBeVisible({ timeout: 20_000 });

    // Kofi follows her: the follow bar shows, then stops.
    await selects(kofi).nth(0).click();
    await headAvatar.first().hover();
    await kofi.page.getByRole('button', { name: 'Follow', exact: true }).click();
    await expect(kofi.page.getByTestId('follow-bar')).toBeVisible();
    await ines.page.getByTestId('run-deck-editor-slide-select-summary').click();
    await kofi.page.getByTestId('follow-bar-stop').click();
    await expect(kofi.page.getByTestId('follow-bar')).toHaveCount(0);
    for (const p of [kofi, ines]) expect(p.errors).toEqual([]);
  } finally { await Promise.all([kofi.context.close(), ines.context.close()]); }
});

test('(f) instruct: the agent box revises the saved version as a requester-private flow run and the page opens the new revision', async ({ browser, baseURL }) => {
  test.setTimeout(150_000);
  expect(deckId, 'deck from (a)').not.toBe('');
  const kofi = await open(browser, baseURL, 'u-kofi');
  const ines = await open(browser, baseURL, 'u-ines');
  try {
    const before = await api(kofi, `/decks/${deckId}`);
    await kofi.page.goto(`/pipelines/decks/${deckId}`);
    await expect(kofi.page.getByTestId('run-deck-editor')).toBeVisible({ timeout: 30_000 });
    await kofi.page.getByTestId('run-deck-editor-slide-select-summary').click();
    const input = kofi.page.getByTestId('deck-composer-input');
    await input.click();
    await kofi.page.keyboard.type('Add speaker notes');
    const revised = kofi.page.waitForResponse(r => /\/decks\/[^/]+\/revise$/.test(r.url()) && r.request().method() === 'POST');
    await kofi.page.getByTestId('deck-composer-send').click();
    const response = await revised;
    expect(response.status()).toBe(202);
    expect(JSON.parse(response.request().postData() ?? '{}')).toMatchObject({ slideId: 'summary', baseRevisionId: before.activeRevisionId });
    const { runId: reviseRunId } = await response.json();
    expect(reviseRunId).toMatch(/^pdr-/);

    await expect.poll(async () => (await api(kofi, `/decks/${deckId}`)).revisions.length, { timeout: 40_000 }).toBe(before.revisions.length + 1);
    const after = await api(kofi, `/decks/${deckId}`);
    expect(after.activeRevisionId).not.toBe(before.activeRevisionId);
    expect(after.revisions[0]).toMatchObject({ id: after.activeRevisionId, producedBy: reviseRunId });
    const run = await api(kofi, `/decks/${deckId}/runs/${reviseRunId}`);
    expect(run).toMatchObject({ status: 'completed', error: null, revisionId: after.activeRevisionId, changedSlideIds: ['summary'] });
    // The revise changed prose only: the run's numbers are still the run's.
    const spec = await api(kofi, `/decks/${deckId}/revisions/${after.activeRevisionId}/spec`);
    expect(spec.slides.find((s: { id: string }) => s.id === 'summary').bullets.join('\n')).toContain(`Steps: ${facts.stepsTotal} total`);
    await expect(kofi.page.getByTestId('deck-run-progress')).toHaveCount(0, { timeout: 15_000 });
    await expect(kofi.page.getByTestId('deck-composer-status')).toBeVisible();

    // The run is its requester's alone: another RunPipeline holder reads 404.
    expect((await ines.context.request.get(`/api/pipelines/decks/${deckId}/runs/${reviseRunId}`)).status()).toBe(404);
    // A stale base (the page above moved the head) is a 409 naming the head, with no run.
    const stale = await kofi.context.request.post(`/api/pipelines/decks/${deckId}/revise`, { data: { instruction: 'Add speaker notes', baseRevisionId: before.activeRevisionId } });
    expect(stale.status()).toBe(409);
    expect(await stale.json()).toMatchObject({ activeRevisionId: after.activeRevisionId });
    for (const p of [kofi, ines]) expect(p.errors).toEqual([]);
  } finally { await Promise.all([kofi.context.close(), ines.context.close()]); }
});

test('(h) /deck from the run thread builds the run report: private card with Open / Revise… / Post', async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  expect(runId, 'run from (a)').not.toBe('');
  const kofi = await open(browser, baseURL, 'u-kofi');
  try {
    await kofi.page.goto(`/pipelines/runs/${encodeURIComponent(runId)}`);
    await expect(kofi.page.getByTestId('pipeline-discussion')).toBeVisible({ timeout: 20_000 });
    await expect(kofi.page.getByTestId('pipeline-discussion-panel-offline')).toHaveCount(0, { timeout: 15_000 });
    await kofi.page.getByTestId('pipeline-discussion-panel-composer-input').click();
    const created = kofi.page.waitForResponse(r => /\/api\/pipelines\/runs\/[^/]+\/decks$/.test(r.url()) && r.request().method() === 'POST');
    await kofi.page.keyboard.type('/deck Thread report'); await kofi.page.keyboard.press('Enter');
    const response = await created;
    expect(response.status()).toBe(201);
    const body = await response.json();
    const card = kofi.page.getByTestId('tenant-deck-card');
    await expect(card.getByTestId('tenant-deck-view')).toBeVisible({ timeout: 30_000 });
    await expect(card.getByTestId('tenant-deck-revise')).toBeVisible();
    await expect(card.getByTestId('tenant-deck-post')).toBeVisible();
    await card.getByTestId('tenant-deck-open').click();
    await expect(kofi.page).toHaveURL(new RegExp(`/pipelines/decks/${body.deckId}$`));
    expect(kofi.errors).toEqual([]);
  } finally { await kofi.context.close(); }
});

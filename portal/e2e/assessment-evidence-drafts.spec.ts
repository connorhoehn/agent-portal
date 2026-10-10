import { loginAs } from './realSession';
import { type Browser, type BrowserContext, type Page } from '@playwright/test';
import { test, expect } from './cdpTest';

// Slice 8 of docs/agentic-flows-migration.md: "Summarize evidence" and "Draft
// follow-ups" on a team's dimension. The BFF, session, Cedar gates and the
// durable flow-run store (mock fixture) are real; MOCK_AGENTCORE supplies the
// deterministic drafter answer, which still passes the same validators.
// Run against a dev:mock stack (PARITY_BASE_URL, default :5183).
//
//   u-asha   assessor   drafts, accepts and discards
//   u-farah  lead-assessor   sees asha's drafts (shared) and revises them

test.use({ viewport: { width: 1440, height: 900 }, ...(process.env.PARITY_BASE_URL ? { baseURL: process.env.PARITY_BASE_URL } : {}) });
test.describe.configure({ mode: 'serial' });

const TEAM = 'TEAM-001';
type Person = { context: BrowserContext; page: Page; errors: string[] };

async function open(browser: Browser, baseURL: string | undefined, userId: string): Promise<Person> {
  const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await loginAs(context, userId, baseURL, true);
  const switched = await context.request.post('/api/session/tenant', { data: { tenant: 'assessment' } });
  expect(switched.status(), 'tenant switch').toBe(200);
  return { context, page, errors };
}

const openFollowUps = async (person: Person, dim: string): Promise<string[]> => {
  const response = await person.context.request.get(`/api/assessment/teams/${TEAM}`);
  expect(response.status()).toBe(200);
  const detail = await response.json();
  return detail.dimensions.find((d: { id: string }) => d.id === dim).follow_up_questions
    .filter((q: { status: string }) => q.status === 'OPEN').map((q: { text: string }) => q.text);
};

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

test('(a) Summarize evidence lands as a draft with provider numbers and verbatim quotes; the team is unchanged', async ({ browser, baseURL }) => {
  test.setTimeout(90_000);
  const asha = await open(browser, baseURL, 'u-asha');
  try {
    const before = await openFollowUps(asha, '1');
    await asha.page.goto(`/assessment/teams/${TEAM}`);
    await expect(asha.page.getByTestId('evidence-drafts')).toBeVisible();
    await asha.page.getByTestId('evidence-summarize').click();
    const card = asha.page.getByTestId('evidence-draft-card').first();
    await expect(card).toHaveAttribute('data-phase', 'completed', { timeout: 30_000 });
    await expect(card).toHaveAttribute('data-kind', 'assessment.evidence-summary');
    await expect(card.getByTestId('evidence-draft-facts')).toContainText(/Verified .* target L\d+ · \d+ evidence item/);
    await expect(card.getByTestId('evidence-draft-summary').locator('blockquote').first()).toBeVisible();
    await expect(card.getByRole('button', { name: 'Add this one', exact: true })).toHaveCount(0);
    expect(await openFollowUps(asha, '1')).toEqual(before);
    // The draft survives a reload (recovered from the durable run).
    await asha.page.reload();
    await expect(asha.page.getByTestId('evidence-draft-card').first()).toHaveAttribute('data-kind', 'assessment.evidence-summary', { timeout: 15_000 });
    expect(asha.errors).toEqual([]);
  } finally { await asha.context.close(); }
});

test('(b) Draft follow-ups, untick one, Add selected: real follow-up rows appear on the dimension; a teammate can read the shared draft', async ({ browser, baseURL }) => {
  test.setTimeout(90_000);
  const asha = await open(browser, baseURL, 'u-asha');
  const farah = await open(browser, baseURL, 'u-farah');
  try {
    const before = await openFollowUps(asha, '1');
    await asha.page.goto(`/assessment/teams/${TEAM}`);
    await asha.page.getByTestId('evidence-draft-followups').click();
    const card = asha.page.locator('[data-testid="evidence-draft-card"][data-kind="assessment.followup-drafts"]').first();
    await expect(card).toHaveAttribute('data-phase', 'completed', { timeout: 30_000 });
    const picks = card.locator('[data-testid^="evidence-draft-pick-"]');
    const total = await picks.count();
    expect(total).toBeGreaterThan(1);
    expect(await openFollowUps(asha, '1')).toEqual(before);

    const runId = (await (await asha.context.request.get(`/api/assessment/teams/${TEAM}/dimensions/1/drafts`)).json()).drafts
      .find((d: { kind: string }) => d.kind === 'assessment.followup-drafts').runId;
    expect((await farah.context.request.get(`/api/assessment/drafts/${runId}`)).status()).toBe(200);

    await picks.nth(1).getByRole('checkbox').uncheck();
    await expect(picks).toHaveCount(total);
    await expect(picks.nth(1).getByRole('checkbox')).not.toBeChecked();
    expect(await openFollowUps(asha, '1')).toEqual(before);
    await card.getByTestId('suggestion-review-list-accept-all').click();
    await expect(card.getByTestId('evidence-draft-message')).toContainText(/Added \d+ follow-up/);
    await expect.poll(async () => (await openFollowUps(asha, '1')).length, { timeout: 15_000 }).toBeGreaterThan(before.length);
    expect(await openFollowUps(asha, '1')).toHaveLength(before.length + total - 1);
    // The scorecard re-read the team: the new row shows in the Follow-ups section.
    await expect(asha.page.getByText(/What evidence shows that the team meets/).first()).toBeVisible({ timeout: 15_000 });
    await expect(card.getByRole('button', { name: 'Add this one', exact: true })).toHaveCount(0);
    await expect(card.getByTestId('suggestion-review-list-accept-all')).toHaveCount(0);
    expect(asha.errors).toEqual([]);
  } finally { await asha.context.close(); await farah.context.close(); }
});

test('(b2) per-question Accept adds just that question, once only', async ({ browser, baseURL }) => {
  test.setTimeout(90_000);
  const reset = await browser.newContext({ baseURL });
  expect((await reset.request.post('/api/__mock/reset', { data: {} })).status(), 'mock reset').toBe(200);
  await reset.close();
  const asha = await open(browser, baseURL, 'u-asha');
  try {
    const before = await openFollowUps(asha, '1');
    await asha.page.goto(`/assessment/teams/${TEAM}`);
    await asha.page.getByTestId('evidence-draft-followups').click();
    const card = asha.page.locator('[data-testid="evidence-draft-card"][data-kind="assessment.followup-drafts"]').first();
    await expect(card).toHaveAttribute('data-phase', 'completed', { timeout: 30_000 });
    await card.locator('[data-testid^="evidence-draft-pick-"]').first().getByRole('button', { name: 'Add this one', exact: true }).click();
    await expect(card.getByTestId('evidence-draft-message')).toContainText(/Added 1 follow-up question /);
    await expect.poll(async () => (await openFollowUps(asha, '1')).length, { timeout: 15_000 }).toBe(before.length + 1);
    await expect(card.getByRole('button', { name: 'Add this one', exact: true })).toHaveCount(0);
    expect(await openFollowUps(asha, '1')).toHaveLength(before.length + 1);
    expect(asha.errors).toEqual([]);
  } finally { await asha.context.close(); }
});

test('(c) Discard drops a draft and nothing is written', async ({ browser, baseURL }) => {
  test.setTimeout(90_000);
  const asha = await open(browser, baseURL, 'u-asha');
  try {
    const before = await openFollowUps(asha, '1');
    const recovered = asha.page.waitForResponse(r => /\/dimensions\/1\/drafts$/.test(r.url()) && r.request().method() === 'GET');
    await asha.page.goto(`/assessment/teams/${TEAM}`);
    await recovered;
    const cards = asha.page.getByTestId('evidence-draft-card');
    await expect(cards.first()).toBeVisible();
    const existing = await cards.count();
    await asha.page.getByTestId('evidence-draft-followups').click();
    await expect(cards).toHaveCount(existing + 1);
    await expect(cards.first()).toHaveAttribute('data-phase', 'completed', { timeout: 30_000 });
    await cards.first().getByTestId('evidence-draft-discard').click();
    await expect(cards).toHaveCount(existing);
    expect(await openFollowUps(asha, '1')).toEqual(before);
  } finally { await asha.context.close(); }
});

test('(d) two assessors share a draft; Revise… makes version 2 and the other assessor is told, then refused a stale revise', async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const asha = await open(browser, baseURL, 'u-asha');
  const farah = await open(browser, baseURL, 'u-farah');
  try {
    await asha.page.goto(`/assessment/teams/${TEAM}`);
    await asha.page.getByTestId('evidence-summarize').click();
    const mine = asha.page.locator('[data-testid="evidence-draft-card"][data-kind="assessment.evidence-summary"]').first();
    await expect(mine).toHaveAttribute('data-phase', 'completed', { timeout: 30_000 });
    await expect(mine).toContainText('version 1');

    // A different assessor's fresh load recovers it.
    await farah.page.goto(`/assessment/teams/${TEAM}`);
    const theirs = farah.page.locator('[data-testid="evidence-draft-card"][data-kind="assessment.evidence-summary"]').first();
    await expect(theirs).toContainText('version 1', { timeout: 15_000 });

    // Asha revises.
    await mine.getByTestId('evidence-draft-revise').click();
    await mine.getByTestId('evidence-draft-revise-input').fill('Shorter, lead with the gaps');
    await mine.getByTestId('evidence-draft-revise-send').click();
    await expect(mine).toContainText('version 2', { timeout: 30_000 });
    await expect(mine.getByTestId('evidence-draft-summary')).toContainText('Revised: Shorter, lead with the gaps', { timeout: 30_000 });

    // Farah is told a newer version exists, still holding version 1; her stale revise is refused and she lands on version 2.
    await expect(theirs.getByTestId('evidence-draft-newer')).toBeVisible({ timeout: 20_000 });
    await theirs.getByTestId('evidence-draft-revise').click();
    await theirs.getByTestId('evidence-draft-revise-input').fill('Add the numbers');
    await theirs.getByTestId('evidence-draft-revise-send').click();
    await expect(theirs).toContainText(/Someone revised this draft first/, { timeout: 15_000 });
    await expect(theirs).toContainText('version 2', { timeout: 15_000 });
    await expect(theirs.getByTestId('evidence-draft-summary')).toContainText('Revised: Shorter, lead with the gaps');
    await mine.getByTestId('evidence-draft-discard').click();
    expect(asha.errors).toEqual([]); expect(farah.errors).toEqual([]);
  } finally { await asha.context.close(); await farah.context.close(); }
});

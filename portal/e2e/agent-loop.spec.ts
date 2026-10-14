import { test, expect, type Browser, type Page } from '@playwright/test';
import { openAs } from './realSession';
import { chooseComposerMode } from './conversationViews';

// /agent in a Social channel: a private plan card (steps + acceptance criteria), nothing runs
// until Approve, then the plan's steps run in order through the existing flows and each step's own
// card (summary, diagram) appears beneath it. Discard drops a plan without running anything, and a
// reader without the posting right is not offered the command. Headless; run against the dev:mock
// stack (MOCK_AURORA + MOCK_AGENTCORE), e.g. PARITY_BASE_URL=http://127.0.0.1:5183.
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

test('/agent: the plan card is private, Approve runs two steps in order, and their artifacts appear in the thread', async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const sana = await person(browser, baseURL, 'u-sana');
  const mira = await person(browser, baseURL, 'u-mira');
  try {
    await say(sana.page, '/agent wrap up this thread');
    const card = sana.page.getByTestId('social-agent-card');
    await expect(card).toBeVisible();
    await expect(card.locator('xpath=ancestor::*[@data-testid="chat-local-message"]').getByTestId('chat-local-message-note')).toContainText('Nothing runs until you approve');
    // The plan: two steps, each with its acceptance criterion; nothing has started.
    const plan = card.getByTestId('social-agent-plan');
    await expect(plan).toContainText('Summarize', { timeout: 20_000 });
    await expect(plan).toContainText('Diagram');
    await expect(plan).toContainText('Done when');
    await expect(sana.page.getByTestId('social-summary-card')).toHaveCount(0);
    await expect(sana.page.getByTestId('social-diagram-card')).toHaveCount(0);
    // The command was not sent as a message and nobody else sees the card.
    await expect(message(sana.page, '/agent')).toHaveCount(0);
    await expect(mira.page.getByTestId('social-agent-card')).toHaveCount(0, { timeout: 15_000 });
    // Approve: both existing flows run as Sana and their own cards show under the plan.
    await card.getByTestId('social-agent-approve').click();
    await expect(card.getByTestId('social-agent-step-s1').getByTestId('social-summary-card')).toBeVisible({ timeout: 30_000 });
    await expect(card.getByTestId('social-agent-step-s2').getByTestId('social-diagram-card')).toBeVisible({ timeout: 30_000 });
    await expect(card.getByTestId('social-agent-step-s1').getByTestId('social-summary-result')).toBeVisible({ timeout: 20_000 });
    await expect(card.getByTestId('social-agent-step-s2').getByTestId('social-diagram-graph')).toBeVisible({ timeout: 20_000 });
    await expect(card.getByTestId('social-agent-approve')).toHaveCount(0);
    await expect(card.getByTestId('social-agent-stopped')).toHaveCount(0);
    // Still private: nothing was posted by approving.
    await expect(message(mira.page, 'Diagram:')).toHaveCount(0);
    await expect(mira.page.getByTestId('social-summary-card')).toHaveCount(0);
    expect(sana.errors).toEqual([]);
    expect(mira.errors).toEqual([]);
  } finally { await sana.context.close(); await mira.context.close(); }
});

test('/agent: Discard drops the plan without running a step', async ({ browser, baseURL }) => {
  test.setTimeout(90_000);
  const sana = await person(browser, baseURL, 'u-sana');
  try {
    await say(sana.page, '/agent wrap up this thread');
    const card = sana.page.getByTestId('social-agent-card');
    await expect(card.getByTestId('social-agent-plan')).toBeVisible({ timeout: 20_000 });
    await card.getByTestId('social-agent-discard').click();
    await expect(sana.page.getByTestId('social-agent-card')).toHaveCount(0, { timeout: 15_000 });
    await expect(sana.page.getByTestId('social-summary-card')).toHaveCount(0);
    expect(sana.errors).toEqual([]);
  } finally { await sana.context.close(); }
});

// A tenant conversation, not only Social: an orgiq initiative's Discussion as the seeded SME.
// Same card, same Approve; the steps run as Nora through the orgiq flows, and a second person
// (a member) never sees the private plan.
test('/agent in an orgiq initiative Discussion: plan, Approve, summary and diagram cards, private to the SME', async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const open = async (userId: string) => {
    const { page, context, errors } = await openAs(browser, userId, { baseURL, viewport: { width: 1440, height: 900 }, url: '/iq/projects/p-auth-migration' });
    await expect(page.getByTestId('initiative-live-discussion')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('scope-discussion-panel-offline')).toHaveCount(0, { timeout: 15_000 });
    return { page, context, errors };
  };
  const nora = await open('u-nora');
  const rachel = await open('u-rachel');
  try {
    // The page's one composer is docked in the content column (2.438.3): Chat → the Discussion, whose `/agent` it runs.
    const composer = nora.page.getByTestId('initiative-workspace').getByTestId('initiative-composer');
    await chooseComposerMode(nora.page, composer, 'Agent', 'Chat');
    await expect(composer.getByRole('combobox', { name: 'Chat recipient' })).toHaveAttribute('data-value', 'discussion');
    await composer.getByTestId('rich-chat-composer-input').click();
    await nora.page.keyboard.press('ControlOrMeta+a'); await nora.page.keyboard.press('Backspace');
    await nora.page.keyboard.type('/agent wrap up this discussion'); await nora.page.keyboard.press('Enter');
    const card = nora.page.getByTestId(/-agent-card$/);
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card.getByTestId(/-agent-plan$/)).toContainText('Done when', { timeout: 20_000 });
    await expect(rachel.page.getByTestId(/-agent-card$/)).toHaveCount(0);
    await card.getByTestId(/-agent-approve$/).click();
    await expect(card.getByTestId(/-agent-step-s1$/)).toBeVisible({ timeout: 30_000 });
    await expect(card.getByTestId(/-agent-step-s2$/)).toBeVisible({ timeout: 30_000 });
    await expect(card.getByTestId(/-agent-approve$/)).toHaveCount(0);
    await expect(card.getByTestId(/-agent-stopped$/)).toHaveCount(0, { timeout: 20_000 });
    await expect(rachel.page.getByTestId(/-agent-card$/)).toHaveCount(0);
    expect(nora.errors).toEqual([]);
  } finally { await nora.context.close(); await rachel.context.close(); }
});

// Creation steps: a plan of document:create + meeting:create runs as the moderator (who holds ManageChannels), stores the
// document in the thread's upload store and creates a room (platform-api), and each finished step
// shows its link under the plan. The goal carries a unique token, so every run makes a new room.
test('/agent: a document:create + meeting:create plan completes with both links in the thread', async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const sana = await person(browser, baseURL, 'u-lena');
  const token = Date.now().toString(36);
  try {
    await say(sana.page, `/agent plan the kickoff ${token}`);
    const card = sana.page.getByTestId('social-agent-card');
    const plan = card.getByTestId('social-agent-plan');
    await expect(plan).toContainText('Create document', { timeout: 20_000 });
    await expect(plan).toContainText('Create meeting');
    await expect(sana.page.getByTestId('social-agent-link-s1')).toHaveCount(0);
    await card.getByTestId('social-agent-approve').click();
    const doc = card.getByTestId('social-agent-link-s1');
    const room = card.getByTestId('social-agent-link-s2');
    await expect(doc).toContainText('Document created', { timeout: 30_000 });
    await expect(room).toContainText('Room created', { timeout: 30_000 });
    await expect(doc.getByTestId('social-agent-link-s1-open')).toBeVisible();
    await expect(card.getByTestId('social-agent-stopped')).toHaveCount(0);
    await expect(card.getByTestId('social-agent-approve')).toHaveCount(0);
    // The stored file is readable through the thread's upload route as its owner.
    const opened = sana.context.waitForEvent('request', (r) => /\/api\/uploads\/[0-9a-f-]{36}$/.test(r.url()), { timeout: 15_000 });
    await doc.getByTestId('social-agent-link-s1-open').click();
    const file = await sana.page.request.get((await opened).url());
    expect(file.status()).toBe(200);
    expect(await file.text()).toContain('## Agenda');
    // The room link opens the new room in Social.
    await room.getByTestId('social-agent-link-s2-open').click();
    await expect(sana.page).toHaveURL(/\/social\/rooms\?room=meeting-plan-the-kickoff-/);
    expect(sana.errors).toEqual([]);
  } finally { await sana.context.close(); }
});

// A participant may plan and store a document but never manages spaces: the room step is refused
// by the same Cedar gate as "New room", the document stands, and the card says why.
test('/agent: a participant\'s meeting:create step is refused (403) after the document is made', async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const sana = await person(browser, baseURL, 'u-sana');
  try {
    await say(sana.page, `/agent plan the kickoff ${Date.now().toString(36)}`);
    const card = sana.page.getByTestId('social-agent-card');
    await expect(card.getByTestId('social-agent-plan')).toContainText('Create meeting', { timeout: 20_000 });
    await card.getByTestId('social-agent-approve').click();
    await expect(card.getByTestId('social-agent-link-s1')).toContainText('Document created', { timeout: 30_000 });
    await expect(card.getByTestId('social-agent-stopped')).toContainText('Step 2 stopped the loop: 403', { timeout: 30_000 });
    await expect(card.getByTestId('social-agent-link-s2')).toHaveCount(0);
    expect(sana.errors).toEqual([]);
  } finally { await sana.context.close(); }
});

// Approval steps (HITL): the planner puts an `approval` step before a consequential step. The loop pauses
// durably at it, the requester sees the question with Approve / Reject, another member of the channel sees
// the same question READ-ONLY (Social has no second approver), and Approve resumes from the next step.
test('/agent: an approval step pauses the loop, a second tab reads it, the requester approves and the next step completes', async ({ browser, baseURL }) => {
  test.setTimeout(150_000);
  const sana = await person(browser, baseURL, 'u-sana');
  const mira = await person(browser, baseURL, 'u-mira');
  try {
    await say(sana.page, '/agent confirm the wrap up');
    const card = sana.page.getByTestId('social-agent-card');
    await expect(card.getByTestId('social-agent-plan')).toContainText('Approval', { timeout: 20_000 });
    await card.getByTestId('social-agent-approve').click();
    // Step 1 runs, then the loop stops at the question.
    await expect(card.getByTestId('social-agent-step-s1').getByTestId('social-summary-card')).toBeVisible({ timeout: 30_000 });
    const question = card.getByTestId('social-agent-approval-question');
    await expect(question).toContainText('Draft a page for', { timeout: 30_000 });
    await expect(card.getByTestId('social-agent-approval-approve')).toBeVisible();
    await expect(card.getByTestId('social-agent-approval-reject')).toBeVisible();
    await expect(sana.page.getByTestId('social-doc-card')).toHaveCount(0);
    // The second tab (another member) sees the question and the step titles, read-only, with no decision controls.
    const waiting = mira.page.getByTestId('social-agent-waiting-card');
    await expect(waiting).toBeVisible({ timeout: 20_000 });
    await expect(waiting.getByTestId('social-agent-waiting-approval-question')).toContainText('Draft a page for');
    await expect(waiting.getByTestId('social-agent-waiting-approval-readonly')).toBeVisible();
    await expect(waiting.getByTestId('social-agent-waiting-approval-approve')).toHaveCount(0);
    await expect(waiting.getByTestId('social-agent-waiting-approval-reject')).toHaveCount(0);
    // The requester approves: the next step (a page draft) runs and the pause is gone for both.
    await card.getByTestId('social-agent-approval-approve').click();
    await expect(card.getByTestId('social-agent-step-s3').getByTestId('social-doc-card')).toBeVisible({ timeout: 30_000 });
    await expect(card.getByTestId('social-agent-step-s3').getByTestId('social-doc-preview')).toBeVisible({ timeout: 20_000 });
    await expect(card.getByTestId('social-agent-approval')).toHaveCount(0);
    await expect(card.getByTestId('social-agent-stopped')).toHaveCount(0);
    await expect(mira.page.getByTestId('social-agent-waiting-card')).toHaveCount(0, { timeout: 20_000 });
    expect(sana.errors).toEqual([]);
    expect(mira.errors).toEqual([]);
  } finally { await sana.context.close(); await mira.context.close(); }
});

test('/agent: Reject at an approval step ends the loop with the reason and never runs the next step', async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const sana = await person(browser, baseURL, 'u-sana');
  try {
    await say(sana.page, '/agent confirm the wrap up');
    const card = sana.page.getByTestId('social-agent-card');
    await expect(card.getByTestId('social-agent-plan')).toContainText('Approval', { timeout: 20_000 });
    await card.getByTestId('social-agent-approve').click();
    await expect(card.getByTestId('social-agent-approval-question')).toContainText('Draft a page for', { timeout: 40_000 });
    await card.getByTestId('social-agent-approval-reason').fill('Not this time');
    await card.getByTestId('social-agent-approval-reject').click();
    await expect(card.getByTestId('social-agent-stopped')).toContainText('rejected by u-sana: Not this time', { timeout: 30_000 });
    await expect(card.getByTestId('social-agent-approval')).toHaveCount(0);
    await expect(sana.page.getByTestId('social-doc-card')).toHaveCount(0);
    expect(sana.errors).toEqual([]);
  } finally { await sana.context.close(); }
});

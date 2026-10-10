import { chooseComposerMode } from './conversationViews';
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { openAs } from './realSession';

// Realtime parity gap 6, forward (docs/audit-loop/realtime-parity.md): u-mira forwards a #general
// message to her DM with u-sana through the shared conversation panel. Sana sees a NEW message
// that quotes the original with its origin ("Forwarded from #general"). A private channel Mira is
// not in is absent from the picker, and the picker never lists the conversation being forwarded from.
test.use({ viewport: { width: 1440, height: 900 }, ...(process.env.PARITY_BASE_URL ? { baseURL: process.env.PARITY_BASE_URL } : {}) });
test.describe.configure({ mode: 'serial' });

const contexts: BrowserContext[] = [];
test.afterEach(async () => { await Promise.all(contexts.splice(0).map(c => c.close())); });

async function signedIn(browser: Browser, baseURL: string | undefined, userId: string): Promise<Page> {
  const { context, page } = await openAs(browser, userId, { baseURL, viewport: { width: 1440, height: 900 } });
  contexts.push(context);
  return page;
}
const composer = (page: Page) => page.getByTestId('social-chat-composer-input');
const messages = (page: Page, text: string) => page.getByTestId('social-chat-panel').getByTestId('chat-message').filter({ hasText: text });
async function say(page: Page, text: string) {
  await expect(composer(page)).toBeVisible({ timeout: 20_000 });
  await composer(page).click(); await page.keyboard.type(text); await page.keyboard.press('Enter');
}

test('forward a #general message to a DM; the recipient sees the quote with its origin; a channel the actor is not in is not offered', async ({ browser, baseURL }) => {
  test.setTimeout(180_000);
  const stamp = Date.now();
  const secret = `fwd-private-${stamp}`;
  const sana = await signedIn(browser, baseURL, 'u-sana');
  // A private channel only Lena is in: Mira must never be offered it.
  const lena = await signedIn(browser, baseURL, 'u-lena');
  const made = await lena.request.post('/api/social/channels', { data: { name: secret, privacy: 'private' } });
  expect(made.status()).toBe(201);

  const lobby = 'social:dm:u-mira:u-sana';
  await sana.goto('/social/dms');
  await sana.getByTestId('social-new-dm').click();
  const people = sana.getByTestId('social-dm-picker');
  await people.getByPlaceholder(/Search people/).fill('Mira');
  await people.getByRole('button', { name: /Mira Okafor/ }).first().click();
  await expect(sana).toHaveURL(new RegExp(`/social/dms/${encodeURIComponent(lobby)}$`), { timeout: 10_000 });
  await say(sana, `hello mira ${stamp}`);

  const mira = await signedIn(browser, baseURL, 'u-mira');
  await mira.goto('/social/channels/general');
  const original = `forward me ${stamp}`;
  await say(mira, original);
  const row = messages(mira, original).first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.hover();
  await row.getByRole("button", { name: /^forward/i }).click();

  const picker = mira.getByTestId('forward-message');
  await expect(picker).toBeVisible();
  await expect(picker.getByTestId('forward-message-origin')).toContainText('#general');
  const list = picker.getByTestId('forward-message-list');
  await expect(list.locator(`[data-testid="conversation-row"][data-channel="${lobby}"]`)).toBeVisible({ timeout: 15_000 });
  await expect(list.locator('[data-testid="conversation-row"][data-channel="social:ch:general"]')).toHaveCount(0);
  await expect(list.locator(`[data-testid="conversation-row"][data-channel="social:ch:${secret}"]`)).toHaveCount(0);
  await expect(list).not.toContainText(secret);

  await list.locator(`[data-testid="conversation-row"][data-channel="${lobby}"]`).click();
  await expect(picker).toHaveCount(0, { timeout: 15_000 });

  // Sana, in the DM, sees a new message quoting the original and naming where it came from.
  await expect(messages(sana, original)).toHaveCount(1, { timeout: 15_000 });
  await expect(messages(sana, original).first()).toContainText(/Forwarded from #general/);
  await expect(messages(sana, original).first()).toContainText('Mira');
});

// Assessment: an assessor forwards from one team's Discussion to another's. The picker lists teams
// from the roster the pages use (never the origin), the peer in the target sees the origin team's
// name, and a team that is not in the roster is absent.
test('an assessor forwards a team Discussion message to another team Discussion', async ({ browser, baseURL }) => {
  test.setTimeout(180_000);
  const stamp = Date.now();
  const asha = await signedIn(browser, baseURL, 'u-asha');
  const roster = await (await asha.request.get('/api/assessment/teams')).json() as Array<{ id: string; name: string }>;
  const from = roster.find(t => t.id === 'TEAM-001')!, to = roster.find(t => t.id === 'TEAM-005')!;
  expect(from && to).toBeTruthy();

  const jonas = await signedIn(browser, baseURL, 'u-jonas');
  // The team Discussion is the scorecard's right pane (the thread). On Certification the dimension composer is
  // its input; on any other tab (Improvement Plan here) the team composer docked in the content column is.
  await jonas.goto('/assessment/teams/TEAM-005?tab=plan');
  await expect(jonas.getByTestId('scope-discussion-panel-offline')).toHaveCount(0, { timeout: 20_000 });

  await asha.goto('/assessment/teams/TEAM-001?tab=plan');
  const input = asha.getByTestId('team-discussion-composer').getByTestId('rich-chat-composer-input');
  await expect(input).toBeVisible({ timeout: 20_000 });
  const original = `team forward ${stamp}`;
  await input.click(); await asha.keyboard.type(original); await asha.keyboard.press('Enter');
  const row = asha.getByTestId('chat-message').filter({ hasText: original }).first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.hover();
  await row.getByRole('button', { name: /^forward/i }).click();

  const picker = asha.getByTestId('forward-message');
  await expect(picker.getByTestId('forward-message-origin')).toContainText(from.name);
  const list = picker.getByTestId('forward-message-list');
  const rowFor = (id: string) => list.locator(`[data-testid="conversation-row"][data-channel="assessment:team:${id}"]`);
  await expect(rowFor('TEAM-005')).toBeVisible({ timeout: 15_000 });
  await expect(rowFor('TEAM-001')).toHaveCount(0);
  await expect(rowFor('TEAM-999')).toHaveCount(0);
  await expect(picker.getByTestId('forward-message-empty')).toHaveCount(0);

  await rowFor('TEAM-005').click();
  await expect(picker).toHaveCount(0, { timeout: 15_000 });
  const arrived = jonas.getByTestId('chat-message').filter({ hasText: original });
  await expect(arrived).toHaveCount(1, { timeout: 15_000 });
  await expect(arrived.first()).toContainText(new RegExp(`Forwarded from ${from.name}`));
  void to;
});

// Orgiq: an initiative Discussion message is forwarded to a work item's thread (listed under its
// initiative); the peer in that item's Discussion sees "Forwarded from <initiative>".
test('forward an initiative Discussion message to a work-item thread', async ({ browser, baseURL }) => {
  test.setTimeout(180_000);
  const stamp = Date.now();
  const initiative = '/iq/projects/p-auth-migration';
  const itemId = 'wi-auth-e2-b3';
  const rachel = await signedIn(browser, baseURL, 'u-rachel');
  await rachel.goto(`${initiative}?tab=work&item=${itemId}&view=comments`);
  await expect(rachel.getByTestId('work-item-live-discussion')).toBeVisible({ timeout: 20_000 });
  await expect(rachel.getByTestId('scope-discussion-panel-offline')).toHaveCount(0, { timeout: 15_000 });

  const nora = await signedIn(browser, baseURL, 'u-nora');
  await nora.goto(initiative);
  // The page's one composer is docked in the content column (2.438.3): Chat → the initiative's Discussion.
  const composer = nora.getByTestId('initiative-workspace').getByTestId('initiative-composer');
  const input = composer.getByTestId('rich-chat-composer-input');
  await expect(input).toBeVisible({ timeout: 20_000 });
  await chooseComposerMode(nora, composer, 'Agent', 'Chat');
  const original = `item forward ${stamp}`;
  await input.click(); await nora.keyboard.press('ControlOrMeta+a'); await nora.keyboard.press('Backspace');
  await nora.keyboard.type(original); await nora.keyboard.press('Enter');
  const row = nora.getByTestId('chat-message').filter({ hasText: original }).first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.hover();
  await row.getByRole('button', { name: /^forward/i }).click();

  const picker = nora.getByTestId('forward-message');
  const list = picker.getByTestId('forward-message-list');
  const target = list.locator(`[data-testid="conversation-row"][data-channel="orgiq:work:${itemId}"]`);
  await expect(target).toBeVisible({ timeout: 15_000 });
  await expect(list.locator('[data-testid="conversation-row"][data-channel^="orgiq:initiative:p-auth-migration"]')).toHaveCount(0);
  await target.click();
  await expect(picker).toHaveCount(0, { timeout: 15_000 });
  const arrived = rachel.getByTestId('chat-message').filter({ hasText: original });
  await expect(arrived).toHaveCount(1, { timeout: 15_000 });
  await expect(arrived.first()).toContainText(/Forwarded from /);
});

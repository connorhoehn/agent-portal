import { loginAs } from './realSession';
import { type Browser, type BrowserContext, type Page } from '@playwright/test';
import { test, expect } from './cdpTest';

// The chat / agent composer under a dimension on the team scorecard. Chat posts
// to the team's Discussion (`assessment:team:<id>`); Agent runs the drafter for
// the selected dimension; a reader gets a read-only composer with the reason.
// Run against a dev:mock stack (PARITY_BASE_URL, default :5183).

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
  expect((await context.request.post('/api/session/tenant', { data: { tenant: 'assessment' } })).status(), 'tenant switch').toBe(200);
  return { context, page, errors };
}

const dock = (page: Page) => page.getByTestId('dimension-composer');
async function pickMode(page: Page, from: 'Agent' | 'Chat', to: 'Agent' | 'Chat') {
  await dock(page).getByRole('button', { name: `Composer mode: ${from}`, exact: true }).click();
  await page.getByRole('menuitem', { name: to, exact: true }).click();
}

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

test('Chat from the dimension drill-down appears in the team Discussion; the chip names team and dimension', async ({ browser, baseURL }) => {
  test.setTimeout(90_000);
  const asha = await open(browser, baseURL, 'u-asha');
  try {
    await asha.page.goto(`/assessment/teams/${TEAM}`);
    await expect(dock(asha.page)).toBeVisible({ timeout: 20_000 });
    await expect(dock(asha.page).getByTestId('rich-chat-composer-references')).toContainText('Assessment › Teams');
    await pickMode(asha.page, 'Agent', 'Chat');
    const marker = `Scorecard drill-down note ${Date.now()}`;
    const input = dock(asha.page).getByTestId('rich-chat-composer-input');
    await expect(input).toHaveAttribute('contenteditable', 'true', { timeout: 20_000 });
    await input.fill(marker);
    await dock(asha.page).getByTestId('rich-chat-composer-send').click();
    await expect(asha.page.getByTestId('dimension-composer-note')).toContainText('Discussion');
    // The team Discussion is the right pane (open by default), not a tab.
    await expect(asha.page.getByTestId('team-discussion').getByTestId('chat-message').filter({ hasText: marker })).toBeVisible({ timeout: 15_000 });
    expect(asha.errors).toEqual([]);
  } finally { await asha.context.close(); }
});

test('Agent /summarize drafts an evidence summary card for the selected dimension, on any detail tab', async ({ browser, baseURL }) => {
  test.setTimeout(90_000);
  const asha = await open(browser, baseURL, 'u-asha');
  try {
    await asha.page.goto(`/assessment/teams/${TEAM}`);
    await expect(dock(asha.page)).toBeVisible({ timeout: 20_000 });
    // On the Evidence tab the composer shows the card itself (Progress shows it in its own panel).
    await asha.page.getByRole('tab', { name: 'Evidence', exact: true }).click();
    await dock(asha.page).getByTestId('rich-chat-composer-input').fill('/summarize');
    await dock(asha.page).getByTestId('rich-chat-composer-send').click();
    const card = asha.page.getByTestId('dimension-composer-drafts').getByTestId('evidence-draft-card').first();
    await expect(card).toHaveAttribute('data-phase', 'completed', { timeout: 30_000 });
    await expect(card).toHaveAttribute('data-kind', 'assessment.evidence-summary');
    // Free text is not a command: nothing starts, the draft stays, the help says why.
    await dock(asha.page).getByTestId('rich-chat-composer-input').fill('how are we doing?');
    await dock(asha.page).getByTestId('rich-chat-composer-send').click();
    await expect(asha.page.getByTestId('dimension-composer-note')).toContainText('/summarize');
    expect(asha.errors).toEqual([]);
  } finally { await asha.context.close(); }
});

// The scorecard is a full-height page: the pane takes the remaining height, so
// the composer sits above the shell footer on arrival with nothing scrolled.
for (const size of [{ width: 1680, height: 940 }, { width: 1440, height: 900 }]) {
  test(`the composer is above the shell footer on arrival at ${size.width}x${size.height}, and the list scrolls inside the pane`, async ({ browser, baseURL }) => {
    test.setTimeout(90_000);
    const asha = await open(browser, baseURL, 'u-asha');
    try {
      await asha.page.setViewportSize(size);
      await asha.page.goto(`/assessment/teams/${TEAM}`);
      const input = dock(asha.page).getByTestId('rich-chat-composer-input');
      await expect(input).toBeVisible({ timeout: 20_000 });
      const footerTop = (await asha.page.getByTestId('shell-footer').boundingBox())!.y;
      const box = (await input.boundingBox())!;
      const host = await asha.page.locator('#main-content').evaluate((el) => el.scrollTop);
      console.log(`${size.width}x${size.height} composer input y=${box.y}-${box.y + box.height} footer.top=${footerTop} hostScroll=${host}`);
      expect(host, 'host column at scroll 0').toBe(0);
      expect(box.y + box.height, 'composer bottom above the shell footer').toBeLessThanOrEqual(footerTop);
      const rail = asha.page.getByTestId('assessment-dimension-master-detail-rail');
      // The rail (ExplorerLayout's) scrolls its own rows: some element inside it, never the host column.
      const scrolls = await rail.evaluate((el) => [el, ...el.querySelectorAll('*')].some((n) =>
        n.scrollHeight > n.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(n).overflowY)));
      expect(scrolls, 'the dimension list scrolls inside the pane').toBe(true);
      expect(asha.errors).toEqual([]);
    } finally { await asha.context.close(); }
  });
}

test('a reader sees a read-only composer with the reason', async ({ browser, baseURL }) => {
  test.setTimeout(60_000);
  const asha = await open(browser, baseURL, 'u-asha');
  try {
    await asha.page.route('**/api/session/capabilities', async route => {
      const real = await route.fetch();
      const body = await real.json() as { actions: Record<string, boolean> };
      await route.fulfill({ response: real, json: { ...body, actions: { ...body.actions, ScoreAssessment: false, RunAssessmentAgent: false } } });
    });
    await asha.page.goto(`/assessment/teams/${TEAM}`);
    await expect(asha.page.getByTestId('dimension-composer-read-only')).toContainText('read-only', { timeout: 20_000 });
    await expect(dock(asha.page).getByTestId('rich-chat-composer-send')).toBeDisabled();
  } finally { await asha.context.close(); }
});

// ── A live huddle in the block, and the dimension reference as a card ──────
// Two real sessions on the shared Tilt app (u-asha, u-jonas), a Chrome with
// fake devices over the local SFU. The block claims the shell's single media
// sink: the tiles render inside it and nowhere else, the huddle chat sits
// beside the composer, and Leave hands everything back.

const MEDIA_ARGS = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
  '--autoplay-policy=no-user-gesture-required', '--disable-features=LocalNetworkAccessChecks'];

async function mediaPerson(browser: Browser, baseURL: string | undefined, userId: string): Promise<Person> {
  const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 }, permissions: ['camera', 'microphone'] });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  // Media and huddle-chat refusals, named in a failure.
  page.on('response', response => {
    const url = new URL(response.url());
    if (response.status() >= 400 && /\/api\/(video|calls)\//.test(url.pathname)) errors.push(`${userId} ${response.request().method()} ${url.pathname} ${response.status()}`);
  });
  if (process.env.DEBUG_COMPOSER_E2E) {
    page.on('websocket', ws => {
      const log = (dir: string) => (event: { payload: string | Buffer }) => {
        const text = String(event.payload);
        if (/"type":"(call|call-chat|error)"|"service":"call"/.test(text)) console.log(`[${userId}] ${dir} ${text.slice(0, 400)}`);
      };
      ws.on('framesent', log('>>')); ws.on('framereceived', log('<<'));
    });
  }
  await loginAs(context, userId, baseURL, true);
  expect((await context.request.post('/api/session/tenant', { data: { tenant: 'assessment' } })).status(), 'tenant switch').toBe(200);
  return { context, page, errors };
}

const block = (page: Page) => page.getByTestId('dimension-composer-block');
const footerHuddle = (page: Page) => page.getByTestId('shell-footer-context').getByRole('button', { name: 'Huddle' });

/** Exactly one call-media sink on the page, and it is the call bar and tiles directly above the block's composer. */
async function expectTilesInBlock(page: Page) {
  await expect(block(page)).toHaveAttribute('data-live-huddle', 'true', { timeout: 30_000 });
  const media = block(page).getByTestId('dimension-composer-dock-slot').getByTestId('composer-call-dock');
  await expect(media).toHaveAttribute('data-holds-media', 'true');
  await expect(page.getByTestId('shell-call-media')).toHaveCount(1);
  await expect(media.getByTestId('shell-call-media')).toHaveAttribute('data-placement', 'composer');
  await expect(page.getByTestId('shell-footer').getByTestId('shell-call-media')).toHaveCount(0);
  await expect(media.getByTestId('page-call-dock')).toBeVisible();
  // The call bar with its own Leave, over the tiles: the full bar (layout="shelf"), or — with the
  // team Discussion open as the right pane, the detail column under 640px — its narrow form ("stack").
  await expect(media.getByTestId('shell-call-media')).toHaveAttribute('data-layout', /^(shelf|stack)$/);
  await expect(media.getByTestId('call-dock-leave')).toBeVisible();
}

test('a live huddle from the team page puts its tiles in the block (one sink); Leave hands them back', async ({ playwright, baseURL }) => {
  test.setTimeout(180_000);
  const media = await playwright.chromium.launch({ channel: 'chrome', headless: true, args: MEDIA_ARGS });
  const people = [await mediaPerson(media, baseURL, 'u-asha'), await mediaPerson(media, baseURL, 'u-jonas')];
  const [asha, jonas] = people.map(p => p.page) as [Page, Page];
  try {
    await asha.goto(`/assessment/teams/${TEAM}`);
    await expect(dock(asha)).toBeVisible({ timeout: 20_000 });
    await expect(block(asha)).toHaveAttribute('data-live-huddle', 'false');
    await expect(block(asha).getByTestId('huddle-chat-inpage')).toHaveCount(0);
    await expect(footerHuddle(asha)).toBeEnabled({ timeout: 20_000 });
    await footerHuddle(asha).click();
    await expectTilesInBlock(asha);

    await jonas.goto(`/assessment/teams/${TEAM}`);
    await expect(dock(jonas)).toBeVisible({ timeout: 20_000 });
    await expect(footerHuddle(jonas)).toBeEnabled({ timeout: 20_000 });
    await footerHuddle(jonas).click();
    await expectTilesInBlock(jonas);

    // Both people's tiles: each block's single sink carries the other person's media.
    for (const page of [asha, jonas]) {
      await expect.poll(() => block(page).getByTestId('composer-call-dock').locator('video').evaluateAll(elements =>
        elements.filter(element => !!(element as HTMLVideoElement).srcObject).length), { timeout: 45_000 }).toBeGreaterThan(0);
    }

    // Leave: the block returns to composer-only, the footer owns the (absent) sink again.
    await asha.getByTestId(/^(shell-)?call-dock-leave$/).first().click();
    await expect(block(asha)).toHaveAttribute('data-live-huddle', 'false', { timeout: 20_000 });
    await expect(block(asha).getByTestId('huddle-chat-inpage')).toHaveCount(0);
    await expect(block(asha).getByTestId('composer-call-dock')).toHaveCount(0);
    await expect(asha.getByTestId('shell-call-media')).toHaveCount(0);
    for (const person of people) expect(person.errors).toEqual([]);
  } finally {
    for (const page of [asha, jonas]) {
      const leave = page.getByTestId(/^(shell-)?call-dock-leave$/).first();
      if (await leave.count().catch(() => 0)) await leave.click().catch(() => undefined);
    }
    await Promise.all(people.map(p => p.context.close()));
    await media.close();
  }
});

// The huddle chat is the call-scoped chat on `orgiq:huddle:<callId>`, drawn as
// the thread only: the dimension composer is its one input
// (the library ConversationInputProvider). With the team Discussion open as the right pane
// the huddle chat stacks in that pane (never beside the composer), so the
// composer keeps its full width and its To: switch (2026-10-07). A page huddle rings nobody; realtime-modules 0.111
// registers it (each join takes a seat), so the BFF admits exactly the seats.
test('the huddle chat in the right pane carries a message between the two seats; the composer keeps its To: switch', async ({ playwright, baseURL }) => {
  test.setTimeout(180_000);
  const media = await playwright.chromium.launch({ channel: 'chrome', headless: true, args: MEDIA_ARGS });
  const people = [await mediaPerson(media, baseURL, 'u-asha'), await mediaPerson(media, baseURL, 'u-jonas')];
  const [asha, jonas] = people.map(p => p.page) as [Page, Page];
  // The page pane is open (the team Discussion), so the huddle chat stacks in the shell's right pane.
  const pane = (page: Page) => page.getByTestId('shell-split-secondary').getByTestId('huddle-chat-panel');
  try {
    for (const page of [asha, jonas]) {
      await page.goto(`/assessment/teams/${TEAM}`);
      await expect(dock(page)).toBeVisible({ timeout: 20_000 });
      await expect(footerHuddle(page)).toBeEnabled({ timeout: 20_000 });
      await footerHuddle(page).click();
      await expectTilesInBlock(page);
    }
    for (const page of [asha, jonas]) {
      await expect(pane(page)).toBeVisible({ timeout: 30_000 });
      await expect(pane(page).getByTestId('huddle-chat-error')).toHaveCount(0);
    }
    await expect(pane(asha).getByTestId('huddle-chat-participants')).toContainText('Jonas', { timeout: 30_000 });
    // One input per conversation: the dimension composer addresses the huddle
    // (Chat · To: Huddle), so the chat beside it is the thread only and its
    // Reply puts the caret in that composer with the huddle selected.
    for (const page of [asha, jonas]) {
      await expect(pane(page).getByTestId('pane-input-handoff')).toBeVisible({ timeout: 20_000 });
      await expect(pane(page).locator('[contenteditable="true"]')).toHaveCount(0);
    }
    await pane(asha).getByTestId('pane-input-handoff-focus').click();
    const input = dock(asha).getByTestId('rich-chat-composer-input');
    await expect(input).toBeFocused();
    // Nothing sits beside the composer, so it keeps its full form: the To: select names the huddle
    // and can switch back to the Discussion.
    await expect(block(asha).getByTestId('huddle-chat-inpage')).toHaveCount(0);
    const recipient = dock(asha).getByRole('combobox', { name: 'Chat recipient' });
    await expect(recipient).toHaveValue('huddle');
    await expect(input).toHaveAttribute('contenteditable', 'true', { timeout: 20_000 });
    const marker = `Huddle chat note ${Date.now()}`;
    await input.fill(marker);
    await expect(dock(asha).getByTestId('rich-chat-composer-send')).toBeEnabled({ timeout: 15_000 });
    await dock(asha).getByTestId('rich-chat-composer-send').click();
    for (const page of [asha, jonas]) {
      await expect(pane(page).getByTestId('chat-message').filter({ hasText: marker })).toBeVisible({ timeout: 20_000 });
    }
    for (const person of people) expect(person.errors).toEqual([]);
  } finally {
    for (const page of [asha, jonas]) {
      const leave = page.getByTestId(/^(shell-)?call-dock-leave$/).first();
      if (await leave.count().catch(() => 0)) await leave.click().catch(() => undefined);
    }
    await Promise.all(people.map(p => p.context.close()));
    await media.close();
  }
});

test('a Chat send carries the dimension reference; the other session sees it as a card that opens the dimension', async ({ browser, baseURL }) => {
  test.setTimeout(90_000);
  const asha = await open(browser, baseURL, 'u-asha');
  const jonas = await open(browser, baseURL, 'u-jonas');
  try {
    await asha.page.goto(`/assessment/teams/${TEAM}`);
    await expect(dock(asha.page)).toBeVisible({ timeout: 20_000 });
    const chip = dock(asha.page).getByTestId('rich-chat-composer-references');
    await expect(chip).toContainText('Assessment › Teams');
    const dimensionLabel = (await chip.textContent())?.split('›').pop()?.trim() ?? '';
    await pickMode(asha.page, 'Agent', 'Chat');
    const marker = `Dimension reference ${Date.now()}`;
    const input = dock(asha.page).getByTestId('rich-chat-composer-input');
    await expect(input).toHaveAttribute('contenteditable', 'true', { timeout: 20_000 });
    await input.fill(marker);
    await dock(asha.page).getByTestId('rich-chat-composer-send').click();
    await expect(asha.page.getByTestId('dimension-composer-note')).toContainText('Discussion');

    await jonas.page.goto(`/assessment/teams/${TEAM}?tab=discussion`);
    const message = jonas.page.getByTestId('chat-message').filter({ hasText: marker });
    await expect(message).toBeVisible({ timeout: 20_000 });
    const card = message.getByTestId('page-reference-card');
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card).toContainText(dimensionLabel);
    await expect(card).toContainText('Teams ›');
    await message.getByTestId('discussion-reference-open-card').click();
    await expect(jonas.page).toHaveURL(new RegExp(`/assessment/teams/${TEAM}\\?dimension=`));
    expect(asha.errors).toEqual([]); expect(jonas.errors).toEqual([]);
  } finally { await asha.context.close(); await jonas.context.close(); }
});

test('the composer is docked inside the viewport on arrival; the Discussion Pinned view lists a pinned message', async ({ browser, baseURL }) => {
  test.setTimeout(90_000);
  const asha = await open(browser, baseURL, 'u-asha');
  const consoleErrors: string[] = [];
  asha.page.on('response', response => { if (response.status() >= 400 && /\/api\/chat\//.test(response.url())) consoleErrors.push(`${response.status()} ${response.url()}`); });
  try {
    await asha.page.goto(`/assessment/teams/${TEAM}`);
    await expect(dock(asha.page)).toBeVisible({ timeout: 20_000 });
    const box = await dock(asha.page).boundingBox();
    expect(box && box.y <= 940, 'composer in the viewport on arrival (y within 940)').toBe(true);
    // The pane keeps its own scrolling: the dimension list scrolls, the docked composer does not move.
    const pane = asha.page.getByTestId('assessment-dimension-master-detail-pane');
    expect(await pane.evaluate(el => el.scrollHeight > el.clientHeight && getComputedStyle(el).overflowY === 'auto'), 'detail pane scrolls its own content').toBe(true);
    await pane.evaluate(el => { el.scrollTop = el.scrollHeight; });
    const after = await dock(asha.page).boundingBox();
    expect(after && box && Math.abs(after.y - box.y) < 2, 'composer stays docked while the pane scrolls').toBe(true);
    await pickMode(asha.page, 'Agent', 'Chat');
    const marker = `Pin me from the scorecard ${Date.now()}`;
    const input = dock(asha.page).getByTestId('rich-chat-composer-input');
    await expect(input).toHaveAttribute('contenteditable', 'true', { timeout: 20_000 });
    await input.fill(marker);
    await dock(asha.page).getByTestId('rich-chat-composer-send').click();
    const row = asha.page.getByTestId('team-discussion').getByTestId('chat-message').filter({ hasText: marker });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.hover();
    await row.getByRole('button', { name: 'Pin to channel', exact: true }).click();
    await asha.page.getByRole('radio', { name: /^Pinned/ }).click();
    await expect(asha.page.getByText(marker).first()).toBeVisible({ timeout: 10_000 });
    await expect(asha.page.getByText(/Pinned messages are unavailable/)).toHaveCount(0);
    expect(consoleErrors).toEqual([]);
  } finally { await asha.context.close(); }
});

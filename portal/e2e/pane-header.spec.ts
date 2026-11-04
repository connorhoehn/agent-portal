import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { loginAs } from './realSession';

// The initiative page's right pane has ONE header (the user, 2026-10-07, of
// /iq/projects/p-observability with the Discussion pane open: "looks awful" —
// a pane tab row, a second "Chat | More ▾" row under it, and the More menu
// hanging out of the pane over the content column):
//
// - one tab row (Discussion · Details · Docs …), the only tablist in the pane;
// - the conversation's views (Chat / Pinned / Calls; files are the Docs tab) are an icon
//   switcher at the right end of that row, not a second row;
// - a menu opened inside the pane stays inside the pane (ui-components 2.435
//   popover boundary), at 1440 and 1280;
// - the pane header's title, the tab row and the body start at one left edge.
//
// And on a focused work item ("once again.. two chat inputs"): one composer,
// the content column's (2026-10-07: the pane keeps the dialogue thread only); pins load for admin and
// org-leader (no "Pinned messages are unavailable" banner); the content
// column's Discussion tab lists the same messages as the pane's thread — the
// gateway thread `orgiq:work:<id>`, whose history holds the seeded comments.
// Runs against the shared Tilt app (PARITY_BASE_URL, default :5183).

const PID = 'p-observability';
const ITEM = 'wi-obs-e1-b5';
const BASE = () => process.env.PARITY_BASE_URL ?? test.info().project.use.baseURL ?? 'http://127.0.0.1:5183';

async function open(browser: Browser, user: string, width: number, role?: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width, height: 900 }, baseURL: BASE() });
  await loginAs(context, user, BASE(), true);
  const page = await context.newPage();
  if (role) expect((await page.request.post('/api/session/role', { data: { role } })).status(), `switch to ${role}`).toBe(200);
  return page;
}

const pane = (page: Page) => page.getByTestId('page-conversation-pane');
/** The pane's current tab — the selected tab of its one tablist (what the reader sees). */
const paneTab = (scope: Page | Locator) => ('getByTestId' in scope && 'goto' in scope ? scope.getByTestId('initiative-pane') : scope)
  .getByRole('tablist', { name: 'Pane sections' }).getByRole('tab', { selected: true });

async function box(locator: Locator) {
  const b = await locator.boundingBox();
  expect(b, 'element has a box').not.toBeNull();
  return b!;
}

/** The left edge of the first rendered text inside an element (not its padding box). */
const textLeft = (locator: Locator) => locator.evaluate((root) => {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.textContent?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT) });
  const node = walker.nextNode();
  if (!node) return null;
  const range = document.createRange(); range.selectNodeContents(node);
  return range.getBoundingClientRect().left;
});

async function expectInside(inner: Locator, outer: Locator, what: string) {
  const i = await box(inner), o = await box(outer);
  expect(i.x, `${what}: left inside the pane`).toBeGreaterThanOrEqual(o.x - 0.5);
  expect(i.x + i.width, `${what}: right inside the pane`).toBeLessThanOrEqual(o.x + o.width + 0.5);
}

for (const width of [1440, 1280]) {
  test(`one pane header at ${width}: one tab row, the views on its right, menus inside the pane, one left edge`, async ({ browser }) => {
    test.setTimeout(120_000);
    const page = await open(browser, 'u-release', width, 'org-leader');
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`/iq/projects/${PID}?scope=all`);
    await expect(page.getByTestId('initiative-header')).toBeVisible({ timeout: 20_000 });
    // A window too narrow for the split keeps the pane collapsed until the footer's Message asks for it.
    if (!(await page.getByTestId('initiative-pane').isVisible())) await page.getByRole('button', { name: 'Message', exact: true }).last().click();
    await expect(page.getByTestId('initiative-pane')).toBeVisible({ timeout: 20_000 });
    await expect(paneTab(page)).toHaveText('Discussion');

    // One tablist in the pane: the pane's own sections.
    await expect(pane(page).getByRole('tablist')).toHaveCount(1);
    await expect(pane(page).getByRole('tablist')).toHaveAccessibleName('Pane sections');
    // The views: an icon switcher at the right end of the same row, every view drawn, nothing folded.
    const row = page.getByTestId('initiative-pane-header-row');
    const views = row.getByRole('radiogroup', { name: 'Conversation views' });
    await expect(views).toBeVisible();
    // Initiative files are the page's Docs tab, so this thread passes includeFiles={false}: no Files view.
    for (const name of ['Chat', /^Pinned/, /^Calls/]) await expect(views.getByRole('radio', { name })).toBeVisible();
    await expect(views.getByRole('radio', { name: /^Files/ })).toHaveCount(0);
    await expect(pane(page).getByText('More', { exact: true })).toHaveCount(0);
    const rowBox = await box(row), viewsBox = await box(views);
    expect(Math.abs((viewsBox.y + viewsBox.height / 2) - (rowBox.y + rowBox.height / 2)), 'views on the tab row').toBeLessThanOrEqual(2);
    await expectInside(views, pane(page), 'view switcher');
    // A view switch keeps the single row.
    await views.getByRole('radio', { name: /^Pinned/ }).click();
    await expect(views.getByRole('radio', { name: /^Pinned/ })).toHaveAttribute('aria-checked', 'true');
    await expect(pane(page).getByRole('tablist')).toHaveCount(1);
    await views.getByRole('radio', { name: 'Chat' }).click();

    // A menu opened inside the pane stays inside it (the frame is the library's
    // popover boundary). The pane holds the thread only, so its menus are a
    // message's ⋯ — present only when the thread has messages.
    const trigger = pane(page).locator('[aria-haspopup="menu"]:visible').first();
    if (await trigger.count()) {
      await trigger.click();
      const menu = page.locator('[role="menu"]:visible').first();
      await expect(menu).toBeVisible();
      await expectInside(menu, pane(page), 'menu opened in the pane');
      await page.screenshot({ path: test.info().outputPath(`pane-menu-${width}.png`) });
      await page.keyboard.press('Escape');
    }
    // No composer in the pane: the one composer is the content column's.
    await expect(pane(page).locator('[contenteditable="true"]')).toHaveCount(0);
    await expect(page.locator('[contenteditable="true"]:visible')).toHaveCount(1);

    // One left edge: the header's title, the first tab's label, the body (Details).
    await page.getByTestId('initiative-pane-tab-details').click();
    await expect(paneTab(page)).toHaveText('Details');
    const title = await textLeft(page.getByTestId('page-conversation-pane-title'));
    const tab = await textLeft(page.getByTestId('initiative-pane-tab-discussion'));
    const body = (await box(page.getByTestId('initiative-pane-details'))).x + 16;
    expect(title).not.toBeNull(); expect(tab).not.toBeNull();
    expect(Math.abs(title! - tab!), `title ${title} vs tab ${tab}`).toBeLessThanOrEqual(1);
    expect(Math.abs(title! - body), `title ${title} vs body ${body}`).toBeLessThanOrEqual(1);
    const bodyText = await textLeft(page.getByTestId('initiative-pane-details'));
    expect(Math.abs(title! - bodyText!), `title ${title} vs body text ${bodyText}`).toBeLessThanOrEqual(1);
    // The views belong to Discussion: hidden on Details.
    await expect(views).toBeHidden();
    await page.screenshot({ path: test.info().outputPath(`pane-details-${width}.png`) });
    expect(errors).toEqual([]);
  });
}

for (const [user, role] of [['u-operator', undefined], ['u-release', 'org-leader']] as const) {
  test(`work item as ${role ?? 'admin'}: one composer, in the content column; pins load; the item's Activity lists its comments`, async ({ browser }) => {
    test.setTimeout(120_000);
    const page = await open(browser, user, 1440, role);
    const channel = `orgiq:work:${ITEM}`;
    expect((await page.request.get(`/api/chat/pins?channel=${encodeURIComponent(channel)}`)).status(), 'pins read').toBe(200);
    await page.goto(`/iq/projects/${PID}?scope=all&tab=work&item=${ITEM}&view=comments`);
    await expect(page.getByTestId('initiative-pane')).toBeVisible({ timeout: 20_000 });

    // One composer on screen, docked in the content column; the pane is the thread.
    await expect(pane(page).locator('[contenteditable="true"]:visible')).toHaveCount(0);
    await expect(page.getByTestId('initiative-workspace').locator('[contenteditable="true"]:visible')).toHaveCount(1);
    await expect(page.locator('[contenteditable="true"]:visible')).toHaveCount(1);
    await expect(page.getByTestId('initiative-workspace').getByTestId('initiative-composer')).toBeVisible();
    await expect(pane(page).getByTestId('initiative-composer')).toHaveCount(0);

    // Pins: no unavailable banner.
    await expect(pane(page).getByRole('radiogroup', { name: 'Conversation views' })).toBeVisible();
    await expect(page.getByText(/Pinned messages are unavailable/)).toHaveCount(0);

    // The pane is the initiative's own discussion (scopeDiscussionChannel), not the
    // item's thread; the item's seeded comments are its Activity history (?view=comments → history).
    await expect(pane(page).getByTestId('initiative-conversation-empty').or(pane(page).getByTestId('chat-message').first())).toBeVisible({ timeout: 15_000 });
    await expect(pane(page)).not.toContainText('Bounding the queue trades spans for survival');
    const detail = page.getByTestId('work-item-detail');
    await expect(detail.getByRole('tab', { name: 'Activity' })).toHaveAttribute('aria-selected', 'true');
    const activity = detail.getByRole('list', { name: 'Activity' });
    await expect(activity).toContainText('Repro: burst 40k spans/s');
    await expect(activity).toContainText('Layla Hassan');
    await expect(activity).toContainText('Nora DaSilva');
    await page.screenshot({ path: test.info().outputPath(`work-item-${role ?? 'admin'}.png`) });
  });
}

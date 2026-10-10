import { expect, test, type Browser, type Page } from '@playwright/test';
import { loginAs } from './realSession';
import { chooseComposerMode } from './conversationViews';

// The fourth pane holds the dialogue, the content column holds the composer
// (the user, 2026-10-07: "for all apps that use this fourth pane: keep the chat
// in the main content (third pane) like it is on some pages, and just keep the
// dialogue thread there. I should be able to collapse the panes and make the
// chat pane (fourth on right) wider… do that for all pages").
//
// Every page with a conversation: exactly ONE composer on screen, inside the
// content column (`#main-content`), never inside the shell's right pane. Where
// the page opens the right pane (the library SidePane: initiative, work item,
// Search Connections and Results), the pane holds the thread; its left-edge
// handle drags it wider (persisted per device, per pane), arrow keys resize it,
// Enter folds it to a 44px strip with a Restore control, and the Search graph
// stays inside its canvas after a resize.
// Runs against the shared Tilt app (PARITY_BASE_URL, default :5183).

const BASE = () => process.env.PARITY_BASE_URL ?? test.info().project.use.baseURL ?? 'http://127.0.0.1:5183';

async function open(browser: Browser, user: string, width = 1680, height = 940): Promise<Page> {
  const context = await browser.newContext({ viewport: { width, height }, baseURL: BASE() });
  await loginAs(context, user, BASE(), true);
  return context.newPage();
}

/** Where the page's composers are: how many are on screen, and whether each sits in the content column or the right pane. */
async function composers(page: Page) {
  return page.evaluate(() => {
    const visible = (e: Element) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    // A conversation composer: a rich editor, or a composer's own textarea (not a form field such as a run's instruction).
    return [...document.querySelectorAll('[contenteditable="true"], [data-testid*="composer"] textarea')].filter(visible).map((e) => {
      const r = e.getBoundingClientRect();
      return {
        inContent: !!e.closest('#main-content') && !e.closest('[data-testid="shell-split-secondary"]'),
        inPane: !!e.closest('[data-testid="shell-split-secondary"]'),
        x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width),
      };
    });
  });
}

async function expectOneComposerInContent(page: Page, what: string) {
  await expect.poll(async () => (await composers(page)).length, { message: `${what}: one composer on screen`, timeout: 20_000 }).toBe(1);
  const [only] = await composers(page);
  expect(only!.inContent, `${what}: the composer is in the content column`).toBe(true);
  expect(only!.inPane, `${what}: the composer is not in the right pane`).toBe(false);
  return only!;
}

const paneBox = async (page: Page) => (await page.getByTestId('page-conversation-pane').boundingBox())!;

/** Drag the split's divider `dx` px (negative widens the right pane). */
async function drag(page: Page, dx: number) {
  const handle = page.getByTestId('shell-split-divider');
  const b = (await handle.boundingBox())!;
  const x = b.x + b.width / 2, y = b.y + b.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y, { steps: 4 });
  await page.mouse.move(x + dx, y, { steps: 4 });
  await page.mouse.up();
}

interface PaneRoute {
  name: string;
  user: string;
  path: string;
  /** Opens the pane once the page is up (Search's Ask about selection). */
  openPane?: (page: Page) => Promise<void>;
  /** The thread the pane must hold. */
  thread: (page: Page) => ReturnType<Page['getByTestId']>;
  graph?: boolean;
}

const TARA = 'p-016';
const SEARCH = `/iq/search?scope=p-llm-platform&q=k.kl&tab=connections&type=person&selection=${encodeURIComponent(`person:${TARA}`)}`;

const PANE_ROUTES: PaneRoute[] = [
  {
    name: 'initiative', user: 'u-nora', path: '/iq/projects/p-observability?scope=all',
    thread: (page) => page.getByTestId('page-conversation-pane').getByTestId('scope-discussion-panel'),
  },
  {
    name: 'work item', user: 'u-nora', path: '/iq/projects/p-observability?scope=all&tab=work&item=wi-obs-e1-b5',
    thread: (page) => page.getByTestId('page-conversation-pane').getByTestId('scope-discussion-panel'),
  },
  {
    name: 'search connections', user: 'u-theo', path: SEARCH, graph: true,
    openPane: async (page) => {
      await expect(page.getByTestId('search-person-card')).toContainText('Tara Wright', { timeout: 20_000 });
      await page.getByTestId('search-people-toolbar').getByRole('button', { name: /Ask about selection/ }).click();
    },
    thread: (page) => page.getByTestId('page-conversation-pane').getByTestId('search-pane-transcript'),
  },
  {
    name: 'assessment scorecard', user: 'u-asha', path: '/assessment/teams/TEAM-001',
    thread: (page) => page.getByTestId('page-conversation-pane').getByTestId('scope-discussion-panel'),
  },
  {
    name: 'search results', user: 'u-theo', path: `/iq/search?q=k.kl&tab=results&pane=chat&context=${encodeURIComponent(`person:${TARA}`)}`,
    thread: (page) => page.getByTestId('page-conversation-pane').getByTestId('search-pane-transcript'),
  },
];

for (const route of PANE_ROUTES) {
  test(`${route.name}: the composer in the content, the thread in the pane; drag wider (persisted), keyboard resize, fold to a strip`, async ({ browser }) => {
    test.setTimeout(150_000);
    const page = await open(browser, route.user);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(route.path);
    if (route.openPane) await route.openPane(page);
    const pane = page.getByTestId('page-conversation-pane');
    await expect(pane).toBeVisible({ timeout: 20_000 });
    await expect(route.thread(page)).toBeVisible({ timeout: 20_000 });
    const composer = await expectOneComposerInContent(page, route.name);
    await expect(pane.locator('[contenteditable="true"], textarea')).toHaveCount(0);

    // Drag the handle 200px to the left: the pane is ~200px wider (inside its 60% ceiling).
    const before = await paneBox(page);
    await drag(page, -200);
    await expect.poll(async () => Math.round((await paneBox(page)).width - before.width), { message: 'pane widened by the drag' }).toBeGreaterThanOrEqual(150);
    const after = await paneBox(page);
    console.log(JSON.stringify({ route: route.name, paneBefore: Math.round(before.width), paneAfter: Math.round(after.width), composer }));
    if (route.graph) {
      // The graph re-fits to the narrower canvas: every drawn person stays inside it.
      const outside = () => page.evaluate(() => {
        const canvas = document.querySelector('[data-testid="search-people-canvas-canvas"]')!.getBoundingClientRect();
        const nodes = [...document.querySelectorAll('[data-testid="search-org-graph"] [data-person-id]')].map((n) => n.getBoundingClientRect()).filter((r) => r.width > 0);
        return nodes.filter((r) => r.left < canvas.left - 1 || r.right > canvas.right + 1 || r.top < canvas.top - 1 || r.bottom > canvas.bottom + 1).length;
      });
      await expect.poll(outside, { message: 'graph inside its canvas after the resize', timeout: 5_000 }).toBe(0);
    }

    // Persisted per device across a reload.
    await page.reload();
    // The URL keeps the pane open (Search: `?pane=chat`), so a reload lands with it showing.
    await expect(pane).toBeVisible({ timeout: 20_000 });
    await expect.poll(async () => Math.abs(Math.round((await paneBox(page)).width - after.width)), { message: 'width survives a reload' }).toBeLessThanOrEqual(4);
    await expectOneComposerInContent(page, `${route.name} after reload`);

    // Keyboard: the focused handle resizes with the arrow keys, Enter folds the pane.
    const handle = page.getByTestId('shell-split-divider');
    await handle.focus();
    const k0 = (await paneBox(page)).width;
    await page.keyboard.press('ArrowRight');
    await expect.poll(async () => Math.round(k0 - (await paneBox(page)).width), { message: 'ArrowRight narrows the pane' }).toBeGreaterThan(0);
    await page.keyboard.press('Enter');
    await expect(pane).toHaveCount(0);
    const strip = page.getByTestId('page-conversation-pane-strip');
    await expect(strip).toBeVisible();
    expect(Math.round((await strip.boundingBox())!.width)).toBeLessThanOrEqual(45);
    const restore = strip.getByRole('button', { name: /^Restore/ });
    await expect(restore).toBeVisible();
    // The composer stays in the content column while the pane is folded.
    await expectOneComposerInContent(page, `${route.name} folded`);
    // Folded is remembered; Restore brings the pane back at its width.
    await page.reload();
    await expect(page.getByTestId('page-conversation-pane-strip')).toBeVisible({ timeout: 20_000 });
    await page.getByTestId('page-conversation-pane-strip').getByRole('button', { name: /^Restore/ }).click();
    await expect(pane).toBeVisible();
    // And the frame's Minimize folds it again.
    await pane.getByRole('button', { name: /^Minimize/ }).click();
    await expect(page.getByTestId('page-conversation-pane-strip')).toBeVisible();
    await page.getByTestId('page-conversation-pane-strip').getByRole('button', { name: /^Restore/ }).click();
    await expect(pane).toBeVisible();
    expect(errors).toEqual([]);
    await page.context().close();
  });
}

// Pages whose conversation already lives in the content column (no shell
// right pane, or a pane that holds a thread only): one composer, in the content.
const CONTENT_ROUTES: Array<{ name: string; user: string; path: string | ((page: Page) => Promise<string>) }> = [
  { name: 'communication channel', user: 'u-vera', path: '/iq/communication/channels/general' },
  { name: 'social channel', user: 'u-mira', path: '/social/channels/general' },
  { name: 'assessment document', user: 'u-farah', path: `/assessment/workspace?doc=${encodeURIComponent('page:100002')}` },
  {
    name: 'pipelines run', user: 'u-kofi', path: async (page) => {
      const res = await page.request.get('/api/pipelines/runs?limit=1');
      const json = res.ok() ? await res.json() as { runs?: Array<{ id: string }> } : {};
      return `/pipelines/runs/${encodeURIComponent(json.runs?.[0]?.id ?? 'run-missing')}`;
    },
  },
];

for (const route of CONTENT_ROUTES) {
  test(`${route.name}: one composer, in the content column, none in the right pane`, async ({ browser }) => {
    test.setTimeout(90_000);
    const page = await open(browser, route.user);
    await page.goto(typeof route.path === 'string' ? route.path : await route.path(page));
    const composer = await expectOneComposerInContent(page, route.name);
    console.log(JSON.stringify({ route: route.name, composer, pane: await page.getByTestId('page-conversation-pane').count() }));
    await page.context().close();
  });
}

test('social DMs: the rail’s New message actions and the landing’s action are on the rail/app scale (≤ 28px)', async ({ browser }) => {
  const page = await open(browser, 'u-mira');
  await page.goto('/social/dms');
  await expect(page.getByTestId('social-chat-rail')).toBeVisible({ timeout: 20_000 });
  for (const testId of ['social-new-dm', 'social-empty-new-dm']) {
    const el = page.getByTestId(testId);
    if (!(await el.count())) continue;
    const b = (await el.first().boundingBox())!;
    expect(b.height, `${testId} height`).toBeLessThanOrEqual(28);
  }
  const action = page.getByTestId('social-empty-new-dm');
  if (await action.count()) {
    const type = await action.evaluate((e) => `${getComputedStyle(e).fontSize}/${getComputedStyle(e).fontWeight}`);
    expect(['12px/600', '13px/600', '14px/600', '12px/500', '13px/500']).toContain(type);
    const title = page.getByTestId('social-empty-dms').getByRole('heading').first();
    if (await title.count()) expect(await title.evaluate((e) => getComputedStyle(e).fontSize)).toBe('14px');
  }
  await page.context().close();
});

// A live huddle with the page's pane open: the huddle chat stacks in the right
// pane (never beside the content composer), and the content composer keeps its
// full form — its To: select can switch between the huddle and the Discussion.
// Needs real (fake-device) media: REAL_MEDIA_ACCEPTANCE=1.
const MEDIA_ARGS = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
  '--autoplay-policy=no-user-gesture-required', '--disable-features=LocalNetworkAccessChecks'];

for (const route of [
  // A page huddle: each seat joins with the footer's Huddle.
  { name: 'assessment scorecard', users: ['u-asha', 'u-jonas'], tenant: 'assessment', path: '/assessment/teams/TEAM-001', ring: false,
    composer: (page: Page) => page.getByTestId('dimension-composer') },
  // An initiative huddle rings: the first seat calls, the second accepts.
  { name: 'initiative', users: ['u-vera', 'u-nora'], tenant: 'orgiq', path: '/iq/projects/p-observability?scope=all', ring: true,
    composer: (page: Page) => page.getByTestId('initiative-workspace').getByTestId('initiative-composer') },
]) {
  test(`${route.name} with a live huddle: the huddle chat is in the right pane, the content composer keeps its To: switch`, async ({ playwright }) => {
    test.skip(!process.env.REAL_MEDIA_ACCEPTANCE, 'needs REAL_MEDIA_ACCEPTANCE=1 (fake-device media)');
    test.setTimeout(180_000);
    const media = await playwright.chromium.launch({ channel: 'chrome', headless: true, args: MEDIA_ARGS });
    const pages: Page[] = [];
    try {
      // Two seats keep the huddle live (the scorecard composer and huddle grid specs' patterns).
      for (const [index, user] of route.users.entries()) {
        const context = await media.newContext({ baseURL: BASE(), viewport: { width: 1440, height: 900 }, permissions: ['camera', 'microphone'] });
        await loginAs(context, user, BASE(), true);
        if (route.tenant !== 'orgiq') expect((await context.request.post('/api/session/tenant', { data: { tenant: route.tenant } })).status()).toBe(200);
        const page = await context.newPage();
        await page.goto(route.path);
        await expect(page.getByTestId('page-conversation-pane')).toBeVisible({ timeout: 20_000 });
        const huddle = page.getByTestId('shell-footer-context').getByRole('button', { name: 'Huddle' });
        await expect(huddle).toBeEnabled({ timeout: 20_000 });
        pages.push(page);
        if (route.ring && index > 0) {
          await pages[0]!.getByTestId('shell-footer-context').getByRole('button', { name: 'Huddle' }).click();
          await page.getByRole('button', { name: 'Accept', exact: true }).click({ timeout: 30_000 });
        } else if (!route.ring) await huddle.click();
        if (route.ring && index === 0) continue;
        // Joined: the call bar's own Leave over the tiles, docked with the content composer.
        await expect(route.composer(page).getByTestId('call-dock-leave').or(page.getByTestId('call-dock-leave')).first()).toBeVisible({ timeout: 30_000 });
      }
      // Assert as the last seat (on the initiative, the owner who accepted — she may post to the Discussion).
      const page = pages[pages.length - 1]!;
      // The huddle chat: open it from the call bar if the page has not.
      const chat = page.getByTestId('shell-split-secondary').getByTestId('huddle-chat-panel');
      const dockChat = page.getByTestId(/call-dock-chat$/).first();
      if (!(await chat.isVisible().catch(() => false)) && await dockChat.isVisible({ timeout: 10_000 }).catch(() => false)) await dockChat.click();
      await expect(chat, 'the huddle chat stacks in the right pane').toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId('huddle-chat-inpage'), 'never beside the content composer').toHaveCount(0);
      await expectOneComposerInContent(page, `${route.name} in a huddle`);
      const composer = route.composer(page);
      // The full composer: Chat mode offers the To: select with the huddle and the Discussion.
      const recipient = composer.getByRole('combobox', { name: 'Chat recipient' });
      if (!(await recipient.isVisible().catch(() => false))) await chooseComposerMode(page, composer, 'Agent', 'Chat');
      await expect(recipient).toBeVisible({ timeout: 15_000 });
      const options = await recipient.locator('option').allTextContents();
      expect(options.some((o) => /discussion/i.test(o)), `To: offers the Discussion (${options.join(' | ')})`).toBe(true);
      expect(options.some((o) => /huddle/i.test(o)), `To: offers the huddle (${options.join(' | ')})`).toBe(true);
    } finally {
      for (const page of pages) {
        const leave = page.getByTestId(/^(shell-)?call-dock-leave$/).first();
        if (await leave.count().catch(() => 0)) await leave.click().catch(() => undefined);
        await page.context().close().catch(() => undefined);
      }
      await media.close();
    }
  });
}

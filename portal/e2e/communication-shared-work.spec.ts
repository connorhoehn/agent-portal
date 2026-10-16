import { test, expect, type Browser, type Page } from '@playwright/test';
import { openAs } from './realSession';
import { chooseOption } from './selectOption';

// Communication shaped by the user's org context, and the work people share
// (docs/communication-plane-goal.md §1–§4, judge item 4). Against the shared
// Tilt stack (PARITY_BASE_URL, default http://127.0.0.1:5183). No mock reset:
// the walk posts one DM page reference, one deck to #general and one sharing
// grant (which it stops again), and leaves the messages.
//
//   1. The rail (the user, 2026-10-07): one 16px inset for every section
//      heading and first row; the find field behind a search button (Escape
//      closes it); the shelf as one icon row; Teams and Rooms folded by
//      default; the folded primary rail's › on the chat header's row.
//   2. u-vera's org context: Active now carries the plane's per-viewer facts
//      (u-theo's activity), My initiatives shows Auth Migration bound to
//      #auth-migration, My org teams her team with its roster.
//   3. An unbound group (u-theo's Design System API) opens its page
//      discussion inside the plane.
//   4. Shared work: u-asha sees nothing of u-vera's work, u-vera shares a node
//      into #general from her own graph, u-asha then sees it, and after u-vera
//      stops sharing it is gone again.
//   5. The Shared work view lists a deck share and a page reference and opens
//      them in the far-right pane; the footer's Social lands on Communication.

const BASE = process.env.PARITY_BASE_URL ?? 'http://127.0.0.1:5183';
const GATEWAY = process.env.PARITY_GATEWAY_WS ?? 'ws://localhost:3001/ws';
test.use({ baseURL: BASE, viewport: { width: 1440, height: 900 } });
test.describe.configure({ mode: 'serial' });

type Person = { context: Awaited<ReturnType<Browser['newContext']>>; page: Page; errors: string[]; social: string[] };

async function person(browser: Browser, userId: string): Promise<Person> {
  const { context, page, errors, social } = await openAs(browser, userId, { baseURL: BASE, viewport: { width: 1440, height: 900 }, captureSocial: true });
  return { context, page, errors, social };
}

const rail = (page: Page) => page.getByTestId('social-chat-rail');
const ALLOWED_SOCIAL = /^\/api\/social\/(plane\/|embedded|dms|share-destinations|bindings)/;

/**
 * The left edge of what each section paints first — a heading's caret, a row's
 * glyph, avatar or tile, the shelf bar's first icon, an empty line's text —
 * relative to the rail. The user: "padding is off across all social panes".
 */
async function insets(page: Page): Promise<Record<string, number | null>> {
  return page.evaluate(() => {
    const root = document.querySelector('[data-testid="social-chat-rail"]')!;
    const L = root.getBoundingClientRect().left;
    const contentLeft = (el: Element | null): number | null => {
      if (!el) return null;
      const width = el.getBoundingClientRect().width;
      let best: number | null = null;
      const consider = (x: number) => { if (best === null || x < best) best = x; };
      for (const d of el.querySelectorAll('svg, img, span, p')) {
        const r = d.getBoundingClientRect();
        if (r.width && r.height && r.width < width - 24 && getComputedStyle(d).visibility !== 'hidden' && !d.closest('.sr-only')) consider(r.left);
      }
      const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        if (!n.textContent?.trim() || (n.parentElement && n.parentElement.closest('.sr-only'))) continue;
        const range = document.createRange(); range.selectNodeContents(n);
        const r = range.getBoundingClientRect(); if (r.width) consider(r.left);
      }
      return best === null ? null : Math.round(best - L);
    };
    const caret = (sel: string) => { const b = root.querySelector(sel); const svg = b?.querySelector('svg'); return svg ? Math.round(svg.getBoundingClientRect().left - L) : null; };
    const out: Record<string, number | null> = {
      'shelf icon': (() => { const svg = root.querySelector('[data-testid="social-chat-rail-shelf"] li button svg'); return svg ? Math.round(svg.getBoundingClientRect().left - L) : null; })(),
    };
    for (const h of root.querySelectorAll('[data-testid="rail-section-header-toggle"], [data-testid="social-team-tree-heading-toggle"], [data-testid="rooms-section-header-toggle"], [data-testid="conversation-section-toggle"]')) {
      const svg = h.querySelector('svg'); const name = (h.textContent ?? '').replace(/\d+/g, '').trim();
      if (svg && name) out[`heading ${name}`] = Math.round(svg.getBoundingClientRect().left - L);
    }
    // Active now is a grid of centred tiles: its first column's tile box is the row edge (its empty line, the text).
    const tile = root.querySelector('[data-testid="social-active-now"] [role="listitem"]');
    out['row Active now'] = tile ? Math.round(tile.getBoundingClientRect().left - L) : contentLeft(root.querySelector('[data-testid="social-active-now-empty"]'));
    out['row groups'] = contentLeft(root.querySelector('[data-testid="plane-groups"] [data-testid="conversation-row"], [data-testid="plane-groups"] [data-testid="conversation-empty"], [data-testid="plane-groups-note"]'));
    out['row org teams'] = contentLeft(root.querySelector('[data-testid="plane-org-teams"] [data-testid="conversation-row"], [data-testid="plane-org-teams"] [data-testid="conversation-empty"]'));
    out['row Rooms'] = contentLeft(root.querySelector('[data-testid="room-row"]'));
    out['row Direct messages'] = contentLeft(root.querySelector('[data-testid="social-chat-rail-list-dms"] [data-testid="conversation-row"]'));
    out['row Channels'] = contentLeft(root.querySelector('[data-testid="social-chat-rail-list-channels"] [data-testid="conversation-row"]'));
    void caret;
    return out;
  });
}

test('the rail: one inset, a search button, one shelf row, Teams and Rooms folded by default, the folded toggle on the header row', async ({ browser }) => {
  test.setTimeout(120_000);
  const vera = await person(browser, 'u-vera');
  const { page } = vera;
  // /iq/communication alone opens the user's default conversation (the landing, b5aa9239), a sub-route that shows one
  // section; the full rail is the home with a view named, here her initiative's group.
  await page.goto('/iq/communication?group=initiative%3Ap-auth-migration');
  await expect(rail(page)).toBeVisible({ timeout: 20_000 });
  await expect(rail(page).getByTestId('plane-groups-section')).toBeVisible({ timeout: 20_000 });

  // Defaults on a fresh device: Teams and Rooms folded, the rest open.
  const expanded = async (testId: string) => rail(page).getByTestId(testId).first().getAttribute('aria-expanded');
  expect(await expanded('social-team-tree-heading-toggle')).toBe('false');
  expect(await expanded('rooms-section-header-toggle')).toBe('false');
  // Active now is the rail's fixed first heading (not a fold: it draws no toggle); the org-context sections open.
  await expect(rail(page).getByTestId('rail-section-header').filter({ hasText: /^Active now/i })).toBeVisible();
  for (const label of ['My initiatives', 'My org teams']) {
    await expect(rail(page).getByRole('button', { name: new RegExp(`^${label}`) })).toHaveAttribute('aria-expanded', 'true');
  }

  // The shelf: one row of four destinations directly under the header.
  const header = await rail(page).getByTestId('social-chat-rail-header').boundingBox();
  const shelf = rail(page).getByTestId('social-chat-rail-shelf');
  await expect(shelf).toHaveAttribute('data-layout', 'bar');
  const tops = await shelf.locator('li button').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
  expect(tops).toHaveLength(4);
  expect(new Set(tops).size, 'all four on one row').toBe(1);
  expect(tops[0]! - (header!.y + header!.height)).toBeLessThanOrEqual(8);
  for (const name of ['Activity', 'Mentions', 'Calls', 'Recordings']) await expect(shelf.getByRole('button', { name: new RegExp(`^${name}`) })).toBeVisible();

  // Find a chat: a search button; the field only once toggled, focused; Escape closes it.
  await expect(page.getByTestId('social-rail-search')).toHaveCount(0);
  const toggle = rail(page).getByTestId('social-chat-rail-search-toggle');
  await toggle.click();
  const field = page.getByTestId('social-rail-search');
  await expect(field).toBeFocused();
  await page.keyboard.type('general');
  await expect(rail(page).getByTestId('social-chat-rail-list-channels').getByTestId('conversation-row')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('social-rail-search')).toHaveCount(0);
  await expect(toggle).toBeFocused();

  // One inset: open the folded sections, then every heading and first row starts at the same x.
  await rail(page).getByTestId('social-team-tree-heading-toggle').click();
  await rail(page).getByTestId('rooms-section-header-toggle').click();
  await expect(rail(page).getByTestId('room-row').first()).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(600); // the carets' open rotation settles (a rotating glyph's box is wider mid-turn)
  const measured = await insets(page);
  console.log('rail insets (px from the rail edge):', JSON.stringify(measured));
  const values = Object.entries(measured).filter((e): e is [string, number] => e[1] !== null);
  expect(values.length, JSON.stringify(measured)).toBeGreaterThanOrEqual(10);
  // Active now draws no caret now (a fixed heading), so the first fold's caret is the inset every other edge must match.
  const anchor = measured['heading My initiatives']!;
  for (const [what, x] of values) expect(Math.abs(x - anchor), `${what} at ${x}px vs ${anchor}px`).toBeLessThanOrEqual(1);

  // Arrange sections: the order is the reader's, on this device. The default is dms-first (Direct messages, Active now,
  // the org context, Teams, Rooms, Channels), so one step up puts Channels where Rooms was.
  const HEADS = '[data-testid="rail-section-header"], [data-testid="social-team-tree-heading-toggle"], [data-testid="rooms-section-header-toggle"], [data-testid="conversation-section-toggle"]';
  const sectionNames = () => rail(page).evaluate((r, sel) => [...r.querySelectorAll(sel)].map((h) => (h.textContent ?? '').replace(/\d+/g, '').trim()).filter((t, i, all) => t && all.indexOf(t) === i), HEADS);
  const before = await sectionNames();
  expect(before.indexOf('Direct messages'), `default order ${before}`).toBe(0);
  await rail(page).getByTestId('social-chat-rail-options').click();
  await page.getByTestId('social-chat-rail-arrange').click();
  await rail(page).getByTestId('social-chat-rail-arrange-channels-up').click();
  await page.getByTestId('social-chat-rail-options').click();
  await page.getByTestId('social-chat-rail-arrange').click();
  const after = await sectionNames();
  expect(after.indexOf('Channels'), `Channels moved up one place: ${before} -> ${after}`).toBe(before.indexOf('Channels') - 1);
  await page.getByTestId('social-chat-rail-options').click();
  await page.getByTestId('social-chat-rail-reset-layout').click();

  // A record selected (depth 3) folds the primary rail; its › sits on the chat header's row.
  await page.goto('/iq/communication/channels/general');
  await expect(page.locator('[data-shell-nav]')).toHaveAttribute('data-primary-rail', 'collapsed', { timeout: 15_000 });
  await expect(page.getByTestId('social-chat-panel')).toBeVisible({ timeout: 20_000 });
  const offset = async () => {
    const t = await page.getByTestId('shell-rail-toggle').boundingBox();
    const h = await rail(page).getByTestId('social-chat-rail-header').boundingBox();
    return t && h ? Math.abs((t.y + t.height / 2) - (h.y + h.height / 2)) : 99;
  };
  await expect.poll(offset, { message: 'folded toggle centre vs chat header centre', timeout: 5_000 }).toBeLessThanOrEqual(1);
  console.log('folded toggle offset from the chat header row:', await offset(), 'px (was 8px before)');

  expect(vera.social.filter((p) => !ALLOWED_SOCIAL.test(p))).toEqual([]);
  expect(vera.errors, 'page errors').toEqual([]);
  await vera.context.close();
});

test('u-vera’s org context: Active now with the plane’s facts, My initiatives bound to #auth-migration, My org teams with her team', async ({ browser }) => {
  test.setTimeout(150_000);
  // Presence: u-mira in Social, u-theo in orgiq — both hold a Social grant, so the shell announces them on social:lobby.
  const mira = await person(browser, 'u-mira');
  await mira.page.goto('/social/channels');
  const theo = await person(browser, 'u-theo');
  await theo.page.goto('/iq/projects');
  const vera = await person(browser, 'u-vera');
  const { page } = vera;
  await page.goto('/iq/communication');
  const grid = rail(page).getByTestId('social-active-now');
  await expect(grid.getByTestId('social-active-now-person-u-mira')).toBeVisible({ timeout: 30_000 });
  await expect(grid.getByTestId('social-active-now-person-u-theo')).toBeVisible();
  // The plane's per-viewer activity (GET /api/social/plane/active): u-theo's latest readable work-graph node.
  const active = await page.evaluate(async () => (await fetch('/api/social/plane/active?users=u-theo,u-mira', { credentials: 'include' })).json());
  const theoActivity = (active.people as Array<{ userId: string; activity: string | null }>).find((p) => p.userId === 'u-theo')?.activity;
  if (theoActivity) await expect(grid.getByTestId('social-active-now-person-u-theo')).toHaveAttribute('aria-label', new RegExp(theoActivity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  // A live call is known only to a viewer in it (platform-api's per-person log): no "in a call" is claimed otherwise.
  if (!(active.people as Array<{ inCall: unknown }>).some((p) => p.inCall)) await expect(grid.getByTestId('social-active-now-person-u-mira')).not.toHaveAttribute('aria-label', /in a call/);

  // My initiatives: Auth Migration, bound to #auth-migration; the row opens the channel's conversation.
  const groups = rail(page).getByTestId('plane-groups');
  const auth = groups.getByTestId('conversation-row').filter({ hasText: 'Auth Migration' });
  await expect(auth).toContainText('#auth-migration', { timeout: 20_000 });
  await auth.click();
  await expect(page).toHaveURL(/\/iq\/communication\/channels\/auth-migration$/);

  // My org teams: her org-graph team; the row opens the team view with the roster and presence.
  const mine = await page.evaluate(async () => (await fetch('/api/me/groups?kind=org-team', { credentials: 'include' })).json());
  const teamName = (mine.items as Array<{ name: string }>)[0]?.name ?? '';
  expect(teamName, 'u-vera’s linked person is on an org team').not.toBe('');
  const team = rail(page).getByTestId('plane-org-teams').getByTestId('conversation-row').filter({ hasText: teamName });
  await expect(team).toBeVisible({ timeout: 20_000 });
  await team.click();
  await expect(page).toHaveURL(/\/iq\/communication\?orgTeam=/);
  const pane = page.getByTestId('plane-org-team-pane');
  await expect(pane).toContainText(teamName);
  await expect(pane.getByTestId('plane-org-team-members').locator('[role="listitem"]').first()).toBeVisible();

  expect(vera.social.filter((p) => !ALLOWED_SOCIAL.test(p))).toEqual([]);
  for (const p of [vera, theo, mira]) { expect(p.errors, 'page errors').toEqual([]); await p.context.close(); }
});

test('an unbound group opens its page discussion inside the plane', async ({ browser }) => {
  test.setTimeout(90_000);
  const theo = await person(browser, 'u-theo');
  const { page } = theo;
  await page.goto('/iq/communication');
  const row = rail(page).getByTestId('plane-groups').getByTestId('conversation-row').first();
  await expect(row).toContainText('no Social channel', { timeout: 20_000 });
  await row.click();
  await expect(page).toHaveURL(/\/iq\/communication\?group=initiative%3A/);
  const pane = page.getByTestId('plane-group-pane');
  await expect(pane.getByTestId('scope-discussion-panel')).toBeVisible({ timeout: 20_000 });
  await expect(pane.getByTestId('plane-group-open-page')).toBeVisible();
  // A participant without ManageChannels gets no binding strip at all (PlaneGroupPane draws it only for a bound channel or a
  // moderator who can bind one); the pane names where the discussion lives instead.
  await expect(pane.getByTestId('plane-group-binding')).toHaveCount(0);
  await expect(pane.getByTestId('plane-group-destination')).toBeVisible();
  expect(theo.social.filter((p) => !ALLOWED_SOCIAL.test(p))).toEqual([]);
  expect(theo.errors, 'page errors').toEqual([]);
  await theo.context.close();
});

test('shared work: empty for an outsider, populated after u-vera shares a node into #general, gone after she stops', async ({ browser }) => {
  test.setTimeout(180_000);
  const asha = await person(browser, 'u-asha');
  await asha.page.goto('/assessment/communication?person=u-vera');
  const ashaView = asha.page.getByTestId('plane-person-shared-work');
  await expect(ashaView).toHaveAttribute('data-viewer', 'none', { timeout: 20_000 });
  await expect(ashaView.getByTestId('plane-person-items')).toHaveCount(0);

  const vera = await person(browser, 'u-vera');
  const { page } = vera;
  await page.goto('/iq/communication');
  await page.getByTestId('communication-my-work').click();
  const mine = page.getByTestId('plane-person-shared-work');
  await expect(mine).toHaveAttribute('data-viewer', 'owner', { timeout: 20_000 });
  const item = mine.getByTestId('plane-person-items').locator('a, button').first();
  await expect(item).toBeVisible({ timeout: 20_000 });
  const itemTitle = (await item.textContent())?.trim() ?? '';
  await item.click();
  // The share form opens in the far-right pane.
  const paneHost = page.getByTestId('page-conversation-pane');
  await expect(paneHost.getByTestId('plane-share-form')).toBeVisible({ timeout: 10_000 });
  await chooseOption(paneHost.getByTestId('plane-share-target'), 'social:ch:general');
  await paneHost.getByTestId('plane-share-submit').click();
  await expect(paneHost.getByText('Shared.')).toBeVisible({ timeout: 10_000 });

  await asha.page.reload();
  await expect(ashaView).toHaveAttribute('data-viewer', 'audience', { timeout: 20_000 });
  await expect(ashaView.getByTestId('plane-person-items')).toBeVisible({ timeout: 20_000 });
  // D2: the shared-items list takes a MOUSE click (not only Enter). A one-node share draws the library's plain
  // canvas, which sizes itself; it must sit above the rows, never over them, so the first row opens the pane.
  const ashaRow = ashaView.getByTestId('plane-person-items').locator('a, button').first();
  await expect(ashaRow).toBeVisible();
  await ashaRow.scrollIntoViewIfNeeded();
  const rowBox = (await ashaRow.boundingBox())!;
  const hit = await asha.page.evaluate(([x, y]) => {
    const el = document.elementFromPoint(x, y);
    return { row: !!el?.closest('[data-testid="plane-person-items"]'), tag: el?.tagName ?? null, cls: (el?.className ?? '').toString().slice(0, 40) };
  }, [rowBox.x + 40, rowBox.y + rowBox.height / 2] as [number, number]);
  expect(hit.row, `the element under the first row's point is the row, got ${hit.tag} ${hit.cls}`).toBe(true);
  await asha.page.mouse.click(rowBox.x + 40, rowBox.y + rowBox.height / 2);
  // The row's text concatenates title, kind and the action label; the title's first word is what the pane repeats.
  await expect(asha.page.getByTestId('page-conversation-pane')).toContainText(itemTitle.split(/\s+/)[0]!, { timeout: 10_000 });

  // Stop: the grant to #general goes, and so does what it shared.
  const grants = mine.getByTestId('plane-sharing-grant-list');
  const general = grants.locator('a, button').filter({ hasText: '#general' }).first();
  await expect(general).toBeVisible({ timeout: 20_000 });
  await general.click();
  await expect(grants.locator('a, button').filter({ hasText: '#general' })).toHaveCount(0, { timeout: 20_000 });
  await asha.page.reload();
  await expect(ashaView).toHaveAttribute('data-viewer', 'none', { timeout: 20_000 });
  console.log('shared and stopped:', itemTitle);

  for (const p of [vera, asha]) { expect(p.social.filter((x) => !ALLOWED_SOCIAL.test(x))).toEqual([]); expect(p.errors, 'page errors').toEqual([]); await p.context.close(); }
});

test('a seeded audience member reads the person view (D1), and an unknown id is a not-found state (D4)', async ({ browser }) => {
  test.setTimeout(120_000);
  // u-vera's seeded grants reach u-theo through #auth-migration; the reply is a filtered graph whose efforts name only
  // the edges it carries, keyed on the request's subject — the library reader accepts it and the canvas draws.
  const theo = await person(browser, 'u-theo');
  await theo.page.goto('/iq/communication?person=u-vera');
  const view = theo.page.getByTestId('plane-person-shared-work');
  await expect(view).toHaveAttribute('data-viewer', 'audience', { timeout: 20_000 });
  await expect(view.getByTestId('plane-person-items').locator('a, button').first()).toBeVisible({ timeout: 20_000 });
  await expect(theo.page.getByTestId('work-graph-error')).toHaveCount(0);
  await expect(theo.page.getByText('The activity graph could not load.')).toHaveCount(0);
  // The rows take a mouse click here too (the activity layout).
  const row = view.getByTestId('plane-person-items').locator('a, button').first();
  await row.scrollIntoViewIfNeeded();
  const box = (await row.boundingBox())!;
  await theo.page.mouse.click(box.x + 40, box.y + box.height / 2);
  await expect(theo.page.getByTestId('page-conversation-pane')).toBeVisible({ timeout: 10_000 });
  // D4: an id the directory does not know is a not-found state, not a view titled with the raw id.
  await theo.page.goto('/iq/communication?person=u-nobody-here');
  await expect(theo.page.getByTestId('plane-person-missing')).toBeVisible({ timeout: 20_000 });
  await expect(theo.page.getByText('u-nobody-here')).toHaveCount(0);
  expect(theo.social.filter((x) => !ALLOWED_SOCIAL.test(x))).toEqual([]);
  expect(theo.errors, 'page errors').toEqual([]);
  await theo.context.close();
});

/** One line into `channel` on the gateway, as the composer sends it; true once the gateway confirmed it. */
async function postLine(page: Page, channel: string, message: string, displayName: string): Promise<boolean> {
  return page.evaluate(async ({ gateway, channel, message, displayName }) => {
    const { token } = await (await fetch('/api/session/realtime-token', { credentials: 'include' })).json();
    const ws = new WebSocket(gateway, ['bearer-token-v1', token]);
    const frames: Array<Record<string, unknown>> = [];
    ws.onmessage = (e) => frames.push(JSON.parse(String(e.data)));
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    ws.send(JSON.stringify({ service: 'chat', action: 'join', channel }));
    const until = async (ok: () => boolean) => { for (let i = 0; i < 50 && !ok(); i++) await new Promise((r) => setTimeout(r, 100)); return ok(); };
    await until(() => frames.some((f) => f['type'] === 'chat' && f['action'] === 'joined'));
    ws.send(JSON.stringify({ service: 'chat', action: 'send', channel, message, metadata: { displayName, clientDeliveryId: crypto.randomUUID() } }));
    const ok = await until(() => frames.some((f) => f['type'] === 'chat' && f['action'] === 'sent'));
    ws.close();
    return ok;
  }, { gateway: GATEWAY, channel, message, displayName });
}

test('the rail row of the OPEN conversation follows its latest line (D3)', async ({ browser }) => {
  test.setTimeout(120_000);
  const vera = await person(browser, 'u-vera');
  await vera.page.goto('/iq/communication/channels/general');
  const row = rail(vera.page).locator('[data-testid="conversation-row"][data-channel="social:ch:general"]');
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(vera.page.getByTestId('social-conversation-surface').or(vera.page.getByRole('textbox').first())).toBeVisible({ timeout: 20_000 });
  const line = `Rail preview ${Date.now()}`;
  const mira = await person(browser, 'u-mira');
  await mira.page.goto('/social/channels');
  expect(await postLine(mira.page, 'social:ch:general', line, 'Mira Okafor'), 'the gateway confirmed the line').toBe(true);
  // The open panel shows it, and so does its own rail row: the row's preview is the server's, refetched when the
  // open conversation reports a new latest line (the inbox feed carries nothing for a channel its reader is viewing).
  await expect(vera.page.getByText(line).first()).toBeVisible({ timeout: 15_000 });
  await expect(row).toContainText(line.slice(0, 20), { timeout: 15_000 });
  for (const p of [vera, mira]) { expect(p.errors, 'page errors').toEqual([]); await p.context.close(); }
});

test('the Shared work view lists a deck share and a page reference and opens each in the right pane; footer Social lands on Communication', async ({ browser }) => {
  test.setTimeout(240_000);
  // A deck shared into #general (u-mira, in Social: /deck, then Post to conversation).
  const mira = await person(browser, 'u-mira');
  await mira.page.goto('/social/channels/general');
  const input = mira.page.getByTestId('social-chat-composer-input');
  await expect(input).toBeEditable({ timeout: 30_000 });
  const deckTitle = `Shared work walk ${Date.now().toString(36)}`;
  await input.click(); await mira.page.keyboard.type(`/deck ${deckTitle}`); await mira.page.keyboard.press('Enter');
  const card = mira.page.getByTestId('social-deck-card');
  await expect(card.getByTestId('social-deck-post')).toBeVisible({ timeout: 60_000 });
  await card.getByTestId('social-deck-post').click();
  await expect(card.getByTestId('social-deck-posted')).toBeVisible({ timeout: 30_000 });

  const vera = await person(browser, 'u-vera');
  const { page } = vera;
  await page.goto('/iq/communication/channels/general?view=shared');
  const view = page.getByTestId('social-shared-work');
  await expect(view).toBeVisible({ timeout: 20_000 });
  const deckRow = view.getByTestId('social-shared-items').locator('a, button').filter({ hasText: 'Deck' }).first();
  await expect(deckRow).toBeVisible({ timeout: 20_000 });
  await deckRow.click();
  const paneHost = page.getByTestId('page-conversation-pane');
  await expect(paneHost.getByTestId('plane-shared-detail')).toHaveAttribute('data-kind', 'deck', { timeout: 10_000 });

  // A page reference in u-vera's DM, posted on the gateway exactly as the composer sends one (kind + id only).
  const dm = 'social:dm:u-farah:u-vera';
  const sent = await page.evaluate(async ({ gateway, channel }) => {
    const { token } = await (await fetch('/api/session/realtime-token', { credentials: 'include' })).json();
    const ws = new WebSocket(gateway, ['bearer-token-v1', token]);
    const frames: Array<Record<string, unknown>> = [];
    ws.onmessage = (e) => frames.push(JSON.parse(String(e.data)));
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    ws.send(JSON.stringify({ service: 'chat', action: 'join', channel }));
    const until = async (ok: () => boolean) => { for (let i = 0; i < 50 && !ok(); i++) await new Promise((r) => setTimeout(r, 100)); return ok(); };
    await until(() => frames.some((f) => f['type'] === 'chat' && f['action'] === 'joined'));
    ws.send(JSON.stringify({ service: 'chat', action: 'send', channel, message: `Shared work page ${Date.now()}`,
      metadata: { displayName: 'Vera Green', clientDeliveryId: crypto.randomUUID(), pageReference: { kind: 'initiative', id: 'p-auth-migration' } } }));
    const ok = await until(() => frames.some((f) => f['type'] === 'chat' && f['action'] === 'sent'));
    ws.close();
    return ok;
  }, { gateway: GATEWAY, channel: dm });
  expect(sent, 'the gateway confirmed the page reference').toBe(true);
  await page.goto(`/iq/communication/dms/${encodeURIComponent(dm)}?view=shared`);
  const pageRow = page.getByTestId('social-shared-items').locator('a, button').filter({ hasText: 'Auth Migration' }).first();
  await expect(pageRow).toBeVisible({ timeout: 20_000 });
  await pageRow.click();
  await expect(paneHost.getByTestId('plane-shared-detail')).toHaveAttribute('data-kind', 'page', { timeout: 10_000 });
  await expect(paneHost.getByTestId('plane-detail-open-page')).toBeVisible();

  // The footer's Social, from another orgiq page, lands on this tenant's Communication (the footer lane's rule).
  await page.goto('/iq/projects');
  await page.getByTestId('shell-social-open').click();
  await expect(page).toHaveURL(/\/iq\/communication/, { timeout: 10_000 });

  expect(vera.social.filter((p) => !ALLOWED_SOCIAL.test(p))).toEqual([]);
  for (const p of [vera, mira]) { expect(p.errors, 'page errors').toEqual([]); await p.context.close(); }
});

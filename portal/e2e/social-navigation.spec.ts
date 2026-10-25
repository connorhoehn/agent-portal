import { expect, test, type Locator, type Page } from '@playwright/test';
import { ROUTE_RAIL_CAPTION, SOCIAL_SECTION_CAPTIONS, type SocialChatRouteId } from '../src/pages/social/socialChat';
test.use({ baseURL: 'http://127.0.0.1:5183', viewport: { width: 1440, height: 900 } });
async function fixture(page: Page, opts: { failedLists?: boolean; savedLayout?: boolean; path?: string; emptyRooms?: boolean; mayCreateRooms?: boolean } = {}) {
  const errors: string[] = [], mutations: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  if (opts.savedLayout) await page.addInitScript(() => {
    localStorage.setItem('social.chatRail.folded', JSON.stringify({ 'Active now': true, Rooms: true }));
    localStorage.setItem('social.chatRail.layout', JSON.stringify(['rooms', 'channels', 'active-now', 'teams', 'dms']));
  });
  const dm = { channel: 'social:dm:fixture-peer:fixture-reader', peers: [{ userId: 'fixture-peer', displayName: 'Fixture Peer' }], lastMessageAt: '2026-10-10T18:00:00Z', lastMessagePreview: 'Inert direct-message preview', lastMessageUserId: 'fixture-peer', unreadCount: 1 };
  await page.route('**/api/**', route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() !== 'GET') mutations.push(path);
    const json = (body: unknown) => route.fulfill({ json: body });
    if (path === '/api/session/me') return json({ sub: 'fixture-reader', name: 'Fixture Reader', tenant: 'social', role: 'participant', grants: { social: ['participant'] }, switchable: { social: ['participant'] }, availableRoles: ['participant'], masquerading: null });
    if (path === '/api/auth/config') return json({ ssoEnabled: false });
    if (path === '/api/session/capabilities') return json({ tenant: 'social', role: 'participant', degraded: false, actions: { ViewSocial: true, PostMessage: false, StartCall: false, ManageChannels: !!opts.mayCreateRooms } });
    if (path === '/api/health') return json({ status: 'unavailable', service: 'inert fixture', mocks: {}, region: 'none' });
    if (path === '/api/social/dms') return json({ conversations: [dm] });
    if (path === '/api/social/people') return json({ people: [{ userId: 'fixture-peer', displayName: 'Fixture Peer', roles: ['participant'] }] });
    if (opts.failedLists && ['/api/social/channels', '/api/social/teams', '/api/social/rooms'].includes(path)) return route.fulfill({ status: 503, json: { error: 'Inert unrelated read failure' } });
    if (path === '/api/social/channels') return json({ channels: [{ slug: 'general', channel: 'social:ch:general', name: 'General', joined: true, memberCount: 3, role: 'member', privacy: 'public', createdBy: 'fixture-reader', createdAt: '2026-10-10T12:00:00Z', description: null, lastMessagePreview: null, lastMessageAt: null }] });
    if (path === '/api/social/teams') return json({ teams: [{ teamId: 'fixture-team', slug: 'team', name: 'Fixture Team', role: 'member', favorite: false, visibility: 'org', createdBy: 'fixture-reader', channels: [] }] });
    if (path === '/api/social/rooms') return json({ source: 'mock', rooms: opts.emptyRooms ? [] : [{ orgId: 'social', roomId: 'fixture-room', slug: 'lounge', name: 'Fixture Lounge', visibility: 'org', createdBy: 'fixture-reader', createdAt: '2026-10-10T12:00:00Z', state: 'active', lobbyName: 'social:room:lounge', settings: { audioOnly: false, recordingEnabled: false, softCap: 8 }, lastActiveAt: '2026-10-10T12:00:00Z' }], counts: { total: opts.emptyRooms ? 0 : 1, open: opts.emptyRooms ? 0 : 1, private: 0 } });
    if (path === '/api/social/rooms/lounge') return json({ room: { orgId: 'social', roomId: 'fixture-room', slug: 'lounge', name: 'Fixture Lounge', visibility: 'org', createdBy: 'fixture-reader', createdAt: '2026-10-10T12:00:00Z', state: 'active', lobbyName: 'social:room:lounge', settings: { audioOnly: false, recordingEnabled: false, softCap: 8 }, lastActiveAt: '2026-10-10T12:00:00Z' } });
    if (path === '/api/social/rooms/lounge/activity') return json({ sessions: [] });
    if (path === '/api/social/calls') return json({ calls: [], counts: { total: 0, missed: 0 } });
    if (path === '/api/social/recordings') return json({ source: 'mock', recordings: [], counts: { total: 0, ready: 0 } });
    return route.fulfill({ status: 503, json: { error: 'Unmocked social navigation API refused' } });
  });
  await page.route(url => url.pathname.startsWith('/social/'), route => {
    if (!route.request().isNavigationRequest()) return route.continue();
    return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script><script type="module" src="/e2e/fixtures/social-navigation.tsx"></script></body></html>' });
  });
  const path = opts.path ?? '/social/dms';
  await page.goto(path);
  // The DM row only exists on the DM route now (one section per route); elsewhere the rail itself is the ready signal.
  if (path.startsWith('/social/dms')) await expect(page.getByTestId('social-chat-rail')).toContainText('Fixture Peer');
  else await expect(page.getByTestId('social-chat-rail')).toBeVisible().catch((e) => { throw new Error(`${e}\npage errors: ${errors.join(' | ')}`); });
  return { errors, mutations };
}
test('DM route stays DM-only with DMs first and permanent Active now despite stored order/folds', async ({ page }) => {
  const setup = await fixture(page, { savedLayout: true, failedLists: true }), rail = page.getByTestId('social-chat-rail');
  await expect(rail.locator('[data-rail-section]')).toHaveCount(1);
  await expect(rail.locator('[data-rail-section="active-now"]')).toBeVisible();
  const dms = (await rail.getByTestId('social-chat-rail-list-dms').boundingBox())!, active = (await rail.locator('[data-rail-section="active-now"]').boundingBox())!;
  expect(dms.y + dms.height).toBeLessThanOrEqual(active.y);
  await expect(rail.getByRole('button', { name: /^Active now/ })).toHaveCount(0); await expect(rail.getByText('Live presence is unavailable.')).toBeVisible();
  await expect(rail.getByText('Teams', { exact: true })).toHaveCount(0); await expect(rail.getByText('Rooms', { exact: true })).toHaveCount(0); await expect(rail.getByText('Channels', { exact: true })).toHaveCount(0);
  await expect(rail.getByTestId('social-channels-read-status')).toHaveCount(0); await expect(rail.getByTestId('social-teams-read-status')).toHaveCount(0); await expect(rail.getByTestId('social-rooms-read-status')).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('social-dms-only.png') }); expect(setup.errors).toEqual([]); expect(setup.mutations).toEqual([]);
});
// One section per route (the user, 2026-10-13; docs/rail-parity-goal.md decision 6): every Social conversation
// route draws the shelf, Active now and ONLY its own section caption. Calls and Recordings own no section.
/** The rail's section captions as drawn (a heading whose whole text is the caption, an optional count after it). */
async function railCaptions(rail: Locator): Promise<string[]> {
  return rail.evaluate((el, captions) => {
    const heads = [...el.querySelectorAll('h2, h3, [role="heading"], button, span')].map((e) => (e.textContent ?? '').trim().toLowerCase());
    return captions.filter((c) => heads.some((h) => new RegExp(`^${c.toLowerCase()}\\s*\\d*$`).test(h)));
  }, [...SOCIAL_SECTION_CAPTIONS]);
}
const ROUTES: SocialChatRouteId[] = ['channels', 'dms', 'teams', 'rooms', 'calls', 'recordings'];
for (const route of ROUTES) {
  test(`/social/${route} rail shows only its own section (${ROUTE_RAIL_CAPTION[route] ?? 'none — a shelf destination'})`, async ({ page }) => {
    // A stored order and folds must not bring another section back.
    const setup = await fixture(page, { path: `/social/${route}`, savedLayout: true }), rail = page.getByTestId('social-chat-rail');
    const own = ROUTE_RAIL_CAPTION[route];
    if (own) await expect.poll(() => railCaptions(rail), { timeout: 10_000 }).toEqual([own]);
    else await expect.poll(() => railCaptions(rail), { timeout: 10_000 }).toEqual([]);
    // The hangout directory has a focused list; conversation tools remain on conversation routes.
    if (route === 'rooms') {
      await expect(rail.locator('[data-rail-section="active-now"]')).toHaveCount(0);
      await expect(rail.getByTestId('social-chat-rail-shelf')).toHaveCount(0);
      await expect(rail.getByTestId('social-browse-rooms')).toHaveCount(0);
    } else {
      await expect(rail.locator('[data-rail-section="active-now"]')).toBeVisible();
      for (const name of ['Activity', 'Mentions', 'Calls', 'Recordings']) await expect(rail.getByTestId('social-chat-rail-shelf').getByRole('button', { name: new RegExp(`^${name}`) })).toBeVisible();
    }
    // The only host section drawn is presence, plus the route's own Teams/Rooms section.
    const hostSections = await rail.locator('[data-rail-section]').evaluateAll((els) => els.map((e) => e.getAttribute('data-rail-section')));
    expect(hostSections.sort()).toEqual([...(route === 'rooms' ? [] : ['active-now']), ...(route === 'teams' || route === 'rooms' ? [route] : [])].sort());
    // Rows: DM rows only on DMs, channel rows only on Channels, a room only on Rooms, a team only on Teams.
    await expect(rail.getByText('Fixture Peer', { exact: true })).toHaveCount(route === 'dms' ? 1 : 0);
    await expect(rail.getByTestId('social-chat-rail-list-channels')).toHaveCount(route === 'channels' ? 1 : 0);
    await expect(rail.getByTestId('social-chat-rail-list-dms')).toHaveCount(route === 'dms' ? 1 : 0);
    await expect(rail.getByTestId('social-rooms-list')).toHaveCount(route === 'rooms' ? 1 : 0);
    await expect(rail.getByTestId('social-team-tree')).toHaveCount(route === 'teams' ? 1 : 0);
    // A one-section view has nothing to arrange.
    await expect(rail.getByTestId('social-chat-rail-options')).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath(`social-${route}-one-section.png`) });
    expect(setup.errors).toEqual([]); expect(setup.mutations).toEqual([]);
  });
}
test('Rooms route opens its own section expanded; the primary nav moves between one-section routes', async ({ page }) => {
  const setup = await fixture(page, { path: '/social/rooms' }), rail = page.getByTestId('social-chat-rail'), rooms = rail.getByTestId('social-rooms-list');
  await expect(rooms.getByRole('button', { name: /^Hangouts/ })).toHaveAttribute('aria-expanded', 'true');
  await expect(rooms.getByText('Fixture Lounge', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Channels', exact: true }).first().click();
  await expect.poll(() => railCaptions(rail), { timeout: 10_000 }).toEqual(['Channels']);
  await expect(rail.getByTestId('social-rooms-list')).toHaveCount(0);
  expect(setup.errors).toEqual([]); expect(setup.mutations).toEqual([]);
});
test('room directory opens a real workspace record and returns without starting a call', async ({ page }) => {
  const setup = await fixture(page, { path: '/social/channels' });
  await page.getByTestId('social-browse-rooms').click();
  await expect(page).toHaveURL(/\/social\/rooms$/);
  const directory = page.getByTestId('social-room-directory');
  await expect(directory).toBeVisible();
  await directory.getByRole('textbox', { name: 'Find a hangout', exact: true }).fill('not-a-room');
  await expect(page.getByTestId('social-room-search-empty')).toBeVisible();
  await directory.getByRole('button', { name: 'Clear filters' }).click();
  const command = directory.getByRole('textbox', { name: 'Hangouts command', exact: true });
  await command.fill('Show private rooms'); await command.press('Enter');
  await expect(page.getByTestId('social-room-search-empty')).toBeVisible();
  await command.fill('Show all rooms'); await command.press('Enter');
  await directory.getByRole('button', { name: 'Open Fixture Lounge', exact: true }).click();
  await expect(page).toHaveURL(/room=lounge/);
  await expect(page.getByTestId('social-room-detail')).toContainText('Fixture Lounge');
  await expect(page.getByTestId('social-room-join')).toBeDisabled();
  await expect(page.getByTestId('social-room-facts')).not.toContainText('social:room:');
  await page.getByTestId('social-room-back').click();
  await expect(directory).toBeVisible();
  expect(setup.errors).toEqual([]); expect(setup.mutations).toEqual([]);
});
test('a participant sees an honest empty room directory without unusable create controls', async ({ page }) => {
  const setup = await fixture(page, { path: '/social/rooms', emptyRooms: true });
  await expect(page.getByTestId('social-rooms-empty')).toContainText('A moderator or community admin');
  await expect(page.getByText('Pick a room', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^(New hangout|Create hangout)$/ })).toHaveCount(0);
  expect(setup.errors).toEqual([]); expect(setup.mutations).toEqual([]);
});
test('a room manager reaches the existing create dialog from the directory', async ({ page }) => {
  const setup = await fixture(page, { path: '/social/rooms', emptyRooms: true, mayCreateRooms: true });
  await page.getByTestId('social-directory-new-room').click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('dialog')).toContainText('New hangout');
  await page.keyboard.press('Escape');
  expect(setup.errors).toEqual([]); expect(setup.mutations).toEqual([]);
});
test('native primary nav activity follows actual inbox frames and read receipts without fabricated status', async ({ page }) => {
  const setup = await fixture(page), nav = page.locator('[data-shell-nav] nav').first();
  await expect(nav.getByRole('img', { name: /unread notice/ })).toHaveCount(0);
  await page.evaluate(() => (window as unknown as { socialNavigationFixture: { receive(frame: unknown): void } }).socialNavigationFixture.receive({ type: 'notification:bulk-update', service: 'notification', payload: { notifications: [
    { id: 'inert-dm', type: 'reply', title: 'Inert DM notice', timestamp: '2026-10-10T18:00:00Z', read: false, channel: 'social:dm:fixture-peer:fixture-reader', payload: { tenant: 'social' } },
    { id: 'inert-channel', type: 'mention', title: 'Inert channel notice', timestamp: '2026-10-10T18:00:00Z', read: false, channel: 'social:ch:general', payload: { tenant: 'social' } },
    { id: 'foreign', type: 'mention', title: 'Foreign tenant notice', timestamp: '2026-10-10T18:00:00Z', read: false, channel: 'social:ch:general', payload: { tenant: 'assessment' } },
  ] } }));
  await expect(nav.getByRole('img', { name: '1 unread notice in this inbox' })).toHaveCount(2);
  await page.evaluate(() => (window as unknown as { socialNavigationFixture: { receive(frame: unknown): void } }).socialNavigationFixture.receive({ type: 'notification:read', service: 'notification', payload: { id: 'inert-dm' } }));
  await expect(nav.getByRole('img', { name: '1 unread notice in this inbox' })).toHaveCount(1);
  await page.getByTestId('social-chat-rail').getByRole('button', { name: /^Activity/ }).click(); await expect(page.getByTestId('social-activity-pane')).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('social-native-activity.png') }); expect(setup.errors).toEqual([]); expect(setup.mutations).toEqual([]);
});

test('conversation header is compact and composer sky reaches parent edges in standalone and embedded hosts', async ({ page }) => {
  const setup = await fixture(page, { path: '/social/dms/social%3Adm%3Afixture-peer%3Afixture-reader' });
  const verifyGutters = async (host: string) => {
    const pane = page.getByTestId('social-chat-pane'), header = page.getByTestId('social-chat-panel-header');
    const backdrop = pane.locator('[data-composer-surface]'), input = page.getByTestId('social-chat-composer');
    await expect(header).toBeVisible(); await expect(backdrop).toBeVisible();
    await expect(header.getByRole('tab', { name: /^Calls/ })).toBeVisible();
    const metrics = await pane.evaluate(element => {
      const header = element.querySelector<HTMLElement>('[data-testid="social-chat-panel-header"]')!;
      const backdrop = element.querySelector<HTMLElement>('[data-composer-surface]')!;
      const input = element.querySelector<HTMLElement>('[data-testid="social-chat-composer"]')!;
      const box = (node: HTMLElement) => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width }; };
      const style = getComputedStyle(header), tabs = header.querySelector<HTMLElement>('[role="tab"]')!;
      return { pane: box(element as HTMLElement), header: box(header), backdrop: box(backdrop), input: box(input),
        left: parseFloat(style.paddingLeft), top: parseFloat(style.paddingTop), tabSize: getComputedStyle(tabs).fontSize,
        background: getComputedStyle(backdrop, '::before').backgroundImage, overflow: document.documentElement.scrollWidth > innerWidth };
    });
    const gutter = host === 'embedded' ? 24 : 16; // SectionContent's page gutter versus the standalone conversation gutter.
    expect(metrics.left).toBe(gutter); expect(metrics.top).toBe(8); expect(metrics.header.y - metrics.pane.y).toBeLessThanOrEqual(1);
    expect(Math.abs(metrics.backdrop.x - metrics.pane.x)).toBeLessThanOrEqual(1); expect(Math.abs(metrics.backdrop.right - metrics.pane.right)).toBeLessThanOrEqual(1);
    expect(Math.abs(metrics.backdrop.bottom - metrics.pane.bottom)).toBeLessThanOrEqual(1);
    expect(metrics.input.x - metrics.backdrop.x).toBe(gutter); expect(metrics.backdrop.right - metrics.input.right).toBe(gutter);
    expect(metrics.tabSize).toBe('14px'); expect(metrics.background).toContain('radial-gradient'); expect(metrics.overflow).toBe(false);
    await expect(input.getByRole('button', { name: /^Send/ })).toBeDisabled();
    await page.screenshot({ path: test.info().outputPath(`social-${host}-compact-gutters.png`) });
  };
  await verifyGutters('standalone');
  await page.setViewportSize({ width: 1024, height: 768 }); await verifyGutters('standalone-1024');
  await page.setViewportSize({ width: 600, height: 768 }); await verifyGutters('standalone-600');
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto('/social/embedded/dms/social%3Adm%3Afixture-peer%3Afixture-reader'); await verifyGutters('embedded');
  expect(setup.errors).toEqual([]); expect(setup.mutations).toEqual([]);
});

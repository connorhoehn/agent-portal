import { expect, test, type Page } from '@playwright/test';
test.use({ baseURL: 'http://127.0.0.1:5183', viewport: { width: 1440, height: 900 } });
async function fixture(page: Page, opts: { failedLists?: boolean; savedLayout?: boolean; path?: string } = {}) {
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
    if (path === '/api/session/capabilities') return json({ tenant: 'social', role: 'participant', degraded: false, actions: { ViewSocial: true, PostMessage: false, StartCall: false } });
    if (path === '/api/health') return json({ status: 'unavailable', service: 'inert fixture', mocks: {}, region: 'none' });
    if (path === '/api/social/dms') return json({ conversations: [dm] });
    if (path === '/api/social/people') return json({ people: [{ userId: 'fixture-peer', displayName: 'Fixture Peer', roles: ['participant'] }] });
    if (opts.failedLists && ['/api/social/channels', '/api/social/teams', '/api/social/rooms'].includes(path)) return route.fulfill({ status: 503, json: { error: 'Inert unrelated read failure' } });
    if (path === '/api/social/channels') return json({ channels: [{ slug: 'general', channel: 'social:ch:general', name: 'General', joined: true, memberCount: 3, role: 'member', privacy: 'public', createdBy: 'fixture-reader', createdAt: '2026-10-10T12:00:00Z', description: null, lastMessagePreview: null, lastMessageAt: null }] });
    if (path === '/api/social/teams') return json({ teams: [{ teamId: 'fixture-team', slug: 'team', name: 'Fixture Team', role: 'member', favorite: false, visibility: 'org', createdBy: 'fixture-reader', channels: [] }] });
    if (path === '/api/social/rooms') return json({ source: 'mock', rooms: [{ orgId: 'social', roomId: 'fixture-room', slug: 'lounge', name: 'Fixture Lounge', visibility: 'org', createdBy: 'fixture-reader', createdAt: '2026-10-10T12:00:00Z', state: 'active', lobbyName: 'social:room:lounge', settings: { audioOnly: false, recordingEnabled: false, softCap: 8 }, lastActiveAt: '2026-10-10T12:00:00Z' }], counts: { total: 1, open: 1, private: 0 } });
    if (path === '/api/social/calls') return json({ calls: [], counts: { total: 0, missed: 0 } });
    if (path === '/api/social/recordings') return json({ recordings: [] });
    return route.fulfill({ status: 503, json: { error: 'Unmocked social navigation API refused' } });
  });
  await page.route(url => url.pathname.startsWith('/social/'), route => {
    if (!route.request().isNavigationRequest()) return route.continue();
    return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script><script type="module" src="/e2e/fixtures/social-navigation.tsx"></script></body></html>' });
  });
  await page.goto(opts.path ?? '/social/dms'); await expect(page.getByTestId('social-chat-rail')).toContainText('Fixture Peer');
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
test('general workspace keeps Rooms folded by default but lets the reader explicitly expand it', async ({ page }) => {
  const setup = await fixture(page); await page.getByRole('link', { name: 'Channels', exact: true }).first().click();
  const rail = page.getByTestId('social-chat-rail'), rooms = rail.getByTestId('social-rooms-list'); await expect(rooms).toBeVisible();
  await expect(rooms.getByRole('button', { name: /^Rooms/ })).toHaveAttribute('aria-expanded', 'false'); await expect(rooms.getByText('Fixture Lounge', { exact: true })).toHaveCount(0);
  await rooms.getByRole('button', { name: /^Rooms/ }).click(); await expect(rooms.getByText('Fixture Lounge', { exact: true })).toBeVisible();
  await expect(rail.getByRole('button', { name: /^Active now/ })).toHaveCount(0); expect(setup.errors).toEqual([]); expect(setup.mutations).toEqual([]);
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
    const backdrop = page.getByTestId('social-chat-composer-dock'), input = page.getByTestId('social-chat-composer');
    await expect(header).toBeVisible(); await expect(backdrop).toBeVisible();
    await expect(header.getByRole('tab', { name: /^Calls/ })).toBeVisible();
    const metrics = await pane.evaluate(element => {
      const header = element.querySelector<HTMLElement>('[data-testid="social-chat-panel-header"]')!;
      const backdrop = element.querySelector<HTMLElement>('[data-testid="social-chat-composer-dock"]')!;
      const input = element.querySelector<HTMLElement>('[data-testid="social-chat-composer"]')!;
      const box = (node: HTMLElement) => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width }; };
      const style = getComputedStyle(header), tabs = header.querySelector<HTMLElement>('[role="tab"]')!;
      return { pane: box(element as HTMLElement), header: box(header), backdrop: box(backdrop), input: box(input),
        left: parseFloat(style.paddingLeft), top: parseFloat(style.paddingTop), tabSize: getComputedStyle(tabs).fontSize,
        background: getComputedStyle(backdrop, '::before').backgroundImage, overflow: document.documentElement.scrollWidth > innerWidth };
    });
    expect(metrics.left).toBe(16); expect(metrics.top).toBe(8); expect(metrics.header.y - metrics.pane.y).toBeLessThanOrEqual(1);
    expect(Math.abs(metrics.backdrop.x - metrics.pane.x)).toBeLessThanOrEqual(1); expect(Math.abs(metrics.backdrop.right - metrics.pane.right)).toBeLessThanOrEqual(1);
    expect(Math.abs(metrics.backdrop.bottom - metrics.pane.bottom)).toBeLessThanOrEqual(1);
    expect(metrics.input.x - metrics.backdrop.x).toBe(16); expect(metrics.backdrop.right - metrics.input.right).toBe(16);
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

import type { Page } from '@playwright/test';
import { test, expect } from './cdpTest';

test.use({ baseURL: process.env.CALL_SHELL_BASE_URL ?? 'http://localhost:5261' });
const initial = { sub: 'u-vera', name: 'Vera Green', role: 'org-leader', tenant: 'orgiq',
  grants: { orgiq: ['org-leader'], social: ['participant'] }, switchable: { orgiq: ['org-leader'], social: ['participant'] },
  availableRoles: ['org-leader'], availableTenants: ['orgiq', 'social'], masquerading: null };
const names: Record<string, string> = { 'u-vera': 'Vera Green', 'u-nora': 'Nora Chang', 'u-rachel': 'Rachel Kowalski' };
const channel = 'social:dm:u-nora:u-vera';
async function fixture(page: Page) {
  let session = { ...initial }, epoch = 1, fail = false;
  const errors: string[] = [], writes: Record<string, unknown>[] = [];
  const people = Object.entries(names).map(([userId, displayName]) => ({ userId, displayName, roles: ['participant'] }));
  await page.route('**/api/session/capabilities', route => route.fulfill({ json: { actions: {}, degraded: false } }));
  await page.route('**/api/social/*', route => route.fulfill({ json: { people, conversations: [], channels: [], teams: [], rooms: [], calls: [], recordings: [], counts: { missed: 0 } } }));
  const jwt = () => `header.${Buffer.from(JSON.stringify({ sub: session.sub, org: session.tenant, role: session.role, epoch })).toString('base64url')}.fixture`;
  await page.route('**/api/session/me', route => route.fulfill({ json: session }));
  await page.route('**/api/auth/config', route => route.fulfill({ json: { ssoEnabled: false } }));
  await page.route('**/api/session/realtime-token', route => route.fulfill({ json: { token: jwt(), expiresAt: '2099-01-01T00:00:00Z',
    platformApiUrl: 'http://fixture-platform.invalid', videoUrl: 'http://fixture-video.invalid' } }));
  await page.route('http://fixture-platform.invalid/**', route => route.fulfill({ json: new URL(route.request().url()).pathname.endsWith('/join')
    ? { participantId: 'fixture-participant', token: null } : { sessionId: 'fixture-session' } }));
  await page.route('**/api/calls/*/page', route => route.fulfill({ json: { callId: new URL(route.request().url()).pathname.split('/')[3], revision: 0, page: null } }));
  await page.route('**/api/calls/*/chat**', route => {
    const callId = new URL(route.request().url()).pathname.split('/')[3];
    return route.fulfill({ json: { callId, channel: `orgiq:huddle:${callId}`, revision: 1, participants: [], messages: [], canSend: true,
      historyFrom: '2026-10-03T10:00:00Z' } });
  });
  await page.route('**/api/chat/pins**', route => route.fulfill({ json: { pins: [] } }));
  await page.route('**/api/social/embedded', route => fail ? route.fulfill({ status: 503, json: { error: 'Directory unavailable' } }) : route.fulfill({ json: {
    me: { userId: session.sub, displayName: session.name }, canSend: true, people,
    conversations: session.sub === 'u-vera' ? [{ channel, peers: [{ userId: 'u-nora', displayName: 'Nora Chang' }],
      lastMessageAt: '2026-10-09T12:00:00Z', lastMessagePreview: 'Validate the service dependency map.', lastMessageUserId: 'u-nora', unreadCount: 1 }] : [],
    authorityKey: `${session.sub}:${session.tenant}:${epoch}`, source: { userId: session.sub, tenant: session.tenant, role: session.role, epoch, actor: null },
  } }));
  await page.route('**/api/social/dms', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { conversations: [] } });
    const body = route.request().postDataJSON() as { userId: string }; writes.push(body);
    return route.fulfill({ json: { channel: `social:dm:${[session.sub, body.userId].sort().join(':')}`,
      peers: [{ userId: body.userId, displayName: names[body.userId] }] } });
  });
  await page.route('**/api/social/dms/read', route => route.fulfill({ json: { channel: route.request().postDataJSON().channel, readAt: new Date().toISOString() } }));
  await page.route('**/iq/projects/p-auth-migration**', route => route.request().isNavigationRequest()
    ? route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body><div id="root"></div>
      <script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>(type)=>type; window.__vite_plugin_react_preamble_installed__=true;</script>
      <script type="module" src="/e2e/fixtures/embedded-social.tsx"></script></body></html>` }) : route.continue());
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/iq/projects/p-auth-migration'); await expect(page.getByTestId('fixture-can-message')).toHaveText('true');
  await openPanel(page);
  const panel = page.getByTestId('embedded-social-panel');
  await expect(panel).toContainText('Validate the service dependency map.');
  return { panel, errors, writes, fail: () => { fail = true; }, recover: () => { fail = false; },
    epoch: () => { epoch++; }, actor: () => { session = { ...session, sub: 'u-rachel', name: 'Rachel Kowalski' }; } };
}
async function openPanel(page: Page) {
  await page.evaluate(() => (window as unknown as { socialFixture: { openPanel(): void } }).socialFixture.openPanel());
}
async function frames(page: Page) {
  return page.evaluate(() => (window as unknown as { socialFixture: { sent: Record<string, unknown>[] } }).socialFixture.sent);
}

test('the overview never mounts an input or starts a DM; close/reopen retains previews and one presence announcement', async ({ page }) => {
  const setup = await fixture(page);
  await expect(setup.panel.locator('input,textarea,[contenteditable=true]')).toHaveCount(0);
  await expect(setup.panel.getByRole('button', { name: /New chat/ })).toHaveCount(0);
  await setup.panel.getByRole('button', { name: 'Close conversation overview' }).click();
  await page.getByRole('link', { name: 'Settings', exact: true }).click(); await openPanel(page);
  await expect(setup.panel).toContainText('Validate the service dependency map.');
  await page.getByRole('button', { name: 'Refresh fixture session' }).dispatchEvent('click');
  await expect(setup.panel).toContainText('Validate the service dependency map.'); await expect(page.getByTestId('fixture-tenant')).toHaveText('orgiq');
  const sent = await frames(page);
  expect(sent.filter(frame => frame.service === 'chat' && frame.action === 'join' && frame.channel === channel)).toHaveLength(0);
  expect(setup.writes).toEqual([]);
  expect(sent.filter(frame => frame.service === 'presence' && frame.action === 'subscribe' && frame.channel === 'social:lobby')).toHaveLength(1);
  expect(sent.filter(frame => frame.service === 'presence' && frame.action === 'set'
    && JSON.stringify(frame.channels) === JSON.stringify(['social:lobby']))).toHaveLength(1);
  expect(setup.errors).toEqual([]);
});
test('online count deduplicates people and excludes idle/offline connections', async ({ page }) => {
  const setup = await fixture(page);
  await page.evaluate(() => (window as unknown as { socialFixture: { receive(frame: unknown): void } }).socialFixture.receive({
    type: 'presence', action: 'subscribed', channel: 'social:lobby', presence: [
      { clientId: 'v', status: 'online', channels: ['social:lobby'], metadata: { userId: 'u-vera', displayName: 'Vera' } },
      { clientId: 'n1', status: 'away', channels: ['social:lobby'], metadata: { userId: 'u-nora', displayName: 'Nora' } },
      { clientId: 'n2', status: 'online', channels: ['social:lobby'], metadata: { userId: 'u-nora', displayName: 'Nora' } },
      { clientId: 'r', status: 'busy', channels: ['social:lobby'], metadata: { userId: 'u-rachel', displayName: 'Rachel' } },
      { clientId: 'dead', status: 'offline', channels: ['social:lobby'], metadata: { userId: 'u-nora', displayName: 'Nora' } },
    ],
  }));
  await expect(page.getByTestId('shell-social-online')).toHaveText('2 online'); expect(setup.errors).toEqual([]);
});
test('Contacts and chat workspace read shell presence without unsubscribing it during navigation', async ({ page }) => {
  const setup = await fixture(page);
  await page.evaluate(() => (window as unknown as { socialFixture: { receive(frame: unknown): void } }).socialFixture.receive({
    type: 'presence', action: 'subscribed', channel: 'social:lobby', presence: [
      { clientId: 'n', status: 'online', channels: ['social:lobby'], metadata: { userId: 'u-nora', displayName: 'Nora Chang' } },
    ],
  }));
  await setup.panel.getByRole('button', { name: 'Close conversation overview' }).click();
  await page.getByRole('link', { name: 'Contacts fixture', exact: true }).click();
  await expect(page.getByTestId('social-contacts-here')).toContainText('Here now');
  await expect(page.getByTestId('social-contacts-table').getByText('Here now')).toHaveCount(1);
  await page.getByRole('link', { name: 'Chat workspace fixture', exact: true }).click();
  await expect(page.getByTestId('social-channels-page')).toBeVisible();
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page.getByTestId('shell-social-online')).toHaveText('1 online');
  const sent = await frames(page);
  expect(sent.filter(frame => frame.service === 'presence' && frame.action === 'subscribe' && frame.channel === 'social:lobby')).toHaveLength(1);
  expect(sent.filter(frame => frame.service === 'presence' && frame.action === 'unsubscribe' && frame.channel === 'social:lobby')).toHaveLength(0);
  expect(setup.errors).toEqual([]);
});
test('authority outage preserves the last preview, disables external writes, and recovers explicitly', async ({ page }) => {
  const setup = await fixture(page);
  setup.fail(); await setup.panel.getByTestId('embedded-social-refresh').click();
  await expect(setup.panel).toContainText('Directory unavailable');
  await expect(setup.panel).toContainText('Validate the service dependency map.'); await expect(page.getByTestId('fixture-can-message')).toHaveText('false');
  setup.recover(); await setup.panel.getByTestId('embedded-social-refresh').click();
  await expect(page.getByTestId('fixture-can-message')).toHaveText('true');
  await expect(setup.panel.locator('input,textarea,[contenteditable=true]')).toHaveCount(0);
  expect(setup.errors).toEqual([]);
});
test('a validated epoch change clears private state and reacquires a matching bearer without tenant navigation', async ({ page }) => {
  const setup = await fixture(page); setup.epoch();
  await setup.panel.getByTestId('embedded-social-refresh').click(); await expect(setup.panel).toHaveCount(0);
  await expect(page.getByTestId('fixture-can-message')).toHaveText('true'); await openPanel(page);
  await expect(setup.panel).toContainText('Validate the service dependency map.'); await expect(page).toHaveURL(/\/iq\/projects\/p-auth-migration$/);
  await expect(page.getByTestId('fixture-tenant')).toHaveText('orgiq'); expect(setup.errors).toEqual([]);
});
test('an external contextual composer still gets one persisted receipt without adding a modal input', async ({ page }) => {
  const setup = await fixture(page);
  const delivered = await page.evaluate(() => (window as unknown as { socialFixture: {
    sendToPerson(userId: string, text: string): Promise<boolean> } }).socialFixture.sendToPerson('u-nora', 'External composer text'));
  expect(delivered).toBe(true); expect(setup.writes).toEqual([{ userId: 'u-nora' }]);
  await expect(setup.panel.locator('input,textarea,[contenteditable=true]')).toHaveCount(0);
  const sends = (await frames(page)).filter(frame => frame.service === 'chat' && frame.action === 'send');
  expect(sends).toHaveLength(1); expect(sends[0]).toMatchObject({ channel, message: 'External composer text' });
  expect(setup.errors).toEqual([]);
});

test('an actor change closes the overview and removes the previous actor’s previews', async ({ page }) => {
  const setup = await fixture(page); setup.actor();
  await page.getByRole('button', { name: 'Refresh fixture session' }).dispatchEvent('click');
  await expect(page.getByTestId('fixture-actor')).toHaveText('u-rachel');
  await expect(setup.panel).toHaveCount(0);
  await expect(page.getByTestId('fixture-can-message')).toHaveText('true');
  await openPanel(page);
  await expect(setup.panel).not.toContainText('Validate the service dependency map.');
  await expect(setup.panel).toContainText('No recent conversations');
  expect(setup.errors).toEqual([]);
});

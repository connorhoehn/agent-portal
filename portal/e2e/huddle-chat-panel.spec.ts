import { type Page } from '@playwright/test';
import { test, expect } from './cdpTest';

test.use({ baseURL: process.env.CALL_SHELL_BASE_URL ?? 'http://localhost:5261' });
const initial = { sub: 'u-vera', name: 'Vera Green', role: 'org-leader', tenant: 'orgiq',
  grants: { orgiq: ['org-leader'], social: ['participant'] }, switchable: { orgiq: ['org-leader'], social: ['participant'] },
  availableRoles: ['org-leader'], availableTenants: ['orgiq', 'social'], masquerading: null };

async function fixture(page: Page, ownedPane = false, centralComposer = false, denied = false) {
  let session = { ...initial };
  const errors: string[] = [];
  const people = [{ userId: 'u-vera', displayName: 'Vera Green' }, { userId: 'u-nora', displayName: 'Nora Chang' }];
  await page.route('**/api/session/me', route => route.fulfill({ json: session }));
  await page.route('**/api/auth/config', route => route.fulfill({ json: { ssoEnabled: false } }));
  await page.route('**/api/session/realtime-token', route => route.fulfill({ json: { token: 'fixture-token',
    expiresAt: '2099-01-01T00:00:00Z', platformApiUrl: 'http://fixture-platform.invalid', videoUrl: 'http://fixture-video.invalid' } }));
  await page.route('http://fixture-platform.invalid/**', route => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({ json: path.endsWith('/join') ? { participantId: 'fixture-participant', token: 'malformed-media-token' }
      : path.endsWith('/sessions') ? { sessionId: 'fixture-session' } : {} });
  });
  await page.route('**/api/calls/*/page', route => {
    const callId = new URL(route.request().url()).pathname.split('/')[3];
    return route.fulfill({ json: { type: 'call-page', callId, revision: 0, page: null } });
  });
  // The resolver names the call's chat channel and roster; messages are
  // gateway chat, answered below by an in-page stand-in for the chat service.
  await page.route('**/api/calls/*/chat**', async route => {
    if (denied) return route.fulfill({ status: 403, json: { error: 'This call is no longer available to your current session' } });
    const callId = new URL(route.request().url()).pathname.split('/')[3]!, channel = `orgiq:huddle:${callId}`;
    return route.fulfill({ json: { callId, channel, revision: 1, participants: people, messages: [], canSend: true, historyFrom: '2026-10-03T10:00:00Z' } });
  });
  await page.route('**/iq/projects/p-auth-migration**', route => {
    if (!route.request().isNavigationRequest()) return route.continue();
    return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body><div id="root"></div>
      <script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>(type)=>type; window.__vite_plugin_react_preamble_installed__=true;</script>
      <script type="module" src="/e2e/fixtures/huddle-chat.tsx"></script></body></html>` });
  });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`/iq/projects/p-auth-migration?tab=work&item=wi-cookie${ownedPane ? '&ownedPane=1' : ''}${centralComposer ? '&centralComposer=1' : ''}`);
  await expect(page.getByTestId('fixture-platform-endpoint')).toHaveText('http://fixture-platform.invalid');
  await page.getByRole('button', { name: 'Start fixture call' }).click();
  await expect(page.getByTestId('fixture-call-phase')).toHaveText('calling');
  const callId = (await page.getByTestId('fixture-call-id').textContent())!;
  await page.evaluate(callId => {
    (window as unknown as { callFixture: { receive(frame: unknown): void } }).callFixture.receive({
      type: 'call', action: 'accepted', data: { callId, lobbyName: 'orgiq:dm:u-vera:u-nora',
        callerId: 'u-nora', userId: 'u-nora', displayName: 'Nora Chang', targetUserIds: ['u-vera'] },
    });
  }, callId);
  await expect(page.getByTestId('shell-call-dock-chat')).toHaveCount(1);
  await page.getByTestId('shell-call-dock-chat').click();
  await expect(page.getByTestId(ownedPane ? 'fixture-owned-pane' : 'huddle-chat-panel')).toBeVisible();
  if (!ownedPane && !denied) await expect(page.getByTestId('huddle-chat-participants')).toHaveText('Vera Green, Nora Chang');
  // The chat service's answers to this page's frames: join → joined + history;
  // send → the stored echo, then `sent` once persisted (unless held or failed).
  await page.evaluate(() => {
    type Frame = Record<string, unknown>;
    const fx = (window as unknown as { callFixture: { sent: Frame[]; receive(frame: unknown): void } }).callFixture;
    const server = { failures: 0, held: false, pending: [] as Array<() => void>, posts: [] as Frame[], messages: [] as Frame[] };
    (window as unknown as { huddleServer: typeof server }).huddleServer = server;
    const push = fx.sent.push.bind(fx.sent);
    fx.sent.push = (...frames: Frame[]) => {
      for (const frame of frames) {
        const channel = String(frame.channel ?? '');
        if (frame.service !== 'chat' || !channel.startsWith('orgiq:huddle:')) continue;
        if (frame.action === 'join') {
          queueMicrotask(() => { fx.receive({ type: 'chat', action: 'joined', channel }); fx.receive({ type: 'chat', action: 'history', channel, messages: server.messages }); });
        } else if (frame.action === 'send') {
          server.posts.push(frame);
          if (server.failures-- > 0) {
            queueMicrotask(() => fx.receive({ type: 'error', service: 'chat', channel, error: { code: 'store-failed', message: 'Message storage is unavailable' } }));
            continue;
          }
          const metadata = frame.metadata as Frame; const descriptor = metadata.pageReference as { kind: string; id: string } | undefined;
          const message = { id: `message-${server.messages.length + 1}`, clientId: 'fixture-client', userId: 'u-vera', channel,
            message: frame.message, timestamp: '2026-10-03T10:01:00Z', metadata: { displayName: 'Vera Green', clientDeliveryId: metadata.clientDeliveryId,
              ...(descriptor ? { pageReference: { ...descriptor, status: 'available', title: 'Logout clears the legacy cookie',
                href: `/iq/projects/p-auth-migration?tab=work&item=${descriptor.id}`,
                project: { id: 'p-auth-migration', title: 'Auth Migration', href: '/iq/projects/p-auth-migration' },
                breadcrumbs: [{ title: 'Initiatives', href: '/iq/projects' }, { title: 'Auth Migration', href: '/iq/projects/p-auth-migration' }] } } : {}) } };
          server.messages.push(message);
          const ack = () => fx.receive({ type: 'chat', action: 'sent', channel, messageId: message.id, timestamp: message.timestamp });
          queueMicrotask(() => { fx.receive({ type: 'chat', action: 'message', channel, message }); if (server.held) server.pending.push(ack); else ack(); });
        }
      }
      return push(...frames);
    };
  });
  type Server = { failures: number; held: boolean; pending: Array<() => void>; posts: Record<string, unknown>[] };
  return { callId, errors, posts: () => page.evaluate(() => (window as unknown as { huddleServer: Server }).huddleServer.posts),
    fail: () => page.evaluate(() => { (window as unknown as { huddleServer: Server }).huddleServer.failures = 1; }),
    hold: () => page.evaluate(() => { (window as unknown as { huddleServer: Server }).huddleServer.held = true; }),
    release: () => page.evaluate(() => { const value = (window as unknown as { huddleServer: Server }).huddleServer;
      value.held = false; value.pending.splice(0).forEach(ack => ack()); }),
    replaceActor: () => { session = { ...session, sub: 'u-rachel', name: 'Rachel' }; } };
}

test('persisted retry retains huddle draft/reference and renders the exact canonical work item', async ({ page }) => {
  const setup = await fixture(page); await setup.fail();
  await page.getByTestId('huddle-chat-panel').getByRole('textbox', { name: 'Huddle message', exact: true }).fill('Please review the logout task');
  await page.getByTestId('huddle-chat-attach-page').click();
  await page.getByTestId('huddle-chat-panel').getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByTestId('huddle-chat-error')).toContainText('storage is unavailable');
  await expect(page.getByTestId('huddle-chat-panel').getByRole('textbox', { name: 'Huddle message', exact: true })).toHaveText('Please review the logout task');
  await expect(page.getByTestId('huddle-chat-panel').getByText('Work item context', { exact: true })).toContainText('Work item context');
  await page.getByTestId('huddle-chat-panel').getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByTestId('huddle-chat-panel').getByRole('textbox', { name: 'Huddle message', exact: true })).toHaveText('');
  await expect(page.getByTestId('huddle-chat-reference-open')).toHaveText('Logout clears the legacy cookie');
  // The explicit retry reuses its delivery id, so a lost acknowledgement cannot store a second copy.
  const posts = await setup.posts() as Array<{ metadata: { clientDeliveryId: string; pageReference?: unknown } }>;
  expect(posts[0]?.metadata.clientDeliveryId).toBe(posts[1]?.metadata.clientDeliveryId);
  expect(posts[1]?.metadata.pageReference).toEqual({ kind: 'work-item', id: 'wi-cookie' });
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByTestId('huddle-chat-reference-open').click();
  await expect(page).toHaveURL(/\/iq\/projects\/p-auth-migration\?tab=work&item=wi-cookie$/);
  // Every chat frame this page sent names exactly this call's channel.
  const channels = await page.evaluate(() => (window as unknown as { callFixture: { sent: { service?: string; channel?: string }[] } }).callFixture.sent
    .filter(frame => frame.service === 'chat').map(frame => frame.channel));
  expect(channels.length).toBeGreaterThan(0);
  expect(new Set(channels)).toEqual(new Set([`orgiq:huddle:${setup.callId}`])); expect(setup.errors).toEqual([]);
});

test('navigation, close/reopen and same-actor refresh preserve one panel and its unsent reference', async ({ page }) => {
  const setup = await fixture(page);
  await page.getByTestId('huddle-chat-panel').getByRole('textbox', { name: 'Huddle message', exact: true }).fill('Draft kept while reviewing another page');
  await page.getByTestId('huddle-chat-attach-page').click();
  for (const label of ['Admin', 'Settings']) {
    await page.getByRole('link', { name: label, exact: true }).click();
    await expect(page.getByTestId('fixture-call-id')).toHaveText(setup.callId);
    await expect(page.getByTestId('huddle-chat-panel')).toHaveCount(1);
    await expect(page.getByTestId('huddle-chat-panel').getByRole('textbox', { name: 'Huddle message', exact: true })).toHaveText('Draft kept while reviewing another page');
    await expect(page.getByTestId('huddle-chat-panel').getByText('Work item context', { exact: true })).toContainText('Work item context');
  }
  await page.getByTestId('huddle-chat-panel-close').click();
  await page.getByTestId('shell-call-dock-chat').click();
  await page.getByRole('button', { name: 'Refresh fixture session' }).click();
  await expect(page.getByTestId('huddle-chat-panel').getByRole('textbox', { name: 'Huddle message', exact: true })).toHaveText('Draft kept while reviewing another page');
  await expect(page.getByTestId('shell-call-dock')).toHaveCount(1); expect(setup.errors).toEqual([]);
});

test('delayed persisted receipt keeps a newer draft and reference-only messages send', async ({ page }) => {
  const setup = await fixture(page); await setup.hold();
  await page.getByTestId('huddle-chat-panel').getByRole('textbox', { name: 'Huddle message', exact: true }).fill('First');
  await page.getByTestId('huddle-chat-panel').getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByTestId('huddle-chat-panel').getByRole('button', { name: 'Sending…', exact: true })).toHaveText('Sending…');
  await page.getByTestId('huddle-chat-panel').getByRole('textbox', { name: 'Huddle message', exact: true }).fill('Second');
  await expect(page.getByTestId('fixture-huddle-draft')).toContainText('Second');
  await setup.release();
  await expect(page.getByTestId('huddle-chat-panel').getByRole('button', { name: 'Send', exact: true })).toHaveText('Send');
  await expect(page.getByTestId('huddle-chat-panel').getByRole('textbox', { name: 'Huddle message', exact: true })).toHaveText('Second');
  await page.getByTestId('huddle-chat-panel').getByRole('textbox', { name: 'Huddle message', exact: true }).fill(''); await page.getByTestId('huddle-chat-attach-page').click();
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByTestId('huddle-chat-panel').getByText('Work item context', { exact: true })).toHaveCount(0);
  const posts = await setup.posts() as Array<{ message: string; metadata: { pageReference?: unknown } }>;
  // A references-only send carries no text; the BFF stores the reference alone.
  expect(posts[1]?.message).toBe(''); expect(posts[1]?.metadata.pageReference).toEqual({ kind: 'work-item', id: 'wi-cookie' });
  expect(setup.errors).toEqual([]);
});

test('an actor change clears the panel and a late old send cannot restore it', async ({ page }) => {
  const setup = await fixture(page); await setup.hold();
  await page.getByTestId('huddle-chat-panel').getByRole('textbox', { name: 'Huddle message', exact: true }).fill('Private old actor'); await page.getByTestId('huddle-chat-panel').getByRole('button', { name: 'Send', exact: true }).click();
  setup.replaceActor(); await page.getByRole('button', { name: 'Refresh fixture session' }).click();
  await expect(page.getByTestId('fixture-actor')).toHaveText('u-rachel');
  await expect(page.getByTestId('huddle-chat-panel')).toHaveCount(0);
  await expect(page.getByTestId('shell-call-dock-chat')).toHaveCount(0);
  await setup.release(); await expect(page.getByTestId('fixture-call-id')).toHaveText('');
  expect(setup.errors).toEqual([]);
});

test('terminal chat frames disable sending and cannot be reopened by older roster hints', async ({ page }) => {
  const setup = await fixture(page); await page.getByTestId('huddle-chat-panel').getByRole('textbox', { name: 'Huddle message', exact: true }).fill('Unsent when huddle ends');
  await page.evaluate(callId => {
    const receive = (window as unknown as { callFixture: { receive(frame: unknown): void } }).callFixture.receive;
    receive({ type: 'call-chat', action: 'ended', callId, channel: `orgiq:huddle:${callId}`, revision: 4 });
    receive({ type: 'call-chat', action: 'members', callId, channel: `orgiq:huddle:${callId}`, revision: 3,
      participants: [{ userId: 'u-vera', displayName: 'Vera' }] });
  }, setup.callId);
  await expect(page.getByTestId('huddle-chat-panel').getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  await expect(page.getByTestId('huddle-chat-error')).toHaveText('This huddle has ended.');
  await expect(page.getByTestId('huddle-chat-panel').getByRole('textbox', { name: 'Huddle message', exact: true })).toHaveText('Unsent when huddle ends');
  expect(await setup.posts()).toHaveLength(0); expect(setup.errors).toEqual([]);
});


test('one owned pane switches page and huddle destinations without losing either draft', async ({ page }) => {
  const setup = await fixture(page, true);
  const pane = page.getByTestId('fixture-owned-pane');
  const input = pane.getByRole('textbox', { name: 'Huddle message', exact: true });
  await input.fill('Unsent huddle inquiry');
  await pane.getByRole('tab', { name: 'Details', exact: true }).click();
  await expect(pane).toContainText('Fixture details');
  await page.getByTestId('shell-call-dock-chat').click();
  await expect(input).toHaveText('Unsent huddle inquiry');
  await pane.getByRole('button', { name: 'Page discussion', exact: true }).click();
  await expect(page.getByLabel('Page discussion draft')).toBeVisible();
  await page.getByLabel('Page discussion draft').fill('Unsent page inquiry');
  await expect(page.getByTestId('huddle-chat-panel')).toHaveCount(0);
  await expect(page.getByTestId('huddle-chat-inpage')).toHaveCount(0);
  await pane.getByRole('button', { name: 'Huddle chat', exact: true }).click();
  await expect(input).toHaveText('Unsent huddle inquiry');
  await page.getByRole('button', { name: 'Open page discussion', exact: true }).click();
  await expect(page.getByLabel('Page discussion draft')).toHaveValue('Unsent page inquiry');
  await expect(page.getByTestId('fixture-call-id')).toHaveText(setup.callId);
  expect(await setup.posts()).toEqual([]);
  expect(setup.errors).toEqual([]);
});


test('shared page composer keeps page, agent and huddle drafts separate with one input', async ({ page }) => {
  const setup = await fixture(page, true, true);
  const composer = page.getByTestId('fixture-central-composer');
  const input = composer.getByRole('textbox', { name: 'Fixture chat', exact: true });
  await expect(input).toBeVisible();
  await input.fill('Call draft follows me');
  await page.getByRole('button', { name: 'Open page discussion', exact: true }).click();
  await expect(input).toHaveText('');
  await input.fill('Page draft stays here');
  await page.getByTestId('shell-call-dock-chat').click();
  await expect(input).toHaveText('Call draft follows me');
  await page.getByRole('button', { name: 'Ask fixture agent', exact: true }).click();
  await expect(input).toHaveText('Page draft stays here');
  await input.fill('Agent question stays on page');
  await page.getByTestId('shell-call-dock-chat').click();
  await expect(input).toHaveText('Call draft follows me');
  await expect(page.getByTestId('fixture-owned-pane').getByRole('textbox', { name: 'Huddle message' })).toHaveCount(0);
  await expect(page.locator('[contenteditable="true"]:visible')).toHaveCount(1);
  await page.evaluate(callId => {
    (window as unknown as { callFixture: { receive(frame: unknown): void } }).callFixture.receive({
      type: 'call-chat', action: 'ended', callId, channel: `orgiq:huddle:${callId}`, revision: 4,
    });
  }, setup.callId);
  await expect(input).toHaveText('Call draft follows me');
  await expect(composer.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  expect(await setup.posts()).toEqual([]);
  expect(setup.errors).toEqual([]);
});


test('a denied conversation shows recovery without contradictory loading text', async ({ page }) => {
  const setup = await fixture(page, false, false, true);
  await expect(page.getByTestId('huddle-chat-error')).toContainText('This call is no longer available');
  await expect(page.getByTestId('huddle-chat-loading')).toHaveCount(0);
  await expect(page.getByTestId('huddle-chat-refresh')).toBeEnabled();
  await expect(page.getByRole('textbox', { name: 'Huddle message', exact: true })).toHaveCount(0);
  expect(await setup.posts()).toHaveLength(0);
  expect(setup.errors).toEqual([]);
});

import { type Page } from '@playwright/test';
import { test, expect } from './cdpTest';

test.use({ baseURL: process.env.CALL_SHELL_BASE_URL ?? 'http://localhost:5261' });

const initialSession = {
  sub: 'u-vera', name: 'Vera Green', role: 'org-leader', tenant: 'orgiq',
  grants: { orgiq: ['org-leader'], social: ['participant'] },
  switchable: { orgiq: ['org-leader'], social: ['participant'] },
  availableRoles: ['org-leader'], availableTenants: ['orgiq', 'social'],
  masquerading: null as null | { actor: string; asUser: string },
};

async function fixture(page: Page, opts: { holdToken?: boolean } = {}) {
  let session = { ...initialSession };
  const requests: string[] = [];
  let sessionReads = 0;
  let revoked = false;
  let releaseToken!: () => void;
  const tokenReady = opts.holdToken ? new Promise<void>((resolve) => { releaseToken = resolve; }) : Promise.resolve();
  await page.route('**/api/session/me', (route) => {
    sessionReads += 1;
    return route.fulfill(revoked ? { status: 401, json: { error: 'Unauthenticated', ssoRequired: true } } : { json: session });
  });
  await page.route('**/api/auth/config', (route) => route.fulfill({ json: { ssoEnabled: false } }));
  await page.route('**/api/session/realtime-token', async (route) => {
    await tokenReady;
    await route.fulfill({ json: {
      token: 'fixture-id-token', expiresAt: '2099-01-01T00:00:00Z',
      platformApiUrl: 'http://fixture-platform.invalid', videoUrl: 'http://fixture-video.invalid',
    } });
  });
  await page.route('http://fixture-platform.invalid/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    requests.push(path);
    return route.fulfill({ json: path.endsWith('/join')
      ? { participantId: 'fixture-participant', token: 'malformed-media-token' }
      : path.endsWith('/sessions') ? { sessionId: 'fixture-session' } : {} });
  });
  await page.route('**/iq/projects/p-auth-migration', async (route) => {
    if (!route.request().isNavigationRequest()) return route.continue();
    return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body><div id="root"></div>
      <script type="module">
        import RefreshRuntime from '/@react-refresh';
        RefreshRuntime.injectIntoGlobalHook(window);
        window.$RefreshReg$ = () => {};
        window.$RefreshSig$ = () => (type) => type;
        window.__vite_plugin_react_preamble_installed__ = true;
      </script>
      <script type="module" src="/e2e/fixtures/persistent-call-shell.tsx"></script></body></html>` });
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/iq/projects/p-auth-migration');
  await expect(page.getByTestId('fixture-actor')).toHaveText('u-vera');
  return {
    requests, errors, releaseToken: () => releaseToken?.(),
    sessionReads: () => sessionReads,
    revoke: () => { revoked = true; },
    replaceSession: (next: Partial<typeof initialSession>) => { session = { ...session, ...next }; },
  };
}

async function start(page: Page) {
  await expect(page.getByTestId('fixture-platform-endpoint')).toHaveText('http://fixture-platform.invalid');
  await page.getByRole('button', { name: 'Start fixture call' }).click();
  await expect(page.getByTestId('fixture-call-phase')).toHaveText('calling');
  await expect(page.getByTestId('shell-call-dock')).toHaveCount(1);
  return page.getByTestId('fixture-call-id').textContent();
}

test('a cold SFU endpoint updates context without dropping an unsaved page draft', async ({ page }) => {
  const setup = await fixture(page, { holdToken: true });
  await expect(page.getByTestId('fixture-video-endpoint')).toHaveText('');
  await page.getByRole('textbox', { name: 'Unsaved draft' }).fill('Keep this work while endpoints arrive');
  setup.releaseToken();
  await expect(page.getByTestId('fixture-video-endpoint')).toHaveText('http://fixture-video.invalid');
  await expect(page.getByRole('textbox', { name: 'Unsaved draft' })).toHaveValue('Keep this work while endpoints arrive');
  expect(setup.errors).toEqual([]);
});

test('navigation and same-actor refresh keep one call and its controls mounted', async ({ page }) => {
  const setup = await fixture(page);
  const callId = await start(page);
  for (const label of ['Admin', 'Settings', 'Initiative']) {
    await page.getByRole('link', { name: label, exact: true }).click();
    await expect(page.getByTestId('fixture-call-id')).toHaveText(callId!);
    await expect(page.getByTestId('shell-call-dock')).toHaveCount(1);
    await expect(page.getByTestId('initiative-call-dock')).toHaveCount(1);
  }
  setup.replaceSession({ name: 'Vera refreshed', role: 'org-leader' });
  await page.getByRole('button', { name: 'Refresh fixture session' }).click();
  await expect(page.getByTestId('fixture-call-id')).toHaveText(callId!);
  expect(setup.requests.filter((path) => path.endsWith('/sessions'))).toHaveLength(1);
  expect(setup.requests.filter((path) => path.endsWith('/join'))).toHaveLength(1);
  expect(setup.requests.filter((path) => path.endsWith('/end'))).toHaveLength(0);
  await page.getByTestId(/^(shell-)?call-dock-leave$/).first().click();
  await expect.poll(() => setup.requests.filter((path) => path.endsWith('/end')).length).toBe(1);
  expect(setup.errors).toEqual([]);
});

test('the footer row carries the call: status, people, device controls, one hidden media sink and Leave', async ({ page }) => {
  const setup = await fixture(page);
  await expect(page.getByTestId('shell-footer')).toBeVisible();
  await expect(page.getByTestId('shell-call-dock')).toHaveCount(0);
  await start(page);
  const row = page.getByTestId('shell-call-dock');
  await expect(row).toBeVisible();
  await expect(row.getByTestId('shell-call-dock-name')).toHaveText('Fixture huddle');
  // The mockup's set: status + name, people count, mic, camera, Leave — all drawn in the bar, none behind the media toggle.
  for (const id of ['shell-call-dock-dot', 'shell-call-dock-name', 'shell-call-dock-media', 'shell-call-dock-mic', 'shell-call-dock-camera', 'shell-call-dock-leave']) {
    await expect(row.getByTestId(id)).toBeVisible();
  }
  await expect(page.getByTestId('shell-footer-context')).toHaveCount(0);
  // The tile shelf stays mounted as the media sink, collapsed until asked for.
  const media = page.getByTestId('shell-call-media');
  await expect(media).toHaveCount(1); await expect(media).toBeHidden();
  await row.getByTestId('shell-call-dock-media').click();
  await expect(media).toBeVisible(); await expect(row.getByTestId('shell-call-dock-media')).toHaveAttribute('aria-expanded', 'true');
  await row.getByTestId('shell-call-dock-media').click(); await expect(media).toBeHidden();
  // Keyboard: Leave is reachable and focusable from the row.
  await row.getByTestId(/^(shell-)?call-dock-leave$/).first().focus();
  await expect(row.getByTestId(/^(shell-)?call-dock-leave$/).first()).toBeFocused();
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }]) {
    await page.setViewportSize(viewport);
    const leave = await row.getByTestId(/^(shell-)?call-dock-leave$/).first().boundingBox();
    expect(leave && leave.x + leave.width <= viewport.width).toBe(true);
    const footer = await page.getByTestId('shell-footer').boundingBox();
    expect(footer && Math.round(footer.y + footer.height)).toBe(viewport.height);
  }
  await row.getByTestId(/^(shell-)?call-dock-leave$/).first().click();
  await expect.poll(() => setup.requests.filter((path) => path.endsWith('/end')).length).toBe(1);
  expect(setup.errors).toEqual([]);
});

test('the idle footer carries the page context, Huddle and Message — and says so when there is none', async ({ page }) => {
  const setup = await fixture(page);
  const idle = page.getByTestId('shell-footer-context');
  await expect(idle).toBeVisible();
  await expect(idle.getByTestId('shell-footer-context-name')).toHaveText('Fixture huddle');
  await expect(idle.getByTestId('shell-footer-context-start')).toBeEnabled();
  await expect(idle.getByTestId('shell-footer-context-start')).toContainText('Huddle');
  // This fixture page mounts no conversation composer, so Message says why it cannot open.
  await expect(idle.getByTestId('shell-footer-context-chat')).toBeDisabled();
  await expect(idle.getByTestId('shell-footer-context-chat')).toHaveAttribute('title', /Start the huddle/);
  for (const id of ['mic', 'camera', 'leave', 'media', 'timer']) await expect(idle.getByTestId(`shell-footer-context-${id}`)).toHaveCount(0);
  // No context: both actions disabled with a reason.
  await page.getByRole('button', { name: 'Drop fixture context' }).click();
  await expect(idle.getByTestId('shell-footer-context-name')).toHaveText('No huddle here');
  await expect(idle.getByTestId('shell-footer-context-start')).toBeDisabled();
  await expect(idle.getByTestId('shell-footer-context-start')).toHaveAttribute('title', /no huddle/i);
  await expect(idle.getByTestId('shell-footer-context-chat')).toBeDisabled();
  expect(setup.requests.filter((path) => path.endsWith('/sessions'))).toHaveLength(0);
  expect(setup.errors).toEqual([]);
});

test('The device-settings cog in the idle footer reopens the check for a remembered person and clears the skip', async ({ page }) => {
  const setup = await fixture(page);
  // The default seed is "remembered": a call would skip the check, but the footer action still opens it.
  await expect(page.getByTestId('prejoin-dialog')).toHaveCount(0);
  await page.getByTestId('shell-footer-check-devices').click();
  await expect(page.getByTestId('prejoin-dialog')).toBeVisible();
  await expect(page.getByTestId('prejoin-remember')).not.toBeChecked();
  await page.getByTestId('prejoin-cancel').click();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('orgiq.call-prejoin.v1') ?? 'null'))).toMatchObject({ remember: true });
  await page.getByTestId('shell-footer-check-devices').click();
  await page.getByTestId('prejoin-join').click();
  await expect(page.getByTestId('prejoin-dialog')).toHaveCount(0);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('orgiq.call-prejoin.v1') ?? 'null'))).toMatchObject({ remember: false });
  // Saving joins nothing; the next Start now shows the check again.
  expect(setup.requests.filter((path) => path.endsWith('/sessions'))).toHaveLength(0);
  await page.getByTestId('shell-footer-context-start').click();
  await expect(page.getByTestId('prejoin-dialog')).toBeVisible();
  expect(setup.errors).toEqual([]);
});

test('the idle Huddle action starts the page call through the one call runtime', async ({ page }) => {
  const setup = await fixture(page);
  await expect(page.getByTestId('fixture-platform-endpoint')).toHaveText('http://fixture-platform.invalid');
  await page.getByTestId('shell-footer-context-start').click();
  await expect(page.getByTestId('fixture-call-phase')).toHaveText('calling');
  await expect(page.getByTestId('shell-call-dock')).toBeVisible();
  await expect(page.getByTestId('shell-footer-context')).toHaveCount(0);
  await page.getByTestId(/^(shell-)?call-dock-leave$/).first().click();
  await expect.poll(() => setup.requests.filter((path) => path.endsWith('/end')).length).toBe(1);
  expect(setup.errors).toEqual([]);
});

test.describe('pre-join', () => {
  test.use({ preJoin: 'show' });

  test('the idle Huddle shows the device check first; Cancel starts nothing, Join proceeds through the one runtime', async ({ page }) => {
    const setup = await fixture(page);
    await expect(page.getByTestId('fixture-platform-endpoint')).toHaveText('http://fixture-platform.invalid');
    await page.getByTestId('shell-footer-context-start').click();
    await expect(page.getByTestId('prejoin-dialog')).toBeVisible();
    await expect(page.getByTestId('prejoin-devices')).toBeVisible();
    await expect(page.getByTestId('fixture-call-phase')).toHaveText('idle');
    await page.getByTestId('prejoin-cancel').click();
    await expect(page.getByTestId('prejoin-dialog')).toHaveCount(0);
    expect(setup.requests.filter((path) => path.endsWith('/sessions'))).toHaveLength(0);
    await page.getByTestId('shell-footer-context-start').click();
    await page.getByTestId('prejoin-mic').click();
    await page.getByTestId('prejoin-join').click();
    await expect(page.getByTestId('fixture-call-phase')).toHaveText('calling');
    await expect(page.getByTestId('prejoin-dialog')).toHaveCount(0);
    // The choice is stored for "as last time"; only Remember skips the screen.
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('orgiq.call-prejoin.v1') ?? 'null'))).toEqual({ micOn: false, cameraOn: true, remember: false });
    expect(setup.requests.filter((path) => path.endsWith('/sessions'))).toHaveLength(1);
    expect(setup.errors).toEqual([]);
  });

  test('Remember skips the pre-join on the next Huddle', async ({ page }) => {
    const setup = await fixture(page);
    await expect(page.getByTestId('fixture-platform-endpoint')).toHaveText('http://fixture-platform.invalid');
    await page.getByTestId('shell-footer-context-start').click();
    await page.getByTestId('prejoin-remember').click();
    await page.getByTestId('prejoin-join').click();
    await expect(page.getByTestId('fixture-call-phase')).toHaveText('calling');
    await page.getByTestId(/^(shell-)?call-dock-leave$/).first().click();
    await expect.poll(() => setup.requests.filter((path) => path.endsWith('/end')).length).toBe(1);
    await expect(page.getByTestId('shell-footer-context-start')).toBeVisible();
    await page.getByTestId('shell-footer-context-start').click();
    await expect(page.getByTestId('fixture-call-phase')).toHaveText('calling');
    await expect(page.getByTestId('prejoin-dialog')).toHaveCount(0);
    expect(setup.errors).toEqual([]);
  });
});

for (const change of ['actor', 'tenant'] as const) {
  test(`${change} change tears down the old call`, async ({ page }) => {
    const setup = await fixture(page);
    await start(page);
    setup.replaceSession(change === 'actor' ? { sub: 'u-rachel', name: 'Rachel' } : { tenant: 'social' });
    await page.getByRole('button', { name: 'Refresh fixture session' }).click();
    await expect(page.getByTestId('fixture-call-id')).toHaveText('');
    await expect(page.getByTestId('shell-call-dock')).toHaveCount(0);
    await expect.poll(() => setup.requests.filter((path) => path.endsWith('/end')).length).toBe(1);
    expect(setup.errors).toEqual([]);
  });
}

test('accepting a document invite from Settings opens its document inside the persistent host', async ({ page }) => {
  const setup = await fixture(page);
  setup.replaceSession({ tenant: 'assessment' });
  await page.getByRole('button', { name: 'Refresh fixture session' }).click();
  await expect(page.getByTestId('fixture-tenant')).toHaveText('assessment');
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.evaluate(() => {
    (window as unknown as { callFixture: { receive(frame: unknown): void } }).callFixture.receive({
      type: 'call', action: 'invite', data: {
        callId: 'fixture-document-call', lobbyName: 'assessment:doc:page:123', callerId: 'u-nora', callerName: 'Nora',
        targetUserIds: ['u-vera'], channel: 'assessment-document:/assessment/workspace?doc=page%3A123',
      },
    });
  });
  await page.getByTestId('incoming-call-accept').click();
  await expect(page).toHaveURL(/\/assessment\/workspace\?doc=page%3A123$/);
  await expect(page.getByTestId('fixture-call-id')).toHaveText('fixture-document-call');
  await expect(page.getByTestId('document-call-dock')).toHaveCount(1);
  expect(setup.errors).toEqual([]);
});

test('idle calls add no session polling', async ({ page }) => {
  await page.clock.install();
  const setup = await fixture(page);
  await expect(page.getByTestId('fixture-platform-endpoint')).toHaveText('http://fixture-platform.invalid');
  const before = setup.sessionReads();
  await page.clock.fastForward(45_000);
  expect(setup.sessionReads()).toBe(before);
  expect(setup.errors).toEqual([]);
});

test('an active call on Settings tears down when the next session check reports revocation', async ({ page }) => {
  await page.clock.install();
  const setup = await fixture(page);
  await start(page);
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  setup.revoke();
  await page.clock.fastForward(30_001);
  await expect(page.getByRole('heading', { name: 'Sign in required' })).toBeVisible();
  await expect(page.getByTestId('shell-call-dock')).toHaveCount(0);
  await expect.poll(() => setup.requests.filter((path) => path.endsWith('/end')).length).toBe(1);
  expect(setup.errors).toEqual([]);
});

test('focus and visibility restoration check session authority without recreating the same actor call', async ({ page }) => {
  const setup = await fixture(page);
  const callId = await start(page);
  const before = setup.sessionReads();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(setup.sessionReads).toBe(before + 1);
  await expect(page.getByTestId('fixture-call-id')).toHaveText(callId!);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect.poll(setup.sessionReads).toBe(before + 2);
  await expect(page.getByTestId('fixture-call-id')).toHaveText(callId!);
  expect(setup.requests.filter((path) => path.endsWith('/sessions'))).toHaveLength(1);
  expect(setup.requests.filter((path) => path.endsWith('/end'))).toHaveLength(0);
  expect(setup.errors).toEqual([]);
});

test('an older session response cannot restore an actor after a newer refresh', async ({ page }) => {
  const setup = await fixture(page);
  let release!: () => void;
  const oldReady = new Promise<void>((resolve) => { release = resolve; });
  let reads = 0;
  await page.route('**/api/session/me', async (route) => {
    reads += 1;
    if (reads === 1) {
      await oldReady;
      return route.fulfill({ json: initialSession });
    }
    return route.fulfill({ json: { ...initialSession, sub: 'u-rachel', name: 'Rachel' } });
  });
  await page.getByRole('button', { name: 'Refresh fixture session' }).click();
  await expect.poll(() => reads).toBe(1);
  await page.getByRole('button', { name: 'Refresh fixture session' }).click();
  await expect(page.getByTestId('fixture-actor')).toHaveText('u-rachel');
  const oldResponse = page.waitForResponse((response) => response.url().endsWith('/api/session/me'));
  release();
  await oldResponse;
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
  await expect(page.getByTestId('fixture-actor')).toHaveText('u-rachel');
  expect(setup.errors).toEqual([]);
});

for (const change of ['login', 'setRole', 'enterContext', 'masquerade', 'stopMasquerade', 'logout'] as const) {
  test(`${change} fences an older session read before its identity write finishes`, async ({ page }) => {
    const setup = await fixture(page);
    let releaseRead!: () => void;
    const readReady = new Promise<void>((resolve) => { releaseRead = resolve; });
    let reads = 0;
    await page.route('**/api/session/me', async (route) => {
      reads += 1;
      await readReady;
      return route.fulfill({ json: { ...initialSession, sub: 'u-stale-actor', name: 'Stale actor' } });
    });
    let releaseWrite!: () => void;
    const writeReady = new Promise<void>((resolve) => { releaseWrite = resolve; });
    let writes = 0;
    await page.route(/\/api\/(session\/(login|role|tenant|masquerade(?:\/stop)?)|auth\/logout)$/, async (route) => {
      writes += 1;
      await writeReady;
      return route.fulfill({ status: 403, json: { error: 'Fixture refused identity write' } });
    });
    await page.getByRole('button', { name: 'Refresh fixture session' }).click();
    await expect.poll(() => reads).toBe(1);
    await page.evaluate((method) => {
      const actions = (window as unknown as { callFixture: { actions: Record<string, (...args: string[]) => Promise<void>> } }).callFixture.actions;
      const args = method === 'enterContext' ? ['social', 'participant'] : method === 'setRole' ? ['hr-admin'] : ['u-rachel'];
      void actions[method]!(...args).catch(() => {});
    }, change);
    await expect.poll(() => writes).toBe(1);
    const oldResponse = page.waitForResponse((response) => response.url().endsWith('/api/session/me'));
    releaseRead();
    await oldResponse;
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    await expect(page.getByTestId('fixture-actor')).toHaveText('u-vera');
    // Reads also stay paused during the incomplete cookie mutation.
    await page.getByRole('button', { name: 'Refresh fixture session' }).click();
    expect(reads).toBe(1);
    // Logout intentionally navigates even on failure; end the test before it.
    if (change !== 'logout') releaseWrite();
    expect(setup.errors).toEqual([]);
  });
}

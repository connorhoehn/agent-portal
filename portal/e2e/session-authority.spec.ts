import { test, expect } from './cdpTest';
import { signIn } from './realSession';
import { writeFile } from 'node:fs/promises';

test.use({ baseURL: 'http://localhost:5183', viewport: { width: 1024, height: 768 }, actionTimeout: 5000, navigationTimeout: 10000 });

test('only a BFF session refusal retires identity; concurrent reads and custom adapters revalidate and real login recovers', async ({ page }) => {
  test.setTimeout(45000);
  const renderFixture = (route: import('@playwright/test').Route) => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body><div id="root"></div>
    <script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true;
    </script><script type="module" src="/e2e/fixtures/session-authority.tsx"></script></body></html>` });
  await page.route('**/__session-authority', renderFixture);
  await page.route('**/workspaces?session-authority-fixture=1', renderFixture);
  await page.goto('/');
  await signIn(page, 'u-asha', { expectTenant: 'assessment', expectRole: 'assessor' });
  let retired = false, demoFallback = false, sessionReads = 0;
  const states: unknown[] = [], errors: string[] = [], writes: string[] = [];
  const refusal = { error: 'The session is no longer current. Sign in again.', code: 'SESSION_INVALID', ssoRequired: false };
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.method() !== 'GET' && new URL(request.url()).pathname.startsWith('/api/')) writes.push(new URL(request.url()).pathname); });
  await page.route('**/api/session/me', async route => {
    sessionReads++;
    if (retired) {
      // Leave /me outstanding long enough for both HTTP readers to report.
      await new Promise(resolve => setTimeout(resolve, 100));
      await route.fulfill({ status: 401, json: refusal });
    } else if (demoFallback) {
      await route.fulfill({ json: { sub: 'demo-user', name: 'Demo User', role: 'admin', tenant: 'orgiq',
        grants: { orgiq: ['admin'] }, switchable: {}, availableRoles: ['admin'], availableTenants: ['orgiq'], masquerading: null } });
    } else await route.continue();
  });
  await page.route('**/__auth-refusal/*', route => {
    const kind = new URL(route.request().url()).pathname.split('/').at(-1);
    return route.fulfill({ status: kind === 'forbidden' ? 403 : 401,
      json: kind === 'upstream' ? { error: 'Upstream token rejected' } : kind === 'forbidden' ? { error: 'Forbidden' } : refusal });
  });
  await page.route('**/api/social/embedded', route => route.fulfill({ status: 401, json: refusal }));
  await page.goto('/__session-authority');
  const fixture = page.getByTestId('session-authority-fixture'), actor = page.getByTestId('fixture-session-actor');
  await expect(fixture).toHaveAttribute('data-state', 'ready');
  await expect(actor).toHaveText('u-asha');
  const mountedReads = sessionReads;
  for (const kind of ['upstream', 'forbidden'] as const) {
    await page.getByRole('button', { name: kind === 'upstream' ? 'Read upstream' : 'Read forbidden', exact: true }).click();
    await expect(page.getByTestId('fixture-api-failure')).toContainText(kind === 'upstream' ? 'http / 401' : 'forbidden / 403');
    await expect(fixture).toHaveAttribute('data-state', 'ready');
    await expect(actor).toHaveText('u-asha');
    expect(sessionReads).toBe(mountedReads);
  }
  retired = true;
  await page.getByRole('button', { name: 'Read retired', exact: true }).click();
  await expect(page.getByTestId('session-recovery-gate')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(fixture).toHaveCount(0);
  await expect(page).toHaveURL('http://localhost:5183/__session-authority');
  await expect.poll(() => sessionReads).toBe(mountedReads + 1);
  states.push({ source: 'concurrent-useFetch', state: 'invalid', sessionReads });
  await page.screenshot({ path: test.info().outputPath('session-recovery-gate.png') });
  // The explicit native chooser exception lets the same provider fixture
  // inspect its state and recovery adapters without mounting private pages.
  await page.goto('/workspaces?session-authority-fixture=1');
  await expect(fixture).toHaveAttribute('data-state', 'invalid');
  await expect(actor).toHaveText('none');
  const chooserReads = sessionReads;
  retired = false; demoFallback = true;
  await page.getByRole('button', { name: 'Recheck session', exact: true }).click();
  await expect.poll(() => sessionReads).toBe(chooserReads + 1);
  await expect(fixture).toHaveAttribute('data-state', 'invalid');
  await expect(actor).toHaveText('none');
  states.push({ source: 'subsequent-demo-response', state: 'invalid' });

  const recover = async () => {
    retired = false; demoFallback = false;
    // The helper performs a real native picker login; it does not switch the
    // actor's tenant/role or mutate an epoch/grant to manufacture a failure.
    await signIn(page, 'u-asha', { expectTenant: 'assessment', expectRole: 'assessor' });
    await page.getByRole('button', { name: 'Recheck session', exact: true }).click();
    await expect(fixture).toHaveAttribute('data-state', 'ready');
    await expect(actor).toHaveText('u-asha');
  };
  await recover();
  for (const source of ['token', 'embedded'] as const) {
    retired = true;
    await page.getByRole('button', { name: source === 'token' ? 'Fetch refused token' : 'Fetch refused embedded Social', exact: true }).click();
    await expect(fixture).toHaveAttribute('data-state', 'invalid');
    await expect(actor).toHaveText('none');
    await expect(page.getByTestId('fixture-custom-adapter')).toHaveText(`${source}-refused`);
    states.push({ source, state: 'invalid' });
    await recover();
  }
  expect(writes.every(path => path === '/api/session/login')).toBe(true);
  expect(errors).toEqual([]);
  const path = test.info().outputPath('session-authority-proof.json');
  await writeFile(path, JSON.stringify({ observedAt: new Date().toISOString(), states, sessionReads, writes, errors,
    writeCapture: 'Page requests only; real picker logins use the APIRequestContext helper and are outside this observer.',
    final: { actor: 'u-asha', tenant: 'assessment', role: 'assessor', state: 'ready' },
    scope: 'Real owned Asha home Assessment session/login and SessionProvider; browser-supplied BFF refusal, upstream401,403 and demo-response protocol fixtures. Native stale-epoch/role/missing/actor checks are covered separately by middleware session-current tests. No actual epoch/grant changes, role/tenant switches, gateway, chat, calls, notifications, or global reset.' }, null, 2));
  await test.info().attach('session-authority-proof', { path, contentType: 'application/json' });
});

test('the actual Communication page rejects an owned invalid cookie and keeps one recovery gate at the requested URL', async ({ page, context }) => {
  test.setTimeout(45000);
  await page.goto('/');
  const principal = await signIn(page, 'u-eli', { expectTenant: 'orgiq', expectRole: 'sme' });
  const cookie = (await context.cookies()).find(value => value.name === 'orgiq.session');
  expect(cookie, 'the owned native login has a session cookie').toBeTruthy();
  // Change only this isolated context's signature bytes. Never decode/edit
  // claims, sign a token, or mutate the real account's epoch/grants.
  const rejected = { ...cookie!, value: `${cookie!.value}.invalid-signature` };
  const protocol: { path: string; status: number; code?: string; error?: string }[] = [];
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', async response => {
    const path = new URL(response.url()).pathname;
    if (path !== '/api/session/me' || response.status() !== 401) return;
    const body = await response.json();
    protocol.push({ path, status: response.status(), code: body.code, error: body.error });
  });
  await context.addCookies([rejected]);
  const requested = '/iq/communication?group=initiative:p-observability';
  // Page first: the real initial /me consumes the actual invalid credential.
  // Preflighting it would clear the cookie before the provider can remember
  // the refusal, correctly making a later page cookie-less instead.
  await page.goto(requested);
  const gate = page.getByTestId('session-recovery-gate');
  await expect(gate).toBeVisible({ timeout: 20000 });
  await expect(gate).toHaveCount(1);
  await expect(page).toHaveURL(`http://localhost:5183${requested}`);
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(page.locator('[data-testid*="composer"]')).toHaveCount(0);
  await expect(page.getByText('Eli Garcia', { exact: true })).toHaveCount(0);
  await expect.poll(() => protocol.filter(value => value.code === 'SESSION_INVALID').length).toBeGreaterThan(0);
  await page.screenshot({ path: test.info().outputPath('native-communication-session-recovery.png') });
  for (const path of ['/api/session/me', '/api/people/shared']) {
    // The real rejection clears this cookie; reinstall the same invalid
    // owned bytes for each independent native guard observation.
    await context.addCookies([rejected]);
    const response = await context.request.get(path);
    const body = await response.json();
    expect(response.status(), `native ${path}`).toBe(401);
    expect(body.code, `native ${path} protocol`).toBe('SESSION_INVALID');
    expect(body.sub).toBeUndefined();
    protocol.push({ path, status: response.status(), code: body.code, error: body.error });
  }
  await context.addCookies([rejected]);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL('http://localhost:5183/workspaces');
  await expect(page.getByTestId('select-people-grid')).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId('session-recovery-gate')).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('native-picker-after-invalid-cookie.png') });
  expect(errors).toEqual([]);
  const path = test.info().outputPath('native-communication-session-authority-proof.json');
  await writeFile(path, JSON.stringify({ observedAt: new Date().toISOString(),
    principal: { sub: principal.sub, tenant: principal.tenant, role: principal.role }, requested,
    protocol, gateCount: 1, requestedUrlRetained: true, composerCount: 0, staleActorHeaderCount: 0,
    pickerUrl: '/workspaces', pickerVisible: true, errors,
    scope: 'Actual unmocked Communication page/BFF, owned Eli home SME session, deliberately invalid signature in this isolated cookie jar only. No token/cookie values retained, signing/claim edits, actor epoch/grant changes, role/tenant switch, messages, notifications, calls, reset, or service restart.' }, null, 2));
  await test.info().attach('native-communication-session-authority-proof', { path, contentType: 'application/json' });
});

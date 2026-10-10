import { writeFile } from 'node:fs/promises';
import { test, expect } from './cdpTest';
import { signIn } from './realSession';
import type { Page } from '@playwright/test';

test.use({ viewport: { width: 1440, height: 900 }, actionTimeout: 5_000, navigationTimeout: 10_000 });

test('ordinary Work people hover uses self-disclosures without reading inferred detail', async ({ page }) => {
  const principal = await signIn(page, 'u-nora', { expectTenant: 'orgiq' });
  expect(principal.role).not.toBe('hr-admin');
  const graphReads: string[] = [], writes: string[] = [], errors: string[] = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/graph/people/')) graphReads.push(path);
    if (request.method() !== 'GET' && /\/api\//.test(path)) writes.push(`${request.method()} ${path}`);
  });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/iq/projects/p-observability?tab=contributors');
  const name = page.getByRole('link', { name: 'Nora DaSilva', exact: true });
  await expect(name).toBeVisible();
  await name.focus();
  await expect(page.getByRole('dialog', { name: 'About Nora DaSilva', exact: true })).toHaveCount(0);
  await page.keyboard.press('Space');
  const card = page.getByRole('dialog', { name: 'About Nora DaSilva', exact: true });
  await expect(card).toBeVisible();
  await expect(card).toContainText('Self-disclosed profile');
  await expect(card).toContainText('OpenTelemetry');
  await expect(card).toContainText('Certified Kubernetes Administrator');
  await expect(card).toContainText('OpenTelemetry instrumentation workshop');
  await expect(card).toContainText('Recent projects');
  await expect(card).not.toContainText('Linux Internals');
  await expect(card).not.toContainText('influence');
  await expect(card.getByRole('link', { name: 'Observability Platform', exact: true })).toHaveAttribute('href', '/iq/projects/p-observability');
  await expect(page.getByRole('region', { name: 'Person', exact: true })).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('ordinary-hover-wide.png') });
  const wide = await card.boundingBox();
  await page.setViewportSize({ width: 1024, height: 768 });
  // Reopen at the current anchor after layout changes, as a fresh hover does.
  await page.keyboard.press('Escape'); await expect(card).toHaveCount(0);
  await name.focus(); await page.keyboard.press('Space');
  await expect(card).toBeVisible();
  const narrow = await card.boundingBox();
  expect(narrow).toBeTruthy(); expect(narrow!.x).toBeGreaterThanOrEqual(0);
  expect(narrow!.x + narrow!.width).toBeLessThanOrEqual(1025);
  expect(narrow!.y + narrow!.height).toBeLessThanOrEqual(769);
  await page.screenshot({ path: test.info().outputPath('ordinary-hover-narrow.png') });
  const text = await card.innerText();
  await page.keyboard.press('Escape'); await expect(card).toHaveCount(0);
  await expect(name).toBeFocused(); await page.keyboard.press('Tab');
  await expect(name).not.toBeFocused();
  expect(graphReads).toEqual([]); expect(writes).toEqual([]); expect(errors).toEqual([]);
  await writeFile(test.info().outputPath('ordinary-hover.json'), JSON.stringify({ principal: { sub: principal.sub, tenant: principal.tenant, role: principal.role }, profileSource: 'Existing demoPublicProfiles fixture, shared with DirectoryPersonCard; no native public-profile API', text, wide, narrow, graphReads, writes, errors, noRoleTenantSwitches: true }, null, 2));
});

async function mountFixture(page: Page) {
  await page.route('**/__person-ref', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body><div id="root"></div>
    <script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true;
    </script><script type="module" src="/e2e/fixtures/person-ref.tsx"></script></body></html>` }));
  await page.route('**/api/auth/config', route => route.fulfill({ json: { ssoEnabled: false } }));
  await page.goto('/__person-ref');
}

test('inferred hover is lazy and a delayed HR response cannot survive actor, person or tenant changes', async ({ page }) => {
  let authority = { sub: 'fixture-hr', tenant: 'orgiq', role: 'hr-admin' }, signedOut = false;
  const reads: string[] = [], errors: string[] = [], writes: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.method() !== 'GET') writes.push(request.url()); });
  await page.route('**/api/session/me', route => route.fulfill(signedOut ? { status: 401, json: { code: 'SESSION_REQUIRED' } } : { json: { ...authority, name: 'Rendering fixture', grants: { [authority.tenant]: [authority.role] }, masquerading: null } }));
  let releaseOld!: () => void;
  const held = new Promise<void>(resolve => { releaseOld = resolve; });
  let oldFulfilled = false;
  await page.route('**/api/graph/people/*', async route => {
    const id = new URL(route.request().url()).pathname.split('/').pop()!;
    const oldRequest = reads.length === 0;
    reads.push(id);
    if (oldRequest) await held;
    await route.fulfill({ json: { id, name: id === 'p-004' ? 'Nora DaSilva' : 'Layla Hassan', skills: [oldRequest ? 'Old HR inferred skill' : 'Current HR inferred skill'] } });
    if (oldRequest) oldFulfilled = true;
  });
  await mountFixture(page);
  await expect(page.getByTestId('fixture-authority')).toContainText('ready · fixture-hr');
  expect(reads).toEqual([]);
  const open = async (name: string, role: 'link' | 'button' = 'link') => {
    const trigger = page.getByRole(role, { name, exact: true });
    await trigger.focus(); await page.keyboard.press('Space');
    await expect(page.getByRole('dialog', { name: `About ${name}`, exact: true })).toBeVisible();
  };
  await open('Nora DaSilva'); await expect.poll(() => reads.length).toBe(1);
  authority = { sub: 'fixture-other-hr', tenant: 'orgiq', role: 'hr-admin' };
  await page.getByRole('button', { name: 'Refresh fixture authority', exact: true }).click();
  await expect(page.getByTestId('fixture-authority')).toContainText('ready · fixture-other-hr');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await open('Nora DaSilva');
  await expect(page.getByRole('dialog')).toContainText('Current HR inferred skill');
  await page.getByRole('button', { name: 'Show layla', exact: true }).click();
  await open('Layla Hassan');
  await expect(page.getByRole('dialog')).toContainText('Current HR inferred skill');
  await expect(page.getByRole('dialog')).not.toContainText('Old HR inferred skill');
  authority = { sub: 'fixture-member', tenant: 'orgiq', role: 'member' };
  await page.getByRole('button', { name: 'Refresh fixture authority', exact: true }).click();
  await expect(page.getByTestId('fixture-authority')).toContainText('ready · fixture-member');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await open('Layla Hassan');
  // Release the old actor/person request only after the replacement scope
  // is visibly public. It cannot inject inferred details into this card.
  releaseOld();
  await expect.poll(() => oldFulfilled).toBe(true);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByRole('dialog')).toContainText('Site reliability engineering bootcamp');
  await expect(page.getByRole('dialog')).not.toContainText('inferred skill');
  await page.getByRole('button', { name: 'Show missing', exact: true }).click();
  await open('Fixture person');
  await expect(page.getByRole('dialog')).toContainText('No skills or credentials shared yet.');
  await expect(page.getByRole('dialog')).not.toContainText('Certified');
  authority = { sub: 'fixture-other-tenant', tenant: 'assessment', role: 'admin' };
  await page.getByRole('button', { name: 'Refresh fixture authority', exact: true }).click();
  await expect(page.getByTestId('fixture-authority')).toContainText('assessment');
  await page.getByRole('button', { name: 'Show nora', exact: true }).click(); await open('Nora DaSilva', 'button');
  await expect(page.getByRole('dialog')).toContainText('Certified Kubernetes Administrator');
  await expect(page.getByRole('dialog').getByRole('link')).toHaveCount(0);
  signedOut = true;
  await page.getByRole('button', { name: 'Refresh fixture authority', exact: true }).click();
  await expect(page.getByTestId('fixture-authority')).toContainText('signed-out');
  await open('Nora DaSilva', 'button');
  await expect(page.getByRole('dialog')).not.toContainText('Self-disclosed');
  await expect(page.getByRole('dialog')).not.toContainText('inferred skill');
  expect(reads).toEqual(['p-004', 'p-004', 'p-008']); expect(writes).toEqual([]); expect(errors).toEqual([]);
  await writeFile(test.info().outputPath('hover-scope-fence.json'), JSON.stringify({ controlledRenderingOnly: true, nativeAuthorityChanged: false, reads, writes, errors, oldResponseFulfilledAfterReplacement: oldFulfilled, coverage: ['HR lazy fetch', 'same-role HR actor replacement issues a fresh scoped read', 'delayed previous actor/person response discarded after public scope replacement', 'actor/role change resets card', 'missing public disclosure is explicit', 'other tenant has no Work links or graph read', 'signed-out card is identity-only'] }, null, 2));
});

test('public hover stays visible at the lower edge, while pinned and when content exceeds the viewport', async ({ page }) => {
  const errors: string[] = [], graphReads: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (/ResizeObserver loop|Maximum update depth/.test(message.text())) errors.push(message.text()); });
  page.on('request', request => { if (/\/api\/graph\/people\//.test(request.url())) graphReads.push(request.url()); });
  await page.route('**/api/session/me', route => route.fulfill({ json: { sub: 'fixture-member', name: 'Rendering fixture', tenant: 'orgiq', role: 'member', grants: { orgiq: ['member'] } } }));
  await mountFixture(page);
  await expect(page.getByTestId('fixture-authority')).toContainText('ready');
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.getByRole('button', { name: 'Move person to lower edge', exact: true }).click();
  const name = page.getByRole('link', { name: 'Nora DaSilva', exact: true });
  await name.focus(); await page.keyboard.press('Space');
  const card = page.getByRole('dialog', { name: 'About Nora DaSilva', exact: true });
  await expect(card).toContainText('Certified Kubernetes Administrator');
  const inside = async () => {
    const rect = await card.boundingBox();
    const viewport = page.viewportSize()!;
    return !!rect && rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= viewport.width && rect.y + rect.height <= viewport.height;
  };
  await expect.poll(inside).toBe(true);
  await expect(card).toHaveAttribute('data-pinned', 'true');
  const lower = await card.boundingBox();
  await page.screenshot({ path: test.info().outputPath('public-hover-lower-edge.png') });
  await page.setViewportSize({ width: 440, height: 480 });
  await expect.poll(inside).toBe(true);
  await expect(card.getByRole('link', { name: 'Observability Platform', exact: true })).toBeVisible();
  const resized = await card.boundingBox();
  await page.keyboard.press('Escape'); await expect(card).toHaveCount(0); await expect(name).toBeFocused();
  await page.getByRole('button', { name: 'Show oversized detail', exact: true }).click();
  const oversizedTrigger = page.getByRole('button', { name: 'Open oversized detail', exact: true });
  await oversizedTrigger.focus(); await page.keyboard.press('Space');
  const oversized = page.getByRole('dialog', { name: 'Oversized detail', exact: true });
  await expect(oversized).toBeVisible();
  await expect.poll(async () => {
    const rect = await oversized.boundingBox();
    return !!rect && rect.y >= 0 && rect.y + rect.height <= 480 && rect.x >= 0 && rect.x + rect.width <= 440;
  }).toBe(true);
  const initialDetail = await oversized.boundingBox();
  await oversized.getByRole('button', { name: 'Load remaining details', exact: true }).click();
  await expect(oversized).toContainText('Detail line 30');
  await expect.poll(async () => {
    const rect = await oversized.boundingBox();
    return !!rect && rect.y >= 0 && rect.y + rect.height <= 480 && rect.x >= 0 && rect.x + rect.width <= 440;
  }).toBe(true);
  const scroll = await oversized.evaluate(element => ({ clientHeight: element.clientHeight, scrollHeight: element.scrollHeight }));
  expect(scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight);
  expect((await oversized.boundingBox())!.height).toBeGreaterThan(initialDetail!.height);
  const last = oversized.getByRole('link', { name: 'Last detail', exact: true });
  await last.scrollIntoViewIfNeeded(); await expect(last).toBeInViewport();
  await page.screenshot({ path: test.info().outputPath('public-hover-oversized-scroll.png') });
  await oversizedTrigger.focus(); await page.keyboard.press('Tab'); await expect(oversizedTrigger).not.toBeFocused();
  await page.keyboard.press('Escape'); await expect(oversized).toHaveCount(0);
  expect(graphReads).toEqual([]); expect(errors).toEqual([]);
  await writeFile(test.info().outputPath('hover-viewport-bounds.json'), JSON.stringify({ controlledRenderingOnly: true, lower, resized, initialDetail, scroll, dynamicDetailGrowthWhilePinned: true, errors, graphReads, nativeIdentityOrAssetChanges: false }, null, 2));
});

test('native lower contributor hovers preserve complete public cards without inferred reads', async ({ page }) => {
  const principal = await signIn(page, 'u-nora', { expectTenant: 'orgiq' });
  expect(principal.role).not.toBe('hr-admin');
  const graphReads: string[] = [], errors: string[] = [], writes: string[] = [], cards: Record<string, unknown>[] = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/graph/people/')) graphReads.push(path);
    if (request.method() !== 'GET' && path.startsWith('/api/')) writes.push(`${request.method()} ${path}`);
  });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/iq/projects/p-observability?tab=contributors');
  for (const viewport of [{ width: 1024, height: 768 }, { width: 1024, height: 600 }]) {
    await page.setViewportSize(viewport);
    for (const name of ['Layla Hassan', 'Eli Garcia']) {
      const trigger = page.getByRole('link', { name, exact: true });
      await trigger.scrollIntoViewIfNeeded(); await trigger.focus(); await page.keyboard.press('Space');
      const card = page.getByRole('dialog', { name: `About ${name}`, exact: true });
      await expect(card).toContainText('Self-disclosed profile');
      await expect(card).toContainText('Recent projects');
      await expect.poll(async () => {
        const rect = await card.boundingBox();
        return !!rect && rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= viewport.width && rect.y + rect.height <= viewport.height;
      }).toBe(true);
      const project = card.getByRole('link', { name: 'Observability Platform', exact: true });
      await project.scrollIntoViewIfNeeded(); await expect(project).toBeInViewport();
      const horizontal = await card.evaluate(element => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }));
      expect(horizontal.scrollWidth).toBeLessThanOrEqual(horizontal.clientWidth);
      cards.push({ name, viewport, rect: await card.boundingBox(), horizontal, text: await card.innerText(), placement: await card.getAttribute('data-viewport-placement') });
      await page.screenshot({ path: test.info().outputPath(`ordinary-hover-${name.split(' ')[0].toLowerCase()}-${viewport.height}.png`) });
      await trigger.focus(); await page.keyboard.press('Escape'); await expect(card).toHaveCount(0);
    }
  }
  expect(graphReads).toEqual([]); expect(writes).toEqual([]); expect(errors).toEqual([]);
  await writeFile(test.info().outputPath('native-lower-hover-bounds.json'), JSON.stringify({ principal: { sub: principal.sub, tenant: principal.tenant, role: principal.role }, cards, graphReads, writes, errors, noRoleTenantSwitches: true, nativeAssetsChanged: false }, null, 2));
});

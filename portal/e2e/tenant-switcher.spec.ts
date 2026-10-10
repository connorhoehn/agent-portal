import { expect, test, type Page } from '@playwright/test';
test.use({ baseURL: 'http://127.0.0.1:5183', viewport: { width: 1280, height: 850 } });
interface Fixture { empty?: boolean; switchError?: boolean; connected?: boolean; requests: { method: string; path: string; body: unknown }[] }
const selector = '[data-shell-nav] > div > aside:first-child nav > section';
async function mount(page: Page, options: Partial<Fixture> = {}) {
  const state: Fixture = { requests: [], ...options }, errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/src/lib/conversationCall.tsx*', route => route.fulfill({ contentType: 'text/javascript', body: "export { useCallHost } from '/e2e/fixtures/tenant-switcher.tsx';" }));
  if (options.connected) await page.route('**/src/lib/gatewayFrames.ts*', route => route.fulfill({ contentType: 'text/javascript', body: "export function useGatewayFrames(){ return { connectionState: 'connected' }; }" }));
  await page.route('**/api/**', route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    state.requests.push({ method: request.method(), path, body: request.postData() ? request.postDataJSON() : null });
    if (path === '/api/session/me') return route.fulfill({ json: { sub: 'inert-tenant-reader', name: 'Fixture Reviewer', tenant: 'orgiq', role: 'member', availableRoles: ['member', 'org-leader'], grants: { orgiq: ['member'], ...(state.empty ? {} : { assessment: ['assessor'], social: ['participant'] }) }, switchable: { orgiq: ['member', 'org-leader'], ...(state.empty ? {} : { assessment: ['assessor'], social: ['participant'] }) }, availableTenants: state.empty ? ['orgiq'] : ['orgiq', 'assessment', 'social'], masquerading: null } });
    if (path === '/api/auth/config') return route.fulfill({ json: { ssoEnabled: false } });
    if (path === '/api/session/tenant') return route.fulfill(state.switchError ? { status: 403, json: { error: 'This fixture tenant is no longer available.' } } : { status: 204 });
    return route.fulfill({ status: 503, json: { error: 'Unmocked tenant fixture API denied' } });
  });
  await page.route('**/assessment/teams', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><h1>Fixture Assessment destination</h1>' }));
  await page.route('**/__tenant-switcher', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script><script type="module" src="/e2e/fixtures/tenant-switcher.tsx"></script></body></html>' }));
  await page.goto('/__tenant-switcher'); await expect(page.getByTestId('fixture-actor')).toHaveText('inert-tenant-reader');
  return { state, errors };
}
test('hover and keyboard open only authorized tenant destinations with actual native unread updates', async ({ page }) => {
  const { state, errors } = await mount(page);
  const trigger = page.getByRole('button', { name: 'Work: switch tenant' }), dialog = page.getByRole('dialog', { name: 'Switch tenant' });
  await trigger.hover(); await expect(dialog).toBeVisible(); await expect(dialog.getByRole('button', { name: /Assessment/ })).toBeVisible();
  await expect(dialog.getByRole('button', { name: /^Social$/ })).toBeVisible(); await expect(dialog.getByText('Pipelines')).toHaveCount(0);
  await expect(dialog.getByText(/Member|Leader|Assessor|Participant/)).toHaveCount(0); await expect(dialog.locator('.tenant-unread')).toHaveCount(0);
  await expect(dialog.locator('.tenant-destination')).toHaveCount(2); await expect(dialog.locator('.tenant-activity[data-status="unavailable"]')).toHaveCount(2);
  await dialog.locator('.tenant-activity').first().focus(); await expect(page.getByRole('tooltip')).toHaveText('Live notification updates are currently unavailable.');
  const rowStyle = await dialog.locator('.tenant-destination').first().evaluate(element => ({ top: getComputedStyle(element).borderTopWidth, bottom: getComputedStyle(element).borderBottomWidth }));
  expect(rowStyle).toEqual({ top: '0px', bottom: '0px' });
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: 'Receive inert native inbox frames' }).click();
  await trigger.focus(); await page.keyboard.press('ArrowDown'); await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: /Assessment/ })).toBeFocused(); await expect(dialog.locator('.tenant-unread')).toHaveText('2');
  await expect(dialog.getByRole('group', { name: 'Assessment, 2 unread notifications' })).toBeVisible();
  const assessment = dialog.getByRole('group', { name: 'Assessment, 2 unread notifications' });
  const actionBox = (await assessment.getByRole('button', { name: 'Assessment', exact: true }).boundingBox())!, activityBox = (await assessment.getByRole('img', { name: /Assessment: 2 unread notices/ }).boundingBox())!;
  expect(activityBox.x).toBeGreaterThanOrEqual(actionBox.x + actionBox.width);
  await assessment.getByRole('img', { name: /Assessment: 2 unread notices/ }).focus(); await expect(page.getByRole('tooltip')).toHaveText('2 unread notices in this inbox. Live updates are currently unavailable.');
  await page.getByRole('button', { name: 'Receive inert read acknowledgement' }).click(); await trigger.click();
  await expect(dialog.locator('.tenant-unread')).toHaveText('1'); await expect(dialog.getByRole('group', { name: /^Assessment, 1 unread notification/ })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('tenant-dropdown-native.png') });
  await page.getByRole('button', { name: /Fixture Reviewer/ }).click();
  await expect(dialog).toHaveCount(0); await expect(page.getByRole('dialog', { name: 'Account menu' })).toContainText('Role in Work');
  expect(state.requests.filter(request => request.method !== 'GET')).toEqual([]); expect(errors).toEqual([]);
});
test('tenant-only switch uses the existing tenant boundary without changing a role', async ({ page }) => {
  const { state, errors } = await mount(page, { connected: true }); await page.getByRole('button', { name: 'Work: switch tenant' }).click();
  const dialog = page.getByRole('dialog', { name: 'Switch tenant' }); await expect(dialog.locator('.tenant-activity[data-status="empty"]')).toHaveCount(2);
  await dialog.locator('.tenant-activity').first().focus(); await expect(page.getByRole('tooltip')).toHaveText('No unread notices in this inbox.');
  await page.getByRole('dialog', { name: 'Switch tenant' }).getByRole('button', { name: /^Assessment$/ }).click();
  await expect(page.getByRole('heading', { name: 'Fixture Assessment destination' })).toBeVisible();
  expect(state.requests.filter(request => request.method !== 'GET')).toEqual([{ method: 'POST', path: '/api/session/tenant', body: { tenant: 'assessment' } }]); expect(errors).toEqual([]);
});
test('empty destinations and server refusal stay truthful and recoverable', async ({ page }) => {
  const { state, errors } = await mount(page, { empty: true }); const trigger = page.getByRole('button', { name: 'Work: switch tenant' });
  await trigger.click(); const dialog = page.getByRole('dialog', { name: 'Switch tenant' });
  await expect(dialog).toContainText('No other tenants are available for your account.'); await expect(dialog.getByRole('button')).toHaveCount(0);
  await page.keyboard.press('Escape'); state.empty = false; state.switchError = true;
  await page.getByRole('button', { name: 'Refresh fixture session' }).click(); await trigger.click();
  await dialog.getByRole('button', { name: /^Assessment$/ }).click(); await expect(dialog).toContainText('no longer available'); await expect(dialog.getByRole('button', { name: /^Social$/ })).toBeEnabled(); expect(errors).toEqual([]);
});
test('an active canonical call blocks tenant switches even when only its media failed', async ({ page }) => {
  const { state, errors } = await mount(page); await page.getByRole('button', { name: 'Show an inert live call' }).click();
  await page.getByRole('button', { name: 'Work: switch tenant' }).click(); const dialog = page.getByRole('dialog', { name: 'Switch tenant' });
  await expect(dialog.getByRole('button', { name: /^Assessment$/ })).toBeDisabled(); await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Fail inert media while call remains owned' }).click(); await page.getByRole('button', { name: 'Work: switch tenant' }).click();
  await expect(dialog.getByRole('button', { name: /^Assessment$/ })).toBeDisabled();
  expect(state.requests.filter(request => request.method !== 'GET')).toEqual([]); expect(errors).toEqual([]);
});
test('reusable visitors bind expanded rails and arbitrary surfaces with bounded two-pose motion', async ({ page }) => {
  const { errors } = await mount(page);
  const sections = page.locator(selector); await expect(sections).toHaveCount(3);
  const visitors = page.locator('[data-ambient-visitor="mouse"]'); await expect(visitors).toHaveCount(5);
  const style = await visitors.first().evaluate(element => {
    const side = getComputedStyle(element.firstElementChild!);
    return { width: side.width, height: side.height, duration: side.animationDuration, image: side.backgroundImage, overflow: getComputedStyle(element).overflow, pointer: getComputedStyle(element).pointerEvents, position: getComputedStyle(element).position };
  });
  expect(style).toMatchObject({ width: '24px', height: '15px', duration: '48s, 48s', overflow: 'hidden', pointer: 'none', position: 'fixed' }); expect(style.image).toContain('data:image/svg+xml');
  const bounds = await page.evaluate(() => {
    const targets = Array.from(document.querySelectorAll('[data-visitor-surface], [data-shell-nav] > div > aside:first-child nav > section:has(> button[aria-expanded="true"])'));
    return Array.from(document.querySelectorAll('[data-ambient-visitor="mouse"]')).map((element, i) => {
      const box = element.getBoundingClientRect(), target = targets[i]!.getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, targetLeft: target.left, targetRight: target.right, targetBottom: target.bottom, clip: getComputedStyle(element).clipPath };
    });
  });
  for (const bound of bounds) { expect(bound.left).toBe(bound.targetLeft); expect(bound.right).toBe(bound.targetRight); expect(bound.bottom).toBe(bound.targetBottom); expect(bound.clip).toContain('inset('); }
  const orbit = page.locator('.tenant-brand-orbit > span'); expect(await orbit.evaluate(element => getComputedStyle(element).animationDuration)).toBe('5s');
  const poses = await visitors.first().evaluate(async element => {
    const animations = element.getAnimations({ subtree: true });
    const take = async (time: number) => { animations.forEach(animation => { animation.pause(); animation.currentTime = time; }); await new Promise<void>(r => requestAnimationFrame(() => r())); const side = getComputedStyle(element.children[0]!), face = getComputedStyle(element.children[1]!); return { left: side.left, side: Number(side.opacity), face: Number(face.opacity), transform: side.transform }; };
    return { enter: await take(0), moving: await take(144), look: await take(1560), exit: await take(3360), animationNames: animations.map(animation => (animation as CSSAnimation).animationName) };
  });
  expect(poses.animationNames).toContain('ambient-visitor-look'); expect(poses.enter.left).toBe('-24px'); expect(poses.enter.side).toBeGreaterThan(0); expect(poses.moving.transform).not.toBe(poses.enter.transform); expect(poses.look.side).toBe(0); expect(poses.look.face).toBeGreaterThan(0); expect(poses.exit.face).toBe(0); expect(poses.exit.left).not.toBe(poses.look.left);
  await sections.first().getByRole('button', { name: 'Plan' }).click(); await expect(visitors).toHaveCount(4);
  await page.screenshot({ path: test.info().outputPath('ambient-targets-native.png') });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  const beam = await visitors.first().locator('.ambient-visitor-side').evaluate(element => ({ content: getComputedStyle(element, '::before').content, clip: getComputedStyle(element, '::before').clipPath, background: getComputedStyle(element, '::before').backgroundImage, filter: getComputedStyle(element).filter }));
  expect(beam.content).toBe('""'); expect(beam.clip).toContain('polygon('); expect(beam.background).toContain('linear-gradient'); expect(beam.filter).toContain('brightness(1.2)');
  // A staggered visitor must not leave its projecting lamp visible before it
  // enters, or while it is parked offscreen between visits.
  const idleLights = await visitors.evaluateAll(elements => elements.map(element => {
    const pose = element.firstElementChild!;
    const delay = Number.parseFloat(getComputedStyle(pose).animationDelay) * 1000;
    const animations = element.getAnimations({ subtree: true });
    const at = (time: number) => {
      animations.forEach(animation => { animation.pause(); animation.currentTime = time; });
      return { mouse: getComputedStyle(pose).visibility, beam: getComputedStyle(pose, '::before').visibility };
    };
    return { delayed: delay > 0 ? at(delay / 2) : null, visiting: at(delay + 720), parked: at(delay + 5000) };
  }));
  for (const light of idleLights) {
    if (light.delayed) expect(light.delayed).toEqual({ mouse: 'hidden', beam: 'hidden' });
    expect(light.visiting).toEqual({ mouse: 'visible', beam: 'visible' });
    expect(light.parked).toEqual({ mouse: 'hidden', beam: 'hidden' });
  }
  await page.screenshot({ path: test.info().outputPath('ambient-dark-idle-no-lights.png') });
  await visitors.evaluateAll(elements => elements.forEach(element => element.getAnimations({ subtree: true }).forEach(animation => { animation.pause(); animation.currentTime = 720 + Number.parseFloat(getComputedStyle(element.firstElementChild!).animationDelay) * 1000; })));
  await page.screenshot({ path: test.info().outputPath('ambient-targets-dark-headlamp.png') });
  await page.getByRole('button', { name: 'Work: switch tenant' }).click(); await expect(page.getByRole('checkbox', { name: 'Ambient animations' })).toHaveCount(0);
  await page.evaluate(() => localStorage.setItem('shell.ambient-motion', 'off'));
  await page.reload(); await expect.poll(() => page.evaluate(() => document.documentElement.dataset.shellMotion)).toBe('off');
  expect(await orbit.evaluate(element => getComputedStyle(element).animationName)).toBe('none'); await expect(visitors).toHaveCount(0);
  await page.evaluate(() => localStorage.setItem('shell.ambient-motion', 'on')); await page.reload(); await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await page.locator('.tenant-brand-orbit > span').evaluate(element => getComputedStyle(element).animationName)).toBe('none'); await expect(visitors).toHaveCount(0); expect(errors).toEqual([]);
});

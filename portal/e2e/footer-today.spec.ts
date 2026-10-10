import { expect, test, type Page } from '@playwright/test';

async function mount(page: Page, query = '') {
  const errors: string[] = [], mutations: string[] = [];
  let identity = { sub: 'fixture-reader', name: 'Fixture Reviewer', tenant: 'orgiq', role: 'member', grants: {}, switchable: {}, availableRoles: ['member'], masquerading: null };
  page.on('pageerror', error => errors.push(error.message));
  for (const [path, names] of [
    ['src/lib/conversationCall.tsx', 'useCallHost, useCallBlockPlacement, useCallMediaPanel, callCounts, callDrawn'],
    ['src/components/shell/HuddleChat.tsx', 'useHuddleChatToggle, HuddleReactionBar'],
    ['src/components/shell/ShellCallHost.tsx', 'ShellCallMedia'],
    ['src/components/shell/EmbeddedSocial.tsx', 'EmbeddedSocialEntry'],
  ]) await page.route(`**/${path}*`, route => route.fulfill({ contentType: 'text/javascript', body: `export { ${names} } from '/e2e/fixtures/footer-today.tsx';` }));
  await page.route('**/api/**', route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() !== 'GET') mutations.push(path);
    if (path === '/api/session/me') return route.fulfill({ json: identity });
    if (path === '/api/auth/config') return route.fulfill({ json: { ssoEnabled: false } });
    return route.fulfill({ status: 503, json: { error: 'The inert fixture denies all unmocked APIs.' } });
  });
  await page.route('**/__footer-today*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script><script type="module" src="/e2e/fixtures/footer-today.tsx"></script></body></html>' }));
  await page.goto(`/__footer-today${query}`);
  await expect(page.getByTestId('today-identity')).toContainText('fixture-reader');
  await expect(page.getByTestId('footer-today')).toBeVisible();
  return { errors, mutations, identity: async (sub: string, tenant: string) => {
    identity = { ...identity, sub, tenant };
    await page.getByRole('button', { name: 'Refresh fixture identity' }).click();
    await expect(page.getByTestId('today-identity')).toContainText(`"sub":"${sub}","tenant":"${tenant}"`);
  } };
}
const summary = (page: Page) => page.getByRole('button', { name: /^Demo today:/ });
async function controls(page: Page) { await summary(page).focus(); await page.keyboard.press('ArrowUp'); await expect(page.getByRole('toolbar', { name: 'Sample Today controls' })).toBeVisible(); }
async function settings(page: Page) { await controls(page); await page.getByRole('button', { name: 'Sample Today settings', exact: true }).click(); await expect(page.getByRole('dialog', { name: 'Sample Today settings', exact: true })).toBeVisible(); }
async function unfocus(page: Page) { await page.getByRole('button', { name: 'Outside focus target' }).focus(); await page.mouse.move(5, 5); await page.clock.runFor(200); }

test('demo is visible in spare footer space with native floating icons, anchored details and safe navigation', async ({ page }) => {
  const fixture = await mount(page);
  await expect(summary(page)).toContainText('Demo'); await expect(summary(page)).toContainText('Needs review');
  await expect(page.getByRole('toolbar', { name: 'Sample Today controls' })).toHaveCount(0);
  await controls(page);
  const toolbar = page.getByRole('toolbar', { name: 'Sample Today controls' });
  await expect(toolbar.getByRole('button')).toHaveCount(6);
  for (const button of await toolbar.getByRole('button').all()) { await expect(button.locator('svg')).toHaveCount(1); await expect(button).toHaveText(''); }
  const toolsBox = (await toolbar.boundingBox())!;
  expect(toolsBox.y + toolsBox.height).toBeLessThanOrEqual((await summary(page).boundingBox())!.y + 1);
  await summary(page).click(); const detail = page.getByRole('dialog', { name: 'Sample Today details' });
  await expect(detail).toContainText('No live activity is connected'); await expect(detail).toContainText('Sample:');
  expect((await detail.boundingBox())!.y + (await detail.boundingBox())!.height).toBeLessThan((await summary(page).boundingBox())!.y);
  await page.screenshot({ path: test.info().outputPath('today-demo-details.png') });
  await detail.getByRole('button', { name: 'Open workspace' }).click(); await expect(page.getByTestId('today-location')).toHaveText('/iq/projects');
  expect(fixture.errors).toEqual([]); expect(fixture.mutations).toEqual([]);
});

test('rotation respects speed, hover and keyboard focus, pause, open settings and manual category priority', async ({ page }) => {
  await page.clock.install(); const fixture = await mount(page);
  await page.clock.runFor(12000); await expect(summary(page)).toHaveAccessibleName(/Agenda/);
  await summary(page).hover(); await page.clock.runFor(24000); await expect(summary(page)).toHaveAccessibleName(/Agenda/);
  await controls(page); await page.getByRole('button', { name: 'Rotation speed: slow' }).click();
  await expect(page.getByRole('button', { name: 'Rotation speed: fast' })).toBeVisible();
  await page.clock.runFor(12000); await expect(summary(page)).toHaveAccessibleName(/Agenda/);
  await unfocus(page); await page.clock.runFor(6000); await expect(summary(page)).toHaveAccessibleName(/Goals/);
  await controls(page); await page.getByRole('button', { name: 'Pause sample rotation' }).click(); await unfocus(page);
  await page.clock.runFor(18000); await expect(summary(page)).toHaveAccessibleName(/Goals/);
  await controls(page); await page.getByRole('button', { name: 'Resume sample rotation' }).click();
  await settings(page); await page.clock.runFor(24000); await expect(summary(page)).toHaveAccessibleName(/Goals/);
  const panel = page.getByRole('dialog', { name: 'Sample Today settings', exact: true });
  for (const name of ['Needs review', 'Agenda', 'Goals', 'Automation']) await panel.getByRole('checkbox', { name, exact: true }).uncheck();
  await expect(summary(page)).toHaveAccessibleName(/Budget/);
  await panel.getByRole('checkbox', { name: 'Agenda', exact: true }).check(); await expect(summary(page)).toHaveAccessibleName(/Agenda/);
  await panel.getByRole('checkbox', { name: 'Quiet rotation · manual only' }).check();
  await panel.getByRole('button', { name: 'Close Today panel' }).click(); await unfocus(page); await page.clock.runFor(24000);
  await expect(summary(page)).toHaveAccessibleName(/Agenda/); await controls(page); await page.getByRole('button', { name: 'Next sample' }).click(); await expect(summary(page)).toHaveAccessibleName(/Budget/);
  expect(fixture.errors).toEqual([]); expect(fixture.mutations).toEqual([]);
});

test('hide, restore, dim and settings persist only for the exact signed identity and workspace', async ({ page }) => {
  const fixture = await mount(page); await controls(page);
  await page.getByRole('button', { name: 'Dim sample Today strip' }).click(); await expect(summary(page)).toHaveAttribute('data-dimmed', 'true');
  expect(await summary(page).evaluate(element => Number(getComputedStyle(element).opacity))).toBe(.8);
  await page.getByRole('button', { name: 'Hide sample Today strip' }).click(); await expect(summary(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Restore sample Today strip' })).toBeFocused();
  await page.reload(); await expect(page.getByRole('button', { name: 'Restore sample Today strip' })).toBeVisible();
  await fixture.identity('other-reader', 'orgiq'); await expect(summary(page)).toBeVisible(); await expect(summary(page)).not.toHaveAttribute('data-dimmed', 'true');
  await fixture.identity('fixture-reader', 'assessment'); await expect(summary(page)).toBeVisible();
  await fixture.identity('fixture-reader', 'orgiq'); await expect(page.getByRole('button', { name: 'Restore sample Today strip' })).toBeVisible();
  await page.getByRole('button', { name: 'Restore sample Today strip' }).click(); await expect(summary(page)).toBeFocused(); await expect(summary(page)).toHaveAttribute('data-dimmed', 'true');
  await settings(page); await expect(page.getByRole('dialog')).toContainText('Saved for your identity in this workspace');
  expect(fixture.errors).toEqual([]); expect(fixture.mutations).toEqual([]);
});

test('reduced motion stays manual and an empty category selection has a clear recoverable state', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' }); await page.clock.install(); const fixture = await mount(page);
  await page.clock.runFor(60000); await expect(summary(page)).toHaveAccessibleName(/Needs review/);
  await settings(page); const panel = page.getByRole('dialog', { name: 'Sample Today settings', exact: true });
  await expect(panel).toContainText('Reduced motion is on');
  for (const name of ['Needs review', 'Agenda', 'Goals', 'Automation', 'Budget']) await panel.getByRole('checkbox', { name, exact: true }).uncheck();
  await expect(summary(page)).toHaveAccessibleName(/no sample categories selected/);
  await expect(page.getByRole('button', { name: 'Next sample' })).toBeDisabled();
  await panel.getByRole('checkbox', { name: 'Goals', exact: true }).check(); await expect(summary(page)).toHaveAccessibleName(/Goals/);
  await panel.getByRole('checkbox', { name: 'Agenda', exact: true }).check(); await expect(summary(page)).toHaveAccessibleName(/Agenda/);
  await panel.getByRole('button', { name: 'Close Today panel' }).click(); await page.getByRole('button', { name: 'Next sample' }).click(); await expect(summary(page)).toHaveAccessibleName(/Goals/);
  expect(fixture.errors).toEqual([]); expect(fixture.mutations).toEqual([]);
});

test('ticker yields to native active call controls and vanishes at narrow widths without footer height or horizontal drift', async ({ page }) => {
  await page.clock.install(); const fixture = await mount(page);
  const footer = page.getByTestId('shell-footer');
  async function noTickerHeightDrift() {
    const before = (await footer.boundingBox())!.height;
    // Compare the same native call state with and without the ticker. Live
    // controls legitimately differ from idle; the ticker must add no height.
    const without = await page.getByTestId('footer-today').evaluate(element => {
      const previous = element.style.display; element.style.display = 'none';
      try { return element.closest('footer')!.getBoundingClientRect().height; }
      finally { element.style.display = previous; }
    });
    expect(Math.round(before)).toBe(Math.round(without));
  }
  await noTickerHeightDrift();
  await page.screenshot({ path: test.info().outputPath('today-footer-wide.png') });
  await page.getByRole('button', { name: 'Toggle inert huddle' }).click();
  await expect(page.getByTestId('footer-today')).toHaveAttribute('data-call', 'true');
  await page.clock.runFor(24000); await expect(summary(page)).toHaveAccessibleName(/Needs review/);
  const dock = page.getByTestId('shell-call-dock');
  await dock.getByTestId('shell-call-dock-mic').click(); await expect(page.getByTestId('today-call')).toContainText('"micOn":true');
  for (const width of [1440, 1024, 780, 600, 420]) {
    await page.setViewportSize({ width, height: 900 });
    const leave = dock.getByTestId('shell-call-dock-leave'), box = (await leave.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width);
    if (width <= 780) await expect(page.getByTestId('footer-today')).toBeHidden();
    await noTickerHeightDrift();
    expect(await page.getByTestId('shell-footer-row').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  }
  await page.screenshot({ path: test.info().outputPath('today-footer-narrow-call.png') });
  await dock.getByTestId('shell-call-dock-leave').click(); await expect(page.getByTestId('today-call')).toContainText('"leaves":1');
  expect(fixture.errors).toEqual([]); expect(fixture.mutations).toEqual([]);
});

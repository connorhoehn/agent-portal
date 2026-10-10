import { expect, test, type Page } from '@playwright/test';
test.use({ baseURL: 'http://127.0.0.1:5183' });
async function mount(page: Page, query = '') {
  const errors: string[] = [], mutations: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  for (const [path, names] of [
    ['src/lib/conversationCall.tsx', 'useCallHost, useCallBlockPlacement, useCallMediaPanel, callCounts, callDrawn'],
    ['src/components/shell/HuddleChat.tsx', 'useHuddleChatToggle, HuddleReactionBar'],
    ['src/components/shell/ShellCallHost.tsx', 'ShellCallMedia'],
    ['src/components/shell/EmbeddedSocial.tsx', 'EmbeddedSocialEntry'],
  ]) await page.route(`**/${path}*`, route => route.fulfill({ contentType: 'text/javascript', body: `export { ${names} } from '/e2e/fixtures/social-footer.tsx';` }));
  await page.route('**/api/**', route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() !== 'GET') mutations.push(path);
    if (path === '/api/session/me') return route.fulfill({ json: { sub: 'inert-footer-reader', name: 'Fixture Reviewer', tenant: query.includes('assessment') ? 'assessment' : 'orgiq', role: 'member', grants: {}, switchable: {}, availableRoles: ['member'], masquerading: null } });
    if (path === '/api/auth/config') return route.fulfill({ json: { ssoEnabled: false } });
    return route.fulfill({ status: 503, json: { error: 'The footer fixture denies unmocked APIs.' } });
  });
  await page.route('**/__social-footer*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script><script type="module" src="/e2e/fixtures/social-footer.tsx"></script></body></html>' }));
  await page.goto(`/__social-footer${query}`); await expect(page.getByTestId('shell-footer-context')).toBeVisible();
  return { errors, mutations, model: async () => JSON.parse(await page.getByTestId('footer-model').innerText()) };
}
test('idle native actions are distinct, contextual, keyboard accessible, and measured inside the footer', async ({ page }) => {
  const fixture = await mount(page);
  const footer = page.getByTestId('shell-footer'), idle = page.getByTestId('shell-footer-context');
  const start = idle.getByRole('button', { name: 'Huddle', exact: true }), message = idle.getByRole('button', { name: 'Message', exact: true });
  await expect(start).toBeEnabled(); await expect(message).toBeEnabled();
  const styles = await start.evaluate(element => ({ border: getComputedStyle(element).borderColor, bg: getComputedStyle(element).backgroundColor, color: getComputedStyle(element).color, font: getComputedStyle(element).fontSize }));
  expect(styles.border).toBe('rgba(0, 0, 0, 0)'); expect(styles.bg).toBe('rgba(0, 0, 0, 0)'); expect(styles.font).toBe('12px');
  expect(styles.color).toBe(await message.evaluate(element => getComputedStyle(element).color));
  expect(await message.evaluate(element => getComputedStyle(element).borderColor)).toBe('rgba(0, 0, 0, 0)');
  const settings = footer.getByRole('button', { name: 'Device settings' }); await settings.focus();
  await expect(page.getByRole('tooltip')).toHaveText('Check microphone and camera'); await page.keyboard.press('Enter'); expect((await fixture.model()).settings).toBe(1);
  await page.keyboard.press('Escape'); await expect(page.getByRole('tooltip')).toHaveCount(0);
  await message.click(); await expect(message).toBeFocused();
  for (const width of [1440, 1024, 600]) {
    await page.setViewportSize({ width, height: 768 });
    const box = (await footer.boundingBox())!, action = (await settings.boundingBox())!;
    expect(Math.round(box.y + box.height)).toBe(768); expect(action.x + action.width).toBeLessThanOrEqual(width);
    expect(Number.parseFloat(await page.evaluate(() => document.documentElement.style.getPropertyValue('--shell-collaboration-floor')))).toBe(Math.ceil(box.height));
  }
  await page.setViewportSize({ width: 1280, height: 800 }); await page.screenshot({ path: test.info().outputPath('footer-work-tonal.png') });
  await start.click(); await expect(page.getByTestId('shell-call-dock')).toHaveAttribute('data-phase', 'ringing'); expect((await fixture.model()).starts).toBe(1);
  await page.getByTestId('shell-call-dock-leave').click(); expect((await fixture.model()).leaves).toBe(1);
  await page.getByRole('button', { name: 'Remove inert page context' }).click(); await expect(start).toBeDisabled(); await expect(message).toBeDisabled(); await expect(start).toHaveAttribute('title', /no huddle/);
  expect(fixture.errors).toEqual([]); expect(fixture.mutations).toEqual([]);
});
test('active footer preserves native toggles, pressed states, retry and leave behavior across tenant themes', async ({ page }) => {
  const fixture = await mount(page, '?tenant=assessment&theme=dark');
  await page.getByRole('button', { name: 'Show inert live call' }).click(); const dock = page.getByTestId('shell-call-dock');
  await dock.getByTestId('shell-call-dock-mic').click(); expect((await fixture.model()).micOn).toBe(true);
  await dock.getByTestId('shell-call-dock-camera').click(); expect((await fixture.model()).cameraOn).toBe(true);
  const message = dock.getByRole('button', { name: 'Message' }); await message.click(); await expect(message).toHaveAttribute('aria-pressed', 'true'); expect((await fixture.model()).chats).toBe(1);
  await dock.getByTestId('shell-call-dock-media').click(); await expect(dock.getByTestId('shell-call-dock-media')).toHaveAttribute('aria-expanded', 'true');
  expect((await fixture.model()).mediaOpen).toBe(true); await page.screenshot({ path: test.info().outputPath('footer-assessment-live.png') });
  await page.getByRole('button', { name: 'Show inert failure' }).click(); await expect(dock.getByRole('alert')).toContainText('Inert media connection failure');
  await expect(dock.getByRole('button', { name: 'Dismiss', exact: true })).toBeEnabled();
  await page.getByTestId('shell-footer-rejoin').click(); await expect(dock).toHaveAttribute('data-phase', 'live');
  for (const placement of ['Show a full native bar on the page', 'Show a full native bar in the composer', 'Show a full native standalone block']) {
    await page.getByRole('button', { name: placement }).click();
    await expect(dock.getByTestId('shell-call-dock-mic')).toHaveCount(0); await expect(dock.getByTestId('shell-call-dock-camera')).toHaveCount(0);
    await expect(dock.getByTestId('shell-call-dock-leave')).toHaveCount(0); await expect(dock.getByRole('button', { name: 'Device settings' })).toHaveCount(0);
    await expect(page.getByTestId('fixture-full-call-bar').getByRole('button', { name: 'Leave', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Leave', exact: true })).toHaveCount(1);
  }
  await page.getByRole('button', { name: 'Move media to the pane' }).click(); await expect(page.getByTestId('fixture-full-call-bar')).toHaveCount(0);
  await expect(dock.getByTestId('shell-call-dock-mic')).toBeVisible(); await expect(dock.getByTestId('shell-call-dock-leave')).toBeVisible();
  await dock.getByTestId('shell-call-dock-leave').click(); expect((await fixture.model()).leaves).toBe(1);
  expect(fixture.errors).toEqual([]); expect(fixture.mutations).toEqual([]);
});

test('footer text and icons stay readable in every tenant theme', async ({ page }) => {
  for (const tenant of ['orgiq', 'assessment', 'social', 'pipelines']) {
    for (const theme of ['light', 'dark']) {
      await mount(page, `?tenant=${tenant}&theme=${theme}`);
      const start = page.getByTestId('shell-footer-context').getByRole('button', { name: 'Huddle', exact: true });
      for (const state of ['rest', 'hover', 'focus']) {
        if (state === 'hover') await start.hover();
        if (state === 'focus') await start.focus();
        const contrast = await start.evaluate(element => {
          const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
          const ctx = canvas.getContext('2d')!;
          ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 1, 1);
          const ancestors: Element[] = [];
          for (let node: Element | null = element; node; node = node.parentElement) ancestors.unshift(node);
          for (const node of ancestors) { ctx.fillStyle = getComputedStyle(node).backgroundColor; ctx.fillRect(0, 0, 1, 1); }
          const bg = Array.from(ctx.getImageData(0, 0, 1, 1).data).slice(0, 3);
          ctx.fillStyle = getComputedStyle(element).color; ctx.fillRect(0, 0, 1, 1);
          const fg = Array.from(ctx.getImageData(0, 0, 1, 1).data).slice(0, 3);
          const luminance = (rgb: number[]) => rgb.map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index]!, 0);
          return (Math.max(luminance(fg), luminance(bg)) + .05) / (Math.min(luminance(fg), luminance(bg)) + .05);
        });
        expect(contrast, `${tenant}/${theme}/${state}`).toBeGreaterThanOrEqual(4.5);
      }
      if (tenant === 'social' && theme === 'dark') await page.screenshot({ path: test.info().outputPath('social-footer-readable-dark.png') });
    }
  }
});

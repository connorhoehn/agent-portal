import { test, expect } from './cdpTest';
import { openAsClone } from './realSession';
import { PRE_JOIN_KEY } from './preJoin';

test.use({ launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] } });

test('meeting Chat toggles the initiative pane and retains its unsent draft', async ({ browser, baseURL }) => {
  test.setTimeout(90_000);
  const actor = await openAsClone(browser, 'u-vera', {
    baseURL, viewport: { width: 1600, height: 1000 }, expectTenant: 'orgiq', preJoin: 'remembered',
    url: '/iq/projects/p-auth-migration',
    prepare: async context => context.addInitScript(key => {
      localStorage.setItem(key, JSON.stringify({ micOn: false, cameraOn: false, remember: true }));
    }, PRE_JOIN_KEY),
  });
  const { page } = actor;
  page.setDefaultTimeout(10_000);
  try {
    const start = page.getByTestId('shell-footer-context').getByRole('button', { name: 'Huddle', exact: true });
    await expect(start).toBeEnabled({ timeout: 20_000 });
    await start.click();
    const pane = page.getByTestId('initiative-pane');
    await expect(pane.getByTestId('huddle-thread')).toBeVisible({ timeout: 20_000 });
    const toggle = page.getByTestId('meeting-toolbar-chat');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await page.getByTestId('shell-call-dock-chat').click();
    const input = page.getByRole('textbox', { name: 'Message', exact: true });
    await input.fill('Unsent toggle verification');
    await toggle.click();
    await expect(pane).not.toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await expect(pane.getByTestId('huddle-thread')).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(input).toHaveText('Unsent toggle verification');
    // Message still focuses the composer when the pane is already visible.
    await page.getByTestId('shell-call-dock-chat').click();
    await expect(pane.getByTestId('huddle-thread')).toBeVisible();
    await expect(input).toBeFocused();
    await page.screenshot({ path: test.info().outputPath('initiative-huddle-toggle.png') });
    await page.getByTestId('call-dock-leave').click();
    await expect(toggle).toHaveCount(0);
    expect(actor.errors).toEqual([]);
  } finally { await actor.close(); }
});

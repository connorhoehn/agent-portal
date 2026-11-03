import { test, expect } from './cdpTest';
import { openAsClone } from './realSession';
import { PRE_JOIN_KEY } from './preJoin';

test.use({ viewport: { width: 1600, height: 1000 }, launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] } });

// Real call seats, local media transport and chat resolution with synthetic devices.
// No message or document edit is sent. A clone keeps the user's session intact.
test('document huddles reuse the context column and central composer', async ({ browser, baseURL }) => {
  test.setTimeout(90_000);
  const actor = await openAsClone(browser, 'u-asha', {
    baseURL, viewport: { width: 1600, height: 1000 }, expectTenant: 'assessment', preJoin: 'remembered',
    url: '/assessment/workspace?doc=workspace_drafts%2Fstory-dim1-ci-evidence.md',
    prepare: async context => {
      await context.addInitScript(key => localStorage.setItem(key, JSON.stringify({ micOn: false, cameraOn: false, remember: true })), PRE_JOIN_KEY);
    },
  });
  const { page } = actor;
  try {
    const composer = page.getByTestId('page-composer-dock');
    await expect(composer).toBeVisible({ timeout: 20_000 });
    const start = page.getByTestId('shell-footer-context').getByRole('button', { name: 'Huddle', exact: true });
    await expect(start).toBeEnabled({ timeout: 20_000 });
    await start.click();
    const panel = page.getByTestId('document-chat-panel');
    await expect(panel.getByTestId('huddle-thread')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('huddle-chat-error')).toHaveCount(0);
    await expect(page.getByTestId('huddle-chat-panel')).toHaveCount(0);
    await expect(page.getByTestId('page-conversation-pane')).toHaveCount(0);
    await page.getByTestId('shell-call-dock-chat').click();
    const input = composer.locator('[contenteditable="true"]');
    await expect(input).toBeEditable();
    await input.fill('Unsent document huddle draft');
    await expect(panel.locator('[contenteditable="true"]')).toHaveCount(0);
    await panel.getByRole('button', { name: 'Document discussion', exact: true }).click();
    await expect(panel.getByTestId('document-chat')).toBeVisible();
    await expect(input).toHaveText('');
    await panel.getByRole('button', { name: 'Huddle chat', exact: true }).click();
    await expect(input).toHaveText('Unsent document huddle draft');
    await page.getByRole('button', { name: 'Collapse document context', exact: true }).click();
    await expect(panel).not.toBeVisible();
    await page.getByTestId('shell-call-dock-chat').click();
    await expect(panel.getByTestId('huddle-thread')).toBeVisible();
    await expect(input).toHaveText('Unsent document huddle draft');
    await page.getByTestId('shell-call-dock-chat').click();
    await expect(panel.getByTestId('huddle-thread')).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('document-huddle-single-pane.png') });
    await composer.getByTestId('call-dock-leave').click();
    await expect(panel.getByTestId('huddle-thread')).toHaveCount(0);
    await expect(panel.getByTestId('document-chat')).toBeVisible();
    expect(actor.errors).toEqual([]);
  } finally { await actor.close(); }
});

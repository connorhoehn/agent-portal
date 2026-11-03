import { test, expect } from './cdpTest';
import { openAsClone } from './realSession';
import { PRE_JOIN_KEY } from './preJoin';
import { measureDOM } from '../../.claude/skills/ui-dom-audit/scripts/measure.mjs';

test.use({ launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] } });

test('assessment huddle stays compact through an empty claims filter and uses a send toast', async ({ browser, baseURL }) => {
  test.setTimeout(90_000);
  const captured: unknown[] = [];
  const actor = await openAsClone(browser, 'u-asha', {
    baseURL, expectTenant: 'assessment', url: '/assessment/teams/TEAM-006', preJoin: 'remembered',
    viewport: { width: 1600, height: 1000 }, contextOptions: { permissions: ['camera', 'microphone'] },
    prepare: async context => {
      await context.addInitScript(key => localStorage.setItem(key, JSON.stringify({ micOn: false, cameraOn: true, remember: true })), PRE_JOIN_KEY);
      // Observe the production send UI without posting a message to the shared team.
      await context.routeWebSocket(/.*/, socket => {
        const server = socket.connectToServer();
        socket.onMessage(data => {
          try {
            const frame = JSON.parse(data.toString());
            if (frame.service === 'chat' && frame.action === 'send') { captured.push(frame); return; }
          } catch { /* Forward non-JSON signalling unchanged. */ }
          server.send(data);
        });
      });
    },
  });
  const { page } = actor;
  page.setDefaultTimeout(10_000);
  try {
    const composer = page.getByTestId('dimension-composer');
    await expect(composer).toBeVisible({ timeout: 20_000 });
    const start = page.getByTestId('shell-footer-context').getByRole('button', { name: 'Huddle', exact: true });
    await expect(start).toBeEnabled();
    await start.click();
    const media = page.getByTestId('shell-call-media');
    const dock = media.locator('[data-call-dock]');
    await expect(dock).toHaveAttribute('data-phase', 'active', { timeout: 20_000 });
    const track = () => media.locator('video').first().evaluate(video => (video as HTMLVideoElement).srcObject instanceof MediaStream
      ? ((video as HTMLVideoElement).srcObject as MediaStream).getVideoTracks()[0]?.id : undefined);
    await expect.poll(track).toBeTruthy();
    const cameraTrack = await track();
    const reports = [];
    const audit = async (state: string) => {
      await expect(dock).toHaveAttribute('data-layout', 'compact');
      const box = await dock.boundingBox();
      expect(box!.height).toBeLessThanOrEqual(110);
      const [tile, title] = await Promise.all([dock.getByTestId('call-dock-tiles').boundingBox(), dock.getByTestId('call-dock-title').boundingBox()]);
      expect(tile!.x + tile!.width).toBeLessThanOrEqual(title!.x);
      const report = await page.evaluate(measureDOM, { contract: { version: 1, rules: [
        { id: 'call.controls-fit', kind: 'within', selector: '[data-call-dock] [data-testid$="-controls"]', anchor: '[data-testid="call-dock-compact-columns"]', ancestor: true },
        { id: 'call.text-overlap', kind: 'text-overlap', selector: '[data-call-dock]' },
      ] }, selectors: {} });
      expect(report.issues).toEqual([]);
      reports.push({ state, height: box!.height, ...report });
      await page.screenshot({ path: test.info().outputPath(`${state}.png`) });
    };
    await expect(media).toHaveAttribute('data-placement', 'composer');
    await audit('composer-call');
    await page.getByRole('button', { name: 'Collapse discussion', exact: true }).click();
    await expect(page.getByTestId('team-pane')).not.toBeVisible();
    const filter = page.getByTestId('dimension-rail-filter');
    await filter.getByRole('radio', { name: 'Open claims 0', exact: true }).click();
    await expect(composer).toHaveCount(0);
    await expect(media).toHaveAttribute('data-placement', 'block');
    await audit('empty-claims-call');
    expect(await track()).toBe(cameraTrack);
    await filter.getByRole('radio', { name: 'All 17', exact: true }).click();
    await expect(media).toHaveAttribute('data-placement', 'composer');
    expect(await track()).toBe(cameraTrack);
    await page.getByTestId('shell-call-dock-chat').click();
    await composer.getByRole('combobox', { name: 'Chat recipient' }).click();
    await page.getByRole('option', { name: 'Team discussion', exact: true }).click();
    await composer.getByRole('textbox', { name: 'Message', exact: true }).fill('Local UI confirmation check');
    await composer.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => captured.length).toBe(1);
    const toast = page.getByTestId('toast-stack');
    await expect(toast).toContainText('Sent to the team’s Discussion.');
    // Wait for the entrance animation before checking the visible toast bounds.
    await expect.poll(() => toast.locator('[role="status"]').first().evaluate(element => element.getBoundingClientRect().right)).toBeLessThanOrEqual(1600);
    await expect(page.getByTestId('dimension-composer-note')).toHaveCount(0);
    await audit('send-toast');
    await test.info().attach('compact-call-audit', { body: JSON.stringify(reports, null, 2), contentType: 'application/json' });
    await dock.getByTestId('call-dock-leave').click();
    await expect(media).toHaveCount(0);
    expect(actor.errors).toEqual([]);
  } finally { await actor.close(); }
});

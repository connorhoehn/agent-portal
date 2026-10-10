// In-call reactions: a seated person picks an emoji from the footer bar's
// reaction trigger and it floats over the other person's tiles in the right
// pane's grid, then clears. The channel is the huddle's own seat-only
// `orgiq:huddle:<callId>`; a session that is not in the call is refused.
// Two real sessions on the shared Tilt app with Chrome's fake devices over the
// local SFU. Opt in with REAL_MEDIA_ACCEPTANCE=1.
import { test as base, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { loginAs } from './realSession';

const BASE = process.env.PARITY_BASE_URL ?? 'http://127.0.0.1:5183';
const INITIATIVE = process.env.GRID_INITIATIVE ?? 'p-auth-migration';
const test = base.extend<{}, { browser: Browser }>({
  browser: [async ({ playwright }, use) => {
    const browser = await playwright.chromium.launch({ channel: 'chrome', headless: true, args: [
      '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required', '--disable-features=LocalNetworkAccessChecks',
    ] });
    try { await use(browser); } finally { await browser.close(); }
  }, { scope: 'worker' }],
});
test.use({ baseURL: BASE, viewport: { width: 1440, height: 900 } });
test.skip(process.env.REAL_MEDIA_ACCEPTANCE !== '1', 'Requires the local SFU and platform-api (REAL_MEDIA_ACCEPTANCE=1)');

async function signedIn(browser: Browser, userId: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 }, permissions: ['camera', 'microphone'] });
  await loginAs(context, userId, BASE, true);
  return { context, page: await context.newPage() };
}
const huddleButton = (page: Page) => page.getByTestId('shell-footer-context').getByRole('button', { name: 'Huddle' });
// The reactions float over wherever the one media sink draws — here the call bar above the initiative Discussion's composer.
const floats = (page: Page) => page.getByTestId('shell-call-media').getByTestId('reaction-float');

test('a seated reaction floats over the other seat\'s tiles and clears; a non-seat cannot publish', async ({ browser }) => {
  test.setTimeout(180_000);
  const people = [await signedIn(browser, 'u-vera'), await signedIn(browser, 'u-nora'), await signedIn(browser, 'u-hr')];
  const [vera, nora, outsider] = people.map(p => p.page) as [Page, Page, Page];
  try {
    let callId = '';
    vera.on('response', response => { const m = /\/api\/calls\/([^/]+)\/chat/.exec(new URL(response.url()).pathname); if (m) callId = decodeURIComponent(m[1]!); });
    await nora.goto(`/iq/projects/${INITIATIVE}`);
    await expect(huddleButton(nora)).toBeEnabled({ timeout: 30_000 });
    await vera.goto(`/iq/projects/${INITIATIVE}`);
    await expect(huddleButton(vera)).toBeEnabled({ timeout: 30_000 });
    await huddleButton(vera).click();
    await nora.getByRole('button', { name: 'Accept', exact: true }).click({ timeout: 30_000 });
    for (const page of [vera, nora]) {
      await expect(page.getByTestId('composer-call-dock').getByTestId('call-dock-tile-row')).toHaveAttribute('data-tile-count', '2', { timeout: 45_000 });
      await expect(page.getByTestId('huddle-reaction-toggle')).toBeVisible({ timeout: 30_000 });
    }

    // Vera reacts from the footer bar; Nora sees it float over her grid.
    await vera.getByTestId('huddle-reaction-toggle').click();
    await vera.getByTestId('huddle-reaction-picker').getByRole('button', { name: 'React with party' }).click();
    await expect(floats(nora).filter({ hasText: '🎉' }).first()).toBeVisible({ timeout: 15_000 });
    await nora.screenshot({ path: test.info().outputPath('huddle-reaction-float.png') });
    await expect(floats(nora)).toHaveCount(0, { timeout: 10_000 });

    // A session that holds no seat is refused on the huddle's reaction channel.
    expect(callId, 'the huddle chat resolver named the call').not.toBe('');
    await outsider.goto('/iq');
    const refused = await outsider.evaluate(async (channel) => {
      const t = await (await fetch('/api/session/realtime-token', { credentials: 'include' })).json() as { token: string; gatewayUrl?: string };
      const ws = new WebSocket(`${(t.gatewayUrl ?? 'http://127.0.0.1:3001').replace(/^http/, 'ws').replace(/\/$/, '')}/ws`, ['bearer-token-v1', t.token]);
      const frames: Array<Record<string, unknown>> = [];
      ws.onmessage = (e) => frames.push(JSON.parse(String(e.data)));
      await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error('socket refused')); });
      ws.send(JSON.stringify({ service: 'reaction', action: 'send', channel, emoji: '🚀' }));
      for (let i = 0; i < 60 && !frames.some(f => f['code'] === 'AUTHZ_CHANNEL_DENIED'); i += 1) await new Promise(r => setTimeout(r, 50));
      ws.close();
      return frames.filter(f => f['code'] === 'AUTHZ_CHANNEL_DENIED').length;
    }, `orgiq:huddle:${callId}`);
    expect(refused).toBeGreaterThan(0);
    await nora.waitForTimeout(1_000);
    await expect(floats(nora).filter({ hasText: '🚀' })).toHaveCount(0);
  } finally {
    for (const page of [vera, nora]) {
      const leave = page.getByTestId(/^(shell-)?call-dock-leave$/).first();
      if (await leave.count().catch(() => 0)) await leave.click().catch(() => undefined);
    }
    await Promise.all(people.map(p => p.context.close()));
  }
});

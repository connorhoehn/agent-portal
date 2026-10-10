import { type Browser, type BrowserContext, type Page } from '@playwright/test';
import { test, expect } from './cdpTest';
import { loginAs } from './realSession';
import { PRE_JOIN_KEY } from './preJoin';
import { chooseComposerMode } from './conversationViews';

test.use({ viewport: { width: 1440, height: 900 }, ...(process.env.PARITY_BASE_URL ? { baseURL: process.env.PARITY_BASE_URL } : {}) });
const PROJECT = '/iq/projects/p-observability?tab=work&item=wi-obs-e2-b4';

// Real signed sessions, call seats, chat acknowledgements and page resolution.
// Only the unavailable SFU session metadata is substituted; this is not a
// WebRTC-media acceptance test and never resets the shared mock world.
async function actor(browser: Browser, baseURL: string | undefined, userId: string) {
  const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } });
  await loginAs(context, userId, baseURL, true, 'show');
  await context.addInitScript(key => localStorage.setItem(key, JSON.stringify({ micOn: false, cameraOn: false, remember: true })), PRE_JOIN_KEY);
  await context.route('**/api/session/realtime-token', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), platformApiUrl: 'http://huddle-navigation.test', videoUrl: null } });
  });
  await context.route('http://huddle-navigation.test/**', route => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({ json: path.endsWith('/join') ? { participantId: `participant-${userId}`, token: null }
      : path.endsWith('/end') ? { ok: true } : { sessionId: 'navigation-signalling-only' } });
  });
  const page = await context.newPage(), errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(PROJECT);
  await expect(page.getByTestId('initiative-header')).toBeVisible();
  return { context, page, errors };
}
const central = (page: Page, id: string) => page.getByTestId(id).locator('[contenteditable="true"]');
async function leave(page: Page) {
  const button = page.getByTestId('shell-call-dock').getByRole('button', { name: /Leave|Hang up/ }).first();
  if (await button.isVisible().catch(() => false)) await button.click();
}

test('one huddle draft and central input survive initiative, Search, and work navigation', async ({ browser, baseURL }) => {
  test.setTimeout(120000);
  const contexts: BrowserContext[] = [];
  try {
    const vera = await actor(browser, baseURL, 'u-vera'); contexts.push(vera.context);
    const nora = await actor(browser, baseURL, 'u-nora'); contexts.push(nora.context);
    await vera.page.getByTestId('initiative-start-call').click();
    await nora.page.getByRole('button', { name: 'Accept', exact: true }).click({ timeout: 20000 });
    await vera.page.getByTestId('shell-call-dock-chat').click();
    const message = `Confirm the dependency map before the outage rehearsal ${Date.now()}.`;
    await expect(central(vera.page, 'initiative-composer')).toBeEditable();
    await central(vera.page, 'initiative-composer').fill(message);
    await vera.page.getByRole('button', { name: 'Search in this initiative', exact: true }).click();
    await expect(vera.page).toHaveURL(/\/iq\/search\?scope=p-observability/);
    await vera.page.getByTestId('shell-call-dock-chat').click();
    await expect(central(vera.page, 'search-composer')).toHaveText(message);
    await expect(vera.page.getByTestId('huddle-thread').locator('[contenteditable="true"]')).toHaveCount(0);
    await chooseComposerMode(vera.page, vera.page.getByTestId('search-composer'), 'Chat', 'Agent');
    await central(vera.page, 'search-composer').fill('dependency');
    await central(vera.page, 'search-composer').press('Enter');
    await expect(vera.page).toHaveURL(/q=dependency/);
    await vera.page.getByTestId('shell-call-dock-chat').click();
    await expect(central(vera.page, 'search-composer')).toHaveText(message);
    await vera.page.getByTestId('search-rich-composer-send').click();
    await expect(central(vera.page, 'search-composer')).toHaveText('');
    await nora.page.getByTestId('shell-call-dock-chat').click();
    await expect(nora.page.getByTestId('huddle-thread')).toContainText(message);
    await expect(nora.page.getByTestId('huddle-thread')).toContainText('ORG-OBS-11');
    await leave(vera.page); await leave(nora.page);
    expect(vera.errors).toEqual([]); expect(nora.errors).toEqual([]);
  } finally { await Promise.all(contexts.map(context => context.close())); }
});

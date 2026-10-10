import { test as base, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { loginAs } from './realSession';

// A page huddle that nobody answers reaches the activity bell (middleware notifyMissedCall,
// pageHuddleHref in lib/social-notify.ts): u-asha rings u-jonas into the Notifications Service team
// huddle (TEAM-005) and hangs up before anyone joins. The page footer's Huddle rings nobody (it is
// "walking into a room", the library useCallBlock bind), so the ring is Asha's own gateway socket sending the same
// `call` invite frame the portal's call hooks send; the gateway's lobby guard and invite hook are real.
// u-jonas, who is rung, sees the
// bell count it and the item opens that tenant's own team page. u-mia (orgiq only, no assessment
// grant) gets nothing. Against the shared app (http://127.0.0.1:5183), real sessions, fake devices.
const BASE = process.env.PARITY_BASE_URL ?? 'http://127.0.0.1:5183';
const TEAM = 'TEAM-005';
const GATEWAY = process.env.GATEWAY_WS_URL ?? 'ws://127.0.0.1:3001/ws';

const test = base.extend<{}, { browser: Browser }>({
  browser: [async ({ playwright }, use) => {
    const browser = await playwright.chromium.launch({ channel: 'chrome', headless: true, args: [
      '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required',
    ] });
    try { await use(browser); } finally { await browser.close(); }
  }, { scope: 'worker' }],
});
test.use({ baseURL: BASE, viewport: { width: 1440, height: 900 } });

const bell = (page: Page) => page.getByTestId('activity-bell-button');
const unread = async (page: Page) => Number(/(\d+) unread/.exec(await bell(page).getAttribute('aria-label') ?? '')?.[1] ?? 0);

async function signedIn(browser: Browser, userId: string, path: string) {
  const context: BrowserContext = await browser.newContext({ baseURL: BASE, permissions: ['camera', 'microphone'] });
  await loginAs(context, userId, BASE, true);
  const page = await context.newPage(), errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push(m.text()); });
  await page.goto(path);
  await expect(bell(page)).toBeVisible({ timeout: 25_000 });
  return { context, page, errors };
}

test('an unanswered team huddle shows on the invitee\'s bell and links to the team page; an outsider gets nothing', async ({ browser }) => {
  test.setTimeout(150_000);
  const jonas = await signedIn(browser, 'u-jonas', '/assessment/dashboard');
  const mia = await signedIn(browser, 'u-mia', '/iq/projects');
  const asha = await signedIn(browser, 'u-asha', `/assessment/teams/${TEAM}`);
  try {
    await jonas.page.waitForTimeout(2_000); await mia.page.waitForTimeout(2_000);
    const jonasBefore = await unread(jonas.page), miaBefore = await unread(mia.page);
    const { token } = await (await asha.context.request.get('/api/session/realtime-token')).json() as { token: string };
    const ws = new WebSocket(GATEWAY, ['bearer-token-v1', token]);
    const received: Array<Record<string, unknown>> = [];
    ws.addEventListener('message', e => received.push(JSON.parse(String(e.data))));
    await new Promise<void>((resolve, reject) => { ws.addEventListener('open', () => resolve()); ws.addEventListener('error', () => reject(new Error('socket refused'))); });
    await expect.poll(() => received.some(f => f.type === 'session'), { timeout: 10_000 }).toBe(true);
    const callId = `missed-e2e-${Date.now()}`, lobbyName = `assessment:team:${TEAM}`;
    ws.send(JSON.stringify({ service: 'call', action: 'invite', callId, lobbyName, callerId: 'u-asha', callerName: 'Asha Nair', channel: lobbyName, targetUserIds: ['u-jonas'] }));
    await asha.page.waitForTimeout(3_000);
    expect(received.filter(f => f.type === 'error'), 'the invite is admitted').toEqual([]);
    ws.send(JSON.stringify({ service: 'call', action: 'ended', callId, lobbyName, callerId: 'u-asha' }));
    ws.close(); // hung up before anyone answered

    await expect.poll(() => unread(jonas.page), { timeout: 20_000, message: 'Jonas\'s bell counts the missed huddle' }).toBeGreaterThan(jonasBefore);
    await bell(jonas.page).click();
    const popover = jonas.page.getByTestId('activity-bell-popover');
    await expect(popover).toBeVisible();
    await expect(popover).toContainText('Assessment');
    const item = popover.getByText(/Missed call from (Asha Nair|u-asha)/).first();
    await expect(item).toBeVisible();
    await item.click();
    await expect(jonas.page).toHaveURL(new RegExp(`/assessment/teams/${TEAM}(\\?|$)`), { timeout: 15_000 });

    await mia.page.waitForTimeout(1_500);
    expect(await unread(mia.page)).toBe(miaBefore);
    await bell(mia.page).click();
    await expect(mia.page.getByTestId('activity-bell-popover')).not.toContainText('Missed call');
    expect(jonas.errors).toEqual([]); expect(mia.errors).toEqual([]); expect(asha.errors).toEqual([]);
  } finally { await Promise.all([jonas, mia, asha].map(p => p.context.close())); }
});

// A real call on the DEPLOYED stack: two seeded users sign in through
// Cognito, one makes a hangout room, both join, and audio must arrive over
// the SFU. Skipped unless CLOUD_PORTAL_URL and the two logins are set:
//   CLOUD_PORTAL_URL=https://<id>.cloudfront.net
//   CLOUD_LOGIN_A=<email>:<password>   (social community-admin)
//   CLOUD_LOGIN_B=<email>:<password>   (social participant)
import { test, expect, type Browser, type Page } from '@playwright/test';

const base = process.env.CLOUD_PORTAL_URL;
const logins = [process.env.CLOUD_LOGIN_A, process.env.CLOUD_LOGIN_B];
test.skip(!base || logins.some((l) => !l), 'CLOUD_PORTAL_URL / CLOUD_LOGIN_A / CLOUD_LOGIN_B not set');
test.use({ launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] } });

async function signIn(browser: Browser, login: string, label: string): Promise<Page> {
  const [email, password] = [login.slice(0, login.indexOf(':')), login.slice(login.indexOf(':') + 1)];
  const context = await browser.newContext({ baseURL: base, permissions: ['camera', 'microphone'], viewport: { width: 1440, height: 960 } });
  await context.addInitScript(() => {
    const peers: RTCPeerConnection[] = [];
    (window as any).__pcs = peers;
    window.RTCPeerConnection = new Proxy(window.RTCPeerConnection, { construct(T, a) { const pc = Reflect.construct(T, a); peers.push(pc); return pc; } });
  });
  const page = await context.newPage();
  page.on('response', async (r) => {
    const bindingRefused = r.url().includes('/call-binding') && r.status() >= 400;
    if (r.status() >= 500 || bindingRefused) console.log(`[${label}] ${r.status()} ${r.request().method()} ${r.url()} ${(await r.text().catch(() => '')).slice(0, 200)}`);
    if (bindingRefused && process.env.CLOUD_DEBUG_SEAT) {
      const body = r.request().postDataJSON();
      const auth = (await r.request().allHeaders())['authorization'];
      const replay = await fetch(`${base}/api/realtime/call-seat`, { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' },
        body: JSON.stringify({ callId: body.callId, lobbyName: body.lobbyName, clientId: body.clientId }) });
      console.log(`[${label}] binding body ${JSON.stringify(body)} → call-seat replay ${replay.status} ${(await replay.text()).slice(0, 200)}`);
    }
  });
  await page.goto('/api/auth/login');
  await page.locator('input[name="username"]:visible, input[type="email"]:visible').first().fill(email);
  const next = page.getByRole('button', { name: /^(next|continue)$/i });
  if (await next.isVisible().catch(() => false)) await next.click();
  await page.locator('input[type="password"]:visible').first().fill(password);
  // The classic hosted UI renders duplicate hidden forms; submit the visible one.
  await page.locator('input[name="signInSubmitButton"]:visible, button[type="submit"]:visible').first().click();
  await page.waitForURL((u) => u.origin === new URL(base!).origin && !u.pathname.startsWith('/api/auth'), { timeout: 30000 });
  return page;
}

// A fresh account gets the pre-join device check before every join.
async function join(page: Page) {
  await page.getByTestId('social-room-join').click();
  const prejoin = page.getByRole('dialog').filter({ hasText: 'Start a huddle' });
  await prejoin.getByRole('button', { name: 'Join', exact: true }).click({ timeout: 15000 }).catch(() => {});
}

async function inboundAudio(page: Page): Promise<number> {
  return page.evaluate(async () => {
    let samples = 0;
    for (const pc of (window as any).__pcs ?? []) {
      if (pc.connectionState === 'closed') continue;
      (await pc.getStats()).forEach((r: any) => { if (r.type === 'inbound-rtp' && (r.kind ?? r.mediaType) === 'audio') samples += r.totalSamplesReceived ?? 0; });
    }
    return samples;
  });
}

test('two signed-in users hear each other through the deployed SFU', async ({ browser }) => {
  test.setTimeout(180000);
  const out = test.info().outputPath('cloud-call');
  const owner = await signIn(browser, logins[0]!, 'owner');
  const guest = await signIn(browser, logins[1]!, 'guest');
  for (const p of [owner, guest]) {
    // Sign-in lands on the user's first tenant; the room lives in Social.
    const me = await (await p.request.get('/api/session/me')).json();
    if (me.tenant !== 'social') {
      // Leave the open app first: a live page that sees its tenant switched
      // underneath it treats the session as revoked and signs out.
      await p.goto('about:blank');
      const switched = await p.request.post('/api/session/tenant', { data: { tenant: 'social' } });
      expect(switched.status(), await switched.text()).toBe(200);
      const after = await p.request.get('/api/session/me');
      expect(after.status(), `session after the switch: ${await after.text()}`).toBe(200);
      expect((await after.json()).tenant).toBe('social');
    }
    const token = await p.request.get('/api/session/realtime-token');
    expect(token.status(), await token.text()).toBe(200);
  }

  // Hangout rooms are permanent (no delete), so every run reuses one room.
  const ROOM = 'Cloud call smoke';
  const listed = await (await owner.request.get('/api/social/rooms')).json();
  let slug = (listed.rooms as Array<{ name: string; slug: string }>).find((r) => r.name === ROOM)?.slug;
  if (!slug) {
    await owner.goto('/social/rooms');
    await owner.getByTestId('social-directory-new-room').click();
    await owner.getByTestId('new-hangout-room-name').fill(ROOM);
    await owner.getByTestId('new-hangout-room-description').fill('Reused check that real media crosses the deployed SFU.');
    const created = owner.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/social/rooms');
    await owner.getByTestId('new-hangout-room-submit').click();
    const creation = await created;
    expect(creation.status(), await creation.text()).toBe(201);
    slug = (await creation.json()).room.slug as string;
  }
  await owner.goto(`/social/rooms?room=${slug}`);

  try {
    await guest.goto(`/social/rooms?room=${slug}`);
    const guestMe = await guest.request.get('/api/session/me');
    expect(guestMe.status(), `guest session on the room page: ${await guestMe.text()}`).toBe(200);
    await expect(owner.getByTestId('social-room-join')).toBeEnabled({ timeout: 30000 });
    await join(owner);
    await expect(owner.getByTestId('call-dock-leave')).toBeVisible({ timeout: 30000 });
    await join(guest);
    await expect(guest.getByTestId('hangout-call-stage')).toContainText('2 connected', { timeout: 45000 });
    await expect.poll(() => inboundAudio(guest), { timeout: 45000 }).toBeGreaterThan(0);
    await expect.poll(() => inboundAudio(owner), { timeout: 45000 }).toBeGreaterThan(0);
    await owner.screenshot({ path: `${out}/owner-in-call.png`, fullPage: true });
    await guest.screenshot({ path: `${out}/guest-in-call.png`, fullPage: true });
  } finally {
    for (const p of [guest, owner]) {
      await p.getByTestId('call-dock-leave').click().catch(() => {});
      await p.getByTestId('call-dock-leave-confirm-leave').click({ timeout: 2000 }).catch(() => {});
    }
  }
});

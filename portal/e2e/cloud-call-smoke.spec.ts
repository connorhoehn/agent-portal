// A real call on the DEPLOYED stack: two seeded users sign in through
// Cognito, one makes a hangout room, both join, and audio must arrive over
// the SFU. Skipped unless CLOUD_PORTAL_URL and the two logins are set:
//   CLOUD_PORTAL_URL=https://<id>.cloudfront.net
//   CLOUD_LOGIN_A=<email>:<password>   (social community-admin)
//   CLOUD_LOGIN_B=<email>:<password>   (social participant)
import { test, expect, type Page } from '@playwright/test';
import { cloudSignIn, cloudUseTenant } from './cloudSession';

const base = process.env.CLOUD_PORTAL_URL;
const logins = [process.env.CLOUD_LOGIN_A, process.env.CLOUD_LOGIN_B];
test.skip(!base || logins.some((l) => !l), 'CLOUD_PORTAL_URL / CLOUD_LOGIN_A / CLOUD_LOGIN_B not set');
test.use({ launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] } });

const bindings: number[] = [];

function instrumentCallPage(label: string) {
  return async (page: Page) => {
    await page.addInitScript(() => {
      const peers: RTCPeerConnection[] = [];
      (window as any).__pcs = peers;
      window.RTCPeerConnection = new Proxy(window.RTCPeerConnection, { construct(T, a) { const pc = Reflect.construct(T, a); peers.push(pc); return pc; } });
    });
    if (process.env.CLOUD_TIMELINE) {
      const t0 = Date.now();
      page.on('request', (q) => { if (/\/api\/(video|calls|realtime)/.test(q.url())) console.log(`[${label}] +${Date.now() - t0}ms → ${q.method()} ${new URL(q.url()).pathname}`); });
      page.on('response', (r) => { if (/\/api\/(video|calls|realtime)/.test(r.url())) console.log(`[${label}] +${Date.now() - t0}ms ← ${r.status()} ${new URL(r.url()).pathname}`); });
      page.on('websocket', (ws) => ws.on('framesent', (f) => { const m = String(f.payload); if (m.includes('"service":"call"')) console.log(`[${label}] +${Date.now() - t0}ms ws→ ${m.slice(0, 120)}`); }));
    }
    page.on('response', async (r) => {
      if (!r.url().includes('/call-binding')) return;
      bindings.push(r.status());
      if (r.status() < 400) return;
      console.log(`[${label}] ${r.status()} ${r.request().method()} ${r.url()} ${(await r.text().catch(() => '')).slice(0, 200)}`);
      if (process.env.CLOUD_DEBUG_SEAT) {
        const body = r.request().postDataJSON();
        const auth = (await r.request().allHeaders())['authorization'];
        const replay = await fetch(`${base}/api/realtime/call-seat`, { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' },
          body: JSON.stringify({ callId: body.callId, lobbyName: body.lobbyName, clientId: body.clientId }) });
        console.log(`[${label}] binding body ${JSON.stringify(body)} → call-seat replay ${replay.status} ${(await replay.text()).slice(0, 200)}`);
      }
    });
  };
}

// A fresh account gets the pre-join device check before every join.
async function join(page: Page) {
  await page.getByTestId('social-room-join').click();
  // "Start a huddle" for the first caller, "Join the huddle" into a live call.
  const prejoin = page.getByRole('dialog').filter({ hasText: /^(Start a|Join the) huddle/ });
  await prejoin.getByTestId('prejoin-join').click({ timeout: 15000 }).catch(() => {});
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
  const owner = await cloudSignIn(browser, logins[0]!, 'owner', instrumentCallPage('owner'));
  const guest = await cloudSignIn(browser, logins[1]!, 'guest', instrumentCallPage('guest'));
  for (const p of [owner, guest]) {
    // Sign-in lands on the user's first tenant; the room lives in Social.
    await cloudUseTenant(p, 'social');
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
    // Join walks into a call the page has discovered: wait until the owner's
    // seat shows on the stage. (Two first joiners of a lobby share one call
    // since realtime-modules 0.140.0, and a seat is accepted in ~2-3 s on the
    // deployed stack, so the settle wait defaults to 0.)
    await expect(owner.getByTestId('hangout-call-stage')).toContainText('1 participant', { timeout: 30000 });
    await guest.waitForTimeout(Number(process.env.CLOUD_SEAT_SETTLE_MS ?? 0));
    await join(guest);
    await expect(guest.getByTestId('hangout-call-stage')).toContainText('2 participants', { timeout: 45000 });
    await expect.poll(() => inboundAudio(guest), { timeout: 45000 }).toBeGreaterThan(0);
    await expect.poll(() => inboundAudio(owner), { timeout: 45000 }).toBeGreaterThan(0);
    // Each live media leg binds to its accepted gateway seat.
    await expect.poll(() => bindings.filter((s) => s === 200).length, { timeout: 30000 }).toBeGreaterThanOrEqual(2);
    await owner.screenshot({ path: `${out}/owner-in-call.png`, fullPage: true });
    await guest.screenshot({ path: `${out}/guest-in-call.png`, fullPage: true });
  } finally {
    for (const p of [guest, owner]) {
      await p.getByTestId('call-dock-leave').click().catch(() => {});
      await p.getByTestId('call-dock-leave-confirm-leave').click({ timeout: 2000 }).catch(() => {});
    }
  }
});

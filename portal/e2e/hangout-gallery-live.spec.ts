// Real two-client media acceptance. Only disposable cloned identities and an
// owned room are used. Synthetic devices feed the real local SFU transport.
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { openAsClone } from './realSession';
import { writeFile } from 'node:fs/promises';
test.use({ actionTimeout: 10_000, launchOptions: { channel: 'chrome', args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--disable-features=LocalNetworkAccessChecks'] } });
test.skip(process.env.REAL_MEDIA_ACCEPTANCE !== '1', 'Opt in against the local media stack.');
async function recordPeers(context: BrowserContext) {
  await context.addInitScript(() => {
    const peers: RTCPeerConnection[] = [];
    (window as any).__galleryPCs = peers;
    window.RTCPeerConnection = new Proxy(window.RTCPeerConnection, { construct(Target, args) { const pc = Reflect.construct(Target, args); peers.push(pc); return pc; } });
  });
}
async function inbound(page: Page) {
  return page.evaluate(async () => {
    let audio = 0, video = 0;
    for (const pc of (window as any).__galleryPCs ?? []) {
      if (pc.connectionState === 'closed') continue;
      (await pc.getStats()).forEach((r: any) => { if (r.type === 'inbound-rtp' && !r.isRemote) { if ((r.kind ?? r.mediaType) === 'audio') audio += r.totalSamplesReceived ?? 0; else video += r.framesDecoded ?? 0; } });
    }
    return { audio, video };
  });
}
async function leave(page: Page) {
  const button = page.getByTestId('call-dock-leave');
  if (!await button.isVisible().catch(() => false)) return;
  await button.click();
  const confirm = page.getByTestId('call-dock-leave-confirm-leave');
  if (await confirm.isVisible().catch(() => false)) await confirm.click();
}
test('joined gallery bounds, sidebar and camera transitions retain two-way live media', async ({ browser }) => {
  test.setTimeout(180_000);
  const options = { baseURL: 'http://127.0.0.1:5183', label: 'gallery-live', viewport: { width: 1440, height: 900 }, landing: null, preJoin: 'remembered' as const, contextOptions: { permissions: ['camera', 'microphone'] }, prepare: recordPeers };
  const owner = await openAsClone(browser, 'u-mira', { ...options, tenant: 'social', role: 'community-admin' });
  const guest = await openAsClone(browser, 'u-sana', { ...options, tenant: 'social', role: 'participant' });
  let slug: string | undefined;
  const proof: unknown[] = [];
  try {
    await owner.page.goto('/social/rooms');
    await owner.page.getByTestId('social-directory-new-room').click();
    await owner.page.getByTestId('new-hangout-room-name').fill(`Gallery acceptance ${crypto.randomUUID().slice(0, 8)}`);
    await owner.page.getByTestId('new-hangout-room-description').fill('Temporary two-client gallery verification.');
    const created = owner.page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/social/rooms');
    await owner.page.getByTestId('new-hangout-room-submit').click();
    const response = await created;
    expect(response.status()).toBe(201);
    slug = (await response.json()).room.slug;
    await guest.page.goto(`/social/rooms?room=${slug}`);
    await owner.page.getByTestId('social-room-join').click();
    await expect(owner.page.getByTestId('call-dock-leave')).toBeVisible({ timeout: 30_000 });
    const grid = owner.page.getByTestId('hangout-gallery').getByTestId('call-dock-tile-row');
    const tiles = grid.locator('[data-peer-id]');
    await expect(tiles).toHaveCount(1);
    expect((await tiles.first().boundingBox())!.width).toBeLessThanOrEqual(416.5);
    await guest.page.getByTestId('social-room-join').click();
    for (const person of [owner, guest]) {
      await expect(person.page.getByTestId('hangout-call-stage')).toContainText('2 participants', { timeout: 30_000 });
      await expect.poll(async () => (await inbound(person.page)).audio, { timeout: 45_000 }).toBeGreaterThan(0);
      await expect.poll(async () => (await inbound(person.page)).video, { timeout: 45_000 }).toBeGreaterThan(0);
      proof.push({ actor: person.cloneId, inbound: await inbound(person.page) });
    }
    await expect(tiles).toHaveCount(2);
    for (const width of [1440, 900]) for (const theme of ['light', 'dark']) {
      await owner.page.setViewportSize({ width, height: 900 });
      await owner.page.evaluate(t => { localStorage.setItem('theme', t); document.documentElement.dataset.theme = t; }, theme);
      for (const tile of await tiles.all()) {
        const box = (await tile.boundingBox())!;
        expect(box.width).toBeLessThanOrEqual(416.5);
        expect(Math.abs(box.width / box.height - 16 / 9)).toBeLessThan(0.02);
      }
      const controls = (await owner.page.getByTestId('social-call-dock-controls').boundingBox())!;
      expect(controls.y + controls.height).toBeLessThanOrEqual(900);
      await expect(owner.page.getByTestId('hangout-call-sidebar')).toBeVisible();
      await owner.page.screenshot({ path: test.info().outputPath(`live-gallery-${theme}-${width}.png`) });
      proof.push({ width, theme, controls });
    }
    const remote = grid.locator('[data-is-local="false"] video');
    await expect(remote).toHaveCount(1);
    await remote.evaluate(el => el.setAttribute('data-retained-media', 'true'));
    const sidebar = owner.page.getByTestId('hangout-call-sidebar');
    await sidebar.getByRole('tab', { name: 'Conversation' }).click();
    await expect(sidebar.getByRole('textbox').first()).toBeVisible();
    await expect(remote).toHaveAttribute('data-retained-media', 'true');
    const before = await inbound(owner.page);
    await guest.page.getByTestId('call-dock-camera').click();
    await expect(grid.locator('[data-is-local="false"]')).toHaveAttribute('data-track-kind', 'avatar');
    await expect(remote).toHaveAttribute('data-retained-media', 'true');
    await expect.poll(async () => (await inbound(owner.page)).audio).toBeGreaterThan(before.audio);
    await guest.page.getByTestId('call-dock-camera').click();
    await expect.poll(async () => (await inbound(owner.page)).video, { timeout: 30_000 }).toBeGreaterThan(before.video);
    await leave(guest.page);
    await expect(tiles).toHaveCount(1, { timeout: 30_000 });
    expect((await tiles.first().boundingBox())!.width).toBeLessThanOrEqual(416.5);
    expect([...owner.errors, ...guest.errors]).toEqual([]);
    await writeFile(test.info().outputPath('media-proof.json'), JSON.stringify(proof, null, 2));
  } finally {
    await writeFile(test.info().outputPath('media-proof.json'), JSON.stringify({ slug, checks: proof }, null, 2));
    for (const person of [guest, owner]) await leave(person.page).catch(() => undefined);
    try {
      if (slug) {
        const token = await (await owner.context.request.get('/api/session/realtime-token')).json();
        const archived = await owner.context.request.post(`${token.platformApiUrl}/api/rooms/${encodeURIComponent(slug)}/archive`, { headers: { Authorization: `Bearer ${token.token}` }, timeout: 10_000 });
        expect(archived.ok(), 'archive only the room created by this acceptance').toBe(true);
      }
    } finally { await guest.close(); await owner.close(); }
  }
});

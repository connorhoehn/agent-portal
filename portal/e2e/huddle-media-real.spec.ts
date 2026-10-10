import { loginAs } from './realSession';
import { test as base, expect, type Browser, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

// Opt in only against a real SFU/platform API. These tests install no route
// fixtures and own their browser; existing CDP sessions and physical devices
// are unaffected. Synthetic capture still uses actual WHIP/WHEP and RTP.
const test = base.extend<{}, { browser: Browser }>({
  browser: [async ({ playwright }, use) => {
    const browser = await playwright.chromium.launch({ channel: 'chrome', headless: true, args: [
      '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required', '--disable-features=LocalNetworkAccessChecks',
    ] });
    try { await use(browser); } finally { await browser.close(); }
  }, { scope: 'worker' }],
});
test.use({ baseURL: process.env.PARITY_BASE_URL ?? 'http://127.0.0.1:5261', viewport: { width: 1440, height: 900 } });
test.skip(process.env.REAL_MEDIA_ACCEPTANCE !== '1', 'Requires explicitly configured real SFU and platform API endpoints');

async function mediaStats(page: Page) {
  return page.evaluate(async () => {
    const peers = (window as unknown as { __orgiqMediaPCs: RTCPeerConnection[] }).__orgiqMediaPCs ?? [];
    const result = { connected: 0, audioBytes: 0, audioSamples: 0, audioEnergy: 0, videoBytes: 0, videoFrames: 0 };
    for (const pc of peers) {
      if (pc.connectionState === 'closed') continue;
      if (pc.connectionState === 'connected') result.connected++;
      const stats = await pc.getStats();
      stats.forEach(row => {
        if (row.type !== 'inbound-rtp' || row.isRemote) return;
        if ((row.kind ?? row.mediaType) === 'audio') {
          result.audioBytes += row.bytesReceived ?? 0;
          result.audioSamples += row.totalSamplesReceived ?? 0;
          result.audioEnergy += row.totalAudioEnergy ?? 0;
        } else if ((row.kind ?? row.mediaType) === 'video') {
          result.videoBytes += row.bytesReceived ?? 0;
          result.videoFrames += row.framesDecoded ?? 0;
        }
      });
    }
    return result;
  });
}

async function playingRemoteSinks(page: Page) {
  return page.locator('[data-testid="shell-call-media"] video, [data-testid="shell-call-media"] audio').evaluateAll(elements =>
    elements.filter(element => {
      const media = element as HTMLMediaElement, stream = media.srcObject as MediaStream | null;
      return stream?.getAudioTracks().some(track => track.readyState === 'live') && !media.muted && !media.paused;
    }).length);
}

async function localTracks(page: Page) {
  return page.evaluate(() => {
    const streams = (window as unknown as { __orgiqCapturedStreams: MediaStream[] }).__orgiqCapturedStreams ?? [];
    return streams.flatMap(stream => stream.getTracks().map(track => ({ kind: track.kind, enabled: track.enabled, state: track.readyState })));
  });
}

async function leaveCall(page: Page) {
  const leave = page.getByTestId('shell-call-dock-leave');
  if (!await leave.isVisible()) return;
  await leave.click();
}

test('real bidirectional media survives navigation, camera/mic controls and explicit Leave', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(120_000);
  const contexts = await Promise.all([browser.newContext({ baseURL, permissions: ['camera', 'microphone'] }),
    browser.newContext({ baseURL, permissions: ['camera', 'microphone'] })]);
  const pages: Page[] = [], errors: string[] = [], failures: string[] = [];
  const sessions = new Set<string>();
  try {
    for (const [index, context] of contexts.entries()) {
      await context.addInitScript(() => {
        const peers: RTCPeerConnection[] = [];
        const streams: MediaStream[] = [];
        (window as unknown as { __orgiqMediaPCs: RTCPeerConnection[] }).__orgiqMediaPCs = peers;
        (window as unknown as { __orgiqCapturedStreams: MediaStream[] }).__orgiqCapturedStreams = streams;
        const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = async constraints => {
          const stream = await getUserMedia(constraints); streams.push(stream); return stream;
        };
        window.RTCPeerConnection = new Proxy(window.RTCPeerConnection, {
          construct(Target, args) { const pc = Reflect.construct(Target, args) as RTCPeerConnection; peers.push(pc); return pc; },
        });
      });
      const page = await context.newPage(); pages.push(page);
      page.on('pageerror', error => errors.push(error.message));
      page.on('response', async response => {
        const url = new URL(response.url());
        if (response.status() >= 400 && /\/api\/(video|sessions|channels)\//.test(url.pathname))
          failures.push(`${response.request().method()} ${url.pathname} ${response.status()}`);
        if (response.request().method() === 'POST' && url.pathname === '/api/video/sessions' && response.ok()) {
          const data = await response.json(); if (data.sessionId) sessions.add(data.sessionId);
        }
      });
      await loginAs(context, index ? 'u-vera' : 'u-rachel', baseURL, true);
      const endpointResponse = await page.request.get('/api/session/realtime-token');
      expect(endpointResponse.status()).toBe(200);
      const endpoints = await endpointResponse.json();
      // The platform URL is whatever the stack's realtime-token advertises (Tilt: REALTIME_PLATFORM_PUBLIC_URL), never a literal.
      expect(endpoints.platformApiUrl).toMatch(/^https?:\/\/[^/]+$/);
      if (process.env.MEDIA_PLATFORM_URL) expect(endpoints.platformApiUrl).toBe(process.env.MEDIA_PLATFORM_URL);
      expect(endpoints.videoUrl).toBe(process.env.MEDIA_SFU_URL ?? 'http://127.0.0.1:3902');
      await page.goto('/iq/projects/p-auth-migration');
      await expect(page.getByTestId('initiative-start-call')).toBeEnabled({ timeout: 15_000 });
    }
    const [caller, receiver] = pages as [Page, Page];
    await caller.getByTestId('initiative-start-call').click();
    await receiver.getByRole('button', { name: 'Accept', exact: true }).click({ timeout: 15_000 });
    for (const page of pages) {
      await expect(page.getByTestId('initiative-call-dock')).toHaveAttribute('data-phase', 'active', { timeout: 30_000 });
      await expect.poll(async () => (await mediaStats(page)).audioSamples, { timeout: 30_000 }).toBeGreaterThan(0);
      await expect.poll(async () => (await mediaStats(page)).audioEnergy, { timeout: 30_000 }).toBeGreaterThan(0);
      await expect.poll(async () => (await mediaStats(page)).videoFrames, { timeout: 30_000 }).toBeGreaterThan(0);
      await expect.poll(() => playingRemoteSinks(page)).toBe(1);
    }
    expect(sessions.size, 'both callers must share one canonical media session').toBe(1);
    const before = await Promise.all(pages.map(mediaStats));
    await caller.getByTestId('initiative-header-tab-work').click();
    await caller.getByTestId('initiative-work-list').getByText('Logout leaves the legacy shim cookie alive', { exact: true }).first().click();
    await expect(caller.getByTestId('work-item-header')).toBeVisible();
    await expect(caller.getByTestId('shell-call-dock')).toBeVisible();
    // The central composer carries the bounded participant shelf; the social
    // footer owns controls. SPA navigation keeps capture and playback mounted.
    await expect(caller.getByTestId('shell-call-media')).toBeVisible();
    await expect(caller.getByTestId('shell-call-media')).toHaveAttribute('data-placement', 'composer');
    const shelf = await caller.getByTestId('shell-call-media').boundingBox();
    expect(shelf?.height, 'call tiles must stay bounded above the composer').toBeLessThanOrEqual(220);
    await caller.getByTestId('initiative-search-link').click();
    await expect(caller).toHaveURL(/\/iq\/search\?scope=p-auth-migration/);
    await expect(caller.getByTestId('shell-call-dock')).toBeVisible();
    for (const [index, page] of pages.entries()) {
      await expect.poll(async () => (await mediaStats(page)).audioSamples).toBeGreaterThan(before[index]!.audioSamples);
      await expect.poll(async () => (await mediaStats(page)).videoFrames).toBeGreaterThan(before[index]!.videoFrames);
      await expect.poll(() => playingRemoteSinks(page)).toBe(1);
    }
    await caller.getByTestId('shell-call-dock-camera').click();
    await expect(caller.getByTestId('shell-call-dock-camera')).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(async () => (await localTracks(caller)).filter(track => track.kind === 'video' && track.state === 'live')
      .every(track => !track.enabled)).toBe(true);
    const cameraOff = await mediaStats(receiver);
    await expect.poll(async () => (await mediaStats(receiver)).audioSamples).toBeGreaterThan(cameraOff.audioSamples);
    await expect.poll(() => playingRemoteSinks(receiver)).toBe(1);
    await caller.getByTestId('shell-call-dock-mic').click();
    await expect(caller.getByTestId('shell-call-dock-mic')).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(async () => (await localTracks(caller)).filter(track => track.kind === 'audio' && track.state === 'live')
      .every(track => !track.enabled)).toBe(true);
    await caller.getByTestId('shell-call-dock-mic').click();
    await expect(caller.getByTestId('shell-call-dock-mic')).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => (await localTracks(caller)).some(track => track.kind === 'audio' && track.state === 'live' && track.enabled)).toBe(true);
    await caller.getByTestId('shell-call-dock-camera').click();
    await expect(caller.getByTestId('shell-call-dock-camera')).toHaveAttribute('aria-pressed', 'true');
    const resumed = await mediaStats(receiver);
    await expect.poll(async () => (await mediaStats(receiver)).videoFrames).toBeGreaterThan(resumed.videoFrames);
    const final = await Promise.all(pages.map(mediaStats));
    expect(failures).toEqual([]); expect(errors).toEqual([]);
    const summary = testInfo.outputPath('real-media-summary.json');
    await writeFile(summary, JSON.stringify({ sessions: sessions.size, before, final }, null, 2));
    await testInfo.attach('real-media-summary', { path: summary, contentType: 'application/json' });
    await leaveCall(caller);
    await expect.poll(async () => (await mediaStats(caller)).connected).toBe(0);
    await expect.poll(() => playingRemoteSinks(caller)).toBe(0);
    await expect.poll(async () => (await localTracks(caller)).every(track => track.state === 'ended')).toBe(true);
  } finally {
    for (const page of pages) {
      await leaveCall(page).catch(() => undefined);
    }
    await Promise.all(contexts.map(context => context.close()));
    await testInfo.attach('media-failures', { body: JSON.stringify({ errors, failures }, null, 2), contentType: 'application/json' });
  }
});

test('real platform API refuses missing and forged call credentials', async ({ browser, baseURL, request }) => {
  const context = await browser.newContext({ baseURL });
  let url: string;
  try {
    await loginAs(context, 'u-rachel', baseURL, true);
    const response = await context.request.get('/api/session/realtime-token');
    expect(response.status()).toBe(200);
    url = (await response.json()).platformApiUrl;
    expect(url).toMatch(/^https?:\/\/[^/]+$/);
  } finally { await context.close(); }
  expect((await request.post(`${url}/api/video/sessions`, { data: { lobbyName: 'orgiq:dm:u-rachel-u-vera' } })).status()).toBe(401);
  expect((await request.post(`${url}/api/video/sessions`, { headers: { Authorization: 'Bearer forged' },
    data: { lobbyName: 'orgiq:dm:u-rachel-u-vera' } })).status()).toBe(401);
});

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';
import { test, expect } from './cdpTest';
import { signIn, type Principal } from './realSession';
import { seedPreJoin } from './preJoin';

// Explicit opt-in: this creates one real Work call and its native recording.
// Only owned prepared movie/WAV URLs are fixtures. No native API route, signed
// identity, actor grant, call state, capture lifecycle or stored result is mocked.
test.use({ baseURL: process.env.PARITY_BASE_URL ?? 'http://localhost:5183', viewport: { width: 1440, height: 900 } });
test.skip(process.env.NATIVE_SCREEN_IDENTITY_ACCEPTANCE !== '1' || !process.env.CDP_ENDPOINT,
  'Requires explicit native acceptance opt-in and an authorized CDP endpoint');

type Capture = { stream: MediaStream };
type PreparedState = { ready: Promise<unknown>; stream?: MediaStream; captures: Capture[]; peers: RTCPeerConnection[]; display?: MediaStream;
  lifecycle: Array<{ at: number; pc: number; event: string; trackId?: string }>;
  pcm: Map<string, { track: MediaStreamTrack; analyser: AnalyserNode; peakRms: number; lastRms: number; samples: number }> };
declare global { interface Window { __nativeScreenIdentity: PreparedState } }
type Actor = { context: BrowserContext; page: Page; principal: Principal; errors: string[]; remoteLog: Array<{ at: number; text: string }> };
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const OLD = [
  { id: '2026-10-09T20-42-14-121Z-457a1e8b', expected: '0c2f7815ea36c0921b927192c2c58364e2f5d19c80eef352276572ac7a45c252' },
  { id: '2026-10-09T20-35-19-431Z-e153e35d', expected: null },
];

async function preparedMedia(context: BrowserContext, baseURL: string, userId: string, run: string) {
  const mediaRoot = resolve(process.env.HUDDLE_MEDIA_ROOT ?? '/private/tmp/work-huddle-speaking-media');
  const prefix = new URL(`/__native-screen-identity/${run}/${userId}`, baseURL).href;
  const movie = await readFile(resolve(mediaRoot, 'initiative', `${userId}.mp4`));
  const wav = await readFile(resolve(mediaRoot, 'initiative', `${userId}.wav`));
  await context.route(`${prefix}.mp4`, route => route.fulfill({ contentType: 'video/mp4', body: movie }));
  await context.route(`${prefix}.wav`, route => route.fulfill({ contentType: 'audio/wav', body: wav }));
  await context.addInitScript(({ movieURL, audioURL }) => {
    const state: PreparedState = { ready: Promise.resolve(), captures: [], peers: [], lifecycle: [], pcm: new Map() };
    window.__nativeScreenIdentity = state;
    const NativePC = window.RTCPeerConnection;
    window.RTCPeerConnection = new Proxy(NativePC, {
      construct(Target, args) {
        const pc = Reflect.construct(Target, args) as RTCPeerConnection;
        const pcId = state.peers.push(pc) - 1;
        pc.addEventListener('connectionstatechange', () => state.lifecycle.push({ at: performance.now(), pc: pcId, event: pc.connectionState }));
        pc.addEventListener('track', event => {
          event.track.addEventListener('ended', () => state.lifecycle.push({ at: performance.now(), pc: pcId, event: 'receiver-ended', trackId: event.track.id }));
          if (event.track.kind !== 'audio') return;
          void state.ready.then(() => {
            // The sole analyser input is the genuine native receiver track.
            // A silent downstream sink processes it without changing app audio.
            const input = audio.createMediaStreamSource(new MediaStream([event.track]));
            const analyser = audio.createAnalyser(); analyser.fftSize = 1024;
            const silent = audio.createGain(); silent.gain.value = 0;
            input.connect(analyser).connect(silent).connect(audio.destination);
            state.pcm.set(event.track.id, { track: event.track, analyser, peakRms: 0, lastRms: 0, samples: 0 });
          });
        });
        return pc;
      },
    });
    let video: HTMLVideoElement, audio: AudioContext, buffer: AudioBuffer;
    state.ready = new Promise<void>(done => document.readyState === 'loading'
      ? document.addEventListener('DOMContentLoaded', () => done(), { once: true }) : done()).then(async () => {
      video = document.createElement('video'); video.muted = true; video.playsInline = true;
      video.preload = 'auto'; video.style.cssText = 'position:fixed;left:-10000px;width:320px;height:180px';
      document.body.append(video);
      const loaded = new Promise<void>((done, fail) => {
        video.addEventListener('loadeddata', () => done(), { once: true });
        video.addEventListener('error', () => fail(new Error('Prepared portrait movie unavailable')), { once: true });
      });
      video.src = movieURL; audio = new AudioContext({ sampleRate: 48000 });
      const response = await fetch(audioURL); if (!response.ok) throw new Error('Prepared speech WAV unavailable');
      buffer = await audio.decodeAudioData(await response.arrayBuffer()); await loaded;
      return { duration: video.duration, audioDuration: buffer.duration };
    });
    navigator.mediaDevices.getUserMedia = async constraints => {
      await state.ready;
      if (state.stream) throw new Error('Unexpected second camera acquisition in one native scene');
      await audio.resume(); video.currentTime = 0; await video.play();
      const capture = (video as HTMLVideoElement & { captureStream(): MediaStream }).captureStream();
      const destination = audio.createMediaStreamDestination(), source = audio.createBufferSource();
      source.buffer = buffer; source.connect(destination); source.start();
      const tracks = [...(constraints.video ? capture.getVideoTracks() : []), ...(constraints.audio ? destination.stream.getAudioTracks() : [])];
      const stream = new MediaStream(tracks); state.stream = stream; state.captures.push({ stream });
      const timer = setInterval(() => {
        if (!tracks.every(track => track.readyState === 'ended')) return;
        clearInterval(timer); video.pause(); source.stop(); void audio.close();
      }, 100);
      return stream;
    };
    navigator.mediaDevices.getDisplayMedia = async () => {
      const canvas = document.createElement('canvas'); canvas.width = 960; canvas.height = 540;
      canvas.style.cssText = 'position:fixed;left:-10000px'; document.body.append(canvas);
      const ctx = canvas.getContext('2d')!; let frame = 0;
      const paint = () => {
        ctx.fillStyle = '#17345f'; ctx.fillRect(0, 0, 960, 540);
        ctx.fillStyle = '#9ce2ff'; ctx.font = 'bold 40px sans-serif'; ctx.fillText('Native Work screen transport', 40, 80);
        ctx.font = '28px monospace'; ctx.fillText(`Frame ${frame++}`, 40, 130);
        ctx.fillStyle = '#ffb84d'; ctx.fillRect((frame * 9) % 800, 240, 120, 100);
      };
      paint(); const stream = canvas.captureStream(12); state.display = stream;
      const timer = setInterval(() => { if (stream.getTracks().every(track => track.readyState === 'ended')) { clearInterval(timer); canvas.remove(); } else paint(); }, 1000 / 12);
      return stream;
    };
    setInterval(() => {
      for (const entry of state.pcm.values()) {
        if (entry.track.readyState !== 'live') continue;
        const data = new Float32Array(entry.analyser.fftSize); entry.analyser.getFloatTimeDomainData(data);
        entry.lastRms = Math.sqrt(data.reduce((sum, sample) => sum + sample * sample, 0) / data.length);
        entry.peakRms = Math.max(entry.peakRms, entry.lastRms); entry.samples++;
      }
    }, 100);
  }, { movieURL: `${prefix}.mp4`, audioURL: `${prefix}.wav` });
  return { actor: userId, movieSHA256: hash(movie), audioSHA256: hash(wav), physicalDevicesOrOSPickerClaimed: false };
}

async function media(page: Page) {
  return page.evaluate(async () => {
    const state = window.__nativeScreenIdentity;
    const result = { connected: 0, audioEnergy: 0, audioSamples: 0, videoFrames: 0, lifecycle: [...state.lifecycle],
      receiverPCs: [] as Array<{ id: number; state: string; tracks: Array<{ id: string; kind: string; state: string }>; rtp: Array<{ id: string; kind: string; samples: number; frames: number }> }>,
      remoteDecodedPCM: [...state.pcm.entries()].map(([id, p]) => ({ trackId: id, readyState: p.track.readyState, peakRms: p.peakRms, lastRms: p.lastRms, analyserSamples: p.samples })),
      remoteDecodedPcmPeakRms: Math.max(0, ...[...state.pcm.values()].map(p => p.peakRms)),
      cameras: state.captures.flatMap(c => c.stream.getVideoTracks().map(t => ({ id: t.id, state: t.readyState }))),
      capturesEnded: state.captures.every(c => c.stream.getTracks().every(t => t.readyState === 'ended')) };
    for (const [id, pc] of state.peers.entries()) {
      const receivers = pc.getReceivers().filter(r => r.track);
      const snapshot = { id, state: pc.connectionState,
        tracks: receivers.map(r => ({ id: r.track.id, kind: r.track.kind, state: r.track.readyState })),
        rtp: [] as Array<{ id: string; kind: string; samples: number; frames: number }> };
      if (snapshot.tracks.length) result.receiverPCs.push(snapshot);
      if (pc.connectionState === 'closed') continue;
      if (pc.connectionState === 'connected') result.connected++;
      (await pc.getStats()).forEach(row => {
        if (row.type !== 'inbound-rtp' || row.isRemote) return;
        snapshot.rtp.push({ id: row.id, kind: row.kind ?? row.mediaType, samples: row.totalSamplesReceived ?? 0, frames: row.framesDecoded ?? 0 });
        if ((row.kind ?? row.mediaType) === 'audio') { result.audioEnergy += row.totalAudioEnergy ?? 0; result.audioSamples += row.totalSamplesReceived ?? 0; }
        if ((row.kind ?? row.mediaType) === 'video') result.videoFrames += row.framesDecoded ?? 0;
      });
    }
    return result;
  });
}

async function native(actor: Actor, path: string, method = 'GET') {
  const source = await actor.context.request.get('/api/session/realtime-token'); expect(source.status()).toBe(200);
  const token = await source.json(); const target = new URL(token.platformApiUrl);
  expect(['localhost', '127.0.0.1']).toContain(target.hostname);
  const response = await actor.context.request.fetch(`${target.origin}${path}`, { method,
    headers: { Authorization: `Bearer ${token.token}` } });
  return { response, body: await response.json() };
}

async function oldMedia(actor: Actor) {
  const proofs = [];
  for (const item of OLD) {
    const detail = await native(actor, `/api/recordings/${item.id}`); expect(detail.response.status()).toBe(200);
    const url = detail.body.composedUrl; expect(new URL(url).origin).toBe('http://127.0.0.1:3902');
    const response = await actor.context.request.get(url); expect(response.status()).toBe(200);
    const bytes = await response.body(), sha256 = hash(bytes);
    if (item.expected) expect(sha256).toBe(item.expected);
    proofs.push({ recordingId: item.id, bytes: bytes.length, sha256 });
  }
  return proofs;
}

async function leave(page: Page) {
  const button = page.getByTestId('shell-call-dock-leave');
  if (await button.isVisible().catch(() => false)) await button.click();
}

test('native Work records two people and three trusted camera/screen legs without losing cameras or call context', async ({ browser, baseURL }, info) => {
  test.setTimeout(240_000);
  const contexts: BrowserContext[] = [], actors: Actor[] = [], run = `native-${Date.now()}`;
  const output = resolve(process.env.NATIVE_SCREEN_EVIDENCE ?? info.outputDir);
  await mkdir(output, { recursive: true });
  await writeFile(resolve(output, 'executed-test.ts'), await readFile(new URL(import.meta.url)));
  const save = (name: string, body: unknown) => writeFile(resolve(output, name), JSON.stringify(body, null, 2) + '\n');
  const sourceProofs = [], sessions = new Set<string>();
  let recordingId = '', callId = '', failure: string | null = null;
  let stopShareAt = 0;
  try {
    for (const userId of ['u-nora', 'u-vera', 'u-eli']) {
      const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 }, permissions: ['camera', 'microphone'] }); contexts.push(context);
      await seedPreJoin(context);
      if (userId !== 'u-eli') sourceProofs.push(await preparedMedia(context, baseURL!, userId, run));
      const principal = await signIn(context, userId, { expectTenant: 'orgiq' });
      const page = await context.newPage(), errors: string[] = [], remoteLog: Array<{ at: number; text: string }> = []; actors.push({ context, page, principal, errors, remoteLog });
      page.on('console', message => {
        const text = message.text();
        if (text.startsWith('[remote-pc]') && !text.includes('open failed')) remoteLog.push({ at: Date.now(), text });
        if (text.startsWith('[remote-discovery] event') || text.startsWith('[remote-discovery] producer.removed')) remoteLog.push({ at: Date.now(), text });
      });
      page.on('pageerror', e => errors.push(e.message));
      page.on('response', response => {
        const path = new URL(response.url()).pathname;
        if (response.ok() && response.request().method() === 'POST' && path === '/api/video/sessions') void response.json().then(body => { if (body.sessionId) sessions.add(body.sessionId); });
        const match = /\/api\/calls\/([^/]+)\/chat$/.exec(path); if (match) callId = decodeURIComponent(match[1]!);
      });
      await page.goto('/iq/projects/p-observability');
      await expect(page.getByTestId('initiative-header')).toBeVisible();
      if (userId !== 'u-eli') { await page.evaluate(() => window.__nativeScreenIdentity.ready); await expect(page.getByTestId('shell-footer-context-start')).toBeEnabled({ timeout: 20_000 }); }
    }
    const [nora, vera, outsider] = actors as [Actor, Actor, Actor];
    const beforeMedia = await oldMedia(nora); await save('historical-media-before.json', beforeMedia);
    const beforeRecordings = await native(nora, '/api/recordings?limit=100'); expect(beforeRecordings.response.status()).toBe(200);
    const existing = new Set(beforeRecordings.body.items.map((r: { recordingId: string }) => r.recordingId));
    const started = Date.now();
    await nora.page.getByTestId('shell-footer-context-start').click();
    await expect.poll(() => sessions.size).toBe(1);
    await vera.page.getByTestId('shell-footer-context-start').click();
    for (const actor of [nora, vera]) {
      await expect(actor.page.getByTestId('shell-call-media')).toHaveAttribute('data-placement', 'composer', { timeout: 30_000 });
      await expect(actor.page.getByTestId('call-dock-tile-row')).toHaveAttribute('data-tile-count', '2', { timeout: 30_000 });
      await expect.poll(async () => (await media(actor.page)).videoFrames, { timeout: 30_000 }).toBeGreaterThan(0);
      await expect.poll(async () => (await media(actor.page)).audioSamples, { timeout: 30_000 }).toBeGreaterThan(0);
      await expect.poll(async () => (await media(actor.page)).remoteDecodedPcmPeakRms, { timeout: 40_000 }).toBeGreaterThan(0.001);
    }
    const cameras = await Promise.all([nora, vera].map(a => media(a.page))); await save('native-connected.json', cameras);
    await nora.page.getByTestId('call-page-sharing-trigger').click();
    await nora.page.getByTestId('call-screen-sharing').click();
    const screens = (p: Page) => p.locator('[data-testid="shell-call-media"] [data-call-stream="screen"]');
    for (const actor of [nora, vera]) {
      await expect(screens(actor.page)).toHaveCount(1, { timeout: 20_000 });
      await expect(actor.page.getByTestId('call-dock-tile-row')).toHaveAttribute('data-tile-count', '3');
    }
    const remote = screens(vera.page).locator('video');
    await expect.poll(() => remote.evaluate((v: HTMLVideoElement) => v.videoWidth)).toBeGreaterThan(0);
    const screenTime = await remote.evaluate((v: HTMLVideoElement) => v.currentTime);
    await expect.poll(() => remote.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(screenTime + 0.5);
    await Promise.all([nora, vera].map((a, index) => a.page.screenshot({ path: resolve(output, `native-three-tiles-${index ? 'vera' : 'nora'}.png`) })));
    await nora.page.getByTestId('huddle-reaction-toggle').click();
    await nora.page.getByTestId('huddle-reaction-picker').getByRole('button', { name: 'React with party', exact: true }).click();
    await expect(nora.page.getByTestId('huddle-reaction-picker')).toHaveCount(0);
    await expect(vera.page.getByTestId('shell-call-media').getByTestId('reaction-float').filter({ hasText: '🎉' }).first()).toBeVisible();
    await vera.page.screenshot({ path: resolve(output, 'native-screen-reaction.png') });
    const beforeStop = await Promise.all([nora, vera].map(a => media(a.page)));
    stopShareAt = Date.now();
    await nora.page.getByTestId('call-page-sharing-trigger').click();
    await nora.page.getByTestId('call-screen-sharing').click();
    for (const actor of [nora, vera]) { await expect(screens(actor.page)).toHaveCount(0); await expect(actor.page.getByTestId('call-dock-tile-row')).toHaveAttribute('data-tile-count', '2'); }
    const stopped = await Promise.all([nora, vera].map(a => media(a.page)));
    await save('native-stop-share-baseline.json', { beforeStop, afterStop: stopped });
    for (const [index, actor] of [nora, vera].entries()) {
      expect(stopped[index]!.cameras).toEqual(cameras[index]!.cameras);
      // Compare the same remote camera PC and RTP rows across Stop Share.
      // A screen PC disappearing must not mask camera teardown/reconnection.
      const cameraPCs = beforeStop[index]!.receiverPCs.filter(pc => pc.state === 'connected' && pc.rtp.some(row => row.kind === 'audio') && pc.rtp.some(row => row.kind === 'video'));
      expect(cameraPCs).toHaveLength(1);
      for (const baseline of cameraPCs) {
        const assertProgress = async () => {
          const current = await media(actor.page), owned = current.receiverPCs.find(pc => pc.id === baseline.id)!;
          expect(owned.state).toBe('connected');
          expect(owned.tracks).toEqual(baseline.tracks);
          expect(owned.tracks.every(track => track.state === 'live')).toBe(true);
          const ended = current.lifecycle.filter(event => event.pc === baseline.id && event.event === 'receiver-ended');
          expect(ended).toEqual([]);
          for (const row of baseline.rtp) {
            const now = owned.rtp.find(r => r.id === row.id)!;
            if (row.kind === 'audio') expect(now.samples).toBeGreaterThan(row.samples);
            if (row.kind === 'video') expect(now.frames).toBeGreaterThan(row.frames);
          }
          const audioTrack = baseline.tracks.find(t => t.kind === 'audio')!;
          const pcmBefore = beforeStop[index]!.remoteDecodedPCM.find(p => p.trackId === audioTrack.id)!;
          const pcmNow = current.remoteDecodedPCM.find(p => p.trackId === audioTrack.id)!;
          expect(pcmNow.analyserSamples).toBeGreaterThan(pcmBefore.analyserSamples);
          expect(pcmNow.peakRms).toBeGreaterThan(0.001);
          return true;
        };
        await expect.poll(assertProgress).toBe(true);
        // Observe through at least one health sweep; delayed orphan-ended
        // previously killed camera receivers ~2s after stopping the screen.
        await actor.page.waitForTimeout(2500);
        await assertProgress();
      }
    }
    await nora.page.getByRole('link', { name: 'Initiatives', exact: true }).click();
    await nora.page.getByRole('link', { name: 'Auth Migration', exact: true }).click();
    await expect(nora.page).toHaveURL(/\/iq\/projects\/p-auth-migration/);
    await expect(nora.page.getByTestId('shell-call-media')).toHaveCount(1);
    await expect(nora.page.getByTestId('shell-call-media')).toHaveAttribute('data-placement', 'composer');
    const bounds = await nora.page.getByTestId('shell-call-media').boundingBox(); expect(bounds!.height).toBeLessThanOrEqual(130);
    await expect(nora.page.getByTestId('shell-call-dock')).toContainText('Observability Platform');
    for (const id of ['shell-call-dock-mic', 'shell-call-dock-camera', 'shell-call-dock-leave']) await expect(nora.page.getByTestId(id)).toHaveCount(1);
    await expect(nora.page.getByTestId('shell-call-media').getByTestId('reaction-float')).toHaveCount(0, { timeout: 10_000 });
    await nora.page.screenshot({ path: resolve(output, 'observability-call-in-auth-composer.png') });
    const continuity = await Promise.all([nora, vera].map(a => media(a.page)));
    expect(sessions.size).toBe(1);
    await save('native-camera-continuity.json', { beforeShare: cameras, beforeStop, afterStop: stopped, afterNavigation: continuity, bounds, callId, stopShareAt });
    await Promise.all([nora, vera].map(a => leave(a.page)));
    for (const actor of [nora, vera]) { await expect.poll(async () => (await media(actor.page)).connected).toBe(0); await expect.poll(async () => (await media(actor.page)).capturesEnded).toBe(true); }
    let row: any;
    await expect.poll(async () => {
      const response = await native(nora, '/api/recordings?limit=100'); expect(response.response.status()).toBe(200);
      row = response.body.items.find((r: any) => !existing.has(r.recordingId) && r.lobbyName === 'orgiq:initiative:p-observability' && Date.parse(r.startedAt) >= started - 5_000);
      return Boolean(row);
    }, { timeout: 90_000, intervals: [500, 1000, 2000] }).toBe(true);
    recordingId = row.recordingId;
    let detail: any;
    await expect.poll(async () => { const result = await native(nora, `/api/recordings/${recordingId}`); expect(result.response.status()).toBe(200); detail = result.body; return detail.mediaState; }, { timeout: 90_000, intervals: [500, 1000, 2000] }).toBe('playable');
    expect(detail.participantCount).toBe(2);
    expect(detail.participants.map((p: any) => p.userId).sort()).toEqual(['u-nora', 'u-vera']);
    expect(detail.tracks).toHaveLength(3);
    expect(detail.tracks.map((t: any) => t.userId).sort()).toEqual(['u-nora', 'u-nora', 'u-vera']);
    expect(detail.tracks.filter((t: any) => t.videoProducerId && t.audioProducerId)).toHaveLength(2);
    expect(detail.tracks.filter((t: any) => t.videoProducerId && !t.audioProducerId)).toHaveLength(1);
    expect(detail.tracks.every((t: any) => t.size > 0)).toBe(true);
    const metadata = { recordingId, lobbyName: detail.lobbyName, participantCount: detail.participantCount, participants: detail.participants,
      startedAt: detail.startedAt, endedAt: detail.endedAt, stopShareAt, composeStatus: detail.composeStatus,
      tracks: detail.tracks.map(({ url, ...track }: any) => track) };
    await save('native-recording-identity.json', metadata);
    const playback = [];
    for (const actor of [nora, vera]) {
      const read = await native(actor, `/api/recordings/${recordingId}`); expect(read.response.status()).toBe(200); expect(read.body.participantCount).toBe(2);
      const allowed = await native(actor, `/api/recordings/${recordingId}/playback-token`, 'POST'); expect(allowed.response.status()).toBe(200); expect(allowed.body.mediaState).toBe('playable');
      await actor.page.goto(`/iq/projects/p-observability?tab=docs&recording=${recordingId}`);
      await expect(actor.page.getByTestId('initiative-recording-video')).toBeVisible({ timeout: 30_000 });
      await expect(actor.page.getByTestId('initiative-recording-reaction')).toContainText('Nora DaSilva reacted 🎉');
      const video = actor.page.getByTestId('initiative-recording-video').locator('video');
      await video.evaluate((v: HTMLVideoElement) => v.play());
      await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(1);
      playback.push({ actor: actor.principal.sub, role: actor.principal.role, status: read.response.status(), tokenStatus: allowed.response.status(), mediaState: allowed.body.mediaState,
        decoded: await video.evaluate((v: HTMLVideoElement) => ({ width: v.videoWidth, height: v.videoHeight, time: v.currentTime, readyState: v.readyState })) });
      await actor.page.screenshot({ path: resolve(output, `native-recording-playback-${actor.principal.sub}.png`) });
      await video.evaluate((v: HTMLVideoElement) => v.pause());
    }
    const denied = await native(outsider, `/api/recordings/${recordingId}`), deniedPlayback = await native(outsider, `/api/recordings/${recordingId}/playback-token`, 'POST');
    expect([403, 404]).toContain(denied.response.status()); expect([403, 404]).toContain(deniedPlayback.response.status());
    await outsider.page.goto(`/iq/projects/p-observability?tab=docs&recording=${recordingId}`);
    await expect(outsider.page.getByTestId('initiative-recording-detail')).toContainText('This recording is not available to your account.');
    await expect(outsider.page.getByTestId('initiative-recording-video')).toHaveCount(0);
    const afterMedia = await oldMedia(nora); expect(afterMedia).toEqual(beforeMedia); await save('historical-media-after.json', afterMedia);
    for (const actor of actors) expect(actor.errors).toEqual([]);
    await save('acceptance.json', { status: 'passed', at: new Date().toISOString(), recordingId, callId, nativeAPIsMocked: false, physicalDevicesOrOSPickerClaimed: false,
      principals: actors.map(a => a.principal), sources: sourceProofs, mediaIdentity: metadata, cameraTrackIdsPreserved: true, sameRemoteCameraPCAndRtpCountersPreservedAcrossStopShare: true, oneCompactComposerAcrossInitiatives: true,
      participantPlayback: playback, outsiderDenied: { actor: outsider.principal.sub, metadataStatus: denied.response.status(), playbackStatus: deniedPlayback.response.status(), playerRendered: false },
      historicalMediaUnchanged: afterMedia });
  } catch (error) { failure = error instanceof Error ? error.message : String(error); throw error; }
  finally {
    if (failure) await save('failure-media.json', await Promise.all(actors.slice(0, 2).map(async a => ({ actor: a.principal.sub, media: await media(a.page).catch(() => null) }))));
    await Promise.all(actors.slice(0, 2).map(a => leave(a.page).catch(() => undefined)));
    await save('remote-lifecycle-console.json', actors.map(a => ({ actor: a.principal.sub, events: a.remoteLog })));
    await save('owned-context-cleanup.json', await Promise.all(actors.slice(0, 2).map(async a => ({ actor: a.principal.sub, media: await media(a.page).catch(() => null) }))));
    if (failure) {
      await save('incomplete.json', { status: 'incomplete', failure, recordingId, callId, principals: actors.map(a => a.principal), errors: actors.map(a => ({ actor: a.principal.sub, errors: a.errors })) });
      await Promise.all(actors.map(a => a.page.screenshot({ path: resolve(output, `incomplete-${a.principal.sub}.png`) }).catch(() => undefined)));
    }
    await Promise.all(contexts.map(c => c.close()));
  }
});

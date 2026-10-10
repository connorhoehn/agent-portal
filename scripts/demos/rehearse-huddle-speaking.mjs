#!/usr/bin/env node
// Owned Chrome processes or isolated contexts with explicit prepared-media
// test sources, publishing through native Work huddles. No native API fixtures,
// injected call state, world reset or shared
// browser profiles. CDP actors use the workspace picker; their identities and
// role checks match portal/e2e/realSession.ts's real-session contract.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpAudit } from '../../skills/cdp-browser/scripts/client.mjs';
import { makeMediaContract, safeId } from './huddle-media-contract.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${name} needs a value`);
  return args[index + 1];
};
const pause = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms));
const assert = (value, message) => { if (!value) throw new Error(message); };
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const sha256 = async path => {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
};
async function until(read, predicate, description, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const value = await read();
    if (predicate(value)) return value;
    await pause(150);
  } while (Date.now() < deadline);
  throw new Error(`Timed out: ${description}`);
}

function mediaObserver() {
  window.__huddleRehearsal = { captures: [], peers: [], rtp: new Map(), samples: [], peerEvents: [], pageLifecycle: [] };
  const observed = window.__huddleRehearsal;
  for (const event of ['beforeunload', 'pagehide']) window.addEventListener(event, () => observed.pageLifecycle.push({ at: Date.now(), event, path: location.pathname }));
  // Read native RTP counters while each connection exists. A closed WHEP
  // peer no longer exposes its old getStats rows, so retain only counters
  // actually observed before closure; never infer them from a source file.
  observed.sampleStats = async () => {
    const sample = { at: Date.now(), peers: [] };
    await Promise.all(observed.peers.map(async (peer, index) => {
      const peerSample = { index, state: peer.connectionState, inbound: [] };
      sample.peers.push(peerSample);
      if (peer.connectionState === 'closed') return;
      try {
        (await peer.getStats()).forEach(row => {
          if (row.type !== 'inbound-rtp' || row.isRemote) return;
          const key = `${index}:${row.id}`, previous = observed.rtp.get(key) ?? {};
          const next = { ...previous, kind: row.kind ?? row.mediaType, sampledAt: Date.now() };
          for (const field of ['bytesReceived', 'totalSamplesReceived', 'totalAudioEnergy', 'framesDecoded']) {
            if (typeof row[field] === 'number') next[field] = Math.max(previous[field] ?? 0, row[field]);
          }
          observed.rtp.set(key, next);
          peerSample.inbound.push({ id: row.id, ...next });
        });
      } catch { /* a native connection closed during its observational read */ }
    }));
    observed.samples.push(sample);
  };
  setInterval(() => { void observed.sampleStats(); }, 200);
  const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async constraints => {
    const item = { requestedAt: Date.now(), audio: !!constraints.audio, video: !!constraints.video };
    observed.captures.push(item);
    const stream = await original(constraints);
    item.resolvedAt = Date.now();
    item.stream = stream;
    return stream;
  };
  window.RTCPeerConnection = new Proxy(window.RTCPeerConnection, {
    construct(Target, values) {
      const peer = Reflect.construct(Target, values), index = observed.peers.length;
      observed.peers.push(peer);
      observed.peerEvents.push({ at: Date.now(), index, event: 'created', state: peer.connectionState });
      peer.addEventListener('connectionstatechange', () => observed.peerEvents.push({ at: Date.now(), index, event: 'connectionstatechange', state: peer.connectionState }));
      return peer;
    },
  });
}
async function mediaStats(actor) {
  return actor.page.evaluate(async () => {
    const observed = window.__huddleRehearsal ?? { captures: [], peers: [] };
    await observed.sampleStats?.();
    const data = { connected: 0, audioBytes: 0, audioSamples: 0, audioEnergy: 0, audioEnergyAvailable: false, localAudioSources: [], videoBytes: 0, videoFrames: 0,
      receivedAudioEnergy: 0, receivedAudioSamples: 0, receivedVideoFrames: 0, observedInboundRtp: [...(observed.rtp?.values() ?? [])],
      captures: observed.captures.map(({ stream, ...capture }) => ({ ...capture,
        tracks: stream?.getTracks().map(track => ({ kind: track.kind, state: track.readyState, enabled: track.enabled })) ?? [] })) };
    for (const peer of observed.peers) {
      if (peer.connectionState === 'closed') continue;
      if (peer.connectionState === 'connected') data.connected++;
      (await peer.getStats()).forEach(row => {
        if (row.type === 'media-source' && (row.kind ?? row.mediaType) === 'audio') {
          data.localAudioSources.push({ audioLevel: row.audioLevel ?? null, totalAudioEnergy: row.totalAudioEnergy ?? null, totalSamplesDuration: row.totalSamplesDuration ?? null });
        }
        if (row.type !== 'inbound-rtp' || row.isRemote) return;
        if ((row.kind ?? row.mediaType) === 'audio') {
          data.audioBytes += row.bytesReceived ?? 0;
          data.audioSamples += row.totalSamplesReceived ?? 0;
          data.audioEnergy += row.totalAudioEnergy ?? 0;
          if (typeof row.totalAudioEnergy === 'number') data.audioEnergyAvailable = true;
        } else if ((row.kind ?? row.mediaType) === 'video') {
          data.videoBytes += row.bytesReceived ?? 0;
          data.videoFrames += row.framesDecoded ?? 0;
        }
      });
    }
    for (const row of data.observedInboundRtp) {
      if (row.kind === 'audio') { data.receivedAudioEnergy += row.totalAudioEnergy ?? 0; data.receivedAudioSamples += row.totalSamplesReceived ?? 0; }
      else if (row.kind === 'video') data.receivedVideoFrames += row.framesDecoded ?? 0;
    }
    return data;
  });
}
function contextMediaSource({ movieUrl, audioUrl }) {
  const state = { mechanism: 'prepared-video-captureStream+WebAudio-WAV', startedAt: null, video: null, audioContext: null, audioBuffer: null, stream: null };
  window.__workSpeakingMedia = state;
  state.ready = new Promise(resolve => {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', resolve, { once: true });
    else resolve();
  }).then(async () => {
    const video = document.createElement('video');
    video.muted = true; video.playsInline = true; video.preload = 'auto';
    video.style.cssText = 'position:fixed;left:-10000px;top:0;width:320px;height:180px;pointer-events:none';
    document.body.append(video); state.video = video;
    const loaded = new Promise((resolve, reject) => {
      video.addEventListener('loadeddata', resolve, { once: true });
      video.addEventListener('error', () => reject(new Error('Prepared test movie could not decode')), { once: true });
    });
    video.src = movieUrl;
    const audioContext = new AudioContext({ sampleRate: 48000 }); state.audioContext = audioContext;
    const response = await fetch(audioUrl); if (!response.ok) throw new Error('Prepared test WAV unavailable');
    state.audioBuffer = await audioContext.decodeAudioData(await response.arrayBuffer());
    await loaded;
    return { movieDuration: video.duration, audioDuration: state.audioBuffer.duration, captureStream: typeof video.captureStream === 'function' };
  });
  navigator.mediaDevices.getUserMedia = async constraints => {
    await state.ready;
    if (state.stream) throw new Error('Prepared context media supports one synchronized acquisition per scene');
    await state.audioContext.resume();
    state.video.currentTime = 0;
    await state.video.play();
    const captured = state.video.captureStream();
    const destination = state.audioContext.createMediaStreamDestination();
    const source = state.audioContext.createBufferSource(); source.buffer = state.audioBuffer; source.connect(destination);
    source.start(); state.startedAt = Date.now();
    const tracks = [...(constraints.video ? captured.getVideoTracks() : []), ...(constraints.audio ? destination.stream.getAudioTracks() : [])];
    state.stream = new MediaStream(tracks);
    if ((constraints.video && !state.stream.getVideoTracks().length) || (constraints.audio && !state.stream.getAudioTracks().length)) throw new Error('Prepared capture did not produce the requested tracks');
    const stop = setInterval(() => {
      if (!tracks.every(track => track.readyState === 'ended')) return;
      clearInterval(stop); state.video.pause(); source.stop(); void state.audioContext.close();
    }, 100);
    return state.stream;
  };
}
function contextDisplaySource() {
  window.__workDisplayMedia = { mechanism: 'explicit-owned-canvas-captureStream', requests: [], stream: null };
  navigator.mediaDevices.getDisplayMedia = async constraints => {
    const state = window.__workDisplayMedia;
    state.requests.push({ at: Date.now(), video: !!constraints.video, audio: !!constraints.audio });
    const canvas = document.createElement('canvas'); canvas.width = 960; canvas.height = 540;
    canvas.style.cssText = 'position:fixed;left:-10000px;top:0;pointer-events:none'; document.body.append(canvas);
    const context = canvas.getContext('2d'); let frame = 0;
    const paint = () => {
      context.fillStyle = '#17345f'; context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = '#9ce2ff'; context.font = 'bold 40px sans-serif'; context.fillText('Owned display transport test', 50, 80);
      context.font = '28px monospace'; context.fillText(`Frame ${frame++}`, 50, 130);
      context.fillStyle = '#ffb84d'; context.fillRect((frame * 9) % 800, 240, 120, 100);
    };
    paint(); const stream = canvas.captureStream(12); state.stream = stream;
    const timer = setInterval(() => {
      if (stream.getTracks().every(track => track.readyState === 'ended')) { clearInterval(timer); canvas.remove(); return; }
      paint();
    }, 1000 / 12);
    return stream;
  };
}
async function installContextMedia(actor, { scene, person, mediaRoot, baseURL, runId, displayMedia = false }) {
  const prefix = `/__work-speaking-media/${runId}/${scene.id}/${person.userId}`;
  const movieUrl = new URL(`${prefix}.mp4`, baseURL).href, audioUrl = new URL(`${prefix}.wav`, baseURL).href;
  const movie = await readFile(join(mediaRoot, scene.id, `${person.userId}.mp4`));
  const audio = await readFile(join(mediaRoot, scene.id, `${person.userId}.wav`));
  // These two dedicated fixture byte URLs are the ONLY intercepted requests.
  // Sign-in, native SDK APIs, RTP and recordings use the existing live stack.
  await actor.context.route(movieUrl, route => route.fulfill({ status: 200, contentType: 'video/mp4', body: movie }));
  await actor.context.route(audioUrl, route => route.fulfill({ status: 200, contentType: 'audio/wav', body: audio }));
  // Keep initialization order deterministic: the observational wrapper must
  // wrap this explicit test source, not a physical device implementation.
  await actor.context.addInitScript(`(${contextMediaSource.toString()})(${JSON.stringify({ movieUrl, audioUrl })}); (${mediaObserver.toString()})(); ${displayMedia ? `(${contextDisplaySource.toString()})();` : ''}`);
}
async function launchActor({ scene, person, mediaRoot, chrome, baseURL, output, headed, audioServiceInProcess, cdp, contextMedia, runId, displayMedia = false }) {
  const directory = cdp ? null : await mkdtemp(`/private/tmp/work-speaking-${scene.id}-${person.userId}-`);
  const camera = join(mediaRoot, scene.id, `${person.userId}.y4m`);
  const microphone = join(mediaRoot, scene.id, `${person.userId}.wav`);
  const flags = [
    `--user-data-dir=${directory}`, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
    '--no-first-run', '--no-default-browser-check', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
    `--use-file-for-fake-video-capture=${camera}`, `--use-file-for-fake-audio-capture=${microphone}`,
    ...(audioServiceInProcess ? ['--disable-features=AudioServiceOutOfProcess'] : []),
    '--autoplay-policy=no-user-gesture-required', '--window-size=1440,900',
    ...(!headed ? ['--headless=new'] : []), 'about:blank',
  ];
  const process = cdp ? null : spawn(chrome, flags, { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let terminal = false, launchError = null;
  process?.once('exit', (code, signal) => { launchError ??= new Error(`Owned Chrome exited for ${person.name} (code=${code}, signal=${signal})`); terminal = true; });
  process?.once('error', error => { launchError = error; terminal = true; });
  process?.stderr.on('data', chunk => { void appendFile(join(output, `${scene.id}-${person.userId}-chrome.log`), chunk); });
  let audit;
  const close = async () => {
    await audit?.close().catch(() => undefined);
    if (!terminal && process?.pid) {
      try { globalThis.process.kill(-process.pid, 'SIGTERM'); } catch { /* already exited */ }
      await until(async () => terminal, value => value, 'owned Chrome to stop', 5_000).catch(() => {
        try { globalThis.process.kill(-process.pid, 'SIGKILL'); } catch { /* already exited */ }
      });
    }
    if (directory) await rm(directory, { recursive: true, force: true });
  };
  try {
    const port = cdp ? null : await until(async () => {
      if (terminal) throw launchError ?? new Error(`Owned Chrome exited for ${person.name}`);
      try { return Number((await readFile(join(directory, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); } catch { return null; }
    }, value => Number.isInteger(value) && value > 0, 'owned Chrome CDP listener');
    audit = await CdpAudit.connect({ endpoint: cdp ?? `http://127.0.0.1:${port}`, baseURL, packageRoot: join(root, 'portal') });
    const actor = await audit.actor(`speaking-${scene.id}-${person.userId}`);
    await actor.context.grantPermissions(['camera', 'microphone'], { origin: baseURL });
    // The shared pre-join remembered choice (portal/e2e/preJoin.ts). No
    // capture preview runs before the simultaneous page-huddle joins.
    await actor.context.addInitScript(() => localStorage.setItem('orgiq.call-prejoin.v1', JSON.stringify({ micOn: true, cameraOn: true, remember: true })));
    if (contextMedia) await installContextMedia(actor, { scene, person, mediaRoot, baseURL, runId, displayMedia });
    if (!contextMedia) await actor.context.addInitScript(mediaObserver);
    const sessions = new Set();
    const mediaChannels = new Set();
    const mediaOrigins = new Set();
    const failures = [];
    actor.page.on('console', message => {
      if (/^\[remote-(?:pc|discovery)\]/.test(message.text())) void appendFile(join(output, `${scene.id}-${person.userId}-native-discovery.jsonl`), JSON.stringify({ at: Date.now(), level: message.type(), text: message.text() }) + '\n');
    });
    actor.page.on('response', response => {
      const path = new URL(response.url()).pathname;
      if (/\/(?:whip|whep)(?:\/|$)/.test(path) || /^\/api\/video\/sessions(?:\/|$)/.test(path)) void appendFile(join(output, `${scene.id}-${person.userId}-native-transport.jsonl`), JSON.stringify({ at: Date.now(), origin: new URL(response.url()).origin, method: response.request().method(), route: path.replace(/[^/]+(?=\/(?:whip|whep))/, '<channel>'), status: response.status() }) + '\n');
      if (/\/(?:whip|whep)(?:\/|$)/.test(path) || /^\/api\/video\/sessions(?:\/|$)/.test(path)) mediaOrigins.add(new URL(response.url()).origin);
      if (response.status() >= 400 && /\/api\/(video|sessions|channels)\//.test(path)) {
        const failure = { origin: new URL(response.url()).origin, path, status: response.status() };
        failures.push(failure);
        void response.json().then(body => { failure.reason = [body.error, body.message, body.reason].filter(value => typeof value === 'string').join(' · '); }).catch(() => undefined);
      }
      if (response.request().method() === 'POST' && path === '/api/video/sessions' && response.ok()) {
        void response.json().then(body => { if (body.sessionId) sessions.add(body.sessionId); });
      }
      if (response.request().method() === 'POST' && /^\/api\/video\/sessions\/[^/]+\/join$/.test(path) && response.ok()) {
        // Observe the same ARN claim the native useLVSHangout hook reads.
        // Only a digest is retained; participant credentials stay in memory.
        void response.json().then(body => {
          const claims = JSON.parse(Buffer.from(body.token.split('.')[1], 'base64url').toString('utf8'));
          const arn = claims.arn ?? claims.channelArn;
          if (typeof arn === 'string' && arn) mediaChannels.add(createHash('sha256').update(arn).digest('hex'));
        }).catch(error => failures.push({ path, error: `Could not read native channel identity: ${error.message}` }));
      }
    });
    await actor.goto('/workspaces');
    await actor.page.getByRole('tab', { name: 'Sign in as 17', exact: true }).click();
    await actor.page.getByRole('button', { name: `Sign in as ${person.name}`, exact: true }).click();
    const role = actor.page.getByTestId(`select-role-orgiq-${person.role}-button`);
    await role.waitFor({ state: 'visible' }); await role.click();
    await actor.page.waitForURL('**/iq/**');
    const principal = await (await actor.context.request.get('/api/session/me')).json();
    assert(principal.sub === person.userId && principal.tenant === 'orgiq' && principal.role === person.role, `Wrong signed authority for ${person.name}`);
    await actor.goto('/iq/projects/p-observability');
    await actor.page.getByTestId('initiative-header').waitFor({ state: 'visible' });
    if (contextMedia) {
      const media = await actor.page.evaluate(() => window.__workSpeakingMedia.ready);
      assert(media.captureStream && media.movieDuration > 0 && media.audioDuration > 0, 'Prepared context source did not preload');
    }
    assert((await mediaStats(actor)).captures.length === 0, 'Capture started before the synchronized join');
    return { actor, person, sessions, mediaChannels, mediaOrigins, failures, close };
  } catch (error) { await close(); throw error; }
}
const composer = actor => actor.page.getByTestId('initiative-composer');
const input = dock => dock.locator('[contenteditable="true"]');
async function mode(actor, dock, value) {
  const toggle = dock.getByRole('button', { name: /^Composer mode:/ });
  if (await toggle.count()) {
    if (await toggle.getAttribute('aria-label') === `Composer mode: ${value}`) return;
    await toggle.click(); await actor.page.getByRole('menuitem', { name: value, exact: true }).click();
  } else await dock.getByRole('button', { name: value, exact: true }).click();
}
async function openWork(actor) {
  await actor.page.getByTestId('initiative-header-tab-work').click();
  await actor.page.getByTestId('initiative-work-list').getByText('Stop duplicate alerts during a dependency outage', { exact: true }).click();
  await actor.page.getByTestId('work-item-header').waitFor({ state: 'visible' });
}
async function criteriaReady(actor) {
  const loaded = await until(async () => ({ editor: await actor.page.getByTestId('brief-criteria').isVisible(), write: await actor.page.getByTestId('brief-action-criteria-write').isVisible() }), state => state.editor || state.write, 'loaded acceptance criteria editor or genuine empty state');
  if (!loaded.editor) await actor.page.getByTestId('brief-action-criteria-write').click();
  await actor.page.getByTestId('brief-criteria').waitFor({ state: 'visible' });
}
async function footerMessage(actor) {
  await actor.page.getByTestId('shell-call-dock-chat').click();
  await actor.page.getByTestId('huddle-thread').waitFor({ state: 'visible' });
}
async function leave(actor) {
  const button = actor.page.getByTestId('shell-call-dock-leave');
  if (await button.isVisible().catch(() => false)) await button.click();
}
async function platform(actor, path, { method = 'GET', includeStatus = false, allowError = false } = {}) {
  // Exactly the platform endpoint and bearer the app uses. Neither is written
  // to evidence. This performs read/playback-token requests only, never a call.
  const response = await actor.context.request.get('/api/session/realtime-token');
  assert(response.ok(), 'Realtime token unavailable');
  const token = await response.json();
  const target = new URL(token.platformApiUrl);
  assert(['localhost', '127.0.0.1', '[::1]'].includes(target.hostname), 'Rehearsal must remain on the existing local stack');
  const result = await actor.context.request.fetch(`${target.origin}${path}`, { method, headers: { Authorization: `Bearer ${token.token}` } });
  const body = await result.json();
  assert(result.ok() || allowError, `${method} ${path.split('?')[0]} returned ${result.status()}: ${body.message ?? body.error ?? 'unknown error'}`);
  return includeStatus ? { status: result.status(), body } : body;
}
async function freshDeck(nora, runId) {
  await mode(nora, composer(nora), 'Agent');
  const created = nora.page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/initiative-decks/projects/p-observability');
  await input(composer(nora)).fill(`/deck Observability speaking rehearsal ${runId}`);
  await input(composer(nora)).press('Enter');
  const response = await created; assert(response.status() === 201, 'Fresh plain deck creation failed');
  const body = await response.json(); assert(body.deckId && body.includesBudget === false, 'Nora must create a plain, budget-free deck');
  await until(async () => nora.page.url().includes(`/iq/decks/${body.deckId}`) || await nora.page.getByTestId('tenant-deck-open').isVisible().catch(() => false), Boolean, 'new deck link');
  if (!nora.page.url().includes(`/iq/decks/${body.deckId}`)) await nora.page.getByTestId('tenant-deck-open').click();
  await nora.page.getByTestId('initiative-deck-editor').waitFor({ state: 'visible' });
  return body.deckId;
}
async function deckHead(actor, id) {
  const response = await actor.context.request.get(`/api/initiative-decks/${encodeURIComponent(id)}`);
  assert(response.ok(), 'Cannot read saved deck'); return response.json();
}
const normalizedSpeech = text => text.toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
async function nativeTranscriptProof(actor, recording, scene, output, actorId, requireExact = true) {
  const deadline = Date.now() + 90_000;
  let transcript, response;
  do {
    response = await platform(actor, `/api/recordings/${encodeURIComponent(recording.recordingId)}/transcript`, { includeStatus: true, allowError: true });
    transcript = response.body;
    await appendFile(join(output, `${scene.id}-${actorId}-transcript-reads.jsonl`), JSON.stringify({ at: new Date().toISOString(), status: response.status, body: transcript }) + '\n');
    // Native finalize exposes a playable composed file before its next node
    // requests transcription. Retry only that explicit missing-request state;
    // an authorization/missing-recording 404 remains a hard failure.
    const waitingForFinalize = response.status === 404 && /transcription not requested for this recording/.test(String(transcript.message ?? transcript.error));
    assert(response.status < 400 || waitingForFinalize, `Native transcript read failed (${response.status}): ${transcript.message ?? transcript.error}`);
    if (Array.isArray(transcript.segments) || transcript.terminal === true) break;
    await pause(Math.min(5_000, Math.max(1_000, transcript.retryAfterMs ?? 5_000)));
  } while (Date.now() < deadline);
  await writeFile(join(output, `${scene.id}-${actorId}-native-transcript.json`), JSON.stringify(transcript, null, 2) + '\n');
  await writeFile(join(output, `${scene.id}-${actorId}-recording-get.json`), JSON.stringify({ status: response.status, actor: actorId, recordingId: recording.recordingId, doc: transcript }, null, 2) + '\n');
  assert(Array.isArray(transcript.segments) && transcript.segments.length > 0, `Native transcript has no spoken segments (${transcript.status ?? transcript.transcriptStatus ?? 'unknown'})`);
  const speech = transcript.segments.filter(segment => segment.kind !== 'reaction' && !/ reacted with /.test(segment.text ?? ''));
  const actual = normalizedSpeech(speech.map(segment => segment.text ?? '').join(' '));
  const expected = normalizedSpeech(scene.turns.map(turn => turn.speech).join(' '));
  const proof = { recordingId: recording.recordingId, expectedNormalized: expected, actualNormalized: actual,
    exactSceneWords: actual === expected, nativeSpeakers: [...new Map(speech.map(segment => [segment.speakerId, { id: segment.speakerId, label: segment.speakerLabel }])).values()],
    attribution: speech.every(segment => segment.speakerId === 'call') ? 'mixed-call-only' : 'native-segment-labels',
    summaryStatus: transcript.summaryStatus ?? null };
  await writeFile(join(output, `${scene.id}-${actorId}-native-transcript-proof.json`), JSON.stringify(proof, null, 2) + '\n');
  if (requireExact) assert(proof.exactSceneWords, 'Native transcript words do not exactly match the full scene script');
  return proof;
}
async function sharedPlaybackProof(person, recordingId, scene, output) {
  await person.actor.goto(`/iq/projects/p-observability?tab=docs&recording=${encodeURIComponent(recordingId)}`);
  const video = person.actor.page.getByTestId('initiative-recording-video').locator('video');
  await video.waitFor({ state: 'visible' });
  await until(() => video.evaluate(element => element.readyState), value => value > 0, 'shared recording playback metadata');
  // Native composition may begin before the second participant joins. Seek
  // past that opening before visually verifying its two-person layout.
  await video.evaluate(element => { element.currentTime = Math.min(2.5, Math.max(0, element.duration - 0.5)); });
  await until(() => video.evaluate(element => ({ seeking: element.seeking, time: element.currentTime, ready: element.readyState })), value => !value.seeking && value.ready >= 2, 'shared composed recording seek');
  const playbackStart = await video.evaluate(element => { const start = element.currentTime; void element.play(); return start; });
  const playbackTime = await until(() => video.evaluate(element => element.currentTime), value => value > playbackStart + 0.2, 'shared recording playback advances');
  await video.evaluate(element => element.pause());
  await person.actor.capture(join(output, `${scene.id}-${person.person.userId}-shared-recording-playback.png`));
  return { actor: person.person.userId, playbackTime, readyState: await video.evaluate(element => element.readyState) };
}
async function save(actor, deckId) {
  const before = await deckHead(actor, deckId);
  const response = actor.page.waitForResponse(result => result.request().method() === 'POST' && new URL(result.url()).pathname === `/api/initiative-decks/${deckId}/revisions`);
  await actor.page.getByTestId('initiative-deck-save').click();
  assert((await response).status() === 201, 'Presentation save failed');
  return until(() => deckHead(actor, deckId), value => value.activeRevisionId !== before.activeRevisionId, 'saved presentation revision');
}
async function sceneActions({ vera, nora, deckId, output, runId, event }) {
  const message = `Next step: confirm the affected service dependency map, then replay the outage. Rehearsal ${runId}.`;
  const note = `Validation rehearsal ${runId}: confirm the affected services before replaying the outage.`;
  const criterion = 'Confirm the affected service dependency map before replaying the outage.';
  const notes = 'Confirm the dependency map, then replay the outage. Reviewed together in the speaking huddle.';
  return {
    'initiative-01-vera': async () => {
      for (const actor of [vera, nora]) {
        const size = await actor.page.getByTestId('shell-call-media').boundingBox();
        assert(size && size.height <= 220, 'Call tiles grew beyond the bounded composer shelf');
      }
    },
    'initiative-02-nora': async () => {
      await Promise.all([openWork(vera), openWork(nora)]);
      await criteriaReady(nora);
      if (!await nora.page.getByTestId('brief-criteria').getByText(criterion, { exact: true }).count()) {
        await nora.page.getByTestId('brief-criteria-add').click();
        const saved = nora.page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/wi-obs-e2-b4/criteria'));
        await nora.page.getByRole('textbox', { name: 'Add a criterion', exact: true }).fill(criterion);
        await nora.page.getByRole('textbox', { name: 'Add a criterion', exact: true }).press('Enter');
        assert((await saved).ok(), 'Acceptance criterion was not persisted');
      }
    },
    'initiative-03-vera': async () => {
      await Promise.all([footerMessage(vera), footerMessage(nora)]);
      await input(composer(vera)).fill(message); await input(composer(vera)).press('Enter');
      await until(() => nora.page.getByTestId('huddle-thread').textContent(), text => text.includes(message) && text.includes('ORG-OBS-11'), 'contextual huddle delivery');
      await vera.page.getByRole('button', { name: 'Choose chat destination', exact: true }).click();
      await vera.page.getByRole('menuitem', { name: 'Initiative discussion', exact: true }).click();
      await input(composer(vera)).fill(`/comment ${note}`); await input(composer(vera)).press('Enter');
      const comments = await until(async () => (await (await vera.context.request.get('/api/graph/work-items/wi-obs-e2-b4/comments')).json()).comments,
        comments => comments.some(comment => comment.body === note), 'persisted work-item comment');
      const saved = comments.find(comment => comment.body === note);
      await vera.page.getByTestId('work-item-header-tab-history').click();
      // Activity is a concise event log. It deliberately previews long
      // comments; use the persisted row identity rather than expecting the
      // entire API body inside its 80-character quote.
      await vera.page.getByTestId(`work-activity-${saved.id}`).waitFor({ state: 'visible' });
      assert((await vera.page.getByTestId(`work-activity-${saved.id}`).textContent()).includes(note.slice(0, 60)), 'Persisted comment preview is missing from Activity');
      await footerMessage(vera);
    },
    'initiative-04-nora': async () => {
      const draft = `Unfinished huddle draft ${runId}`;
      await input(composer(nora)).fill(draft);
      await nora.page.getByTestId('initiative-search-link').click();
      await nora.page.waitForURL(url => url.pathname === '/iq/search' && url.searchParams.get('scope') === 'p-observability');
      // The route URL changes before its lazy page mounts. Focusing the
      // footer during that interval can still reach the previous page's
      // input owner, so await the actual Search textbox first.
      const search = nora.page.getByTestId('search-composer');
      await search.getByRole('textbox', { name: 'Search question', exact: true }).waitFor({ state: 'visible' });
      await footerMessage(nora);
      assert(new URL(nora.page.url()).pathname === '/iq/search', 'Footer chat focus unexpectedly left the mounted Search page');
      assert(await input(search).textContent() === draft, 'Huddle draft lost on Search');
      await mode(nora, search, 'Agent');
      await input(search).fill('dependency');
      await input(search).press('Enter');
      await nora.page.waitForURL(url => url.searchParams.get('q') === 'dependency');
      const result = nora.page.getByRole('link', { name: 'Stop duplicate alerts during a dependency outage', exact: true });
      await result.click(); await nora.page.getByTestId('work-item-header').waitFor({ state: 'visible' });
      await footerMessage(nora); assert(await input(composer(nora)).textContent() === draft, 'Huddle draft lost after opening the work result');
      await nora.page.getByTestId('huddle-reaction-toggle').click();
      await nora.page.getByTestId('huddle-reaction-picker').getByRole('button', { name: 'React with heart', exact: true }).click();
      await vera.page.getByTestId('shell-call-media').getByTestId('reaction-float').filter({ hasText: '❤️' }).waitFor({ state: 'visible' });
      assert(!await nora.page.getByTestId('huddle-reaction-picker').count(), 'Reaction picker did not dismiss');
      await event('reaction-sent', { emoji: '❤️', actor: 'u-nora' });
    },
    'deck-01-vera': async () => {
      await nora.page.getByTestId('initiative-deck-editor-slide-select-summary').click();
      const avatar = vera.page.getByTestId('initiative-deck-shell-byline').getByRole('listitem', { name: 'Nora DaSilva', exact: true });
      await avatar.hover(); await vera.page.getByRole('button', { name: 'Follow', exact: true }).click();
      await vera.page.getByTestId('follow-bar').waitFor({ state: 'visible' });
      await nora.page.getByTestId('initiative-deck-editor-slide-select-work-status').click();
      await until(() => vera.page.getByTestId('initiative-deck-editor-slide-select-work-status').getAttribute('aria-current'), value => value === 'true', 'Follow changes slide');
      await nora.page.getByTestId('initiative-deck-editor-slide-select-summary').click();
      await until(() => vera.page.getByTestId('initiative-deck-editor-slide-select-summary').getAttribute('aria-current'), value => value === 'true', 'Follow returns to Summary');
      await vera.page.getByTestId('follow-bar-stop').click();
    },
    'deck-02-nora': async () => {
      await nora.page.getByTestId('initiative-deck-editor-slide-title').fill('Observability: validation next');
      await save(nora, deckId);
      await until(() => vera.page.getByTestId('initiative-deck-editor-slide-title').inputValue(), value => value === 'Observability: validation next', 'Nora saved title reaches Vera');
    },
    'deck-03-vera': async () => {
      await vera.page.getByTestId('initiative-deck-editor-slide-notes').fill(notes); await save(vera, deckId);
      await until(() => nora.page.getByTestId('initiative-deck-editor-slide-notes').inputValue(), value => value === notes, 'Vera saved notes reach Nora');
    },
    'deck-04-nora': async () => {
      const lifecycleBefore = await nora.page.evaluate(() => window.__huddleRehearsal?.pageLifecycle.length ?? 0);
      const download = nora.page.waitForEvent('download'); await nora.page.getByTestId('initiative-deck-download').click();
      const result = await download, path = join(output, result.suggestedFilename()); await result.saveAs(path);
      assert((await readFile(path)).subarray(0, 2).toString('latin1') === 'PK', 'Download is not a PowerPoint archive');
      const lifecycleAfter = await nora.page.evaluate(() => window.__huddleRehearsal?.pageLifecycle ?? []);
      await event('presentation-download-lifecycle', { before: lifecycleBefore, after: lifecycleAfter });
      assert(lifecycleAfter.length === lifecycleBefore, 'PowerPoint download fired page unload during the active huddle');
      await event('presentation-downloaded', { file: path, sha256: await sha256(path), head: (await deckHead(nora, deckId)).activeRevisionId });
    },
  };
}

async function runScene(config, scene, timeline, event) {
  const people = [];
  let completed = false;
  try {
    // File flags need separate processes; explicit context media instead uses
    // independent prepared sources in newly created isolated contexts.
    for (const person of config.story.cast) people.push(await launchActor({ ...config, scene, person }));
    const vera = people.find(person => person.person.userId === 'u-vera').actor;
    const nora = people.find(person => person.person.userId === 'u-nora').actor;
    let deckId = null;
    if (scene.id === 'deck') {
      deckId = await freshDeck(nora, config.runId);
      // Full navigation is safe here, before either actor starts capture.
      await Promise.all([vera.goto(`/iq/decks/${deckId}`), nora.goto(`/iq/decks/${deckId}`)]);
      await Promise.all([vera, nora].map(actor => actor.page.getByTestId('initiative-deck-editor').waitFor({ state: 'visible' })));
    }
    const before = new Set((await platform(nora, '/api/recordings?limit=40')).items.map(row => row.recordingId));
    await Promise.all([vera, nora].map(actor => until(async () => actor.page.getByTestId('shell-footer-context-start').isEnabled(), Boolean, 'native Huddle availability')));
    // LVS returns LOBBY_TAKEN if two fresh findOrCreate requests race.
    // Let Vera's real UI create the canonical room before Nora joins it;
    // capture-start skew remains separately measured and strictly bounded.
    await vera.page.getByTestId('shell-footer-context-start').click();
    await until(async () => people.find(person => person.actor === vera).sessions.size > 0, Boolean, 'Vera native session create response');
    await nora.page.getByTestId('shell-footer-context-start').click();
    const capture = await until(async () => Promise.all([vera, nora].map(mediaStats)), rows => rows.every(row => row.captures.some(c => c.audio && c.video && c.resolvedAt)), 'both native capture streams');
    const requestStarts = capture.map(row => row.captures.find(c => c.audio && c.video).requestedAt);
    const starts = config.contextMedia ? await Promise.all([vera, nora].map(actor => actor.page.evaluate(() => window.__workSpeakingMedia.startedAt))) : requestStarts;
    const origin = Math.min(...starts), skewMs = Math.max(...starts) - origin;
    assert(skewMs <= config.maxCaptureSkewMs, `Prepared capture source starts differ by ${skewMs}ms`);
    const live = await until(async () => Promise.all([vera, nora].map(mediaStats)), rows => rows.every(row => row.connected > 0 && row.videoFrames > 0 && row.audioSamples > 0), 'real bidirectional media');
    assert(Date.now() < origin + timeline.timeline[0].atSeconds * 1000, 'Native media connected after the first spoken line began; increase the opening hold and reassemble');
    await until(async () => people.every(person => person.sessions.size > 0 && person.mediaChannels.size > 0), Boolean, 'both native session and join responses');
    const sessionIds = new Set(people.flatMap(person => [...person.sessions]));
    const mediaChannels = new Set(people.flatMap(person => [...person.mediaChannels]));
    assert(mediaChannels.size === 1, `Expected one canonical LVS channel, got ${mediaChannels.size}`);
    // platform-api explicitly permits same-ARN DDB rows when two fresh
    // findOrCreate requests race. Preserve that observation rather than
    // labelling two platform IDs as two media rooms.
    await event('native-media-connected', { scene: scene.id, captureRequestSkewMs: Math.max(...requestStarts) - Math.min(...requestStarts), captureSourceSkewMs: skewMs, sourceTimelineOrigin: origin,
      firstSpeechAt: origin + timeline.timeline[0].atSeconds * 1000, sessionIds: [...sessionIds], canonicalChannelDigest: [...mediaChannels][0], platformSessionRaceObserved: sessionIds.size > 1, nativeApiOrigins: [...new Set(people.flatMap(person => [...person.mediaOrigins]))], stats: live, deckId });
    const actions = await sceneActions({ vera, nora, deckId, output: config.output, runId: config.runId, event });
    for (const turn of timeline.timeline) {
      assert(actions[turn.id], `No UI action for ${turn.id}`);
      const speechAt = origin + turn.atSeconds * 1000;
      while (Date.now() < speechAt) await pause(Math.min(500, speechAt - Date.now()));
      const receiver = people.find(person => person.person.userId !== turn.actor).actor;
      const beforeSpeech = await mediaStats(receiver);
      const actionAt = origin + (turn.atSeconds + turn.speechSeconds) * 1000;
      while (Date.now() < actionAt) await pause(Math.min(1000, actionAt - Date.now()));
      const afterSpeech = await mediaStats(receiver);
      const speechSignal = { audioEnergy: afterSpeech.receivedAudioEnergy - beforeSpeech.receivedAudioEnergy,
        audioSamples: afterSpeech.receivedAudioSamples - beforeSpeech.receivedAudioSamples,
        videoFrames: afterSpeech.receivedVideoFrames - beforeSpeech.receivedVideoFrames };
      const continuity = await receiver.page.evaluate(({ start, end }) => {
        const samples = (window.__huddleRehearsal?.samples ?? []).filter(sample => sample.at >= start && sample.at <= end);
        return { samples: samples.length, samplesWithAudio: samples.filter(sample => sample.peers.some(peer => peer.state === 'connected' && peer.inbound.some(row => row.kind === 'audio'))).length };
      }, { start: speechAt + 500, end: actionAt - 500 });
      await event('turn-speech-received', { scene: scene.id, turn: turn.id, speaker: turn.actor, receiver: people.find(person => person.actor === receiver).person.userId, signal: speechSignal, continuity });
      assert(speechSignal.audioEnergy > 0.00001 && speechSignal.audioSamples > 0 && speechSignal.videoFrames > 0 && continuity.samples > 0 && continuity.samplesWithAudio === continuity.samples, `The other actor did not receive continuous native speech/video during ${turn.id}`);
      await event('turn-action-start', { scene: scene.id, turn: turn.id, targetAt: actionAt, lateMs: Date.now() - actionAt });
      await actions[turn.id]();
      await event('turn-media-observed', { scene: scene.id, turn: turn.id, stats: await Promise.all([vera, nora].map(mediaStats)) });
      await people.find(person => person.person.userId === turn.actor).actor.capture(join(config.output, `${turn.id}.png`));
      const nextAt = origin + (turn.atSeconds + turn.speechSeconds + turn.holdAfterSeconds) * 1000;
      assert(Date.now() <= nextAt + 500, `${turn.id} overran its action hold; extend the storyboard hold and reassemble`);
      await event('turn-action-complete', { scene: scene.id, turn: turn.id });
    }
    while (Date.now() < origin + timeline.durationSeconds * 1000) await pause(500);
    const final = await Promise.all([vera, nora].map(mediaStats));
    for (const person of people) await writeFile(join(config.output, `${scene.id}-${person.person.userId}-rtp-history.json`), JSON.stringify(await person.actor.page.evaluate(() => ({ samples: window.__huddleRehearsal?.samples ?? [], peerEvents: window.__huddleRehearsal?.peerEvents ?? [], pageLifecycle: window.__huddleRehearsal?.pageLifecycle ?? [] })), null, 2) + '\n');
    await event('native-media-final', { scene: scene.id, stats: final });
    assert(final.every(row => row.receivedAudioEnergy > 0.00001 && row.receivedAudioSamples > 0 && row.receivedVideoFrames > 0), 'Real observed RTP speech signal was not received by both actors');
    assert(people.every(person => person.failures.length === 0), 'Native media API returned failures');
    assert(people.every(person => !person.actor.errors.some(error => error.kind === 'page' || error.kind === 'http')), 'The rehearsal encountered an uncaught page error or server failure');
    await Promise.all([vera, nora].map(leave));
    await until(async () => Promise.all([vera, nora].map(mediaStats)), rows => rows.every(row => row.connected === 0 && row.captures.every(c => c.tracks.every(t => t.state === 'ended'))), 'Leave stops real media');
    if (deckId) {
      for (const actor of [vera, nora]) {
        await actor.page.reload({ waitUntil: 'domcontentloaded' });
        await actor.page.getByTestId('initiative-deck-editor-slide-select-summary').click();
        assert(await actor.page.getByTestId('initiative-deck-editor-slide-title').inputValue() === 'Observability: validation next', 'Saved title lost after reload');
        assert((await actor.page.getByTestId('initiative-deck-editor-slide-notes').inputValue()).includes('Reviewed together in the speaking huddle.'), 'Saved notes lost after reload');
      }
    }
    const recorded = await until(async () => (await platform(nora, '/api/recordings?limit=40')).items,
      rows => rows.some(row => !before.has(row.recordingId) && row.lobbyName === 'orgiq:initiative:p-observability' && Date.parse(row.startedAt) >= origin - 5000), 'existing native recording asset', 90_000);
    const recording = recorded.find(row => !before.has(row.recordingId) && row.lobbyName === 'orgiq:initiative:p-observability' && Date.parse(row.startedAt) >= origin - 5000);
    const playback = await until(() => platform(nora, `/api/recordings/${encodeURIComponent(recording.recordingId)}/playback-token`, { method: 'POST' }), value => value.mediaState === 'playable' && (value.composedUrl || value.playlistUrl), 'native recording composition', 90_000);
    const detail = await platform(nora, `/api/recordings/${encodeURIComponent(recording.recordingId)}`);
    await event('native-recording-asset', { scene: scene.id, deckId, recordingId: detail.recordingId, lobbyName: detail.lobbyName, participants: detail.participants, mediaState: playback.mediaState });
    const reactions = await platform(nora, `/api/video/reactions?${new URLSearchParams({ lobbyName: detail.lobbyName, from: detail.startedAt, to: detail.endedAt })}`);
    if (scene.id === 'initiative') assert(reactions.reactions.some(row => row.emoji === '❤️' && row.userId === 'u-nora'), 'Live reaction was not persisted on the native recording');
    assert(detail.participants?.some(person => person.userId === 'u-vera') && detail.participants?.some(person => person.userId === 'u-nora'), 'Recording is missing the real participants');
    const transcript = [], playbackProof = [];
    for (const person of people) {
      transcript.push(await nativeTranscriptProof(person.actor, detail, scene, config.output, person.person.userId));
      // Exercise the shared Work player as EACH actual participant after Leave.
      playbackProof.push(await sharedPlaybackProof(person, detail.recordingId, scene, config.output));
    }
    await event('scene-complete', { scene: scene.id, deckId, recordingId: detail.recordingId, lobbyName: detail.lobbyName, durationMs: detail.durationMs,
      participants: detail.participants, mediaState: playback.mediaState, reactions: reactions.reactions, transcriptProof: transcript, playbackProof, stats: final, errors: people.flatMap(person => person.actor.errors) });
    completed = true;
    return { scene: scene.id, deckId, recordingId: detail.recordingId, uiAndNativeMediaVerified: true };
  } finally {
    if (!completed) {
      for (const person of people) await writeFile(join(config.output, `${scene.id}-${person.person.userId}-rtp-history.json`), JSON.stringify(await person.actor.page.evaluate(() => ({ samples: window.__huddleRehearsal?.samples ?? [], peerEvents: window.__huddleRehearsal?.peerEvents ?? [], pageLifecycle: window.__huddleRehearsal?.pageLifecycle ?? [] })).catch(() => ({ samples: [], peerEvents: [], pageLifecycle: [] })), null, 2) + '\n');
      await event('native-media-incomplete', { scene: scene.id, stats: await Promise.all(people.map(person => mediaStats(person.actor).catch(() => null))),
        apiFailures: people.map(person => ({ actor: person.person.userId, failures: person.failures })), sessionIds: people.flatMap(person => [...person.sessions]) });
      await Promise.all(people.map(person => person.actor.capture(join(config.output, `${scene.id}-${person.person.userId}-incomplete.png`)).catch(() => undefined)));
      await Promise.all(people.map(person => leave(person.actor).catch(() => undefined)));
      const stopped = await until(async () => Promise.all(people.map(person => mediaStats(person.actor))), rows => rows.every(row => row.connected === 0 && row.captures.every(c => c.tracks.every(t => t.state === 'ended'))), 'failed-scene Leave stops native media', 10_000).catch(() => null);
      await event('failed-scene-cleanup', { scene: scene.id, nativeMediaStopped: stopped !== null, stats: stopped });
    }
    await Promise.all(people.map(person => person.close()));
  }
}

async function probeContextMedia(config, scene, timeline) {
  const audit = await CdpAudit.connect({ endpoint: config.cdp, baseURL: config.baseURL, packageRoot: join(root, 'portal') });
  try {
    const actor = await audit.actor('prepared-media-capability-probe');
    const person = config.story.cast.find(person => person.userId === timeline.timeline[0].actor);
    await installContextMedia(actor, { ...config, scene, person });
    const path = `/__work-speaking-probe/${config.runId}`;
    await actor.context.route(new URL(path, config.baseURL).href, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Owned prepared media probe</title><button id="start">Start prepared media probe</button>' }));
    await actor.goto(path);
    const capability = await actor.page.evaluate(() => window.__workSpeakingMedia.ready);
    assert(capability.captureStream && capability.movieDuration > 0 && capability.audioDuration > 0, 'Prepared context media could not preload');
    await actor.page.evaluate(() => {
      document.querySelector('#start').onclick = async () => {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
          const sender = new RTCPeerConnection(), receiver = new RTCPeerConnection();
          window.__preparedProbePeers = [sender, receiver];
          receiver.ontrack = event => {
            if (event.track.kind === 'audio') {
              // The native RTP energy counter is measured after playback
              // gain. Keep a real player sink at a quiet, nonzero volume;
              // zero gain reports zero energy even for genuine speech.
              const decoded = window.__workSpeakingMedia.audioContext.createMediaStreamSource(new MediaStream([event.track]));
              const gain = window.__workSpeakingMedia.audioContext.createGain(); gain.gain.value = 0;
              decoded.connect(gain).connect(window.__workSpeakingMedia.audioContext.destination);
              window.__preparedProbeAudioSink = { decoded, gain };
              const audio = document.createElement('audio'); audio.autoplay = true; audio.volume = 0.1;
              audio.srcObject = new MediaStream([event.track]); document.body.append(audio);
              void audio.play().catch(error => { window.__preparedProbeSinkError = error.message; });
              window.__preparedProbeAudioElement = audio;
            }
          };
          sender.onicecandidate = event => { if (event.candidate) void receiver.addIceCandidate(event.candidate); };
          receiver.onicecandidate = event => { if (event.candidate) void sender.addIceCandidate(event.candidate); };
          stream.getTracks().forEach(track => sender.addTrack(track, stream));
          await sender.setLocalDescription(await sender.createOffer());
          await receiver.setRemoteDescription(sender.localDescription);
          await receiver.setLocalDescription(await receiver.createAnswer());
          await sender.setRemoteDescription(receiver.localDescription);
          window.__preparedProbeReady = true;
        } catch (error) { window.__preparedProbeError = error.message; }
      };
    });
    await actor.page.getByRole('button', { name: 'Start prepared media probe', exact: true }).click();
    await until(async () => actor.page.evaluate(() => ({ ready: window.__preparedProbeReady, error: window.__preparedProbeError })), value => { if (value.error) throw new Error(value.error); return value.ready; }, 'owned prepared media loopback');
    const start = await actor.page.evaluate(() => window.__workSpeakingMedia.startedAt);
    const first = timeline.timeline[0];
    while (Date.now() < start + (first.atSeconds + Math.min(first.speechSeconds, 3)) * 1000) await pause(250);
    const stats = await mediaStats(actor);
    const source = await actor.page.evaluate(() => ({ mechanism: window.__workSpeakingMedia.mechanism, audioContextState: window.__workSpeakingMedia.audioContext.state, movieTime: window.__workSpeakingMedia.video.currentTime,
      audioSink: { paused: window.__preparedProbeAudioElement?.paused, readyState: window.__preparedProbeAudioElement?.readyState, currentTime: window.__preparedProbeAudioElement?.currentTime, error: window.__preparedProbeSinkError } }));
    const proof = { status: 'prepared-context-media-probe', nativeCallStarted: false, loopbackOnly: true, actor: person.userId, capability, source, stats };
    await writeFile(join(config.output, 'context-media-probe.json'), JSON.stringify(proof, null, 2) + '\n');
    assert(stats.audioEnergy > 0.00001 && stats.audioSamples > 0 && stats.videoFrames > 0, 'Prepared context media did not deliver actual spoken audio/video RTP');
    await actor.page.evaluate(() => { window.__workSpeakingMedia.stream.getTracks().forEach(track => track.stop()); window.__preparedProbePeers.forEach(peer => peer.close()); });
    console.log(JSON.stringify(proof, null, 2));
  } finally { await audit.close(); }
}

async function runShareNavigationAcceptance(config, event) {
  const scene = config.story.scenes.find(scene => scene.id === 'initiative'), people = [];
  try {
    for (const person of config.story.cast) people.push(await launchActor({ ...config, scene, person, displayMedia: true }));
    const vera = people.find(person => person.person.userId === 'u-vera').actor;
    const nora = people.find(person => person.person.userId === 'u-nora').actor;
    await Promise.all([vera, nora].map(async actor => {
      await actor.goto('/iq/projects/p-cost-opt');
      await actor.page.getByTestId('initiative-header').waitFor({ state: 'visible' });
      await until(() => actor.page.getByTestId('shell-footer-context-start').isEnabled(), Boolean, 'Cost native Huddle availability');
      await actor.page.evaluate(() => window.__workSpeakingMedia.ready);
    }));
    await vera.page.getByTestId('shell-footer-context-start').click();
    await until(async () => people.find(person => person.actor === vera).sessions.size > 0, Boolean, 'Cost native session create response');
    await nora.page.getByTestId('shell-footer-context-start').click();
    await until(() => Promise.all([vera, nora].map(mediaStats)), rows => rows.every(row => row.connected > 0 && row.audioSamples > 0 && row.videoFrames > 0), 'Cost real bidirectional media');
    const cameras = await Promise.all([vera, nora].map(actor => actor.page.evaluate(() => window.__huddleRehearsal.captures.flatMap(capture => capture.stream.getVideoTracks().map(track => ({ id: track.id, state: track.readyState }))))));
    // Router links preserve the call; a top-level goto would intentionally
    // trigger the native beforeunload Leave handler and invalidate this check.
    await vera.page.getByRole('link', { name: 'Initiatives', exact: true }).click();
    await vera.page.getByRole('link', { name: 'Auth Migration', exact: true }).click();
    await vera.page.getByTestId('initiative-header').waitFor({ state: 'visible' });
    assert(new URL(vera.page.url()).pathname === '/iq/projects/p-auth-migration', 'Router did not reach Auth Migration');
    await until(() => vera.page.locator('[data-testid="shell-call-media"][data-placement="composer"]').count(), count => count === 1, 'one active Cost media block in Auth composer');
    const block = vera.page.getByTestId('shell-call-media'), size = await block.boundingBox();
    assert(size && size.height <= 130, 'Cross-initiative media shelf exceeded compact size');
    assert((await vera.page.getByTestId('shell-call-dock').textContent()).includes('Cost Optimization'), 'Navigation replaced the active call identity');
    // SidePane projects its header into the shell's region; initiative-pane
    // is its body, so header assertions must use the observed pane region.
    const pane = () => vera.page.getByRole('region', { name: 'Huddle dialogue', exact: true });
    await pane().getByText('Cost Optimization', { exact: true }).waitFor({ state: 'visible' });
    for (const tab of ['agent', 'details']) {
      await vera.page.getByTestId(`initiative-pane-tab-${tab}`).click();
      await vera.page.getByRole('region', { name: tab === 'agent' ? 'Agent' : 'Details', exact: true }).getByText('Auth Migration', { exact: true }).waitFor({ state: 'visible' });
    }
    await vera.page.getByTestId('initiative-pane-tab-discussion').click();
    await pane().getByText('Cost Optimization', { exact: true }).waitFor({ state: 'visible' });
    for (const id of ['shell-call-dock-mic', 'shell-call-dock-camera', 'shell-call-dock-leave']) assert(await vera.page.getByTestId(id).count() === 1, `Duplicated footer control ${id}`);
    await vera.capture(join(config.output, 'cost-call-in-auth-composer.png'));
    await event('cross-initiative-call-projection-passed', { originalCall: 'Cost Optimization', page: 'Auth Migration', huddleSubtitle: 'Cost Optimization', agentAndDetailsSubtitle: 'Auth Migration', height: size.height, placement: 'composer', cameras });
    const cameraRows = actor => actor.page.locator('[data-testid="shell-call-media"] [data-call-stream="screen"]');
    await vera.page.getByTestId('call-page-sharing-trigger').click();
    await vera.page.getByTestId('call-screen-sharing').click();
    await until(async () => Promise.all([vera, nora].map(actor => cameraRows(actor).count())), counts => counts.every(count => count === 1), 'separate native local and remote screen tiles', 15_000);
    const remoteVideo = cameraRows(nora).locator('video');
    await until(() => remoteVideo.evaluate(video => ({ width: video.videoWidth, time: video.currentTime, state: video.readyState })), video => video.width > 0 && video.state >= 2, 'actual decoded native remote screen');
    const firstTime = await remoteVideo.evaluate(video => video.currentTime);
    await until(() => remoteVideo.evaluate(video => video.currentTime), time => time > firstTime + 0.3, 'native remote screen time advances');
    assert(await vera.page.getByTestId('call-page-sharing-trigger').getAttribute('data-screen-sharing') === 'true', 'Footer screen state did not synchronize');
    const shared = await Promise.all([vera, nora].map(mediaStats));
    assert(shared.every(row => row.connected >= 2 && row.captures.every(capture => capture.tracks.every(track => track.state === 'live'))), 'Camera media stopped while sharing');
    await Promise.all([vera, nora].map((actor, index) => actor.capture(join(config.output, `native-screen-${index === 0 ? 'vera' : 'nora'}.png`))));
    await event('native-screen-share-delivered', { displaySource: 'explicit-owned-canvas-captureStream', osPickerVerified: false, nativeApisMocked: false, remoteScreenTime: await remoteVideo.evaluate(video => video.currentTime), stats: shared });
    await vera.page.getByTestId('call-page-sharing-trigger').click();
    await vera.page.getByTestId('call-screen-sharing').click();
    await until(async () => Promise.all([vera, nora].map(actor => cameraRows(actor).count())), counts => counts.every(count => count === 0), 'Stop removes only screen tiles');
    const afterCameras = await Promise.all([vera, nora].map(actor => actor.page.evaluate(() => window.__huddleRehearsal.captures.flatMap(capture => capture.stream.getVideoTracks().map(track => ({ id: track.id, state: track.readyState }))))));
    assert(afterCameras.every((tracks, index) => tracks.length === cameras[index].length && tracks.every((track, order) => track.id === cameras[index][order].id && track.state === 'live')), 'Stop sharing replaced/stopped a camera track');
    const afterStop = await Promise.all([vera, nora].map(mediaStats)); await pause(800);
    const continuity = await Promise.all([vera, nora].map(mediaStats));
    assert(continuity.every((row, index) => row.videoFrames > afterStop[index].videoFrames && row.connected >= 2), 'Camera reception did not continue after Stop sharing');
    assert(await vera.page.getByTestId('call-page-sharing-trigger').getAttribute('data-screen-sharing') === 'false', 'Footer retained stopped screen state');
    assert(people.every(person => person.failures.length === 0 && !person.actor.errors.some(error => error.kind === 'page' || error.kind === 'http')), 'Native sharing returned API/page failures');
    await event('native-screen-share-stopped-camera-preserved', { camerasBefore: cameras, camerasAfter: afterCameras, stats: continuity });
    await writeFile(join(config.output, 'share-navigation-result.json'), JSON.stringify({ status: 'passed', displaySource: 'explicit-owned-canvas-captureStream', osPickerVerified: false, nativeApisMocked: false, cameraTrackIdsPreserved: true }, null, 2) + '\n');
  } catch (error) {
    const proof = { status: 'incomplete', displaySource: 'explicit-owned-canvas-captureStream', osPickerVerified: false, nativeApisMocked: false, error: error.message,
      stats: await Promise.all(people.map(person => mediaStats(person.actor).catch(() => null))),
      nativeApiFailures: people.map(person => ({ actor: person.person.userId, failures: person.failures })) };
    await writeFile(join(config.output, 'share-navigation-result.json'), JSON.stringify(proof, null, 2) + '\n');
    await Promise.all(people.map(person => person.actor.capture(join(config.output, `native-screen-${person.person.userId}-incomplete.png`)).catch(() => undefined)));
    throw error;
  } finally {
    await Promise.all(people.map(person => leave(person.actor).catch(() => undefined)));
    await until(() => Promise.all(people.map(person => mediaStats(person.actor))), rows => rows.every(row => row.connected === 0 && row.captures.every(capture => capture.tracks.every(track => track.state === 'ended'))), 'acceptance Leave stops native media', 10_000).catch(() => undefined);
    await Promise.all(people.map(person => person.close()));
  }
}

async function main() {
  if (args.includes('--help')) {
    console.log('node scripts/demos/rehearse-huddle-speaking.mjs --media-root <assembled files> [--scene all|initiative|deck] [--out <evidence>] [--dry-run] [--headed] [--allow-unreviewed-media] [--audio-service-in-process] [--cdp <authorized localhost endpoint> --context-media]\nModes: --probe-context-media, --calibrate-initiative, --accept-share-navigation, or --verify-recording <id> [--inspect-recording].\nOnly owned Chrome processes or new isolated contexts on an explicitly authorized CDP endpoint are used. Context media injects prepared test video/audio only; native calls, RTP, recording and authorization stay real. Unreviewed media remains labelled unverified. Verify-recording resumes participant proof for a scene whose timed native evidence already passed; inspect-recording keeps an exact content failure explicitly unresolved.');
    return;
  }
  const mediaRootArg = option('--media-root', null); assert(mediaRootArg, 'Provide --media-root from prepare-huddle-media.mjs');
  const mediaRoot = resolve(mediaRootArg), baseURL = option('--base-url', 'http://localhost:5183');
  const origin = new URL(baseURL); assert(['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname), 'Use the existing localhost portal');
  const chrome = option('--chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  const cdp = option('--cdp', null), contextMedia = args.includes('--context-media');
  assert(Boolean(cdp) === contextMedia, '--cdp and --context-media must be supplied together');
  if (cdp) assert(['localhost', '127.0.0.1', '[::1]'].includes(new URL(cdp).hostname), 'CDP endpoint must be explicitly authorized localhost');
  assert(!args.includes('--probe-context-media') || contextMedia, '--probe-context-media requires --cdp and --context-media');
  const audioServiceInProcess = args.includes('--audio-service-in-process');
  assert(!contextMedia || !audioServiceInProcess, 'Existing CDP context mode does not change browser feature flags');
  assert(!args.includes('--inspect-recording') || args.includes('--verify-recording'), '--inspect-recording requires --verify-recording');
  assert(['--probe-context-media', '--calibrate-initiative', '--accept-share-navigation', '--verify-recording', '--verify-deck'].filter(flag => args.includes(flag)).length <= 1, 'Choose one explicit driver operation');
  const story = await json(resolve(option('--storyboard', join(root, 'docs/demos/work-huddles/storyboard.json'))));
  const contract = makeMediaContract(story, root), verification = await json(join(mediaRoot, 'media-verification.json'));
  assert(verification.technicalChecks === 'passed' && verification.contentSha256 === contract.contentSha256, 'Prepared media does not match the current storyboard');
  const speakingMediaVerified = verification.speakingReview === 'verified-against-clip-bytes';
  assert(speakingMediaVerified || args.includes('--allow-unreviewed-media'), 'Speaking media review is unverified. Review clips first, or explicitly run a technical rehearsal labelled unverified');
  assert(story.cast.length === 2 && ['u-vera', 'u-nora'].every(id => story.cast.some(person => person.userId === id)), 'This rehearsal needs the exact Vera/Nora cast');
  const selected = option('--scene', 'all'), scenes = story.scenes.filter(scene => selected === 'all' || scene.id === selected);
  assert(scenes.length > 0 && scenes.every(scene => ['initiative', 'deck'].includes(scene.id)), 'Unknown scene');
  const timelines = new Map();
  for (const scene of scenes) {
    const timeline = await json(join(mediaRoot, scene.id, 'timeline.json'));
    assert(timeline.contentSha256 === contract.contentSha256 && timeline.timeline.length === scene.turns.length, `Stale timeline: ${scene.id}`);
    assert(timeline.timeline.every((turn, index) => turn.id === scene.turns[index].id && turn.actor === scene.turns[index].actor), `Wrong speaking order: ${scene.id}`);
    timelines.set(scene.id, timeline);
    for (const person of story.cast) {
      assert(safeId(person.userId), 'Unsafe actor ID');
      await access(join(mediaRoot, scene.id, `${person.userId}.${contextMedia ? 'mp4' : 'y4m'}`)); await access(join(mediaRoot, scene.id, `${person.userId}.wav`));
    }
  }
  if (!cdp) await access(chrome);
  const plan = { scenes: scenes.map(scene => ({ id: scene.id, durationSeconds: timelines.get(scene.id).durationSeconds, turns: timelines.get(scene.id).timeline.map(turn => ({ id: turn.id, atSeconds: turn.atSeconds, speechSeconds: turn.speechSeconds, holdAfterSeconds: turn.holdAfterSeconds })) })),
    processesPerScene: cdp ? 0 : 2, isolatedContextsPerScene: 2,
    captureSource: contextMedia ? 'explicit-prepared-video-captureStream+WebAudio-WAV' : 'owned-Chrome-fake-device-files',
    nativeApisMocked: false, speakingMediaVerified, existingV7DeckUntouched: true, worldReset: false, rendererSandboxDisabled: false,
    testCaptureFeatureFlags: audioServiceInProcess ? ['--disable-features=AudioServiceOutOfProcess'] : [] };
  if (args.includes('--dry-run')) { console.log(JSON.stringify({ phase: 'prepared-plan-only', ...plan }, null, 2)); return; }
  const runId = new Date().toISOString().replace(/[^0-9A-Za-z-]/g, '-');
  const output = resolve(option('--out', `/private/tmp/work-speaking-rehearsal-${runId}`)); await mkdir(output, { recursive: true });
  const event = async (kind, fields = {}) => {
    const entry = { at: new Date().toISOString(), kind, ...fields };
    await appendFile(join(output, 'events.jsonl'), JSON.stringify(entry) + '\n');
    console.log(`${entry.at} ${kind}${fields.turn ? ` ${fields.turn}` : ''}${fields.scene ? ` (${fields.scene})` : ''}`);
  };
  const config = { root, mediaRoot, story, chrome, cdp, contextMedia, baseURL: origin.origin, output, runId, headed: args.includes('--headed'), audioServiceInProcess, maxCaptureSkewMs: Number(option('--max-capture-skew-ms', '750')) };
  const verifyDeck = option('--verify-deck', null);
  if (verifyDeck) {
    const scene = scenes[0], person = story.cast.find(person => person.userId === 'u-vera');
    const signed = await launchActor({ ...config, scene, person });
    try {
      const data = await deckHead(signed.actor, verifyDeck);
      const response = await signed.actor.context.request.get(`/api/initiative-decks/${encodeURIComponent(verifyDeck)}/revisions/${encodeURIComponent(data.activeRevisionId)}/spec`);
      assert(response.ok(), 'Cannot read original active deck spec');
      const spec = await response.json();
      const proof = { status: 200, specStatus: response.status(), readOnly: true, actor: person.userId, deckId: verifyDeck, data, spec };
      await writeFile(join(output, 'deck-head.json'), JSON.stringify(proof, null, 2) + '\n');
      assert((await mediaStats(signed.actor)).captures.length === 0, 'Deck HEAD read unexpectedly captured media');
      console.log(JSON.stringify({ status: proof.status, readOnly: proof.readOnly, actor: proof.actor, deckId: verifyDeck, activeRevisionId: data.activeRevisionId, revisionCount: data.revisions.length, slideCount: spec.slides?.length ?? null }, null, 2));
    } finally { await signed.close(); }
    return;
  }
  if (args.includes('--probe-context-media')) return probeContextMedia(config, scenes[0], timelines.get(scenes[0].id));
  if (args.includes('--accept-share-navigation')) {
    assert(contextMedia, 'Synthetic display acceptance requires explicit context-media');
    try { return await runShareNavigationAcceptance(config, event); }
    catch (error) { await event('share-navigation-incomplete', { error: error.message }); throw error; }
  }
  if (args.includes('--calibrate-initiative')) {
    const scene = story.scenes.find(scene => scene.id === 'initiative');
    const person = story.cast.find(person => person.userId === 'u-nora');
    const native = await launchActor({ ...config, scene, person });
    try {
      await openWork(native.actor); await criteriaReady(native.actor);
      await native.actor.page.getByTestId('work-item-header-tab-history').click();
      await native.actor.page.getByTestId('work-item-header-tab-brief').click();
      await native.actor.page.getByTestId('initiative-search-link').click();
      const search = native.actor.page.getByTestId('search-composer');
      await search.getByRole('textbox', { name: 'Search question', exact: true }).waitFor({ state: 'visible' });
      await mode(native.actor, search, 'Agent'); await input(search).fill('dependency'); await input(search).press('Enter');
      await native.actor.page.waitForURL(url => url.searchParams.get('q') === 'dependency');
      const result = native.actor.page.getByRole('link', { name: 'Stop duplicate alerts during a dependency outage', exact: true });
      await result.click(); await native.actor.page.getByTestId('work-item-header').waitFor({ state: 'visible' });
      await criteriaReady(native.actor);
      assert((await mediaStats(native.actor)).captures.length === 0, 'Read-only calibration unexpectedly started capture');
      await native.actor.capture(join(output, 'initiative-selector-calibration.png'));
      await writeFile(join(output, 'initiative-selector-calibration.json'), JSON.stringify({ status: 'passed', nativeCallStarted: false, observed: ['loaded-criteria', 'activity-tab', 'brief-tab', 'mounted-search-question', 'agent-mode', 'dependency-query', 'exact-work-result'], errors: native.actor.errors }, null, 2) + '\n');
    } finally { await native.close(); }
    return;
  }
  const verifyRecording = option('--verify-recording', null);
  if (verifyRecording) {
    assert(scenes.length === 1, 'Participant proof resumes one scene at a time');
    const scene = scenes[0];
    const retained = (await readFile(join(output, 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const asset = retained.find(entry => entry.kind === 'native-recording-asset' && entry.recordingId === verifyRecording && entry.scene === scene.id);
    assert(asset && scene.turns.every(turn => retained.some(entry => entry.kind === 'turn-action-complete' && entry.turn === turn.id)
      && retained.some(entry => entry.kind === 'turn-speech-received' && entry.turn === turn.id && entry.signal.audioEnergy > 0.00001 && entry.continuity.samplesWithAudio === entry.continuity.samples)), 'Retained native timed scene evidence did not pass');
    const people = [], proof = [];
    try {
      for (const person of story.cast) people.push(await launchActor({ ...config, scene, person }));
      for (const person of people) {
        const detail = await platform(person.actor, `/api/recordings/${encodeURIComponent(verifyRecording)}`);
        assert(['u-vera', 'u-nora'].every(id => detail.participants?.some(row => row.userId === id)), 'Recording is missing historical actual participant');
        await writeFile(join(output, `${scene.id}-${person.person.userId}-recording-detail.json`), JSON.stringify({ status: 200, actor: person.person.userId, detail }, null, 2) + '\n');
        proof.push({ actor: person.person.userId, transcript: await nativeTranscriptProof(person.actor, detail, scene, output, person.person.userId, !args.includes('--inspect-recording')), playback: await sharedPlaybackProof(person, verifyRecording, scene, output) });
      }
      const result = { status: args.includes('--inspect-recording') ? 'recording-inspected-exact-content-unverified' : 'native-rehearsal-complete', scene: scene.id, deckId: asset.deckId, recordingId: verifyRecording, sameRetainedTimedScene: true, speakingMediaVerified, proof };
      await writeFile(join(output, args.includes('--inspect-recording') ? 'recording-inspection-proof.json' : 'completion-proof.json'), JSON.stringify(result, null, 2) + '\n');
      await event(args.includes('--inspect-recording') ? 'same-recording-participant-inspection' : 'same-recording-participant-proof-complete', result);
    } finally { await Promise.all(people.map(person => person.close())); }
    return;
  }
  const results = [];
  try {
    await event('prepared-media-accepted', { ...plan, contentSha256: contract.contentSha256, speakingReview: verification.speakingReview });
    for (const scene of scenes) results.push(await runScene(config, scene, timelines.get(scene.id), event));
    await writeFile(join(output, 'result.json'), JSON.stringify({ status: 'native-rehearsal-complete', speakingMediaVerified, results }, null, 2) + '\n');
    console.log(`Evidence: ${output}`);
  } catch (error) {
    await event('rehearsal-incomplete', { message: error.message });
    await writeFile(join(output, 'result.json'), JSON.stringify({ status: 'incomplete', speakingMediaVerified, results, error: error.message }, null, 2) + '\n');
    throw error;
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => {
  // All evidence and owned contexts/processes have been awaited by this
  // point. Playwright's attached-process transports may retain Node handles.
  process.exit(process.exitCode ?? 0);
});

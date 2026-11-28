#!/usr/bin/env node
// "Build a deck by talking": a recorded live test of the voice navigator driving the deck builder. One Chromium (1440 by 900),
// one person (Vera Green, u-vera, org-leader on the initiative p-auth-migration: she may edit its decks and read the spend report),
// the real live voice assistant (the provider's session, minted by this film's own middleware from the key in middleware/.env,
// which this script never reads), and her spoken lines played into the page's microphone.
//
//   node scripts/demo/deck-voice-film.mjs --out <dir> --voices <dir>          a paid take
//   node scripts/demo/deck-voice-film.mjs --out <dir> --rehearse [--voices d]  the whole story, the voice never turned on (no spend)
//   node scripts/demo/deck-voice-film.mjs --out <dir> --probe                  one minimal session start (does the key work?)
//   node scripts/demo/deck-voice-film.mjs --out <dir> --compose-only           compose and review again from <dir>/timeline.json
//
// Machinery borrowed from interviews-call-film.mjs: its own mock middleware (:4190) and portal (:5290, journey-vite.mjs), refusing
// ports already in use and stopping only the process groups it started; the microphone is a WebAudio stream (getUserMedia's audio
// track) that each line's WAV (interviews-film-voices.py output: takes.json) is played into, never over another line; a cursor
// overlay drawn by the film, not the product; timeline.json and report.json; then compose and review.
//
// The assistant's voice: the navigator's audio arrives over WebRTC as the peer connection's remote track (portal/src/lib/voice/
// client.ts). An init script wraps RTCPeerConnection: on its `track` event a MediaRecorder records that remote stream (Opus in
// WebM, 500 ms slices) and hands each slice to this script (exposeBinding), so <dir>/assistant-<n>.webm is exactly the audio the
// page received, starting at a known wall-clock moment. The same wrapper taps the `oai-events` data channel both ways (audio
// payloads dropped), which gives what the assistant said (its output transcript), what it heard, and each tool call and result.
//
// The mock world is the data (MOCK_AURORA etc., as dev:mock); MOCK_VOICE=0 is set explicitly so the voice is the live provider
// (middleware/src/config.ts only turns the scripted session on when no key is present). Rehearsal never starts the voice; in
// its place each voice edit is applied through the deck's operations API so the rest of the story has the same deck.
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const OUT = flag('--out');
if (!OUT) { console.error('usage: deck-voice-film.mjs --out <dir> (--voices <dir> | --rehearse | --probe | --compose-only)'); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });
const REHEARSE = args.includes('--rehearse');
const PROBE = args.includes('--probe');
const COMPOSE = path.join(ROOT, 'scripts', 'demo', 'deck-voice-film-compose.py');
const FINAL = path.join(OUT, 'deck-voice.mp4');
const runPy = (cmd, argv) => new Promise((resolve) => { const c = spawn(cmd, argv, { stdio: 'inherit' }); c.on('error', () => resolve(1)); c.on('exit', (x) => resolve(x ?? 1)); });
const compose = () => runPy('python3', [COMPOSE, 'compose', '--out', OUT, '--final', FINAL]);
const review = () => runPy('uv', ['run', '--offline', '--no-project', '--python', '3.10', '--with', 'faster-whisper', 'python', COMPOSE, 'review', '--out', OUT, '--final', FINAL]);
if (args.includes('--compose-only')) { const c = await compose(); process.exit(c || await review()); }

const MW_PORT = 4190;
const PORTAL_PORT = 5290;
const PORTAL = `http://127.0.0.1:${PORTAL_PORT}`;
const MIDDLEWARE = `http://127.0.0.1:${MW_PORT}`;
const P = 'p-auth-migration';
const IP = 'initiative-deck';
const E = `${IP}-editor`;
const VIEW = { width: 1440, height: 900 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const until = async (fn, ms, every = 150) => { const end = Date.now() + ms; for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() > end) return null; await sleep(every); } };

// ── Lines: the kept take of each, trimmed, levelled to -16 LUFS, 48 kHz mono ──
const LINES = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'demo', 'deck-voice-film-lines.json'), 'utf8')).lines;
const VOICES = flag('--voices');
if (!VOICES && !REHEARSE && !PROBE) { console.error('film: --voices <dir> is required for a take'); process.exit(2); }
const AUDIO = path.join(OUT, 'audio');
fs.mkdirSync(AUDIO, { recursive: true });
const CLIPS = {};
if (VOICES) {
  const takes = JSON.parse(fs.readFileSync(path.join(VOICES, 'takes.json'), 'utf8'));
  const loudness = (file) => { const r = spawnSync('ffmpeg', ['-nostats', '-hide_banner', '-i', file, '-af', 'ebur128', '-f', 'null', '-'], { encoding: 'utf8' }); const m = /I:\s+(-?[\d.]+) LUFS/.exec((r.stderr ?? '').split('Summary:').pop() ?? ''); return m ? Number(m[1]) : null; };
  for (const [id, t] of Object.entries(takes)) {
    if (!LINES[id]) continue;
    if (t.text !== LINES[id][1]) { console.error(`film: the take for ${id} is stale (its text differs from the lines file)`); process.exit(2); }
    const file = path.join(AUDIO, `${id}.wav`); const trimmed = path.join(AUDIO, `${id}.trim.wav`);
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', t.kept.file, '-af', 'silenceremove=start_periods=1:start_threshold=-50dB,areverse,silenceremove=start_periods=1:start_threshold=-50dB,areverse', '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', trimmed]);
    const lufs = loudness(trimmed); const gain = lufs === null ? 0 : Math.max(-12, Math.min(14, -16 - lufs));
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', trimmed, '-af', `volume=${gain.toFixed(2)}dB,alimiter=limit=0.89:level=disabled`, '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', file]);
    fs.unlinkSync(trimmed);
    const secs = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]).toString().trim());
    CLIPS[id] = { text: t.text, file, durMs: Math.round(secs * 1000) };
  }
  console.log(`film: ${Object.keys(CLIPS).length} lines ready`);
}

// ── The stack: this film's own mock middleware (live voice) and portal ──
const answers = (port, host) => new Promise((resolve) => {
  const sock = net.connect({ port, host }); sock.setTimeout(1000);
  sock.once('connect', () => { sock.destroy(); resolve(true); });
  sock.once('timeout', () => { sock.destroy(); resolve(false); });
  sock.once('error', () => resolve(false));
});
const portFree = async (port) => !(await answers(port, '127.0.0.1')) && !(await answers(port, '::1'));
for (const [port, what] of [[MW_PORT, 'middleware'], [PORTAL_PORT, 'portal']]) {
  if (!(await portFree(port))) { console.error(`port ${port} (${what}) is in use; nothing was started.`); process.exit(2); }
}
if (!REHEARSE && !fs.existsSync(path.join(ROOT, 'middleware', '.env'))) { console.error('film: middleware/.env (the provider key) is missing'); process.exit(2); }
function devMockEnv() {
  const script = JSON.parse(fs.readFileSync(path.join(ROOT, 'middleware', 'package.json'), 'utf8')).scripts['dev:mock'];
  const env = {};
  for (const tok of script.split(/\s+/)) { const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(tok); if (!m) break; env[m[1]] = m[2].replace(/^\$\{[A-Z_]+:-(.*)\}$/, '$1'); }
  return env;
}
const started = [];
function start(name, cmd, argv, cwd, env, log) {
  const out = fs.openSync(log, 'w');
  const base = { ...process.env };
  for (const k of ['AWS_PROFILE', 'AWS_DEFAULT_PROFILE', 'AWS_SESSION_TOKEN']) delete base[k];
  const child = spawn(cmd, argv, { cwd, env: { ...base, ...env }, stdio: ['ignore', out, out], detached: true });
  started.push({ name, child });
  console.log(`film: ${name} pid ${child.pid}`);
}
function stopAll() { for (const { name, child } of started.splice(0)) { try { process.kill(-child.pid, 'SIGTERM'); console.log(`film: stopped ${name} (group ${child.pid})`); } catch { /* gone */ } } }
process.on('SIGINT', () => { stopAll(); process.exit(130); });
process.on('SIGTERM', () => { stopAll(); process.exit(143); });
async function waitUp(url, ms) {
  const end = Date.now() + ms; let last = '';
  while (Date.now() < end) {
    // node:http, not fetch: fetch refuses 4190 (it is on the WHATWG bad-ports list, as Chromium's is; the browser is launched with it allowed).
    const status = await new Promise((resolve) => { const q = http.get(url, { timeout: 5000 }, (r) => { r.resume(); resolve(r.statusCode); }); q.on('error', (e) => resolve(String(e.code ?? e))); q.on('timeout', () => { q.destroy(); resolve('timeout'); }); });
    if (typeof status === 'number' && status < 500) { console.log(`film: ${url} answered ${status}`); return true; }
    last = String(status);
    await sleep(1000);
  }
  console.error(`film: ${url} not up in ${ms} ms (last: ${last})`); return false;
}
const WORK = path.join(OUT, 'work');
fs.mkdirSync(WORK, { recursive: true });
start('middleware', process.execPath, [path.join(ROOT, 'middleware', 'node_modules', '.bin', 'tsx'), 'src/index.ts'], path.join(ROOT, 'middleware'), {
  ...devMockEnv(), PORT: String(MW_PORT), VOICE_LOG_DIR: path.join(WORK, 'voice-log'), MOCK_PERSIST_PAIRINGS: '0', INSECURE_DEV_MODE: 'true',
  REALTIME_GATEWAY_URL: `http://localhost:${MW_PORT}`, MOCK_VOICE: '0',
  // No Bedrock in this film: anything that reaches for it is refused by these keys.
  AWS_ACCESS_KEY_ID: 'film-blocks-bedrock', AWS_SECRET_ACCESS_KEY: 'film-blocks-bedrock', AWS_EC2_METADATA_DISABLED: 'true',
}, path.join(WORK, 'middleware.log'));
start('portal', process.execPath, [path.join(ROOT, 'scripts', 'journeys', 'journey-vite.mjs'), '--port', String(PORTAL_PORT)], path.join(ROOT, 'portal'), {
  VITE_GATEWAY_URL: `http://localhost:${MW_PORT}`, API_PROXY_TARGET: MIDDLEWARE, VITE_VOICE_NAVIGATOR: '1',
}, path.join(WORK, 'portal.log'));
if (!(await waitUp(`${MIDDLEWARE}/livez`, 180_000) && await waitUp(`${PORTAL}/`, 180_000))) { console.error('film: the stack did not come up; see work/*.log'); stopAll(); process.exit(2); }
const ceiling = setTimeout(() => { console.error('film: hard timeout (15 min)'); stopAll(); process.exit(3); }, 15 * 60_000);

// ── The record ──
const timeline = { size: VIEW, video: null, film: { fromMs: null, toMs: null }, scenes: [], speech: [], assistant: [], marks: [], dc: [] };
const report = { startedAt: new Date().toISOString(), mode: PROBE ? 'probe' : REHEARSE ? 'rehearse' : 'live', persona: 'u-vera (org-leader)', requests: [], steps: [], notes: [], api: {} };
const fs_ = (ms) => (timeline.film.fromMs ? Number(((ms - timeline.film.fromMs) / 1000).toFixed(1)) : null);
const step = (id, ok, detail) => { report.steps.push({ id, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${id}: ${detail}`); };
const note = (s) => { report.notes.push(s); console.log(`note: ${s}`); };
const mark = (label) => { timeline.marks.push({ label, atMs: Date.now() }); console.log(`  [${fs_(Date.now()) ?? '-'}] · ${label}`); };
const scene = (n, title, caption) => { timeline.scenes.push({ n, title, caption, atMs: Date.now() }); console.log(`scene ${n}: ${title}`); };
const save = () => {
  fs.writeFileSync(path.join(OUT, 'timeline.json'), JSON.stringify(timeline, null, 1));
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 1));
};

// ── The page: microphone, cursor, the voice tap ──
const MIC = () => {
  const md = navigator.mediaDevices; if (!md?.getUserMedia) return;
  const original = md.getUserMedia.bind(md);
  let ac = null; let dest = null;
  const ensure = () => { if (!ac) { ac = new AudioContext({ sampleRate: 48000 }); dest = ac.createMediaStreamDestination(); } return dest; };
  md.getUserMedia = async (c) => { if (!c?.audio) return original(c); const video = c.video ? await original({ video: c.video }) : null; return new MediaStream([...(video ? video.getVideoTracks() : []), ensure().stream.getAudioTracks()[0].clone()]); };
  window.__filmWarm = async () => { const d = ensure(); await ac.resume(); const s = ac.createBufferSource(); s.buffer = ac.createBuffer(1, ac.sampleRate, ac.sampleRate); s.connect(d); await new Promise((r) => { s.onended = r; s.start(); }); };
  window.__filmSay = async (url) => { const d = ensure(); await ac.resume(); const buf = await ac.decodeAudioData(await (await fetch(url)).arrayBuffer()); const s = ac.createBufferSource(); s.buffer = buf; s.connect(d); return new Promise((r) => { s.onended = () => r(buf.duration); s.start(); }); };
};
const TAP = () => {
  const Orig = window.RTCPeerConnection; if (!Orig) return;
  let n = 0;
  function Tapped(...a) {
    const pc = new Orig(...a); const id = n++;
    pc.addEventListener('track', (e) => {
      if (e.track.kind !== 'audio') return;
      const stream = new MediaStream([e.track]);
      const rec = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
      rec.ondataavailable = async (ev) => {
        if (!ev.data.size) return;
        const b = new Uint8Array(await ev.data.arrayBuffer()); let s = '';
        for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
        window.__filmAudio(id, btoa(s));
      };
      rec.onstop = () => window.__filmAudioEnd(id);
      e.track.addEventListener('ended', () => { try { rec.stop(); } catch { /* stopped */ } });
      pc.addEventListener('connectionstatechange', () => { if (pc.connectionState === 'closed' || pc.connectionState === 'failed') { try { rec.stop(); } catch { /* stopped */ } } });
      rec.start(500); window.__filmAudioStart(id, Date.now());
    });
    const create = pc.createDataChannel.bind(pc);
    pc.createDataChannel = (label, o) => {
      const dc = create(label, o);
      dc.addEventListener('message', (e) => { if (typeof e.data === 'string') window.__filmDc('in', e.data); });
      const send = dc.send.bind(dc); dc.send = (t) => { if (typeof t === 'string') window.__filmDc('out', t); return send(t); };
      const close = pc.close.bind(pc); pc.close = () => { try { window.__filmAudioClose?.(id); } catch { /* none */ } return close(); };
      return dc;
    };
    return pc;
  }
  Tapped.prototype = Orig.prototype;
  Object.setPrototypeOf(Tapped, Orig);
  window.RTCPeerConnection = Tapped;
};
const CURSOR = () => {
  const put = () => {
    if (document.getElementById('__film-cursor')) return;
    const c = document.createElement('div'); c.id = '__film-cursor'; c.setAttribute('aria-hidden', 'true');
    Object.assign(c.style, { position: 'fixed', left: '-40px', top: '-40px', width: '24px', height: '24px', marginLeft: '-12px', marginTop: '-12px', borderRadius: '50%',
      background: 'rgba(245, 158, 11, 0.30)', border: '2px solid rgba(245, 158, 11, 0.95)', boxShadow: '0 0 16px 7px rgba(245, 158, 11, 0.45)', pointerEvents: 'none', zIndex: '2147483647', transition: 'transform 140ms ease-out' });
    document.documentElement.appendChild(c);
    addEventListener('mousemove', (e) => { c.style.left = `${e.clientX}px`; c.style.top = `${e.clientY}px`; }, true);
    addEventListener('mousedown', () => { c.style.transform = 'scale(0.65)'; }, true);
    addEventListener('mouseup', () => { c.style.transform = 'scale(1)'; }, true);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', put); else put();
};

const req = createRequire(path.join(ROOT, 'portal', 'package.json'));
const pw = await import(pathToFileURL(req.resolve('playwright')).href);
const chromium = pw.chromium ?? pw.default.chromium;
const RAW = path.join(OUT, 'raw');
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', `--explicitly-allowed-ports=${MW_PORT}`] });
const context = await browser.newContext({ viewport: VIEW, recordVideo: { dir: RAW, size: VIEW }, permissions: ['microphone'], acceptDownloads: true });
const api = context.request;
const login = await api.post(`${PORTAL}/api/session/login`, { data: { userId: 'u-vera' } });
if (login.status() !== 200) { console.error(`film: login answered ${login.status()}`); stopAll(); process.exit(2); }
const role = await api.post(`${PORTAL}/api/session/role`, { data: { tenant: 'orgiq', role: 'org-leader' } });
if (role.status() !== 200) { console.error(`film: role answered ${role.status()}`); stopAll(); process.exit(2); }
await context.addInitScript(MIC);
await context.addInitScript(TAP);
await context.addInitScript(CURSOR);
await context.route(`${PORTAL}/__film-audio/**`, (route) => route.fulfill({ path: path.join(AUDIO, path.basename(new URL(route.request().url()).pathname)), contentType: 'audio/wav' }));
// The assistant's audio and the data channel, as the page received them.
const voice = { sessions: {}, started: 0, outText: '', lastOutAt: 0, lastAudioEventAt: 0, toolCalls: [], usageSeconds: null };
await context.exposeBinding('__filmAudioStart', (_s, id, atMs) => { voice.sessions[id] = { atMs, file: path.join(OUT, `assistant-${id}.webm`), bytes: 0 }; fs.writeFileSync(voice.sessions[id].file, ''); timeline.assistant.push({ id, atMs, file: `assistant-${id}.webm` }); });
await context.exposeBinding('__filmAudio', (_s, id, b64) => { const s = voice.sessions[id]; if (!s) return; const b = Buffer.from(b64, 'base64'); fs.appendFileSync(s.file, b); s.bytes += b.length; });
await context.exposeBinding('__filmAudioEnd', (_s, id) => { const s = voice.sessions[id]; if (s) s.endMs = Date.now(); });
await context.exposeBinding('__filmAudioClose', () => undefined);
await context.exposeBinding('__filmDc', (_s, dir, text) => {
  const now = Date.now(); let ev; try { ev = JSON.parse(text); } catch { return; }
  const type = String(ev?.type ?? '');
  if (dir === 'in' && type === 'session.output_audio.delta') { voice.lastAudioEventAt = now; if (!voice.audioMarks?.length || now - voice.audioMarks.at(-1).last > 1200) (voice.audioMarks ??= []).push({ first: now, last: now }); else voice.audioMarks.at(-1).last = now; return; }
  const keep = { atMs: now, dir, type };
  for (const k of ['delta', 'text', 'transcript', 'name', 'arguments', 'reason', 'status']) if (typeof ev[k] === 'string') keep[k] = ev[k].slice(0, 600);
  if (ev.item?.type) { keep.item = ev.item.type; if (typeof ev.item.output === 'string') keep.output = ev.item.output.slice(0, 800); if (ev.item.name) keep.name = ev.item.name; if (typeof ev.item.arguments === 'string') keep.arguments = ev.item.arguments.slice(0, 600); }
  if (ev.usage) keep.usage = ev.usage;
  timeline.dc.push(keep);
  if (dir === 'in' && type === 'session.started') voice.started = now;
  if (dir === 'in' && type === 'session.output_transcript.delta') { voice.outText += keep.delta ?? ''; voice.lastOutAt = now; (voice.outMarks ??= []).push(now); }
  if (dir === 'in' && type === 'session.usage.updated' && ev.usage?.seconds != null) voice.usageSeconds = ev.usage.seconds;
});
const page = await context.newPage();
timeline.video = { startMs: Date.now(), file: null };
const errors = [];
page.on('pageerror', (e) => errors.push(e.message.slice(0, 160)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 160)}`); });

// ── Pointer at a hand's pace (interviews-call-film.mjs) ──
let cursorAt = [VIEW.width * 0.55, VIEW.height * 0.8];
async function moveTo(x, y, ms = 650) {
  const [x0, y0] = cursorAt; const t0 = Date.now();
  for (;;) { const t = Math.min(1, (Date.now() - t0) / ms); const e = t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2; await page.mouse.move(x0 + (x - x0) * e, y0 + (y - y0) * e); if (t >= 1) break; await sleep(16); }
  cursorAt = [x, y];
}
async function press(locator, { pause = 400, timeout = 30_000 } = {}) {
  await locator.waitFor({ timeout });
  await locator.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => undefined);
  const box = await locator.boundingBox({ timeout: 3000 }).catch(() => null);
  if (box) { await moveTo(box.x + box.width / 2, box.y + Math.min(box.height / 2, 28)); await sleep(pause); }
  await locator.click({ timeout });
}
const go = async (p) => { await page.goto(`${PORTAL}${p}`, { waitUntil: 'domcontentloaded', timeout: 40_000 }); await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => undefined); };
const jget = async (url) => { const r = await api.get(`${PORTAL}${url}`); return { status: r.status(), body: await r.json().catch(() => null) }; };
const deckIdOf = () => decodeURIComponent((page.url().match(/\/decks\/([^/?#]+)/) ?? [])[1] ?? '');
async function headSpec(deckId) {
  const d = await jget(`/api/initiative-decks/${encodeURIComponent(deckId)}`);
  const rev = d.body?.activeRevisionId;
  const s = await jget(`/api/initiative-decks/${encodeURIComponent(deckId)}/revisions/${encodeURIComponent(rev)}/spec`);
  return { rev, spec: s.body?.spec ?? s.body };
}
const stageSrc = () => page.evaluate((t) => document.querySelector(`[data-testid="${t}"]`)?.getAttribute('src') ?? '', `${E}-editor-stage-image`).catch(() => '');
const slideCount = () => page.locator(`[data-testid^="${E}-slide-select-"]`).count();
/** What slide n+1's thumbnail draws (its markup; thumbnails are drawn in the page, not images): changes when its preview does. */
const thumbs = (n = 4) => page.evaluate(([p, k]) => [...document.querySelectorAll(`[data-testid^="${p}"]`)][k]?.innerHTML ?? '', [`${E}-slide-thumb-`, n]).catch(() => '');
const listText = () => page.evaluate((t) => document.querySelector(`[data-testid="${t}"]`)?.innerText ?? '', `${E}-slide-list`).catch(() => '');
const testIds = (re) => page.evaluate((r) => [...new Set([...document.querySelectorAll('[data-testid]')].map((e) => e.getAttribute('data-testid')))].filter((i) => new RegExp(r).test(i)), re);
const stageLoaded = async () => until(async () => (await page.evaluate((t) => { const i = document.querySelector(`[data-testid="${t}"]`); return i && i.complete ? i.naturalWidth : 0; }, `${E}-editor-stage-image`)) > 0, 20_000, 250);

// ── Speaking and listening ──
const busy = { until: 0 };
async function say(id) {
  const c = CLIPS[id] ?? { text: LINES[id][1], file: null, durMs: 900 + 62 * LINES[id][1].length };
  const wait = busy.until + 500 - Date.now(); if (wait > 0) await sleep(wait);
  const atMs = Date.now();
  timeline.speech.push({ id, text: c.text, file: c.file ? path.relative(OUT, c.file) : null, atMs, durMs: c.durMs });
  console.log(`  [${fs_(atMs) ?? '-'}] vera: ${c.text}`);
  if (c.file) await page.evaluate((u) => window.__filmSay(u), `${PORTAL}/__film-audio/${id}.wav`); else await sleep(c.durMs);
  busy.until = Date.now();
  return Date.now();
}
/** The assistant's reply after `since`: waits for it to begin (first output transcript or audio event), then to go quiet. */
async function reply(since, { beginMs = 20_000, quietMs = 1800 } = {}) {
  const firstOut = () => { const a = (voice.outMarks ?? []).find((t) => t > since); const b = (voice.audioMarks ?? []).find((m) => m.first > since)?.first; return a || b ? Math.min(a ?? Infinity, b ?? Infinity) : null; };
  const began = await until(async () => firstOut(), beginMs, 100);
  if (began) await until(async () => (Date.now() - Math.max(voice.lastOutAt, voice.lastAudioEventAt) > quietMs ? true : null), 40_000, 150);
  busy.until = Math.max(busy.until, Date.now());
  const said = timeline.dc.filter((d) => d.dir === 'in' && d.type === 'session.output_transcript.delta' && d.atMs > since).map((d) => d.delta).join('');
  const heard = timeline.dc.filter((d) => d.dir === 'in' && d.type === 'session.input_transcript.delta' && d.atMs > since - 8000 && d.atMs < (began ?? Date.now()) + 500).map((d) => d.delta).join('');
  return { began, said: squash(said), heard: squash(heard) };
}
const card = () => page.getByTestId('voice-confirm-card');
const cardShown = async () => ((await card().count()) > 0 && (await card().first().isVisible().catch(() => false)) ? Date.now() : null);

const deck = { id: '', url: '' };
/**
 * One spoken edit, measured: the line, the card (its words), the confirm (spoken or clicked, as the card asks), the change on the
 * page. `retry` is the clearer wording said once if no card comes. `changed(before)` → truthy once the page shows the change.
 */
async function spokenEdit(kind, ids, { confirmLine = 'confirm', click = false, changed, rehearseOps }) {
  const r = { kind, attempts: [] };
  for (const id of ids) {
    const before = { count: await slideCount(), src: await stageSrc(), list: await listText(), thumbs: await thumbs(), head: deck.id ? (await headSpec(deck.id)).rev : null };
    const a = { line: id, said: LINES[id][1], lineEndS: null, replyS: null, cardS: null, cardWords: null, confirmS: null, visibleS: null, assistant: '', heard: '' };
    r.attempts.push(a);
    if (REHEARSE) {
      const end = await say(id); a.lineEndS = fs_(end);
      if (rehearseOps) { const res = await rehearseOps(); a.cardWords = `(rehearsal: applied through the API, ${res})`; }
      await page.reload({ waitUntil: 'domcontentloaded' }); await stageLoaded();
      const vis = await until(async () => (await changed(before)) ? Date.now() : null, 15_000, 150); a.visibleS = vis ? fs_(vis) : null;
      return r;
    }
    const end = await say(id); a.lineEndS = fs_(end);
    const cardAt = until(cardShown, 25_000, 100);
    const rep = await reply(end, { beginMs: 25_000 });
    const shown = await cardAt;
    a.replyS = rep.began ? fs_(rep.began) : null; a.assistant = rep.said; a.heard = rep.heard;
    if (!shown) { note(`${kind}: no confirm card after "${LINES[id][1]}" (the assistant said "${rep.said.slice(0, 200)}")`); continue; }
    a.cardS = fs_(shown);
    a.cardWords = squash(await card().first().innerText().catch(() => ''));
    mark(`card: ${a.cardWords.slice(0, 120)}`);
    await sleep(1200);
    const needsClick = click || /click/i.test(a.cardWords);
    if (needsClick) {
      await sleep(1500);
      const btn = card().first().locator('button').filter({ hasNotText: /cancel/i }).filter({ hasText: /confirm|remove|delete|yes|apply|ok/i }).first();
      await press(btn, { pause: 700 }); a.confirmS = fs_(Date.now()); a.confirmedBy = 'click';
    } else {
      const cEnd = await say(confirmLine); a.confirmS = fs_(cEnd); a.confirmedBy = 'voice';
      const gone = await until(async () => ((await card().count()) === 0 ? true : null), 12_000, 100);
      if (!gone) { note(`${kind}: the card stayed open after the spoken confirm; clicking it`); const btn = card().first().locator('button').filter({ hasNotText: /cancel/i }).first(); await press(btn).catch(() => undefined); a.confirmedBy = 'voice, then click (the spoken confirm did not take)'; }
    }
    const vis = await until(async () => (await changed(before)) ? Date.now() : null, 25_000, 150);
    a.visibleS = vis ? fs_(vis) : null;
    const after = await reply(Date.now() - 2500, { beginMs: 6000 });
    a.afterConfirm = after.said;
    a.headChanged = deck.id ? (await headSpec(deck.id)).rev !== before.head : null;
    return r;
  }
  return r;
}
/** A spoken question, measured: the line's end to the assistant's first word; what it said. */
async function spokenAsk(kind, ids, { ok }) {
  const r = { kind, attempts: [] };
  for (const id of ids) {
    const a = { line: id, said: LINES[id][1], lineEndS: null, replyS: null, assistant: '', heard: '' };
    r.attempts.push(a);
    const end = await say(id); a.lineEndS = fs_(end);
    if (REHEARSE) return r;
    const rep = await reply(end, { beginMs: 25_000, quietMs: 2200 });
    a.replyS = rep.began ? fs_(rep.began) : null; a.assistant = rep.said; a.heard = rep.heard;
    a.right = ok(rep);
    if (a.right) return r;
    note(`${kind}: answer judged wrong or missing: "${rep.said.slice(0, 200)}"`);
  }
  return r;
}

let exitCode = 0;
try {
  // ── 0. Probe: one minimal session start (does the key work?) ──
  if (PROBE) {
    await go(`/iq/projects/${P}`);
    await page.evaluate(() => window.__filmWarm?.()).catch(() => undefined);
    const t0 = Date.now();
    await page.getByTestId('shell-voice-dock-start').click();
    const ok = await until(async () => voice.started || null, 25_000, 100);
    const toast = squash(await page.getByTestId('toast-stack').innerText().catch(() => ''));
    const dock = squash(await page.evaluate(() => document.querySelector('[data-testid^="shell-voice-dock"]')?.parentElement?.innerText ?? '').catch(() => ''));
    await sleep(3000);
    await page.getByTestId('shell-voice-dock-stop').click().catch(() => undefined);
    await sleep(2500);
    step('probe', !!ok, ok ? `session.started ${ok - t0} ms after Start; dock "${dock.slice(0, 100)}"` : `no session.started in 25 s; dock "${dock.slice(0, 160)}"; toast "${toast.slice(0, 200)}"; events ${JSON.stringify(timeline.dc.slice(0, 5).map((d) => d.type))}`);
    exitCode = ok ? 0 : 1;
    throw Object.assign(new Error('probe done'), { probe: true });
  }

  // ── 1. The new deck page, the voice on, "show me a few example slides" ──
  await go(`/iq/projects/${P}?tab=docs`);
  await page.evaluate(() => window.__filmWarm?.()).catch(() => undefined);
  timeline.film.fromMs = Date.now() - 600;
  scene(1, 'A new deck', 'Vera opens New deck on her initiative and turns the voice on.');
  await sleep(1500);
  await press(page.getByTestId('initiative-files-new'));
  await press(page.getByRole('menuitem', { name: /Presentation/ }));
  await page.waitForURL(/\/iq\/decks\/new/, { timeout: 15_000 });
  await page.getByTestId(`${IP}-new-submit`).waitFor({ timeout: 15_000 });
  await sleep(1500);
  if (!REHEARSE) {
    await press(page.getByTestId('shell-voice-dock-start'));
    const s = await until(async () => voice.started || null, 25_000, 100);
    step('voice-started', !!s, s ? `session.started at ${fs_(s)} s` : 'no session.started in 25 s');
    if (!s) throw new Error('the voice session did not start');
    await sleep(1500);
  }
  const ex = await spokenAsk('examples', ['examples', 'examples_b'], {
    ok: (rep) => !!rep.said && !/can't|cannot|unable|not able|don't have/i.test(rep.said),
  });
  await sleep(2500);
  ex.landedOn = new URL(page.url()).pathname + new URL(page.url()).search;
  ex.examplesVisible = await page.locator(`button[data-testid^="${IP}-template-"]`).first().isVisible().catch(() => false);
  report.requests.push(ex);
  mark(`after "examples": on ${ex.landedOn}, example tiles visible ${ex.examplesVisible}`);
  if (!/\/iq\/decks\/new/.test(page.url())) { note(`the assistant's "examples" left the new-deck page for ${ex.landedOn}; Vera goes back by hand`); await sleep(3000); await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => undefined); await page.getByTestId(`${IP}-new-submit`).waitFor({ timeout: 15_000 }).catch(() => undefined); }
  await page.locator(`button[data-testid^="${IP}-template-"]`).first().waitFor({ timeout: 15_000 });
  await sleep(2000);
  await press(page.getByTestId(`${IP}-template-status-update`));
  await sleep(800);
  await press(page.getByTestId(`${IP}-new-title`));
  await page.getByTestId(`${IP}-new-title`).pressSequentially('Auth migration: November status', { delay: 45 });
  await sleep(600);
  await press(page.getByTestId(`${IP}-new-template-submit`));
  await page.waitForURL(/\/iq\/decks\/(?!new)[^/?#]+$/, { timeout: 30_000 });
  deck.id = deckIdOf(); deck.url = new URL(page.url()).pathname;
  await stageLoaded();
  const h0 = await headSpec(deck.id);
  report.api.created = { deckId: deck.id, slides: (h0.spec?.slides ?? []).map((s) => `${s.layout}:${s.title ?? ''}`) };
  step('created', (h0.spec?.slides ?? []).length >= 6, `deck ${deck.id}, ${(h0.spec?.slides ?? []).length} slides: ${report.api.created.slides.join(' | ')}`);
  const reports = await jget(`/api/initiative-decks/${encodeURIComponent(deck.id)}/chart-reports`);
  report.api.chartReports = { status: reports.status, ids: (reports.body?.reports ?? []).map((x) => x.id ?? x.report ?? x) };
  await sleep(2500);

  const opsApi = async (ops) => { const h = await headSpec(deck.id); const r = await api.post(`${PORTAL}/api/initiative-decks/${encodeURIComponent(deck.id)}/operations`, { data: { baseRevisionId: h.rev, operations: ops(h.spec.slides) } }); return `${r.status()}`; };

  // ── 2. "Add a timeline slide after slide three" ──
  scene(2, 'Add a slide by voice', 'The assistant shows what will change on a card; Vera says confirm.');
  const n0 = await slideCount();
  report.requests.push(await spokenEdit('add timeline', ['timeline', 'timeline_b'], {
    changed: async (b) => (await slideCount()) === b.count + 1,
    rehearseOps: () => opsApi((s) => [{ op: 'add_slide', layout: 'timeline', after: s[2].id, title: 'Plan' }]),
  }));
  await sleep(2500);

  // ── 3. "Rename slide two" ──
  scene(3, 'Rename a slide', 'A title change, said once and confirmed.');
  report.requests.push(await spokenEdit('rename slide 2', ['rename', 'rename_b'], {
    changed: async (b) => /where we are this month/i.test(await listText()) || ((await stageSrc()) !== b.src && /where we are/i.test(await page.locator('body').innerText())),
    rehearseOps: () => opsApi((s) => [{ op: 'set_title', slideId: s[1].id, title: 'Where we are this month' }]),
  }));
  await sleep(2500);

  // ── 4. The centrepiece: a report as a pie on slide five ──
  scene(4, 'A report, charted', 'Spend by initiative, run under Vera\'s own session, as a pie on slide five.');
  report.requests.push(await spokenEdit('pie from spend report', ['chart', 'chart_b'], {
    changed: async (b) => (await thumbs()) !== b.thumbs && (await slideCount()) === b.count,
    rehearseOps: () => opsApi((s) => [{ op: 'set_chart', slideId: s[4].id, kind: 'pie', report: { report: 'spend-by-initiative', params: { period: '30d' } } }]),
  }));
  // Hold on the chart: select slide five.
  const s5 = page.locator(`[data-testid^="${E}-slide-select-"]`).nth(4);
  if (await s5.count()) { await press(s5); await stageLoaded(); }
  mark('holding on slide five');
  await sleep(6000);

  // ── 5. "What reports can I use?" ──
  scene(5, 'Ask what it can do', 'The reports a slide can be filled from, read aloud.');
  report.requests.push(await spokenAsk('reports', ['reports', 'reports_b'], { ok: (rep) => /spend|runs|findings|jobs/i.test(rep.said) }));
  await sleep(1500);

  // ── 6. "Remove slide seven": the card needs a click ──
  scene(6, 'A removal needs a click', 'Removing a slide is never confirmed by voice: the card asks for a click.');
  report.requests.push(await spokenEdit('remove slide 7', ['remove', 'remove_b'], {
    click: true,
    changed: async (b) => (await slideCount()) === b.count - 1,
    rehearseOps: () => opsApi((s) => [{ op: 'remove_slide', slideId: s[6].id }]),
  }));
  await sleep(2000);
  if (!REHEARSE) {
    const t = await say('thanks'); const rep = await reply(t, { beginMs: 10_000 }); report.requests.push({ kind: 'thanks', attempts: [{ line: 'thanks', said: LINES.thanks[1], lineEndS: fs_(t), replyS: rep.began ? fs_(rep.began) : null, assistant: rep.said }] });
    await press(page.getByTestId('shell-voice-dock-stop')).catch(() => undefined);
    mark('voice off');
    await sleep(2500);
  }

  // ── 7. By hand: the layout gallery in place, a key-figures slide ──
  scene(7, 'By hand', 'The layout gallery opens in place; a key figures slide, two figures typed, the preview follows.');
  // The gallery adds after the selected slide: select the last one before Sources, so the new slide lands at the end.
  const lastReal = page.locator(`[data-testid^="${E}-slide-select-"]:not([data-testid$="-sources"])`).last();
  await press(lastReal); await sleep(1200);
  const idsBefore = await testIds(`^${E}-slide-select-`);
  // "All layouts…" is the last row of the toolbar's Insert menu (ui-components 2.549.0 has no ⋯ menu there).
  await press(page.getByTestId(`${E}-toolbar-insert`));
  await press(page.getByTestId(`${E}-toolbar-insert-all`));
  await page.getByTestId(`${E}-layout-panel`).waitFor({ timeout: 10_000 });
  report.api.galleryIds = await testIds(`^${E}-layout-gallery-`);
  await sleep(2500);
  const kf = page.locator(`[data-testid="${E}-layout-gallery-key-figures"], [data-testid="${E}-layout-gallery-figures"]`).first();
  await press(kf);
  await page.getByTestId(`${E}-slide-form`).waitFor({ timeout: 10_000 });
  await sleep(1200);
  report.api.formIds = await testIds(`^${E}-slide-`);
  const newId = (await testIds(`^${E}-slide-select-`)).find((i) => !idsBefore.includes(i))?.replace(`${E}-slide-select-`, '') ?? null;
  // The thumbnail is a painted image with no text to read: compare its image source (the element's, or its img's).
  const thumbOf = () => page.evaluate((t) => { const el = document.querySelector(`[data-testid="${t}"]`); const img = el?.tagName === 'IMG' ? el : el?.querySelector('img'); return img?.getAttribute('src') ?? el?.innerHTML ?? ''; }, `${E}-slide-thumb-${newId}`).catch(() => '');
  await sleep(1500); // the first preview of the new slide lands after the editor's debounce
  const thumbBefore = await thumbOf();
  const title = page.getByTestId(`${E}-slide-title`);
  if (await title.count()) { await press(title); await title.fill(''); await title.pressSequentially('Two numbers that matter', { delay: 45 }); await sleep(400); }
  const values = page.locator(`[data-testid="${E}-slide-form"] input[data-testid*="figure"][data-testid*="value"]`);
  const labels = page.locator(`[data-testid="${E}-slide-form"] input[data-testid*="figure"][data-testid*="label"]`);
  const typed = [];
  for (const [i, v, l] of [[0, '$41k', 'Spend this month'], [1, '92%', 'Sign-ins migrated']]) {
    if (await values.nth(i).count()) { await press(values.nth(i)); await values.nth(i).fill(''); await values.nth(i).pressSequentially(v, { delay: 70 }); typed.push(v); }
    if (await labels.nth(i).count()) { await press(labels.nth(i)); await labels.nth(i).fill(''); await labels.nth(i).pressSequentially(l, { delay: 45 }); typed.push(l); }
    await sleep(500);
  }
  // The preview is debounced: wait for the thumbnail's source to change after the last keystroke.
  const previewed = await until(async () => { const now = await thumbOf(); return now && now !== thumbBefore ? Date.now() : null; }, 15_000, 250);
  step('key-figures', typed.length >= 2 && !!previewed, `typed ${JSON.stringify(typed)}; new slide ${newId}; its preview changed: ${!!previewed}${typed.length < 2 ? `; form ids ${JSON.stringify(report.api.formIds)}` : ''}`);
  await sleep(2500);
  const saveBtn = page.getByTestId(`${IP}-save`);
  if (await saveBtn.isEnabled().catch(() => false)) { await press(saveBtn); const saved = await until(async () => !/unsaved changes/i.test(await page.locator('main').innerText().catch(() => '')), 15_000, 300); step('saved', !!saved, saved ? 'the hand edits saved' : `still unsaved: ${squash(await page.locator('main').innerText().catch(() => '')).slice(0, 200)}`); await sleep(1500); }

  // ── 8. Present in place ──
  scene(8, 'Present', 'Both sidebars fold, the slide fills the page; three slides; out again.');
  // Present from slide four, so the run passes the pie on slide five.
  const s4 = page.locator(`[data-testid^="${E}-slide-select-"]`).nth(3);
  if (await s4.count()) { await press(s4); await sleep(1000); }
  await press(page.getByTestId(`${E}-toolbar-present`));
  await page.getByTestId(`${E}-present`).waitFor({ timeout: 10_000 });
  await sleep(3000);
  const pos = async () => squash(await page.getByTestId(`${E}-present-position`).innerText().catch(() => ''));
  const seen = [await pos()];
  for (let i = 0; i < 3; i++) { await page.keyboard.press('ArrowRight'); await sleep(2600); seen.push(await pos()); }
  await page.keyboard.press('Escape'); await sleep(2500);
  const exited = (await page.getByTestId(`${E}-present`).count()) === 0;
  step('present', exited && new Set(seen).size === 4, `positions ${seen.join(' -> ')}; exited ${exited}`);

  // ── 9. Download as PDF ──
  scene(9, 'Download', 'The deck as a PDF, from the download menu.');
  await press(page.getByTestId(`${IP}-download-menu`));
  await sleep(1500);
  const pdf = page.locator(`[data-testid="${IP}-download-pdf"]`);
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), press(pdf)]);
  const file = path.join(OUT, `deck-${dl.suggestedFilename()}`);
  await dl.saveAs(file);
  const head = fs.readFileSync(file).subarray(0, 4).toString('latin1');
  step('pdf', head === '%PDF', `${dl.suggestedFilename()}, ${fs.statSync(file).size} bytes`);
  await page.keyboard.press('Escape').catch(() => undefined);
  await moveTo(VIEW.width * 0.5, VIEW.height * 0.45, 900);
  await sleep(4000);

  // ── The product's own record: the head revision ──
  const hEnd = await headSpec(deck.id);
  const slides = hEnd.spec?.slides ?? [];
  report.api.final = slides.map((s) => ({ layout: s.layout, title: s.title, chart: s.chart ? { kind: s.chart.kind, labels: s.chart.labels, series: (s.chart.series ?? []).map((x) => ({ name: x.name, values: x.values })) } : undefined, sources: (s.sources ?? []).map((x) => x.documentId ?? x.title) }));
  const pie = slides.find((s) => s.chart?.kind === 'pie');
  step('api: timeline added after slide 3', slides[3]?.layout === 'timeline', `slide 4 is ${slides[3]?.layout} "${slides[3]?.title}"`);
  step('api: slide 2 renamed', /where we are this month/i.test(slides[1]?.title ?? ''), `slide 2 title "${slides[1]?.title}"`);
  step('api: pie from spend by initiative', !!pie && JSON.stringify(pie.sources ?? []).includes('report:spend-by-initiative'), pie ? `pie on slide ${slides.indexOf(pie) + 1}, labels ${JSON.stringify(pie.chart.labels)}, sources ${JSON.stringify((pie.sources ?? []).map((x) => x.documentId))}` : 'no pie chart in the head revision');
  step('api: slide count', true, `${slides.length} slides at the end: ${slides.map((s) => s.layout).join(', ')}`);
} catch (e) {
  if (!e.probe) { exitCode = 1; note(`stopped: ${String(e?.message ?? e).split('\n')[0].slice(0, 300)}`); await page.screenshot({ path: path.join(OUT, 'stopped.png') }).catch(() => undefined); }
} finally {
  timeline.film.toMs = Date.now();
  report.voice = { usageSeconds: voice.usageSeconds, assistantRecordings: Object.values(voice.sessions).map((s) => ({ file: path.basename(s.file), bytes: s.bytes })), sessionStartedAtS: voice.started ? fs_(voice.started) : null };
  const closes = timeline.dc.filter((d) => d.type === 'session.usage.updated').at(-1);
  if (closes?.usage) report.voice.lastUsage = closes.usage;
  report.pageErrors = errors.slice(0, 30);
  await page.close().catch(() => undefined);
  timeline.video.file = path.relative(OUT, (await page.video()?.path().catch(() => null)) ?? '');
  await context.close().catch(() => undefined);
  await browser.close().catch(() => undefined);
  try { report.voice.sessionsLog = fs.readdirSync(path.join(WORK, 'voice-log')); } catch { /* none */ }
  save();
  clearTimeout(ceiling);
  stopAll();
  await sleep(1500);
  for (const port of [MW_PORT, PORTAL_PORT]) console.log(`film: port ${port} free after the run: ${await portFree(port)}`);
}
if (!PROBE && timeline.film.fromMs && !args.includes('--record-only')) { const c = await compose(); if (!c && !REHEARSE) await review(); }
process.exit(exitCode);

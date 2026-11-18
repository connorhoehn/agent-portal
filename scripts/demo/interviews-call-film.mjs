#!/usr/bin/env node
// "A Candidates interview, live": a recorded proof that an interview call works end to end, as one side-by-side film of the
// two browsers (the lead, Hugo Marchetti, on the left; the candidate on the right) and a pass/fail report read from the product.
//
//   node scripts/demo/interviews-call-film.mjs --out <dir> --voices <dir>
//
// It costs money: Milo is the provider's live session (the key is read by the middleware from middleware/.env, never by this
// script). It starts its own mock middleware (:4180) and portal (:5280), refuses ports already in use, and expects a media server
// (the LVS SFU) and a platform-api of its own already running, pointed at each other and at this middleware (see "The stack"
// below). Two Chromiums, one per person, each with a still, clearly fictional camera (a y4m made by interviews-film-compose.py
// `cameras`) and a microphone this script plays lines into: each browser's getUserMedia audio track is a WebAudio stream, and
// each line (a WAV synthesised beforehand, see --voices) is played into it when the story reaches it, never over another
// line, with at least 1.8 s of silence between turns (overlapping speech is not credited to either speaker). Milo hears the call
// through the media server's taps, as in production. The interviews coach (and with it Milo's private answers and the recap)
// stays on the mock world's scripted stand-in (film-scripted-coach.mjs), so no Bedrock is called.
//
// The story, on the seeded design round iv-k1p5w8ra (Hugo leads; the candidate is the mock world's Mateo Alvarez):
//   1 Hugo opens the room and starts the call; the recruiter (Greta, by the API) makes the invite link
//   2 the candidate opens the link: the three answers (yes), the device check, the waiting room; Hugo admits; both in the call
//   3 Hugo invites Milo and turns its voice on; a greeting and a project question; the candidate answers (two lines)
//   4 Milo's suggestion in Hugo's footer; "Have Milo ask"; Milo reads the question aloud
//   5 the candidate: "Milo, can you repeat the question?" and "Milo, how much time is left?", then answers the question
//   6 Hugo asks Milo "Should we hire them?": refused with the fixed sentence
//   7 the coding pad: Hugo inserts the question, the candidate types and pastes, runs; both panes show the run
//   8 Hugo ends the interview: the scorecard, ratings, the recap
// It writes <dir>/timeline.json, <dir>/report.json (each step's pass/fail with what the product showed), the raw recordings in
// <dir>/raw, Milo's voice frames in <dir>/assistant-voice.jsonl, stops what it started, then runs interviews-film-compose.py to
// write <dir>/interviews-call.mp4.
//
// Options: --rehearse (stops after the join: no Milo, no spend), --record-only (no compose), --compose-only (reuse <dir>/timeline.json), --voices <dir> (the output of
// interviews-film-voices.py: takes.json and the takes; required to record), --max-minutes <n> (Milo's listening ceiling, default 8).
// Env: IVFILM_MEDIA_ADMIN_TOKEN and IVFILM_SINK_SECRET (the media server's ADMIN_TOKEN and LIVE_CAPTIONS_SHARED_SECRET; required),
// IVFILM_MEDIA_URL (http://127.0.0.1:3911), IVFILM_VIDEO_PUBLIC_URL (http://localhost:3911), IVFILM_PLATFORM_PUBLIC_URL
// (http://localhost:23011), IVFILM_PLATFORM_INTERNAL_URL (http://127.0.0.1:23011, Milo's channel lookup), IVFILM_DYNAMODB (http://127.0.0.1:8011, the chat store), IVFILM_MW_PORT (4180), IVFILM_PORTAL_PORT
// (5280), IVFILM_SOCIAL_SETTINGS (optional: the social profile's .scratch/social-documents/settings.json, for document grants),
// FILM_ENV_IS_COPY=1 (middleware/.env is a copy made for this run; removed once the middleware has read it).
//
// The stack (nothing here starts or stops it): a redis, a DynamoDB Local with the realtime tables, a platform-api container
// with VIDEO_API_URL/VIDEO_PUBLIC_URL at the media server and LOBBY_AUTHORITY_URL at http://host.docker.internal:<mw port>/api/
// realtime/lobby-access, and the media server (live-video-streaming, `node src/server.js`) with its own PORT, WEB_PORT, REDIS_URL,
// MEDIASOUP_RTC_PORT/MEDIASOUP_RTC_TCP_PORT and LIVE_CAPTIONS_ORIGIN=http://127.0.0.1:<mw port>. A second media server must not
// share another one's redis (they would join one cluster) or ports.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const OUT = flag('--out') ?? process.env.FILM_OUT;
if (!OUT) { console.error('usage: interviews-call-film.mjs --out <dir> --voices <dir> [--record-only | --compose-only] [--max-minutes <n>]'); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });
const COMPOSE = path.join(ROOT, 'scripts', 'demo', 'interviews-film-compose.py');
const FINAL = path.join(OUT, 'interviews-call.mp4');
const py = (...a) => new Promise((resolve) => spawn('python3', [COMPOSE, ...a], { stdio: 'inherit' }).on('exit', (c) => resolve(c ?? 1)));
if (args.includes('--compose-only')) process.exit(await py('compose', '--out', OUT, '--final', FINAL));

const MW_PORT = Number(process.env.IVFILM_MW_PORT || 4180);
const PORTAL_PORT = Number(process.env.IVFILM_PORTAL_PORT || 5280);
const PORTAL = `http://localhost:${PORTAL_PORT}`;
const MIDDLEWARE = `http://127.0.0.1:${MW_PORT}`;
const MAX_MINUTES = Number(flag('--max-minutes') ?? 8);
const IV = 'iv-k1p5w8ra';
const HUGO = 'u-hugo';
const GRETA = 'u-greta';
const FIXED_REFUSAL = 'Milo can only find what was said in this interview and where it was said; it does not judge, rate or describe the candidate.';
const TIME_LINE = /(minutes? (are|is) left|minutes long|end of its time)/i;
const CANDIDATE_CODE = '\nfunction total(entries) {\n  return entries.reduce((sum, e) => sum + e.amount, 0);\n}\n';
// The mock world's runner prints literal values only, so the pasted line logs a literal.
const PASTED = 'console.log("ledger total: 100");';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const need = (k) => { const v = process.env[k]; if (!v) { console.error(`film: set ${k} (see the header)`); process.exit(2); } return v; };

// ── Voices: the kept take of every line, trimmed of leading and trailing silence, 48 kHz mono PCM16 ──
const VOICES = flag('--voices');
if (!VOICES) { console.error('film: --voices <dir> (interviews-film-voices.py output) is required to record'); process.exit(2); }
const takes = JSON.parse(fs.readFileSync(path.join(VOICES, 'takes.json'), 'utf8'));
const AUDIO = path.join(OUT, 'audio');
fs.mkdirSync(AUDIO, { recursive: true });
const CLIPS = {};
for (const [id, t] of Object.entries(takes)) {
  const file = path.join(AUDIO, `${id}.wav`);
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', t.kept.file, '-af',
    'silenceremove=start_periods=1:start_threshold=-50dB,areverse,silenceremove=start_periods=1:start_threshold=-50dB,areverse',
    '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', file]);
  const secs = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]).toString().trim());
  CLIPS[id] = { who: t.who, text: t.text, file, durMs: Math.round(secs * 1000) };
}
console.log(`film: ${Object.keys(CLIPS).length} lines ready`);
if (!fs.existsSync(path.join(OUT, 'media', 'lead.y4m'))) { const c = await py('cameras', '--out', OUT); if (c) process.exit(c); }

// ── The stack: this film's own mock middleware (Milo live, the scripted coach) and portal ──
const answers = (port, host) => new Promise((resolve) => {
  const sock = net.connect({ port, host });
  sock.setTimeout(1000);
  sock.once('connect', () => { sock.destroy(); resolve(true); });
  sock.once('timeout', () => { sock.destroy(); resolve(false); });
  sock.once('error', () => resolve(false));
});
const portFree = async (port) => !(await answers(port, '127.0.0.1')) && !(await answers(port, '::1'));
for (const [port, what] of [[MW_PORT, 'middleware'], [PORTAL_PORT, 'portal']]) {
  if (!(await portFree(port))) { console.error(`port ${port} (${what}) is in use; nothing was started.`); process.exit(2); }
}
if (!fs.existsSync(path.join(ROOT, 'middleware', '.env'))) { console.error('film: middleware/.env (the provider key) is missing'); process.exit(2); }
function devMockEnv() {
  const script = JSON.parse(fs.readFileSync(path.join(ROOT, 'middleware', 'package.json'), 'utf8')).scripts['dev:mock'];
  const env = {};
  for (const tok of script.split(/\s+/)) { const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(tok); if (!m) break; env[m[1]] = m[2].replace(/^\$\{[A-Z_]+:-(.*)\}$/, '$1'); }
  return env;
}
function documentEnv() {
  const f = process.env.IVFILM_SOCIAL_SETTINGS;
  if (!f) return {};
  const s = JSON.parse(fs.readFileSync(f, 'utf8'));
  return { DOCUMENT_GRANT_ISSUER: s.issuer, DOCUMENT_GRANT_KEY_ID: s.keyId, DOCUMENT_GRANT_PRIVATE_KEY: s.privateKey, DOCUMENT_POLICY_SECRET: s.policySecret };
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
function stopAll() { for (const { child } of started.splice(0)) { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ } } }
process.on('SIGINT', () => { stopAll(); process.exit(130); });
process.on('SIGTERM', () => { stopAll(); process.exit(143); });
async function waitUp(url, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const r = await fetch(url); if (r.status < 500) return true; } catch { /* not yet */ } await sleep(1000); }
  return false;
}
const WORK = path.join(OUT, 'work');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
const dynamo = process.env.IVFILM_DYNAMODB || 'http://127.0.0.1:8011';
start('middleware', process.execPath, [path.join(ROOT, 'middleware', 'node_modules', '.bin', 'tsx'), 'src/index.ts'], path.join(ROOT, 'middleware'), {
  ...devMockEnv(), PORT: String(MW_PORT), VOICE_LOG_DIR: path.join(WORK, 'voice-log'), MOCK_PERSIST_PAIRINGS: '0',
  INSECURE_DEV_MODE: 'true', ...documentEnv(),
  REALTIME_GATEWAY_URL: `http://localhost:${MW_PORT}`,
  // Milo finds the call's media channel through platform-api (by the call's lobby); without it the mock resolver names a channel the
  // media server does not have, and the tap is refused (403).
  SOCIAL_PLATFORM_INTERNAL_URL: process.env.IVFILM_PLATFORM_INTERNAL_URL || 'http://127.0.0.1:23011',
  DOCUMENT_PLATFORM_INTERNAL_URL: process.env.IVFILM_PLATFORM_INTERNAL_URL || 'http://127.0.0.1:23011',
  REALTIME_PLATFORM_PUBLIC_URL: process.env.IVFILM_PLATFORM_PUBLIC_URL || 'http://localhost:23011',
  REALTIME_VIDEO_PUBLIC_URL: process.env.IVFILM_VIDEO_PUBLIC_URL || 'http://localhost:3911',
  SOCIAL_CHAT_DYNAMODB_ENDPOINT: dynamo, DOCUMENT_COMMENT_IMPORT_DYNAMODB_ENDPOINT: dynamo, DOCUMENT_COMMENT_IMPORT_TABLE: 'document-comments',
  MEETING_ASSISTANT_ENABLED: 'true', MEETING_ASSISTANT_LIVE: '1',
  MEETING_ASSISTANT_MAX_MINUTES: String(MAX_MINUTES), MEETING_ASSISTANT_HARD_MAX_MINUTES: String(MAX_MINUTES),
  MEETING_ASSISTANT_TRACE_FILE: path.join(WORK, 'trace.jsonl'),
  MEETING_ASSISTANT_MEDIA_URL: process.env.IVFILM_MEDIA_URL || 'http://127.0.0.1:3911',
  MEETING_ASSISTANT_MEDIA_ADMIN_TOKEN: need('IVFILM_MEDIA_ADMIN_TOKEN'),
  MEETING_ASSISTANT_SINK_BASE_URL: MIDDLEWARE, MEETING_ASSISTANT_SINK_SECRET: need('IVFILM_SINK_SECRET'),
  // No Bedrock: the coach is scripted (the preload); anything else that reaches for it is refused by these keys.
  AWS_ACCESS_KEY_ID: 'film-blocks-bedrock', AWS_SECRET_ACCESS_KEY: 'film-blocks-bedrock', AWS_EC2_METADATA_DISABLED: 'true',
  NODE_OPTIONS: `--require ${path.join(ROOT, 'scripts', 'meeting-assistant', 'lib', 'deadman.cjs')} --import ${pathToFileURL(path.join(ROOT, 'scripts', 'demo', 'film-scripted-coach.mjs')).href}`,
  MA_DEADMAN_MS: String(25 * 60_000),
  FILM_COACH_MODULE: path.join(ROOT, 'middleware', 'src', 'lib', 'interviews', 'coach', 'model.ts'),
}, path.join(WORK, 'middleware.log'));
start('portal', process.execPath, [path.join(ROOT, 'scripts', 'journeys', 'journey-vite.mjs'), '--port', String(PORTAL_PORT)], path.join(ROOT, 'portal'), {
  VITE_GATEWAY_URL: `http://localhost:${MW_PORT}`, API_PROXY_TARGET: MIDDLEWARE,
}, path.join(WORK, 'portal.log'));
const mwUp = await waitUp(`${MIDDLEWARE}/api/health`, 180_000);
if (process.env.FILM_ENV_IS_COPY === '1') fs.rmSync(path.join(ROOT, 'middleware', '.env'), { force: true });
if (!(mwUp && await waitUp(`${PORTAL}/`, 180_000))) { console.error('film: the stack did not come up; see work/*.log'); stopAll(); process.exit(2); }
// A hard ceiling on the whole take, whatever happens below.
const ceiling = setTimeout(() => { console.error('film: hard timeout (20 min)'); stopAll(); process.exit(3); }, 20 * 60_000);

const req = createRequire(path.join(ROOT, 'portal', 'package.json'));
const pw = await import(pathToFileURL(req.resolve('playwright')).href);
const chromium = pw.chromium ?? pw.default.chromium;
const { joinCall, synced, padText, outputText, letSound, suggestion, padTab, chooseLanguage } = await import('../journeys/interviews/h8-room.mjs');
const { rateAllUI, openRecapStep } = await import('../journeys/interviews/h4-kit.mjs');

// ── The record: timeline (for the edit) and report (for the verdict) ──
const VIEW = { width: 1280, height: 800 };
const timeline = { size: VIEW, videos: {}, film: { fromMs: null, toMs: null }, scenes: [], speech: [], labels: { lead: 'Hugo Marchetti (lead)', cand: 'Mateo Alvarez' } };
const report = { startedAt: new Date().toISOString(), interview: IV, steps: [], spend: null, notes: [] };
const step = (id, ok, detail) => { report.steps.push({ id, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${id}: ${detail}`); };
const note = (s) => { report.notes.push(s); console.log(`note: ${s}`); };
const scene = (n, title, caption) => { timeline.scenes.push({ n, title, caption, atMs: Date.now() }); console.log(`scene ${n}: ${title}`); };
const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const until = async (fn, ms, every = 400) => { const end = Date.now() + ms; for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() > end) return null; await sleep(every); } };

// ── The people: one Chromium each (the fake camera is per process), recorded, with a playable microphone ──
const RAW = path.join(OUT, 'raw');
fs.rmSync(RAW, { recursive: true, force: true });
const browsers = [];
const MIC = () => {
  // The page's microphone is a WebAudio stream; window.__filmSay(url) plays a clip into it and resolves when it ends. The camera
  // stays Chromium's fake device (the still y4m). Nothing else on the page changes.
  const md = navigator.mediaDevices;
  if (!md?.getUserMedia) return;
  const original = md.getUserMedia.bind(md);
  let ac = null; let dest = null;
  const ensure = () => { if (!ac) { ac = new AudioContext({ sampleRate: 48000 }); dest = ac.createMediaStreamDestination(); } return dest; };
  md.getUserMedia = async (c) => {
    if (!c?.audio) return original(c);
    const video = c.video ? await original({ video: c.video }) : null;
    const track = ensure().stream.getAudioTracks()[0].clone();
    return new MediaStream([...(video ? video.getVideoTracks() : []), track]);
  };
  window.__filmSay = async (url) => {
    const d = ensure();
    await ac.resume();
    const buf = await ac.decodeAudioData(await (await fetch(url)).arrayBuffer());
    const src = ac.createBufferSource();
    src.buffer = buf;
    src.connect(d);
    return new Promise((resolve) => { src.onended = () => resolve(buf.duration); src.start(); });
  };
};
async function person(key, userId) {
  const b = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required',
    `--use-file-for-fake-video-capture=${path.join(OUT, 'media', `${key}.y4m`)}`] });
  browsers.push(b);
  const context = await b.newContext({ viewport: VIEW, recordVideo: { dir: path.join(RAW, key), size: VIEW }, permissions: ['camera', 'microphone', 'clipboard-read', 'clipboard-write'] });
  if (userId) { const r = await context.request.post(`${PORTAL}/api/session/login`, { data: { userId } }); if (r.status() !== 200) throw new Error(`login ${userId}: ${r.status()}`); }
  for (const k of ['orgiq.call-prejoin.v1', 'interviews.guest-prejoin.v1']) await context.addInitScript(([kk]) => { try { localStorage.setItem(kk, JSON.stringify({ micOn: true, cameraOn: true, remember: true })); } catch { /* none */ } }, [k]);
  await context.addInitScript(MIC);
  await context.route(`${PORTAL}/__film-audio/**`, (route) => route.fulfill({ path: path.join(AUDIO, path.basename(new URL(route.request().url()).pathname)), contentType: 'audio/wav' }));
  const page = await context.newPage();
  timeline.videos[key] = { startMs: Date.now(), file: null };
  const p = { key, context, page, api: context.request, errors: [] };
  page.on('pageerror', (e) => p.errors.push(e.message.slice(0, 160)));
  return p;
}
/** Plays a line into its speaker's microphone; resolves when the clip ends. */
const busy = { until: 0 };
async function say(p, id, gapMs = 1800) {
  const wait = busy.until + gapMs - Date.now();
  if (wait > 0) await sleep(wait);
  const c = CLIPS[id];
  const atMs = Date.now();
  timeline.speech.push({ id, who: c.who, text: c.text, file: path.relative(OUT, c.file), atMs, durMs: c.durMs });
  busy.until = atMs + c.durMs;
  console.log(`  ${c.who}: ${c.text}`);
  await p.page.evaluate((u) => window.__filmSay(u), `${PORTAL}/__film-audio/${id}.wav`).catch((e) => note(`line ${id} did not play: ${String(e).slice(0, 120)}`));
  busy.until = Date.now();
}
// Milo's voice, as the candidate's browser receives it (frames with arrival times; the edit places them). busy.until covers it.
const voiceLog = fs.createWriteStream(path.join(OUT, 'assistant-voice.jsonl'));
const milo = { frames: 0, utterances: 0, cur: null };
function keepMiloVoice(page) {
  page.on('websocket', (ws) => ws.on('framereceived', ({ payload }) => {
    if (typeof payload !== 'string' || !payload.includes('assistant-audio')) return;
    let f; try { f = JSON.parse(payload); } catch { return; }
    if (f?.type !== 'assistant-audio' || typeof f.data?.pcm !== 'string') return;
    const now = Date.now();
    milo.frames += 1;
    // One utterance runs while the frames follow each other (same run, next seq) until one says it is the last.
    const c = milo.cur;
    if (!c || c.done || c.runId !== f.data.runId || f.data.seq !== c.seq + 1) { milo.cur = { runId: f.data.runId, seq: f.data.seq, startMs: now, ms: 0, done: false }; milo.utterances += 1; }
    const u = milo.cur;
    u.seq = f.data.seq;
    u.done = f.data.last === true;
    u.ms += (Buffer.from(f.data.pcm, 'base64').length / 2 / (f.data.sampleRate || 24000)) * 1000;
    busy.until = Math.max(busy.until, u.startMs + u.ms);
    voiceLog.write(`${JSON.stringify({ atMs: now, runId: f.data.runId, seq: f.data.seq, sampleRate: f.data.sampleRate, last: f.data.last === true, pcm: f.data.pcm })}\n`);
  }));
}
/** Waits until Milo has said something new (an utterance after `n`) and finished it. → true when he did. */
async function miloSays(n, ms) {
  const heard = await until(async () => milo.utterances > n, ms, 300);
  if (!heard) return false;
  await until(async () => Date.now() > busy.until + 300, 60_000, 300);
  return true;
}

let lead; let cand; let greta; let callId = null;
try {
  // The recruiter makes the link by the API only (no browser, nothing recorded).
  greta = { api: await (pw.request ?? pw.default.request).newContext() };
  if ((await greta.api.post(`${PORTAL}/api/session/login`, { data: { userId: GRETA } })).status() !== 200) throw new Error('login the recruiter');
  lead = await person('lead', HUGO);
  lead.page.on('request', (rq) => { const m = /\/api\/calls\/([^/?]+)\//.exec(new URL(rq.url()).pathname); if (m && !callId && m[1] !== 'null') callId = decodeURIComponent(m[1]); });
  const hp = lead.page;

  // 1. Hugo opens the room and starts the call.
  await hp.goto(`${PORTAL}/interviews/rounds/${IV}/room`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await hp.getByTestId('interview-room').first().waitFor({ timeout: 60_000 });
  await hp.waitForTimeout(2500);
  timeline.film.fromMs = Date.now() - 1500;
  scene(1, 'The lead starts the call', 'Hugo Marchetti opens the design round\'s room and starts the call. The recruiter makes the candidate\'s invite link.');
  await joinCall(hp);
  const live1 = await until(async () => ((await (await lead.api.get(`${PORTAL}/api/interviews/interviews/${IV}`)).json()).interview?.state === 'live' ? true : null), 20_000, 1000);
  const inv = await greta.api.post(`${PORTAL}/api/interviews/interviews/${IV}/invite`, { data: {} });
  const link = (await inv.json().catch(() => ({}))).linkPath;
  step('1 lead starts the call', !!live1 && !!link, `interview live=${!!live1}; invite ${inv.status()} link=${!!link}`);
  if (!link) throw new Error('no invite link');

  // 2. The candidate's door: answers, device check, waiting room; Hugo admits; the candidate joins.
  cand = await person('cand', null);
  keepMiloVoice(cand.page);
  const cp = cand.page;
  scene(2, 'The candidate joins', 'The candidate opens the link (no account), answers yes to recording, transcript and Milo, checks devices and waits. Hugo admits them.');
  await cp.goto(`${PORTAL}${link}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await cp.getByTestId('join-continue').click({ timeout: 30_000 }).catch(() => undefined);
  await cp.getByTestId('join-consents').waitFor({ timeout: 30_000 });
  for (const part of ['recording', 'transcription', 'milo']) { await cp.getByTestId(`join-consent-${part}-choice`).locator('label').filter({ hasText: /^Yes$/ }).click(); await cp.waitForTimeout(400); }
  await cp.getByTestId('join-consents-continue').click();
  await cp.getByTestId('join-devices').waitFor({ timeout: 30_000 });
  await cp.waitForTimeout(2500);
  await cp.getByTestId('join-devices-continue').click();
  await cp.getByTestId('join-waiting').first().waitFor({ timeout: 30_000 }).catch(() => undefined);
  const admit = hp.getByTestId('interview-room-ask').getByRole('button', { name: /^Admit$/ }).first();
  await admit.waitFor({ timeout: 30_000 });
  await hp.waitForTimeout(800);
  await admit.click();
  await cp.getByTestId('join-room').first().waitFor({ timeout: 30_000 });
  const join = cp.getByTestId('join-room-bar-start').or(cp.getByTestId('join-room-bar-join')).first();
  await join.waitFor({ timeout: 30_000 });
  for (let i = 0; i < 40 && await join.isDisabled(); i++) await sleep(250);
  await join.click();
  const now = cp.getByRole('button', { name: 'Join now', exact: true });
  if (await now.first().waitFor({ timeout: 10_000 }).then(() => true, () => false)) await now.first().click();
  await cp.getByTestId('join-room-time-left').first().waitFor({ timeout: 30_000 });
  const cams = async (pg) => pg.evaluate(() => [...document.querySelectorAll('video')].filter((v) => v.videoWidth > 0 && v.readyState >= 2).length).catch(() => 0);
  const tiles = await until(async () => ((await cams(hp)) >= 2 && (await cams(cp)) >= 2 ? true : null), 30_000, 1000);
  if (args.includes('--rehearse')) await hp.waitForTimeout(8000);
  step('2 both in the call with cameras', !!tiles, `live camera tiles: lead ${await cams(hp)}, candidate ${await cams(cp)}`);

  if (args.includes('--rehearse')) throw new Error('rehearsal: stops after the join (Milo is never invited, nothing is spent)');
  // 3. Milo in, voice on; greeting and a project question; the candidate's answer.
  scene(3, 'Milo joins; the opening', 'Hugo invites Milo (the live model) and turns its voice on, greets the candidate and asks about a project they are proud of.');
  await hp.getByTestId('assistant-invite').first().click({ timeout: 15_000 });
  await hp.getByTestId('assistant-budget-ask').getByRole('button', { name: /go ahead/i }).click({ timeout: 4000 }).catch(() => undefined);
  await until(async () => callId, 10_000);
  const A = (rest) => `${PORTAL}/api/calls/${encodeURIComponent(callId)}/assistant/${rest}`;
  const listening = await until(async () => ((await (await lead.api.get(A('state'))).json()).state === 'listening' ? true : null), 30_000, 1000);
  const invitedAt = Date.now();
  await hp.getByTestId('assistant-status-mark').first().click({ timeout: 10_000 }).catch(() => undefined);
  await hp.getByRole('menuitem', { name: /Turn Milo's voice on/ }).click({ timeout: 10_000 }).catch(() => undefined);
  const voiceOn = await until(async () => ((await (await lead.api.get(A('state'))).json()).voice === true ? true : null), 10_000, 500);
  if (!voiceOn) { const r = await lead.api.post(A('voice'), { data: { on: true } }); note(`voice on from the footer did not take; by the API ${r.status()}`); }
  for (const pg of [hp, cp]) await letSound(pg);
  await hp.waitForTimeout(3000);
  await say(lead, 'h1'); await say(lead, 'h2');
  await say(cand, 'c1'); await say(cand, 'c2');
  await say(lead, 'h3');
  // Milo must be hearing the call by now; if not, he is let go at once (nothing more to spend) and the rest of the story runs.
  const heardLines = await until(async () => { const l = (await (await lead.api.get(A('transcript?limit=50'))).json()).lines ?? []; return l.length ? l : null; }, 15_000, 1500);
  if (!heardLines) { note(`Milo heard nothing (state ${JSON.stringify(await (await lead.api.get(A('state'))).json().catch(() => ({}))).slice(0, 200)}); dismissed to stop the spend`); await lead.api.post(A('dismiss'), { data: {} }); }
  step('3 Milo listening, voice on', !!listening, `Milo listening=${!!listening}; voice on from the footer=${!!voiceOn}; call ${callId}`);

  // 4. The coach's suggestion; Have Milo ask; Milo reads it aloud.
  scene(4, 'Milo suggests; Milo asks', 'Milo\'s suggestion arrives in Hugo\'s footer (only he sees it). He presses "Have Milo ask" and Milo reads the question aloud to both.');
  const deck = await suggestion(hp, 150_000);
  let asked = { deck: deck ?? '', said: null, receipt: false, candQ: '', spoken: false };
  if (deck) {
    await hp.waitForTimeout(1500);
    const n0 = milo.utterances;
    await hp.getByTestId('interview-room-ask').getByRole('button', { name: /have milo ask/i }).click();
    asked.receipt = !!(await until(async () => /Milo asked it aloud/.test(await hp.locator('body').innerText()) ? true : null, 20_000, 500));
    asked.candQ = squash(await until(async () => (await cp.getByTestId('guest-milo-question').first().innerText().catch(() => '')).trim() || null, 20_000) ?? '');
    asked.spoken = await miloSays(n0, 30_000);
  }
  step('4 Have Milo ask, read aloud', !!deck && asked.receipt && asked.spoken && !!asked.candQ,
    `suggestion "${squash(deck).slice(0, 120)}"; receipt=${asked.receipt}; Milo spoke=${asked.spoken} (utterances ${milo.utterances}); candidate's Milo line "${asked.candQ.slice(0, 100)}"`);

  const miloPosts = async () => ((await (await lead.api.get(`${PORTAL}/api/calls/${encodeURIComponent(callId)}/chat?limit=100`)).json().catch(() => ({}))).messages ?? [])
    .filter((m) => String(m.metadata?.kind ?? '').startsWith('assistant')).map((m) => squash(m.message ?? m.text ?? ''));
  // 5. The candidate asks Milo to repeat the question, then how much time is left.
  scene(5, 'The candidate asks Milo', '"Milo, can you repeat the question?" Milo repeats the approved question. "Milo, how much time is left?" Milo answers from the round\'s clock.');
  const posts0 = (await miloPosts()).length;
  let n1 = milo.utterances;
  await say(cand, 'c3', 2500);
  const repeated = await miloSays(n1, 25_000);
  if (!repeated) note('Milo did not say the repeated question aloud within 25 s (see work/trace.jsonl: voice.approved withheld/timeout)');
  const repeatPosts = (await miloPosts()).slice(posts0);
  const repeatLine = repeatPosts.find((t) => asked.candQ && t.includes(asked.candQ.slice(0, 40))) ?? '';
  await sleep(Math.max(0, busy.until + 11_000 - Date.now()));  // a request inside 10 s of Milo's last answer gets the "just answered" line
  n1 = milo.utterances;
  await say(cand, 'c4', 0);
  const timeSpoken = await miloSays(n1, 30_000);
  const timeLine = await until(async () => (await miloPosts()).find((t) => TIME_LINE.test(t)) ?? null, 8000, 800) ?? '';
  await say(cand, 'c7');
  step('5a repeat the question', repeated && !!repeatLine, `Milo spoke=${repeated}; Milo's post "${repeatLine.slice(0, 120)}"; Milo's posts since: ${JSON.stringify(repeatPosts.map((t) => t.slice(0, 60)))}`);
  step('5b how much time is left', timeSpoken && !!timeLine, `Milo spoke=${timeSpoken}; Milo's post "${timeLine.slice(0, 100)}"`);

  // 6. Hugo asks Milo privately: "Should we hire them?" → the fixed sentence.
  scene(6, 'Ask Milo: "Should we hire them?"', 'Hugo asks Milo privately whether to hire. Milo refuses with its fixed sentence: it only finds what was said; it never judges the candidate.');
  await hp.getByTestId('interview-room-pane-tab-milo').click({ timeout: 10_000 });
  const box = hp.getByRole('textbox', { name: 'Your question for Milo' });
  await box.waitFor({ timeout: 15_000 });
  await box.pressSequentially('Should we hire them?', { delay: 45 });
  await hp.getByTestId('interview-room-tab-milo').getByRole('button', { name: 'Ask', exact: true }).click();
  const refusal = squash(await until(async () => { const t = squash(await hp.getByTestId('interview-room-milo-answer').first().innerText().catch(() => '')); return t.includes(FIXED_REFUSAL) ? t : null; }, 20_000, 500) ?? await hp.getByTestId('interview-room-milo-answer').first().innerText().catch(() => ''));
  await hp.waitForTimeout(4000);
  const candBody = squash(await cp.locator('body').innerText());
  step('6 hire question refused', refusal.includes(FIXED_REFUSAL) && !candBody.includes('Should we hire'), `answer "${refusal.slice(0, 140)}"; on the candidate's page: ${candBody.includes('Should we hire')}`);

  // 7. The pad: Hugo inserts the question; the candidate types, pastes and runs.
  scene(7, 'The coding pad', 'Hugo drops the round\'s question into the shared pad. The candidate types a function, pastes a line and runs it; both panes show the run.');
  await say(lead, 'h4');
  await padTab(hp); await padTab(cp);
  const sync = (await synced(hp)) && (await synced(cp));
  await chooseLanguage(hp, 'JavaScript').catch((e) => note(`language: ${String(e).slice(0, 100)}`));
  await hp.waitForTimeout(800);
  await hp.getByTestId('interview-pad-insert').click({ timeout: 8000 });
  await hp.getByRole('menuitem').first().click({ timeout: 5000 });
  await hp.waitForTimeout(1500);
  const qSeen = await until(async () => ((await padText(cp)) ?? '').length > 20 ? true : null, 10_000);
  const c6 = say(cand, 'c6');
  await cp.getByTestId('interview-pad').first().locator('.cm-content').click();
  await cp.keyboard.press('ControlOrMeta+End');
  await cp.keyboard.type(CANDIDATE_CODE, { delay: 35 });
  await cp.evaluate((t) => navigator.clipboard.writeText(t), PASTED).catch((e) => note(`clipboard: ${String(e).slice(0, 80)}`));
  await cp.keyboard.press('ControlOrMeta+V');
  await cp.waitForTimeout(800);
  if (!((await padText(cp)) ?? '').includes('ledger total')) { note('the paste did not land; the line was typed instead'); await cp.keyboard.type(PASTED, { delay: 20 }); }
  await c6;
  const leadSees = await until(async () => ((await padText(hp)) ?? '').includes('ledger total') ? true : null, 10_000);
  await cp.getByTestId('interview-pad-run').click();
  const runC = await until(async () => { const t = await outputText(cp); return /ledger total/.test(t) && /Finished/i.test(t) ? t : null; }, 30_000);
  const runL = await until(async () => { const t = await outputText(hp); return /ledger total/.test(t) ? t : null; }, 20_000);
  await hp.waitForTimeout(3000);
  step('7 pad synced and run', sync && !!qSeen && !!leadSees && !!runC && !!runL,
    `both synced=${sync}; question in the candidate's pad=${!!qSeen}; lead sees the candidate's code=${!!leadSees}; run on the candidate "${squash(runC ?? await outputText(cp)).slice(0, 80)}"; on the lead=${!!runL}`);

  // 8. End, scorecard, recap.
  scene(8, 'End: scorecard and recap', 'Hugo ends the interview. The candidate sees the ended page; Hugo lands on the scorecard, rates and opens Milo\'s recap (every statement sourced).');
  await say(lead, 'h5');
  await hp.waitForTimeout(1500);
  // Milo's listening, for the spend estimate (the state closes with the call).
  const st = await (await lead.api.get(A('state'))).json().catch(() => ({}));
  const listenedS = st.listeningSeconds ?? Math.round((Date.now() - invitedAt) / 1000);
  await hp.getByTestId('interview-end').click();
  await hp.getByTestId('interview-room-ask').getByRole('button', { name: /^End interview$/ }).click({ timeout: 10_000 });
  const endedAt = Date.now();
  const candEnded = await cp.getByTestId('join-ended').first().waitFor({ timeout: 30_000 }).then(() => true, () => false);
  await hp.waitForURL(new RegExp(`/interviews/rounds/${IV}/scorecard$`), { timeout: 20_000 }).catch(() => undefined);
  const onScorecard = /\/scorecard$/.test(new URL(hp.url()).pathname);
  if (!onScorecard) await hp.goto(`${PORTAL}/interviews/rounds/${IV}/scorecard`, { waitUntil: 'domcontentloaded' });
  await hp.getByTestId('interviews-scorecard-form').first().waitFor({ timeout: 30_000 });
  const rated = await rateAllUI(hp, 3).catch(() => 0);
  await hp.waitForTimeout(1200);
  await openRecapStep(hp).catch((e) => note(`recap step: ${String(e).slice(0, 120)}`));
  const recapOk = await hp.getByTestId('interviews-recap-competency').first().waitFor({ timeout: 90_000 }).then(() => true, () => false);
  const claims = hp.getByTestId('interviews-recap-claim');
  const nClaims = await claims.count();
  if (nClaims) { await claims.first().click().catch(() => undefined); await hp.waitForTimeout(1500); }
  await hp.waitForTimeout(4000);
  timeline.film.toMs = Date.now();
  const ivState = (await (await lead.api.get(`${PORTAL}/api/interviews/interviews/${IV}`)).json()).interview?.state;
  step('8 end, scorecard, recap', ivState === 'ended' && candEnded && rated > 0 && recapOk,
    `state ${ivState}; candidate ended page=${candEnded}; lead landed on the scorecard=${onScorecard}; ${rated} ratings; recap opened=${recapOk} with ${nClaims} statements`);

  // The product's record: the transcript's lines and speakers, Milo's chat lines, the spend.
  const rec = (await (await lead.api.get(`${PORTAL}/api/interviews/interviews/${IV}/record`)).json().catch(() => ({}))).record ?? {};
  const lines = rec.transcript?.lines ?? [];
  const sides = lines.reduce((m, l) => ({ ...m, [l.side ?? 'none']: (m[l.side ?? 'none'] ?? 0) + 1 }), {});
  report.transcript = lines.map((l) => ({ seq: l.seq, side: l.side ?? null, speaker: l.speakerName ?? l.speaker ?? l.userId ?? null, text: l.text }));
  const hugoCredited = lines.some((l) => l.side === 'panel' && /project|kick things off|thanks so much for joining/i.test(l.text));
  const candCredited = lines.some((l) => l.side === 'candidate' && /checkout|queue|retries|dropping orders/i.test(l.text))
    && lines.some((l) => l.side === 'candidate' && /idempotency|failover/i.test(l.text));
  const wrong = lines.filter((l) => (l.side === 'candidate' && /kick things off|thanks so much for joining/i.test(l.text)) || (l.side === 'panel' && /checkout service|dropping orders/i.test(l.text))).length;
  step('T transcript, two speakers credited', hugoCredited && candCredited && wrong === 0, `lines ${lines.length} by side ${JSON.stringify(sides)}; Hugo credited=${hugoCredited}; candidate credited=${candCredited}; wrongly credited ${wrong}`);
  step('M Milo spoke', milo.utterances >= 2, `${milo.utterances} utterances, ${milo.frames} voice frames received by the candidate's browser`);
  const spend = (await (await greta.api.get(`${PORTAL}/api/spend/entries?period=month&limit=200`)).json().catch(() => ({}))).entries ?? [];
  const mine = spend.filter((e) => JSON.stringify(e).includes(callId ?? '---'));
  const usd = mine.reduce((s, e) => s + Number(e.costUsd ?? e.amountUsd ?? e.usd ?? 0), 0);
  report.spend = { listeningSeconds: listenedS, entries: mine.length, entriesUsd: Number(usd.toFixed(4)), estimateUsd: Number(((listenedS / 3600) * 3).toFixed(4)), basis: mine.length ? 'spend entries' : 'listening minutes x $3/h' };
  report.call = { callId, endedAt: new Date(endedAt).toISOString(), filmSeconds: Math.round((timeline.film.toMs - timeline.film.fromMs) / 1000) };
  report.pageErrors = [...lead.errors, ...cand.errors].slice(0, 20);
} catch (e) {
  step('X the take', false, `stopped: ${String(e?.stack ?? e).split('\n').slice(0, 2).join(' ')}`);
  if (!timeline.film.toMs) timeline.film.toMs = Date.now();
} finally {
  await greta?.api.dispose().catch(() => undefined);
  for (const p of [lead, cand].filter(Boolean)) {
    await p.context.close().catch(() => undefined);
    if (timeline.videos[p.key]) timeline.videos[p.key].file = path.relative(OUT, (await p.page.video()?.path().catch(() => null)) ?? '');
  }
  await Promise.all(browsers.map((b) => b.close().catch(() => undefined)));
  voiceLog.end();
  fs.writeFileSync(path.join(OUT, 'timeline.json'), JSON.stringify(timeline, null, 1));
  report.passed = report.steps.filter((s) => s.ok).length;
  report.failed = report.steps.filter((s) => !s.ok).length;
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 1));
  stopAll();
  clearTimeout(ceiling);
}
console.log(`film: report ${report.passed} passed, ${report.failed} failed; spend ${JSON.stringify(report.spend)}`);
if (args.includes('--record-only')) process.exit(0);
process.exit(await py('compose', '--out', OUT, '--final', FINAL));

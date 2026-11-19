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
// stays on the mock world's scripted stand-in (the product setting INTERVIEWS_COACH_MODEL=scripted), so no Bedrock is called.
//
// The story, on the seeded round iv-k1p5w8ra (Hugo leads; the candidate is the mock world's Mateo Alvarez). Before the call Hugo
// chooses Two Sum (q-be-twosum) through Prepare's own route. Every step is the product's own code path; the only stand-in is the
// coach's model (INTERVIEWS_COACH_MODEL=scripted, in place of Bedrock). Code runs for real (INTERVIEWS_RUN_BACKEND=docker).
//   0 Hugo chooses Two Sum (PUT /interviews/:id/questions)            1 Hugo starts the call; the recruiter makes the link
//   2 the candidate's door, Hugo admits; both in the call              3 Milo in, voice on; small talk; experience with DSA
//   4 the coach's first suggestion (the chosen question): "I'll ask it"; Hugo sets Two Sum; the pad on Java ("pick whatever you
//     like"); the candidate picks Python in the pad's language menu; Hugo inserts the question: the Python starter on both sides
//   5 a clarifying question; brute force named; the hash map typed with narration; "Milo, how much time is left?" mid-coding
//   6 Run: the duplicate case prints [0, 0]; the candidate moves one line; Run: [0, 1]; both panes show each run
//   7 the complexity question (the coach's suggestion of it, if shown, taken as "I'll ask it")
//   8 the coach's next follow-up, "How would you test this function?": "Have Milo ask", Milo says it; "Milo, can you repeat the
//     question?" right after; the candidate's test cases
//   9 Hugo asks Milo "Should we hire them?" privately: the fixed sentence        10 questions for me, next steps, goodbye
//  11 End; the scorecard; the recap (its Problem solving evidence quotes the Two Sum and testing answers); the pad log
// It writes <dir>/timeline.json, <dir>/report.json (each step's pass/fail with what the product showed), the raw recordings in
// <dir>/raw, Milo's voice frames in <dir>/assistant-voice.jsonl, stops what it started, then runs interviews-film-compose.py to
// write <dir>/interviews-call.mp4.
//
// Options: --rehearse (the whole story with Milo never invited: no spend; lines without a take wait their estimated length),
//   --scripted (with --rehearse: Milo IS invited, on the mock world's scripted session instead of the provider; each line is
//   handed to it as heard text when its clip ends, so Milo's tools and their timing run for real at no spend), --record-only (no compose), --compose-only (reuse <dir>/timeline.json), --voices <dir> (the output of
// interviews-film-voices.py: takes.json and the takes; required to record), --max-minutes <n> (Milo's listening ceiling, default 12).
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
import { spawn, spawnSync, execFileSync } from 'node:child_process';
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

// A take needs the machine awake for its whole length: one that slept on battery dropped both browsers and ended the call. Refuse to start
// on battery, and hold the system, display and disk awake (caffeinate -dimsu) until this process exits.
if (process.platform === 'darwin') {
  const power = execFileSync('pmset', ['-g', 'batt']).toString();
  if (!/'AC Power'/.test(power)) { console.error(`film: refusing to start on battery (pmset: ${power.split('\n')[0]}); plug the machine in`); process.exit(2); }
  spawn('caffeinate', ['-dimsu', '-w', String(process.pid)], { stdio: 'ignore', detached: true }).unref();
}

const MW_PORT = Number(process.env.IVFILM_MW_PORT || 4180);
const PORTAL_PORT = Number(process.env.IVFILM_PORTAL_PORT || 5280);
const PORTAL = `http://localhost:${PORTAL_PORT}`;
const MIDDLEWARE = `http://127.0.0.1:${MW_PORT}`;
const MAX_MINUTES = Number(flag('--max-minutes') ?? 12);
const IV = 'iv-k1p5w8ra';
const HUGO = 'u-hugo';
const GRETA = 'u-greta';
const FIXED_REFUSAL = 'Milo can only find what was said in this interview and where it was said; it does not judge, rate or describe the candidate.';
const TIME_LINE = /(minutes? (are|is) left|minutes long|end of its time)/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const need = (k) => { const v = process.env[k]; if (!v) { console.error(`film: set ${k} (see the header)`); process.exit(2); } return v; };

// ── Voices: the kept take of every line, trimmed of leading and trailing silence, levelled to LINE_LUFS, 48 kHz mono PCM16 ──
// Every line at one loudness: the takes came out between -16 and -27 LUFS (Hugo's quieter), and the edit used to even that out
// with one dynamic loudness filter over the whole mix, which rode the gain up through the film's first minute.
const LINE_LUFS = -16;
const loudness = (file) => {
  const r = spawnSync('ffmpeg', ['-nostats', '-hide_banner', '-i', file, '-af', 'ebur128', '-f', 'null', '-'], { encoding: 'utf8' });
  const m = /I:\s+(-?[\d.]+) LUFS\s*\n\s*Threshold/.exec(r.stderr ?? '') ?? /I:\s+(-?[\d.]+) LUFS/.exec((r.stderr ?? '').split('Summary:').pop() ?? '');
  return m ? Number(m[1]) : null;
};
const VOICES = flag('--voices');
if (!VOICES && !args.includes('--rehearse')) { console.error('film: --voices <dir> (interviews-film-voices.py output) is required to record'); process.exit(2); }
const takes = VOICES ? JSON.parse(fs.readFileSync(path.join(VOICES, 'takes.json'), 'utf8')) : {};
const LINES = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'demo', 'interviews-film-lines.json'), 'utf8')).lines;
const AUDIO = path.join(OUT, 'audio');
fs.mkdirSync(AUDIO, { recursive: true });
const CLIPS = {};
for (const [id, t] of Object.entries(takes)) {
  const file = path.join(AUDIO, `${id}.wav`);
  const trimmed = path.join(AUDIO, `${id}.trim.wav`);
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', t.kept.file, '-af',
    'silenceremove=start_periods=1:start_threshold=-50dB,areverse,silenceremove=start_periods=1:start_threshold=-50dB,areverse',
    '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', trimmed]);
  const lufs = loudness(trimmed);
  const gain = lufs === null ? 0 : Math.max(-12, Math.min(14, LINE_LUFS - lufs));
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', trimmed, '-af', `volume=${gain.toFixed(2)}dB,alimiter=limit=0.89:level=disabled`, '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', file]);
  fs.rmSync(trimmed, { force: true });
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
  MEETING_ASSISTANT_ENABLED: 'true', ...(args.includes('--scripted') ? {} : { MEETING_ASSISTANT_LIVE: '1' }),
  // The pad's runs execute for real: the developer's Docker runner, one throwaway container per run, no network.
  INTERVIEWS_RUN_BACKEND: 'docker',
  MEETING_ASSISTANT_MAX_MINUTES: String(MAX_MINUTES), MEETING_ASSISTANT_HARD_MAX_MINUTES: String(MAX_MINUTES),
  MEETING_ASSISTANT_TRACE_FILE: path.join(WORK, 'trace.jsonl'),
  MEETING_ASSISTANT_MEDIA_URL: process.env.IVFILM_MEDIA_URL || 'http://127.0.0.1:3911',
  MEETING_ASSISTANT_MEDIA_ADMIN_TOKEN: need('IVFILM_MEDIA_ADMIN_TOKEN'),
  MEETING_ASSISTANT_SINK_BASE_URL: MIDDLEWARE, MEETING_ASSISTANT_SINK_SECRET: need('IVFILM_SINK_SECRET'),
  // No Bedrock: the coach is scripted (the preload); anything else that reaches for it is refused by these keys.
  AWS_ACCESS_KEY_ID: 'film-blocks-bedrock', AWS_SECRET_ACCESS_KEY: 'film-blocks-bedrock', AWS_EC2_METADATA_DISABLED: 'true',
  NODE_OPTIONS: `--require ${path.join(ROOT, 'scripts', 'meeting-assistant', 'lib', 'deadman.cjs')}`,
  MA_DEADMAN_MS: String(25 * 60_000),
  INTERVIEWS_COACH_MODEL: 'scripted',
}, path.join(WORK, 'middleware.log'));
start('portal', process.execPath, [path.join(ROOT, 'scripts', 'journeys', 'journey-vite.mjs'), '--port', String(PORTAL_PORT)], path.join(ROOT, 'portal'), {
  VITE_GATEWAY_URL: `http://localhost:${MW_PORT}`, API_PROXY_TARGET: MIDDLEWARE,
}, path.join(WORK, 'portal.log'));
const mwUp = await waitUp(`${MIDDLEWARE}/api/health`, 180_000);
if (process.env.FILM_ENV_IS_COPY === '1') fs.rmSync(path.join(ROOT, 'middleware', '.env'), { force: true });
if (!(mwUp && await waitUp(`${PORTAL}/`, 180_000))) { console.error('film: the stack did not come up; see work/*.log'); stopAll(); process.exit(2); }
// A hard ceiling on the whole take, whatever happens below.
const ceiling = setTimeout(() => { console.error('film: hard timeout (30 min)'); stopAll(); process.exit(3); }, 30 * 60_000);

const req = createRequire(path.join(ROOT, 'portal', 'package.json'));
const pw = await import(pathToFileURL(req.resolve('playwright')).href);
const chromium = pw.chromium ?? pw.default.chromium;
const { joinCall, synced, padText, outputText, letSound, suggestion, padTab, chooseLanguage } = await import('../journeys/interviews/h8-room.mjs');
const { rateAllUI, openRecapStep } = await import('../journeys/interviews/h4-kit.mjs');

// ── The record: timeline (for the edit) and report (for the verdict) ──
const VIEW = { width: 1280, height: 800 };
const timeline = { size: VIEW, videos: {}, film: { fromMs: null, toMs: null }, scenes: [], cuts: [], speech: [], labels: { lead: 'Hugo Marchetti (lead)', cand: 'Mateo Alvarez' } };
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
  // A second of silence through the stream before the first line (the first line no longer wakes the context and the encoder).
  window.__filmWarm = async () => {
    const d = ensure();
    await ac.resume();
    const src = ac.createBufferSource();
    src.buffer = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
    src.connect(d);
    await new Promise((resolve) => { src.onended = resolve; src.start(); });
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
  await context.addInitScript(CURSOR);
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
  const c = CLIPS[id] ?? (LINES[id] ? { who: LINES[id][0], text: LINES[id][1], file: null, durMs: 900 + 62 * LINES[id][1].length } : null);
  if (!c) throw new Error(`no line ${id}`);
  const atMs = Date.now();
  timeline.speech.push({ id, who: c.who, text: c.text, file: c.file ? path.relative(OUT, c.file) : null, atMs, durMs: c.durMs });
  busy.until = atMs + c.durMs;
  console.log(`  [${timeline.film.fromMs ? ((atMs - timeline.film.fromMs) / 1000).toFixed(1) : '-'}] ${c.who}: ${c.text}`);
  if (!c.file) await sleep(c.durMs); // a rehearsal without this take: its estimated length
  else await p.page.evaluate((u) => window.__filmSay(u), `${PORTAL}/__film-audio/${id}.wav`).catch((e) => note(`line ${id} did not play: ${String(e).slice(0, 120)}`));
  busy.until = Date.now();
  await heardByScript(p, c.text);
}
/**
 * --scripted: the scripted session hears no audio, so the line is handed to it as heard text when its clip ends (the dev
 * injector, the mock world only), as the provider would hear it.
 */
const scriptedEar = { on: false, guestId: null };
async function heardByScript(p, text) {
  if (!scriptedEar.on || !callId) return;
  let userId = HUGO;
  if (p === cand) {
    scriptedEar.guestId ??= (await (await cand.api.get(`${PORTAL}/api/interview-invite/room`)).json().catch(() => ({}))).room?.self?.userId ?? null;
    userId = scriptedEar.guestId;
  }
  if (!userId) { note('scripted: no guest user id; line not heard'); return; }
  const r = await lead.api.post(`${PORTAL}/api/dev/calls/${encodeURIComponent(callId)}/transcript-lines`, { data: { userId, text } }).catch(() => null);
  if (!r || r.status() >= 300) note(`scripted: line not heard (${r ? r.status() : 'no answer'})`);
}
// Milo's voice, as the candidate's browser receives it (frames with arrival times; the edit places them). busy.until covers it.
const voiceLog = fs.createWriteStream(path.join(OUT, 'assistant-voice.jsonl'));
const milo = { frames: 0, utterances: 0, cur: null, lastStartMs: 0 };
timeline.milo = [];
function keepMiloVoice(page) {
  page.on('websocket', (ws) => ws.on('framereceived', ({ payload }) => {
    if (typeof payload !== 'string' || !payload.includes('assistant-audio')) return;
    let f; try { f = JSON.parse(payload); } catch { return; }
    if (f?.type !== 'assistant-audio' || typeof f.data?.pcm !== 'string') return;
    const now = Date.now();
    milo.frames += 1;
    // One utterance runs while the frames follow each other (same run, next seq) until one says it is the last.
    const c = milo.cur;
    if (!c || c.done || c.runId !== f.data.runId || f.data.seq !== c.seq + 1) { milo.cur = { runId: f.data.runId, seq: f.data.seq, startMs: now, ms: 0, done: false }; milo.utterances += 1; milo.lastStartMs = now; timeline.milo.push(milo.cur); }
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

// ── The pad, as the candidate types in it (CodeMirror: every keystroke a real edit, reported as theirs) ──
const QUESTION_ID = 'q-be-twosum';
// The first attempt stores the number before it checks for its complement: the duplicate case ([3, 3], 6) finds itself.
const BUGGY_BODY = [
  '    seen = {}',
  '    for i, n in enumerate(nums):',
  '        seen[n] = i',
  '        if target - n in seen:',
  '            return [seen[target - n], i]',
  '    return []',
];
const SECOND_CASE = 'print(two_sum([3, 3], 6))';
/** The line Milo adds at the top of the pad when Hugo asks for it (the Milo-features lane's pad tool). */
const LRU_IMPORT = 'from functools import lru_cache';
/** The marker of Milo's test-case block at the bottom of the pad (lib/interviews/testcases/render.ts). */
const CASES_BLOCK = /# --- Test cases from Milo \((\d+)\) ---/;
const MOVED_LINE = '        seen[n] = i';
const padOf = (page) => page.getByTestId('interview-pad').first();
/**
 * Scrolls the pad's editor to its last line over `ms` (0: at once), by the element that really scrolls (the editor draws only the
 * lines in view, so lines below the fold are not in the page until it does).
 */
async function padToEnd(page, ms) {
  const t0 = Date.now();
  const from = await padOf(page).locator('.cm-content').first().evaluate((el) => {
    let n = el;
    while (n && !(n.scrollHeight > n.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(n).overflowY))) n = n.parentElement;
    if (!n) return null;
    n.dataset.filmScroller = '1';
    return n.scrollTop;
  }).catch(() => null);
  if (from === null) return;
  const scroller = page.locator('[data-film-scroller="1"]').first();
  for (;;) {
    const t = ms > 0 ? Math.min(1, (Date.now() - t0) / ms) : 1;
    const e = t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2;
    await scroller.evaluate((el, [a, f]) => { el.scrollTop = a + f * (el.scrollHeight - el.clientHeight - a); }, [from, e]).catch(() => undefined);
    if (t >= 1) break;
    await sleep(40);
  }
}
const padLanguage = (page) => padOf(page).getByTestId('interview-pad-language').first()
  .evaluate((e) => {
    // The library's Select is a combobox button carrying its value in data-value; its native form is a <select>.
    if (e instanceof HTMLSelectElement) return e.value || null;
    return e.getAttribute('data-value') || null;
  }, undefined, { timeout: 5000 }).catch((e) => { note(`pad language read: ${String(e).split('\n')[0].slice(0, 140)}`); return null; });
const padLines = async (page) => ((await padText(page)) ?? '').split('\n');
async function focusPadEnd(page) {
  await padOf(page).locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+End');
}
/** The caret onto the line `index` of the pad, counting up from the end (the code at the bottom is short lines: no wrapping). */
async function caretToLine(page, index) {
  const lines = await padLines(page);
  await page.keyboard.press('ControlOrMeta+End');
  for (let k = lines.length - 1; k > index; k -= 1) await page.keyboard.press('ArrowUp');
}
/** Types one line as a person does; the editor's own indentation after Enter is replaced by the line's. */
async function typeLine(page, text, first = false) {
  if (!first) { await page.keyboard.press('Enter'); await page.keyboard.press('Shift+Home'); }
  await page.keyboard.type(text, { delay: 55 });
}
/** The starter's `pass` replaced by the body, typed line by line. */
async function replaceStarterBody(page, body) {
  await focusPadEnd(page);
  const lines = await padLines(page);
  await caretToLine(page, lines.lastIndexOf('    pass'));
  await page.keyboard.press('End');
  await page.keyboard.press('Shift+Home');
  for (let i = 0; i < body.length; i += 1) await typeLine(page, i === 0 ? body[i].trimStart() : body[i], i === 0);
}
async function typeAtEnd(page, text) {
  await focusPadEnd(page);
  const last = (await padLines(page)).at(-1) ?? '';
  if (last.trim()) await page.keyboard.press('Enter');
  await page.keyboard.type(text, { delay: 55 });
}
/** The fix: the line that stores the number goes below the check (deleted where it was, typed again after the return). */
async function moveSeenAfterReturn(page) {
  await focusPadEnd(page); // the Run button had the focus
  const lines = await padLines(page);
  const at = lines.indexOf(MOVED_LINE);
  if (at < 0) { note('the fix: the line to move is not in the pad'); return; }
  await caretToLine(page, at);
  await page.keyboard.press('End');
  await page.keyboard.press('Shift+Home'); await page.keyboard.press('Shift+Home');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await sleep(500);
  const now = await padLines(page);
  await caretToLine(page, now.findIndex((l) => l.trimStart().startsWith('return [seen')));
  await page.keyboard.press('End');
  await typeLine(page, MOVED_LINE);
}
/** Run from the candidate's side; both output panes read, and the product's own run containers counted (docker events, bounded). */
async function runAndRead(cp, hp, want) {
  const since = Math.floor(Date.now() / 1000) - 1;
  const [was, wasLead] = [await outputText(cp), await outputText(hp)];
  await press(cp, cp.getByTestId('interview-pad-run'));
  // This run's output only: the pane still shows the last run's until the new one lands.
  const candOut = await until(async () => { const t = await outputText(cp); return t !== was && want.test(t) && /Finished/i.test(t) ? t : null; }, 60_000);
  const leadOut = await until(async () => { const t = await outputText(hp); return t !== wasLead && want.test(t) ? t : null; }, 20_000);
  await sleep(600);
  let containers = 0;
  try {
    containers = execFileSync('docker', ['events', '--since', String(since), '--until', String(Math.floor(Date.now() / 1000)), '--filter', 'label=interviews.run=1', '--filter', 'event=start', '--format', '{{.Actor.Attributes.name}}'], { timeout: 15_000 })
      .toString().split('\n').filter((n) => /^iv-run-[0-9a-f]{16}$/.test(n)).length;
  } catch (e) { note(`docker events: ${String(e).slice(0, 100)}`); }
  return { cand: candOut, lead: leadOut, lastCand: await outputText(cp), containers };
}

// ── The coach's suggestion in Hugo's footer ──
const deckOf = (page) => page.getByTestId('interview-room-ask');
const deckShown = async (page) => ((await deckOf(page).getByRole('button', { name: /have milo ask/i }).isVisible().catch(() => false)) ? squash(await deckOf(page).innerText()) : null);
const OPTION = { ask: /^I.ll ask it$/i, 'milo-ask': /have milo ask/i, skip: /^Skip$/ };
/** A suggestion matching `re`, answered with `option` (within `ms`); → its text, or null when none came. */
async function answerSuggestion(page, re, option, ms) {
  const text = await until(async () => { const t = await deckShown(page); return t && re.test(t) ? t : null; }, ms, 700);
  if (!text) return null;
  await press(page, deckOf(page).getByRole('button', { name: OPTION[option] }).first(), { pause: 600 }).catch((e) => note(`suggestion ${option}: ${String(e).slice(0, 80)}`));
  return text;
}
/** Waits for a suggestion matching `re`; any other one shown meanwhile is skipped, as a lead would. → its text, or null. */
async function waitSuggestion(page, re, ms) {
  return until(async () => {
    const t = await deckShown(page);
    if (!t) return null;
    if (re.test(t)) return t;
    note(`skipped the suggestion "${t.slice(0, 80)}"`);
    await deckOf(page).getByRole('button', { name: OPTION.skip }).first().click().catch(() => undefined);
    return null;
  }, ms, 1500);
}
// The call chat's read takes at most 100 messages (routes/call-chat.ts); a refused read is noted, never read as "no posts".
const miloPosts = async () => {
  const r = await lead.api.get(`${PORTAL}/api/calls/${encodeURIComponent(callId)}/chat?limit=100`);
  if (!r.ok()) { note(`call chat read answered ${r.status()}`); return []; }
  return ((await r.json().catch(() => ({}))).messages ?? [])
    .filter((m) => String(m.metadata?.kind ?? '').startsWith('assistant')).map((m) => squash(m.message ?? m.text ?? ''));
};

// ── What the viewer sees each person do: a soft cursor that travels to a control, rests on it, then presses it ──
// A film overlay injected into these two browsers only (it follows the mouse and ignores it); the product's pages are not changed.
const CURSOR = () => {
  const put = () => {
    if (document.getElementById('__film-cursor')) return;
    const c = document.createElement('div');
    c.id = '__film-cursor';
    c.setAttribute('aria-hidden', 'true');
    Object.assign(c.style, {
      position: 'fixed', left: '-40px', top: '-40px', width: '24px', height: '24px', marginLeft: '-12px', marginTop: '-12px', borderRadius: '50%',
      background: 'rgba(245, 158, 11, 0.30)', border: '2px solid rgba(245, 158, 11, 0.95)', boxShadow: '0 0 16px 7px rgba(245, 158, 11, 0.45)',
      pointerEvents: 'none', zIndex: '2147483647', transition: 'transform 140ms ease-out',
    });
    document.documentElement.appendChild(c);
    addEventListener('mousemove', (e) => { c.style.left = `${e.clientX}px`; c.style.top = `${e.clientY}px`; }, true);
    addEventListener('mousedown', () => { c.style.transform = 'scale(0.65)'; }, true);
    addEventListener('mouseup', () => { c.style.transform = 'scale(1)'; }, true);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', put); else put();
};
const cursorAt = new Map();
/**
 * Moves the cursor to (x, y) at a hand's pace (eased, `ms` long), from where it last was. Paced by the clock, not by a step count:
 * a recording browser can take 100 ms or more to deliver one mouse move, so a fixed count of steps took ten times as long.
 */
async function moveTo(page, x, y, ms = 700) {
  const [x0, y0] = cursorAt.get(page) ?? [VIEW.width * 0.55, VIEW.height * 0.85];
  const t0 = Date.now();
  for (;;) {
    const t = Math.min(1, (Date.now() - t0) / ms); const e = t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2;
    await page.mouse.move(x0 + (x - x0) * e, y0 + (y - y0) * e);
    if (t >= 1) break;
    await sleep(16);
  }
  cursorAt.set(page, [x, y]);
}
/** The cursor to the middle of `locator`, then a rest of `pause` ms (reading it). False when it has no box. */
async function glide(page, locator, { pause = 450, ms = 700 } = {}) {
  const t0 = Date.now();
  // Short waits: a control that keeps animating never counts as stable, and a long wait here was silent film.
  await locator.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => undefined);
  const t1 = Date.now();
  const box = await locator.boundingBox({ timeout: 3000 }).catch(() => null);
  const t2 = Date.now();
  if (!box) { note(`glide: no box for ${String(locator).slice(0, 90)} (${t2 - t0} ms)`); return false; }
  await moveTo(page, box.x + box.width / 2, box.y + Math.min(box.height / 2, 28), ms);
  const t3 = Date.now();
  if (t3 - t0 > ms + 1500) console.log(`  slow glide ${String(locator).slice(0, 80)}: view ${t1 - t0} box ${t2 - t1} move ${t3 - t2} ms`);
  await page.waitForTimeout(pause);
  return true;
}
/** The cursor travels to the control and rests on it, then it is pressed. */
async function press(page, locator, { pause = 450, timeout = 30_000 } = {}) {
  const t0 = Date.now();
  await locator.waitFor({ timeout });
  const t1 = Date.now();
  await glide(page, locator, { pause });
  const t2 = Date.now();
  await locator.click({ timeout });
  const t3 = Date.now();
  if (t3 - t0 > 3000) console.log(`  slow press ${String(locator).slice(0, 80)}: wait ${t1 - t0} glide ${t2 - t1} click ${t3 - t2} ms`);
  // No look at the control after the click: it is often gone (the step moved on), and waiting for it was 30 s of silent film.
}
/** Reads a scrolling block: the cursor rests on it and the wheel takes it down to its end over about `ms`. */
async function scrollThrough(page, locator, ms = 4000) {
  if (!(await glide(page, locator, { pause: 500 }))) return;
  // Scrolled by the clock (smooth behaviour, a slice at a time): the page's own scroll, not the wheel, which a recording browser
  // can deliver slowly.
  const t0 = Date.now();
  for (;;) {
    const t = Math.min(1, (Date.now() - t0) / ms);
    await locator.evaluate((el, f) => { el.scrollTop = f * Math.max(0, el.scrollHeight - el.clientHeight); }, t).catch(() => undefined);
    if (t >= 1) break;
    await sleep(60);
  }
  await page.waitForTimeout(500);
}
/** Hugo starts (or joins) the room's call from the footer, as h8-room.mjs `joinCall` does, with the cursor. */
async function startCall(page) {
  const start = page.getByTestId('shell-footer-context-start').or(page.getByTestId('shell-footer-context-join')).first();
  await start.waitFor({ timeout: 30_000 });
  await until(async () => !(await start.isDisabled()), 20_000);
  await press(page, start);
  const confirm = page.getByRole('dialog').getByRole('button', { name: /join|start|continue/i }).last();
  if (await confirm.waitFor({ timeout: 3000 }).then(() => true, () => false)) await press(page, confirm);
  // The interview turning live is the caller's check; the dock is only waited for briefly.
  await page.getByTestId('shell-call-dock').first().waitFor({ timeout: 3000 }).catch(() => undefined);
}
/** The page's microphone stream runs a second of silence before its first line, so that line is not the one that wakes it. */
/** A timing mark in the log (film seconds), for finding silent stretches in a rehearsal. */
const mark = (label) => console.log(`  [${timeline.film.fromMs ? ((Date.now() - timeline.film.fromMs) / 1000).toFixed(1) : '-'}] · ${label}`);
async function warmMic(p) { await p.evaluate(() => window.__filmWarm?.()).catch((e) => note(`mic warm-up: ${String(e).slice(0, 80)}`)); }
/**
 * A stretch where nothing happens on screen (a page loading, the call connecting, the coach's 90-second pace, the recap being
 * written): the edit cuts it and shows "Skipping ahead". Call the result when the wait is over. Never used around anything Milo
 * says or is asked (interviews-film-compose.py also keeps every cut clear of speech and of Milo's voice): Milo's latency is shown
 * as it was.
 */
function skipFrom(caption) {
  const fromMs = Date.now();
  return () => { const toMs = Date.now(); if (toMs - fromMs > 2500) timeline.cuts.push({ fromMs: fromMs + 700, toMs: toMs - 700, caption }); };
}

let lead; let cand; let greta; let callId = null;
const REHEARSE = args.includes('--rehearse');
// Milo is invited in a take, and in a rehearsal on the scripted session.
const SCRIPTED = args.includes('--scripted');
const MILO = !REHEARSE || SCRIPTED;
try {
  // The recruiter makes the link by the API only (no browser, nothing recorded).
  greta = { api: await (pw.request ?? pw.default.request).newContext() };
  if ((await greta.api.post(`${PORTAL}/api/session/login`, { data: { userId: GRETA } })).status() !== 200) throw new Error('login the recruiter');
  lead = await person('lead', HUGO);
  lead.page.on('request', (rq) => { const m = /\/api\/calls\/([^/?]+)\//.exec(new URL(rq.url()).pathname); if (m && !callId && m[1] !== 'null') callId = decodeURIComponent(m[1]); });
  const hp = lead.page;

  // 0. Before the day (not filmed): Hugo prepares the round with Two Sum, through Prepare's own route.
  const ivRow = (await (await lead.api.get(`${PORTAL}/api/interviews/interviews/${IV}`)).json()).interview;
  const prep = await lead.api.put(`${PORTAL}/api/interviews/interviews/${IV}/questions`, { data: { revision: ivRow.revision, questionIds: [QUESTION_ID] } });
  const chosen = ((await prep.json().catch(() => ({}))).interview?.questionsChosen ?? []).map((q) => q.id);
  step('0 Two Sum chosen in Prepare', prep.status() === 200 && chosen.join() === QUESTION_ID, `PUT questions ${prep.status()}; chosen ${JSON.stringify(chosen)}`);

  // 1. Hugo's Prepare (the Coding round, Two Sum chosen), then the room; he starts the call.
  await hp.goto(`${PORTAL}/interviews/rounds/${IV}/prepare`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await hp.getByTestId('interviews-prepare').first().waitFor({ timeout: 60_000 });
  await hp.waitForTimeout(1500);
  timeline.film.fromMs = Date.now() - 800;
  scene(1, 'Hugo prepares and starts the call', 'Hugo checks the Coding round in Prepare (Two Sum is the chosen question), opens the room and starts the call. The recruiter makes the candidate\'s invite link.');
  const prepText = squash(await hp.getByTestId('interviews-prepare').first().innerText().catch(() => ''));
  step('1p Prepare shows the Coding round with Two Sum', /Coding/.test(prepText) && /array of integers/i.test(prepText), `Prepare reads "${prepText.slice(0, 160)}"`);
  const checking = say(lead, 'h27', 300);
  await glide(hp, hp.getByTestId('interviews-prepare').getByText(/array of integers/i).first(), { pause: 1400 });
  await checking;
  await press(hp, hp.getByTestId('interviews-prepare-room').first());
  await hp.getByTestId('interview-room').first().waitFor({ timeout: 60_000 });
  const roomHead = squash(await hp.getByTestId('interview-room').first().innerText().catch(() => '')).slice(0, 400);
  const h00 = say(lead, 'h00', 0);
  await startCall(hp);
  await h00;
  // Nothing happens on screen while the call goes live, the recruiter sends the link and the candidate's browser opens it: cut, and
  // say so.
  const cutLink = skipFrom('Skipping ahead: the recruiter sends the link and the candidate opens it');
  const live1 = await until(async () => ((await (await lead.api.get(`${PORTAL}/api/interviews/interviews/${IV}`)).json()).interview?.state === 'live' ? true : null), 20_000, 1000);
  const inv = await greta.api.post(`${PORTAL}/api/interviews/interviews/${IV}/invite`, { data: {} });
  const link = (await inv.json().catch(() => ({}))).linkPath;
  step('1 lead starts the call', !!live1 && !!link && /Coding/.test(roomHead), `interview live=${!!live1}; invite ${inv.status()} link=${!!link}; the room says Coding=${/Coding/.test(roomHead)}`);
  if (!link) throw new Error('no invite link');

  // 2. The candidate's door at a person's pace: the notice read, each question answered by the candidate (nothing is pre-selected),
  // the device check, the waiting room; Hugo admits; the candidate joins.
  cand = await person('cand', null);
  keepMiloVoice(cand.page);
  const cp = cand.page;
  await cp.goto(`${PORTAL}${link}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  const firstStep = await Promise.any(['join-interview', 'join-consents'].map((id) => cp.getByTestId(id).first().waitFor({ timeout: 30_000 }).then(() => id))).catch(() => null);
  await cp.waitForTimeout(600);
  cutLink();
  scene(2, 'Before you begin', 'The candidate opens the link (no account). Nothing is chosen for them: they read the notice, answer each question themselves, check camera and microphone, and wait. Hugo admits them.');
  if (firstStep === 'join-interview') {
    const invite = say(cand, 'p00', 200);
    await glide(cp, cp.getByTestId('join-interview').first(), { pause: 600 });
    await invite;
    await press(cp, cp.getByTestId('join-continue').first());
  }
  await cp.getByTestId('join-consents').waitFor({ timeout: 30_000 });
  const radiosChecked = () => cp.evaluate(() => [...document.querySelectorAll('[data-testid="join-questions"] input[type="radio"]')].filter((r) => r.checked).length).catch(() => -1);
  const fresh = await radiosChecked();
  const reading = say(cand, 'p01', 300);
  await scrollThrough(cp, cp.getByTestId('join-notice').first(), 5000);
  await reading;
  // The three questions as they first show, with no answer chosen, held a moment before the first one is read.
  await glide(cp, cp.getByTestId('join-questions').first(), { pause: 800 });
  // Each question read aloud while the cursor goes to it; Yes pressed as the line ends.
  for (const [part, line] of [['recording', 'p02'], ['transcription', 'p03'], ['milo', 'p04']]) {
    const read = say(cand, line, 150);
    await glide(cp, cp.getByTestId(`join-consent-${part}`).locator('p').first(), { pause: 300 });
    await read;
    await press(cp, cp.getByTestId(`join-consent-${part}-choice`).locator('label').filter({ hasText: /^Yes$/ }).first(), { pause: 300 });
    await cp.waitForTimeout(250);
  }
  step('2a nothing pre-selected', fresh === 0 && (await radiosChecked()) === 3, `radios checked when the questions first showed: ${fresh}; after the candidate's three answers: ${await radiosChecked()}`);
  await press(cp, cp.getByTestId('join-consents-continue'));
  await cp.getByTestId('join-devices').waitFor({ timeout: 30_000 });
  const devices = say(cand, 'p05', 150);
  await glide(cp, cp.getByTestId('join-devices').first(), { pause: 600 });
  await devices;
  await press(cp, cp.getByTestId('join-devices-continue'));
  await cp.getByTestId('join-waiting').first().waitFor({ timeout: 30_000 }).catch(() => undefined);
  const admit = hp.getByTestId('interview-room-ask').getByRole('button', { name: /^Admit$/ }).first();
  // The lead's room reads the waiting room every few seconds: the candidate says so while Hugo's Admit arrives.
  await say(cand, 'p06', 500);
  await admit.waitFor({ timeout: 30_000 });
  const bringIn = say(lead, 'h01', 500);
  await glide(hp, admit, { pause: 200 });
  await bringIn;
  await press(hp, admit, { pause: 150 });
  mark('admitted');
  await cp.getByTestId('join-room').first().waitFor({ timeout: 30_000 });
  mark('candidate room');
  const joining = say(cand, 'p07', 200);
  const join = cp.getByTestId('join-room-bar-start').or(cp.getByTestId('join-room-bar-join')).first();
  await join.waitFor({ timeout: 30_000 });
  for (let i = 0; i < 40 && await join.isDisabled(); i++) await sleep(250);
  mark('join enabled');
  await press(cp, join);
  mark('join pressed');
  const now = cp.getByRole('button', { name: 'Join now', exact: true });
  // Shown only by some rooms, and at once when it is: a long wait for it was ten seconds of silent film.
  if (await now.first().waitFor({ timeout: 700 }).then(() => true, () => false)) await press(cp, now.first());
  mark('join now done');
  const cutJoin = skipFrom('Skipping ahead: the call connects');
  await cp.getByTestId('join-room-time-left').first().waitFor({ timeout: 30_000 });
  const cams = async (pg) => pg.evaluate(() => [...document.querySelectorAll('video')].filter((v) => v.videoWidth > 0 && v.readyState >= 2).length).catch(() => 0);
  const tiles = await until(async () => ((await cams(hp)) >= 2 && (await cams(cp)) >= 2 ? true : null), 30_000, 1000);
  cutJoin();
  await joining;
  mark('camera tiles');
  step('2 both in the call with cameras', !!tiles, `live camera tiles: lead ${await cams(hp)}, candidate ${await cams(cp)}`);
  // From here until the lead ends the interview, the call must hold: the room's own lost-call notice on either side is a failure the
  // report names with its time (the product says a call dropped in interview-room-call-lost and join-room-call-lost).
  const lostSeen = { lead: null, cand: null };
  const watchLost = setInterval(() => {
    for (const [who, page, id] of [['lead', hp, 'interview-room-call-lost'], ['cand', cp, 'join-room-call-lost']]) {
      if (lostSeen[who] === null) void page.getByTestId(id).first().isVisible().then((v) => { if (v && lostSeen[who] === null) lostSeen[who] = Date.now(); }, () => undefined);
    }
  }, 2000);

  // 3. Milo in, voice on (not in a rehearsal: nothing is spent) while they say good morning; Milo introduces itself; small talk.
  scene(3, 'Good morning, and Milo says hello', 'Hugo invites Milo, the interview\'s AI support, and turns its voice on. Milo introduces itself aloud; then small talk and data structures and algorithms.');
  let A = null;
  // Milo's state as the product reports it; every read keeps the listening time the product booked (the spend report's only source).
  const booked = { listeningSeconds: null, readStatus: null };
  const miloState = async () => {
    const r = await lead.api.get(A('state'));
    booked.readStatus = r.status();
    const body = r.ok() ? await r.json().catch(() => ({})) : {};
    if (typeof body.listeningSeconds === 'number') booked.listeningSeconds = body.listeningSeconds;
    return body;
  };
  // The greeting starts as soon as both are in (Hugo's mic has been live since h00; the candidate's is warmed while Hugo speaks);
  // Hugo invites Milo and turns its voice on while they say good morning and he introduces himself (nothing there needs Milo).
  const greeting = (async () => { await say(lead, 'h02', 300); await say(cand, 'c01', 700); })();
  await warmMic(cp);
  for (const pg of [hp, cp]) await letSound(pg);
  mark('mics warm, sound allowed');
  const miloReady = (async () => {
  if (MILO) {
    await press(hp, hp.getByTestId('assistant-invite').first(), { timeout: 15_000 });
    const goAhead = hp.getByTestId('assistant-budget-ask').getByRole('button', { name: /go ahead/i });
    if (await goAhead.waitFor({ timeout: 2000 }).then(() => true, () => false)) await press(hp, goAhead);
    mark('Milo invited');
  }
  if (MILO) {
    await until(async () => callId, 10_000);
    A = (rest) => `${PORTAL}/api/calls/${encodeURIComponent(callId)}/assistant/${rest}`;
    const listening = await until(async () => ((await miloState()).state === 'listening' ? true : null), 30_000, 1000);
    await press(hp, hp.getByTestId('assistant-status-mark').first(), { timeout: 10_000 }).catch(() => undefined);
    await press(hp, hp.getByRole('menuitem', { name: /Turn Milo's voice on/ }), { timeout: 10_000 }).catch(() => undefined);
    const voiceOn = await until(async () => ((await miloState()).voice === true ? true : null), 10_000, 500);
    if (!voiceOn) { const r = await lead.api.post(A('voice'), { data: { on: true } }); note(`voice on from the footer did not take; by the API ${r.status()}`); }
    scriptedEar.on = SCRIPTED && !!listening;
    step('3 Milo listening, voice on', !!listening, `Milo listening=${!!listening}; voice on from the footer=${!!voiceOn}; call ${callId}`);
  }
  })();
  await greeting;
  // Milo's introduction (its fixed words), asked aloud by Hugo once Milo listens with its voice on; the call bar's Introduce Milo
  // button if the words are not taken.
  const nIntro = milo.utterances;
  await say(lead, 'h03', 500);
  await miloReady;
  await say(lead, 'h24', 300);
  const introAt = Date.now();
  let intro = A ? await miloSays(nIntro, 9000) : false;
  let introBy = 'his words';
  if (A && !intro) {
    introBy = 'the Introduce Milo button';
    await press(hp, hp.getByTestId('interview-milo-intro').first(), { timeout: 5000 }).catch((e) => note(`Introduce Milo: ${String(e).slice(0, 100)}`));
    intro = await miloSays(nIntro, 15_000);
  }
  if (A) step('3i Milo introduces itself aloud', intro, `Milo spoke=${intro} (asked by ${introBy}) ${intro ? `${((milo.lastStartMs - introAt) / 1000).toFixed(1)} s after Hugo finished` : ''}`);
  await say(cand, 'c02', 700);
  await say(lead, 'h04', 700); await say(cand, 'c03', 700);
  if (A) {
    const heard = await until(async () => { const l = (await (await lead.api.get(A('transcript?limit=50'))).json()).lines ?? []; return l.length ? l : null; }, 15_000, 1500);
    if (!heard) { note('Milo heard nothing; dismissed to stop the spend'); await lead.api.post(A('dismiss'), { data: {} }); await miloState().catch(() => undefined); A = null; }
  }
  await say(lead, 'h05', 700); await say(cand, 'c04', 700);

  // 4. The coding question, the language, the pad. The coach's first suggestion is the chosen question: Hugo asks it himself.
  // Hugo's reaction (h06) bridges the answer into the problem; the pad and the language are set while he speaks.
  const s1p = answerSuggestion(hp, /array of integers/i, 'ask', 2500);
  const bridge = say(lead, 'h06', 600);
  await sleep(1200);
  scene(4, 'Two Sum, in Python', 'Hugo sets the coding problem. The pad is on Java; the candidate picks Python, so the starter code arrives in Python on both screens.');
  await bridge;
  const s1 = await s1p;
  const padReady = (async () => {
    await padTab(hp); await padTab(cp);
    const ok = !!(await until(async () => ((await synced(hp)) && (await synced(cp))) || null, 20_000, 500));
    await chooseLanguage(hp, 'Java').catch((e) => note(`language Java: ${String(e).slice(0, 100)}`));
    return ok;
  })();
  await say(lead, 'h07', 500);
  const sync = await padReady;
  await say(lead, 'h08', 600);
  await say(cand, 'c05', 600);
  const python = chooseLanguage(cp, 'Python').catch((e) => note(`language Python: ${String(e).slice(0, 100)}`));
  // Hugo inserts the question while he is still talking.
  const h09 = say(lead, 'h09', 500);
  await python;
  await press(hp, hp.getByTestId('interview-pad-insert'), { timeout: 8000 });
  await press(hp, hp.getByRole('menuitem').first(), { timeout: 5000 });
  await h09;
  const langBoth = !!(await until(async () => ((await padLanguage(hp)) === 'python' && (await padLanguage(cp)) === 'python') || null, 10_000, 400));
  const starter = !!(await until(async () => ((await padText(cp)) ?? '').includes('def two_sum(') || null, 10_000, 400));
  step('4 language switch and the question in the pad', sync && langBoth && starter,
    `both synced=${sync}; both read Python=${langBoth} (lead ${await padLanguage(hp)}, candidate ${await padLanguage(cp)}); Python starter in the candidate's pad=${starter}; the coach's first suggestion ${s1 ? `"${s1.slice(0, 80)}" answered I'll ask it` : 'not shown yet'}`);

  // 5. Clarifying question, brute force, the hash map typed with narration; Milo adds an import; the time asked mid-coding.
  scene(5, 'Thinking out loud', 'The candidate asks a clarifying question, names the brute force and types a hash-map solution while explaining it. Hugo asks Milo to add an import; the candidate asks Milo how much time is left.');
  await say(cand, 'c06', 900); await say(lead, 'h10', 600); await say(cand, 'c07', 600);
  const narration = say(cand, 'c08', 600);
  await replaceStarterBody(cp, BUGGY_BODY);
  await narration;
  // Hugo asks Milo for the import (the pad tool: the first line becomes the import, about 2 s after he stops); then he turns on
  // "Candidate can ask Milo" in the pad toolbar while telling Mateo he may ask Milo for more examples. Not "test cases": a lead's line
  // holding "test" counts the coach's "How would you test this function?" as asked (half its content words), and scene 9 loses it.
  await say(cand, 'c26', 600);
  const nImport = milo.utterances;
  await say(lead, 'h23', 600);
  const imported = A ? !!(await until(async () => ((await padText(cp)) ?? '').includes(LRU_IMPORT) || null, 30_000, 500)) : false;
  const importSaid = A ? await miloSays(nImport, 15_000) : false;
  if (A) step('5i Milo adds the import at the top', imported && ((await padLines(cp))[0] ?? '').includes(LRU_IMPORT), `"${LRU_IMPORT}" in the pad=${imported}, first line "${(await padLines(cp))[0] ?? ''}"; Milo said so=${importSaid}`);
  await say(cand, 'c27', 500);
  const helpSwitch = hp.getByTestId('interview-pad-milo-help-switch').first();
  const switched = (async () => { await sleep(900); await press(hp, helpSwitch, { timeout: 10_000 }).catch((e) => note(`pad-help switch: ${String(e).slice(0, 100)}`)); })();
  await say(lead, 'h25', 500);
  await switched;
  const helpOn = await helpSwitch.evaluate((e) => e.getAttribute('aria-checked') ?? e.getAttribute('data-state') ?? String(e.checked ?? '')).catch(() => '?');
  if (A) step('5s Hugo lets the candidate ask Milo', /true|checked|on/.test(helpOn), `the switch reads ${helpOn}`);
  const nT = milo.utterances;
  const posts0 = A ? (await miloPosts()).length : 0;
  await say(cand, 'c09', 900);
  const timeSpoken = A ? await miloSays(nT, 30_000) : false;
  const timeLine = A ? (await until(async () => (await miloPosts()).slice(posts0).find((t) => TIME_LINE.test(t)) ?? null, 8000, 800) ?? '') : '';
  if (A) step('5 how much time is left (mid-coding)', timeSpoken && !!timeLine, `Milo spoke=${timeSpoken}; Milo's post "${timeLine.slice(0, 100)}"`);
  const secondCase = (async () => { await sleep(2600); await typeAtEnd(cp, SECOND_CASE); })();
  await say(cand, 'c10', 600);
  await secondCase;

  // 6. Run: the duplicate case fails; the fix; run again: it passes. Both sides see each run, executed in a real container. The
  // candidate and Hugo talk while each run executes.
  scene(6, 'Run, fail, fix, pass', 'The first run really executes (a throwaway container, no network): the duplicate case returns the same index twice. The candidate swaps two lines and runs again: both pairs are right.');
  const r1 = runAndRead(cp, hp, /\[0, 0\]/);
  await say(cand, 'c11', 500);
  await say(lead, 'h11', 400);
  const run1 = await r1;
  const fix = (async () => { await sleep(4200); await moveSeenAfterReturn(cp); })();
  await say(cand, 'c12', 600);
  await fix;
  const r2 = runAndRead(cp, hp, /\[0, 1\]\s*\[0, 1\]/);
  await say(cand, 'c13', 400);
  await say(lead, 'h12', 300);
  const run2 = await r2;
  await say(cand, 'c14', 500);
  step('6 first run fails the duplicate case', !!run1.cand && !!run1.lead, `candidate "${squash(run1.cand ?? run1.lastCand).slice(0, 120)}"; lead sees it=${!!run1.lead}`);
  step('6b fixed run passes', !!run2.cand && !!run2.lead, `candidate "${squash(run2.cand ?? run2.lastCand).slice(0, 120)}"; lead sees it=${!!run2.lead}`);
  step('R code executed for real', run1.containers > 0 && run2.containers > 0 && !!run1.cand && !!run2.cand,
    `run containers seen: ${run1.containers} and ${run2.containers} (label interviews.run=1); outputs computed by the code ([0, 0] then [0, 1]), which the mock runner (literal prints only) cannot produce`);

  // 7. Another dozen test cases from Milo, run. Milo says "On it." and needs about 6 s: Hugo and Mateo talk through it, and Milo's
  // "Added twelve test cases" waits for them to finish.
  scene(7, 'Milo writes test cases', 'The candidate asks Milo for another dozen test cases. Milo says it is on it, fills the bottom of the pad with them, and the candidate runs them all.');
  const casePosts0 = A ? (await miloPosts()).length : 0;
  await say(cand, 'c15', 900);
  const askedAt = Date.now();
  // The editor draws only the lines in view: the candidate scrolls to the bottom to watch the cases arrive, and stays there.
  const scrolled = padToEnd(cp, 1500);
  let caseCount = null;
  const hasBlock = async () => {
    await padToEnd(cp, 0);
    caseCount = CASES_BLOCK.exec((await padText(cp)) ?? '')?.[1] ?? null;
    return caseCount !== null;
  };
  const filledAt = A ? scrolled.then(() => until(async () => ((await hasBlock()) ? Date.now() : null), 45_000, 400)) : Promise.resolve(null);
  const saidSince = async (re) => (await miloPosts()).slice(casePosts0).some((t) => re.test(t));
  const onIt = A ? !!(await until(async () => (await saidSince(/^On it\b/i)) || null, 4000, 400)) : false;
  await say(lead, 'h26', 500); await say(cand, 'c28', 400);
  const filled = await filledAt;
  const casesSaid = A ? !!(await until(async () => (await saidSince(/^Added \w+ test cases/i)) || null, 15_000, 400)) : false;
  if (casesSaid) await until(async () => Date.now() > busy.until + 300, 20_000, 300);
  if (A) step('7t Milo fills the pad with test cases', !!filled, `the block in the pad=${!!filled} (${caseCount ?? 0} cases)${filled ? ` ${((filled - askedAt) / 1000).toFixed(1)} s after the request` : ''}; "On it." posted=${onIt}; "Added ... test cases" posted=${casesSaid}`);
  if (filled) {
    const r3 = runAndRead(cp, hp, /\bok\b/);
    await say(cand, 'c16', 600);
    await say(lead, 'h13', 400);
    const run3 = await r3;
    await say(cand, 'c17', 500);
    const outText = squash(run3.cand ?? run3.lastCand);
    step('7r the generated cases run', !!run3.cand, `ok ${(outText.match(/\bok\b/g) ?? []).length}, DIFF ${(outText.match(/\bDIFF\b/g) ?? []).length}; candidate "${outText.slice(0, 120)}"`);
  }

  // 8. Complexity (the coach's suggestion of it, if shown, is taken as Hugo's own), then the conversation goes on until Milo's next
  // suggestion arrives (the coach suggests at most one question every 90 s): the sorted-array follow-up and the candidate's work.
  scene(8, 'Complexity', 'Hugo asks for the runtime complexity; the candidate answers, and they talk it through.');
  const s2p = answerSuggestion(hp, /complexity/i, 'ask', 2500);
  await say(lead, 'h14', 700);
  const s2 = await s2p;
  await say(cand, 'c18', 600);
  const testingShown = async () => /test this function/i.test((await deckShown(hp)) ?? '');
  for (const [p, id] of [[lead, 'h15'], [cand, 'c19'], [lead, 'h16'], [cand, 'c20'], [lead, 'h17'], [cand, 'c21']]) {
    if (A && await testingShown()) break;
    await say(p, id, 600);
  }

  // 9. Milo's suggestion keyed to the answers: how would you test it. Hugo reads it, says so and presses Have Milo ask; Milo says it;
  // the candidate asks for the repeat, then answers.
  let testing = { deck: '', spoken: false, receipt: false, candQ: '' }; let repeated = false; let repeatLine = '';
  if (A) {
    const cutCoach = skipFrom('Skipping ahead: Milo suggests at most one question every 90 seconds');
    const deck = await waitSuggestion(hp, /test this function/i, 150_000);
    cutCoach();
    scene(9, 'Milo chimes in', 'A suggestion arrives in Hugo\'s footer (only he sees it): ask how they would test the function. He reads it, presses "Have Milo ask" and Milo says it aloud. The candidate asks Milo to repeat it, then answers.');
    testing.deck = deck ?? '';
    if (deck) {
      const ack = say(lead, 'h18', 200);
      await glide(hp, deckOf(hp).first(), { pause: 400 });
      await ack;
      const n0 = milo.utterances;
      await press(hp, deckOf(hp).getByRole('button', { name: /have milo ask/i }).first());
      const pressedAt = Date.now();
      // The receipt is the product's (interviewsRoom.ts miloAskReceipt): "Milo asked it aloud" when spoken, otherwise its reason.
      const RECEIPT = /Milo asked it aloud|Milo posted the question in the chat \([^)]*\)|Not sent: [^.]*\.|Milo did not say whether it was sent/;
      const receiptP = until(async () => RECEIPT.exec(await hp.locator('body').innerText())?.[0] ?? null, 20_000, 500);
      testing.spoken = await miloSays(n0, 30_000);
      testing.voiceAfterS = testing.spoken ? Number(((milo.lastStartMs - pressedAt) / 1000).toFixed(1)) : null;
      testing.receiptText = (await receiptP) ?? '';
      testing.receipt = testing.receiptText === 'Milo asked it aloud';
      testing.candQ = squash(await until(async () => (await cp.getByTestId('guest-milo-question').first().innerText().catch(() => '')).trim() || null, 20_000) ?? '');
      const p1 = (await miloPosts()).length;
      const n1 = milo.utterances;
      await say(cand, 'c22', 1500);
      repeated = await miloSays(n1, 25_000);
      repeatLine = (await miloPosts()).slice(p1).find((t) => /test this function/i.test(t)) ?? '';
    }
    step('7 coach follow-up keyed to the answers', !!deck, `complexity suggestion ${s2 ? `"${s2.slice(0, 60)}" (I'll ask it)` : 'not shown'}; testing suggestion "${squash(deck).slice(0, 120)}"`);
    step('8 Have Milo ask, read aloud', testing.receipt && testing.spoken && !!testing.candQ, `receipt "${testing.receiptText || 'none shown'}"; Milo spoke=${testing.spoken}${testing.voiceAfterS !== null ? ` ${testing.voiceAfterS} s after the press` : ''}; candidate's Milo line "${testing.candQ.slice(0, 100)}"`);
    step('9 repeat the question, spoken', repeated && !!repeatLine, `Milo spoke=${repeated}; Milo's post "${repeatLine.slice(0, 120)}"`);
  }
  await say(cand, 'c23', 800);

  // 10. Hugo asks Milo privately: "Should we hire them?" → the fixed sentence.
  scene(10, 'Ask Milo: "Should we hire them?"', 'Hugo asks Milo privately whether to hire. Milo refuses with its fixed sentence: it only finds what was said; it never judges the candidate.');
  const notes = say(lead, 'h19', 600);
  if (A) {
    await press(hp, hp.getByTestId('interview-room-pane-tab-milo'), { timeout: 10_000 });
    const box = hp.getByRole('textbox', { name: 'Your question for Milo' });
    await box.waitFor({ timeout: 15_000 });
    await press(hp, box);
    await box.pressSequentially('Should we hire them?', { delay: 45 });
    await press(hp, hp.getByTestId('interview-room-tab-milo').getByRole('button', { name: 'Ask', exact: true }));
    const refusal = squash(await until(async () => { const t = squash(await hp.getByTestId('interview-room-milo-answer').first().innerText().catch(() => '')); return t.includes(FIXED_REFUSAL) ? t : null; }, 20_000, 500) ?? '');
    await notes;
    await say(lead, 'h30', 300);
    const candBody = squash(await cp.locator('body').innerText());
    step('10 hire question refused', refusal.includes(FIXED_REFUSAL) && !candBody.includes('Should we hire'), `answer "${refusal.slice(0, 140)}"; on the candidate's page: ${candBody.includes('Should we hire')}`);
    await padTab(hp);
  }
  await notes;

  // 11. Questions for me, next steps, goodbye; end; scorecard; recap.
  scene(11, 'Wrapping up', 'Hugo asks whether the candidate has questions, explains next steps and ends the interview.');
  await say(lead, 'h20', 700); await say(cand, 'c24', 600); await say(lead, 'h21', 600); await say(cand, 'c25', 600); await say(lead, 'h22', 600);
  await hp.waitForTimeout(600);
  if (A) await miloState().catch((e) => note(`Milo's state at the end: ${String(e).slice(0, 120)}`));
  scene(12, 'Scorecard and recap', 'The candidate sees the ended page; Hugo lands on the scorecard, rates and opens Milo\'s recap: every statement sourced to what the candidate said.');
  await press(hp, hp.getByTestId('interview-end'));
  clearInterval(watchLost);
  const at = (t) => (t === null ? 'never' : `${Math.round((t - timeline.film.fromMs) / 1000)} s into the film`);
  step('C the call held', lostSeen.lead === null && lostSeen.cand === null, `the lead's room said the call dropped: ${at(lostSeen.lead)}; the candidate's page: ${at(lostSeen.cand)}`);
  await press(hp, hp.getByTestId('interview-room-ask').getByRole('button', { name: /^End interview$/ }), { timeout: 10_000 });
  const endedAt = Date.now();
  // Hugo says what he does next while the scorecard opens.
  const scoring = say(lead, 'h28', 300);
  const candEnded = await cp.getByTestId('join-ended').first().waitFor({ timeout: 30_000 }).then(() => true, () => false);
  await hp.waitForURL(new RegExp(`/interviews/rounds/${IV}/scorecard$`), { timeout: 20_000 }).catch(() => undefined);
  const onScorecard = /\/scorecard$/.test(new URL(hp.url()).pathname);
  if (!onScorecard) await hp.goto(`${PORTAL}/interviews/rounds/${IV}/scorecard`, { waitUntil: 'domcontentloaded' });
  await hp.getByTestId('interviews-scorecard-form').first().waitFor({ timeout: 30_000 });
  const rated = await rateAllUI(hp, 3).catch(() => 0);
  await scoring;
  await hp.waitForTimeout(1200);
  await openRecapStep(hp).catch((e) => note(`recap step: ${String(e).slice(0, 120)}`));
  const cutRecap = skipFrom('Skipping ahead: Milo writes the recap');
  const recapOk = await hp.getByTestId('interviews-recap-competency').first().waitFor({ timeout: 90_000 }).then(() => true, () => false);
  cutRecap();
  const claims = hp.getByTestId('interviews-recap-claim');
  const nClaims = await claims.count();
  if (nClaims) { const sourced = say(lead, 'h29', 300); await press(hp, claims.first()).catch(() => undefined); await sourced; await hp.waitForTimeout(600); }
  const recapText = squash(await hp.getByTestId('interviews-scorecard-recap-step').first().innerText().catch(() => ''));
  await hp.waitForTimeout(1500);
  timeline.film.toMs = Date.now();
  const ivState = (await (await lead.api.get(`${PORTAL}/api/interviews/interviews/${IV}`)).json()).interview?.state;
  step('11 end, scorecard', ivState === 'ended' && candEnded && rated > 0, `state ${ivState}; candidate ended page=${candEnded}; lead landed on the scorecard=${onScorecard}; ${rated} ratings`);
  if (A) {
    const recap = (await (await lead.api.get(`${PORTAL}/api/interviews/interviews/${IV}/recap`)).json().catch(() => ({}))).recap ?? {};
    const ps = (recap.competencies ?? []).find((c) => c.id === 'problem-solving');
    const quotes = (ps?.evidence ?? []).map((e) => e.source?.quote ?? '');
    step('12 the recap cites the Two Sum and testing answers', recapOk && !!ps && quotes.some((q) => /hash map|brute force|dictionary|O of n/i.test(q)) && quotes.some((q) => /test|duplicates|negative/i.test(q)) && !/Nothing was said about this/.test(recapText),
      `recap opened=${recapOk}, ${nClaims} statements; problem solving quotes ${JSON.stringify(quotes.map((q) => q.slice(0, 70)))}; not covered ${JSON.stringify((recap.notCovered ?? []).map((c) => c.name))}`);
  }

  // The pad log and the runs, as the lead reads them: the language switch, a snapshot per run, both runs with their output.
  const log = (await (await lead.api.get(`${PORTAL}/api/interviews/interviews/${IV}/pad/log`)).json().catch(() => ({})));
  const evs = log.events ?? [];
  const kinds = evs.reduce((m, e) => ({ ...m, [e.kind]: (m[e.kind] ?? 0) + 1 }), {});
  // The runs as the record keeps them (the live runs list closes with the interview).
  const runs = ((await (await lead.api.get(`${PORTAL}/api/interviews/interviews/${IV}/record`)).json().catch(() => ({}))).record?.runs ?? []);
  step('P the pad log and the runs on the record', evs.some((e) => e.kind === 'language' && e.language === 'python') && (kinds.snapshot ?? 0) >= 2 && runs.length >= 2,
    `pad log kinds ${JSON.stringify(kinds)}; runs ${runs.length} (${runs.map((r) => `${r.status}${r.exitCode !== undefined ? ` exit ${r.exitCode}` : ''}`).join(', ')})`);

  // The product's record: the transcript's lines and speakers, the spend.
  const rec = (await (await lead.api.get(`${PORTAL}/api/interviews/interviews/${IV}/record`)).json().catch(() => ({}))).record ?? {};
  const lines = rec.transcript?.lines ?? [];
  const sides = lines.reduce((m, l) => ({ ...m, [l.side ?? 'none']: (m[l.side ?? 'none'] ?? 0) + 1 }), {});
  report.transcript = lines.map((l) => ({ seq: l.seq, side: l.side ?? null, speaker: l.speakerName ?? l.speaker ?? l.userId ?? null, text: l.text }));
  if (A) {
    const hugoCredited = lines.some((l) => l.side === 'panel' && /data structures|runtime complexity|good morning/i.test(l.text));
    const candCredited = lines.some((l) => l.side === 'candidate' && /hash map|brute force|dictionary/i.test(l.text));
    const wrong = lines.filter((l) => (l.side === 'candidate' && /data structures and algorithms\?|runtime complexity\?/i.test(l.text)) || (l.side === 'panel' && /brute force|dictionary to store/i.test(l.text))).length;
    step('T transcript, two speakers credited', hugoCredited && candCredited && wrong === 0, `lines ${lines.length} by side ${JSON.stringify(sides)}; Hugo credited=${hugoCredited}; candidate credited=${candCredited}; wrongly credited ${wrong}`);
    step('M Milo spoke', milo.utterances >= 3, `${milo.utterances} utterances, ${milo.frames} voice frames received by the candidate's browser`);
  }
  // Never estimated from the wall clock: what the product booked, or unknown (with the last read's status) when it could not be read.
  const listenedS = A === null && booked.listeningSeconds === null ? 0 : booked.listeningSeconds;
  report.spend = listenedS === null
    ? { listeningSeconds: null, estimateUsd: null, basis: `unknown: Milo's state could not be read (last status ${booked.readStatus})` }
    : { listeningSeconds: listenedS, estimateUsd: Number(((listenedS / 3600) * 3).toFixed(4)), basis: "the product's booked listening time x $3/h" };
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
if (args.includes('--record-only') || REHEARSE) process.exit(0);
process.exit(await py('compose', '--out', OUT, '--final', FINAL));

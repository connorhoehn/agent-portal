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
import { miloTurns } from './lib/milo-turns.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const OUT = flag('--out') ?? process.env.FILM_OUT;
if (!OUT) { console.error('usage: interviews-call-film.mjs --out <dir> --voices <dir> [--record-only | --compose-only] [--max-minutes <n>]'); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });
const COMPOSE = path.join(ROOT, 'scripts', 'demo', 'interviews-film-compose.py');
const FINAL = flag('--final') ?? path.join(OUT, 'interviews-call.mp4');
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
// The live path the board film takes (interviews-board-film.mjs): --handsfree (MEETING_ASSISTANT_HANDSFREE=1: people talk to Milo
// by name, the lead may hold the bar's talk button), --turn-owner (MILO_TURN_OWNER=1: the turn owner hears and answers the call),
// --name-required (with --turn-owner: the 20 November coding round, below: Milo acts only on his name or the hold), --barge-on
// (none | cand | hold). IVFILM_KEY_FILE: a file holding OPENAI_API_KEY, read here and handed only to the middleware's environment
// (without it the middleware reads its own middleware/.env, as before).
const HANDSFREE = args.includes('--handsfree');
const TURN_OWNER = HANDSFREE && args.includes('--turn-owner');
const NAME_REQUIRED = TURN_OWNER && args.includes('--name-required');
const BARGE_ON = flag('--barge-on') ?? 'none';
function keyEnv() {
  const f = process.env.IVFILM_KEY_FILE; if (!f) return {};
  const line = fs.readFileSync(f, 'utf8').split('\n').find((l) => /^\s*OPENAI_API_KEY\s*=/.test(l)) ?? '';
  const key = line.replace(/^\s*OPENAI_API_KEY\s*=\s*/, '').trim().replace(/^['"]|['"]$/g, '');
  if (!key) { console.error('film: no provider key in IVFILM_KEY_FILE'); process.exit(2); }
  return { OPENAI_API_KEY: key };
}
const IV = 'iv-k1p5w8ra';
const HUGO = 'u-hugo';
const GRETA = 'u-greta';
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
if (!process.env.IVFILM_KEY_FILE && !fs.existsSync(path.join(ROOT, 'middleware', '.env'))) { console.error('film: middleware/.env (the provider key) is missing'); process.exit(2); }
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
  // The pad's runs execute for real (the developer's Docker runner, one throwaway container per run, no network); not in the
  // --name-required round, which runs no code.
  ...(NAME_REQUIRED ? {} : { INTERVIEWS_RUN_BACKEND: 'docker' }),
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
  ...(HANDSFREE ? { MEETING_ASSISTANT_HANDSFREE: '1' } : {}), MILO_TURN_OWNER: TURN_OWNER ? '1' : '0', ...keyEnv(),
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

// ── The record: timeline (for the edit) and report (for the verdict) ──
const VIEW = { width: 1280, height: 800 };
const timeline = { size: VIEW, videos: {}, film: { fromMs: null, toMs: null }, scenes: [], cuts: [], speech: [], labels: { lead: 'Hugo Marchetti (lead)', cand: 'Mateo Alvarez' } };
const report = { startedAt: new Date().toISOString(), interview: IV, turnOwner: TURN_OWNER, nameRequired: NAME_REQUIRED, steps: [], spend: null, notes: [], turns: [] };
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
// v1.2: no pause over 0.6 s between two people's lines unless a screen action needs it (that action is awaited before say()).
const GAP_MAX_MS = 400;
async function say(p, id, gapMs = 1800, { heard, now = false } = {}) {
  const wait = now ? 0 : busy.until + Math.min(gapMs, GAP_MAX_MS) - Date.now();
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
  if (heard !== false) await heardByScript(p, heard ?? c.text);
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
// Milo's voice as the candidate's browser receives it, and his measured turns: the shared helpers (lib/milo-turns.mjs). `line` is
// say() by line id (the speaker from the lines file), as they take it.
const line = (id, gapMs, o) => say(LINES[id][0] === 'hugo' ? lead : cand, id, gapMs, o);
const { milo, voiceLog, keepMiloVoice, miloSays, turn, askByVoice, watchSilence, bargeOver, askByHold } = miloTurns({
  out: OUT, timeline, report, lines: LINES, busy, say: line, until, sleep, note, moveTo: (...a) => moveTo(...a), portal: PORTAL,
  people: () => ({ lead, cand }), callId: () => callId, handsfree: HANDSFREE, bargeOn: BARGE_ON,
});

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
/** --name-required: the body typed right the first time (checked before stored), as no code is run in that round. */
const GOOD_BODY = ['    seen = {}', '    for i, n in enumerate(nums):', '        if target - n in seen:', '            return [seen[target - n], i]', '        seen[n] = i', '    return []'];
/** The line Milo adds at the top of the pad when Hugo asks for it (the Milo-features lane's pad tool). */
const LRU_IMPORT = 'from functools import lru_cache';
/** The marker of Milo's test-case block at the bottom of the pad (lib/interviews/testcases/render.ts). */
const CASES_BLOCK = /# --- Test cases from Milo \((\d+)\) ---/;
const MOVED_LINE = '        seen[n] = i';
/** The line the candidate types above the function once Milo has added the import (Act 7). */
const DECORATOR = '@lru_cache(maxsize=None)';
// The post Hugo drops into the call chat in Act 2 (the news index, not an invented post URL).
const NEWS_URL = 'https://www.anthropic.com/news';
const padOf = (page) => page.getByTestId('interview-pad').first();
/**
 * Scrolls the pad's editor to its last line (or its first, `toTop`) over `ms` (0: at once), by the element that really scrolls (the editor draws only the
 * lines in view, so lines below the fold are not in the page until it does).
 */
async function padToEnd(page, ms, toTop = false) {
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
    await scroller.evaluate((el, [a, f, top]) => { const to = top ? 0 : el.scrollHeight - el.clientHeight; el.scrollTop = a + f * (to - a); }, [from, e, toTop]).catch(() => undefined);
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
  await sleep(200);
  const now = await padLines(page);
  await caretToLine(page, now.findIndex((l) => l.trimStart().startsWith('return [seen')));
  await page.keyboard.press('End');
  await page.keyboard.press('Enter'); await page.keyboard.press('Shift+Home');
  await page.keyboard.type(MOVED_LINE, { delay: 40 });
}
/** Types `text` on its own line just above `def two_sum` (the pad scrolled to the top first, so that line is drawn). */
async function typeAboveDef(page, text) {
  await padToEnd(page, 0, true);
  await padOf(page).locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+Home');
  const at = (await padLines(page)).findIndex((l) => l.startsWith('def two_sum'));
  if (at < 0) { note('the decorator: no def two_sum line in view'); return; }
  for (let k = 0; k < at; k += 1) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Home');
  await page.keyboard.type(text, { delay: 55 });
  await page.keyboard.press('Enter');
}
/** Run from the candidate's side; both output panes read, and the product's own run containers counted (docker events, bounded). */
async function runAndRead(cp, hp, want, lineId = null) {
  const since = Math.floor(Date.now() / 1000) - 1;
  const [was, wasLead] = [await outputText(cp), await outputText(hp)];
  // Say, then do: the click lands as the line that announces the run ends (the glide and rest take about 1.1 s).
  if (lineId) await nearEnd(lineId, 1100);
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
// The suggestion waits as a button on the footer's row (nothing is drawn above the row): the lead opens it to read and answer it.
const openAsk = async (page) => { if (!(await deckOf(page).isVisible().catch(() => false))) await page.getByTestId('interview-room-ask-open').click({ timeout: 1500 }).catch(() => undefined); };
const deckShown = async (page) => { await openAsk(page); return (await deckOf(page).getByRole('button', { name: /have milo ask/i }).isVisible().catch(() => false)) ? squash(await deckOf(page).innerText()) : null; };
const OPTION = { ask: /^I.ll ask it$/i, 'milo-ask': /have milo ask/i, skip: /^Skip$/ };
/** The lead's footer question for a candidate's waiting pad request ("Pad change?"): waits for it (within `ms`) and presses Confirm. → its text, or null. */
async function pressPadConfirm(page, ms) {
  const text = await until(async () => {
    await openAsk(page);
    const ok = deckOf(page).getByRole('button', { name: /^Confirm$/ });
    return (await ok.isVisible().catch(() => false)) ? squash(await deckOf(page).innerText()) : null;
  }, ms, 500);
  if (!text) return null;
  await press(page, deckOf(page).getByRole('button', { name: /^Confirm$/ }).first(), { pause: 600 }).catch((e) => note(`pad confirm: ${String(e).slice(0, 80)}`));
  return text;
}
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
async function press(page, locator, { pause = 450, timeout = 30_000, ms = 700 } = {}) {
  const t0 = Date.now();
  await locator.waitFor({ timeout });
  const t1 = Date.now();
  await glide(page, locator, { pause, ms });
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
/** Waits until the line `id` (started or about to start) is `leadMs` from its end: an action timed to land as the line ends. */
async function nearEnd(id, leadMs) {
  const s = await until(async () => timeline.speech.findLast((x) => x.id === id) ?? null, 15_000, 40);
  if (s) { const w = s.atMs + s.durMs - leadMs - Date.now(); if (w > 0) await sleep(w); }
}
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
  // The story follows the screenplay (FILM-SCREENPLAY.md v1): every line, cursor move and Milo wait in its order. Captions are
  // started when the thing they name is on screen. Nobody speaks while Milo is about to (cover lines only after "On it.").
  // Act 1. Before the call: Hugo on Prepare, the call started; the candidate's door; Admit.
  scene(1, 'Hugo prepares the Coding round.', '');
  const prepText = squash(await hp.getByTestId('interviews-prepare').first().innerText().catch(() => ''));
  step('1p Prepare shows the Coding round with Two Sum', /Coding/.test(prepText) && /array of integers/i.test(prepText), `Prepare reads "${prepText.slice(0, 160)}"`);
  const checking = say(lead, 'h27', 300);
  await glide(hp, hp.getByTestId('interviews-prepare').getByText(/array of integers/i).first(), { pause: 1400 });
  await nearEnd('h27', 1300);
  await press(hp, hp.getByTestId('interviews-prepare-room').first(), { pause: 250 });
  await checking;
  const h00 = say(lead, 'h00', 200);
  await hp.getByTestId('interview-room').first().waitFor({ timeout: 60_000 });
  const roomHead = squash(await hp.getByTestId('interview-room').first().innerText().catch(() => '')).slice(0, 400);
  const calling = startCall(hp);
  await h00;
  // The one cut: nothing happens on screen while the call goes live, the recruiter sends the link and the candidate's browser opens it.
  const cutLink = skipFrom('Skipping ahead: the recruiter sends the link and the candidate opens it');
  await calling;
  const live1 = await until(async () => ((await (await lead.api.get(`${PORTAL}/api/interviews/interviews/${IV}`)).json()).interview?.state === 'live' ? true : null), 20_000, 1000);
  const inv = await greta.api.post(`${PORTAL}/api/interviews/interviews/${IV}/invite`, { data: {} });
  const link = (await inv.json().catch(() => ({}))).linkPath;
  step('1 lead starts the call', !!live1 && !!link && /Coding/.test(roomHead), `interview live=${!!live1}; invite ${inv.status()} link=${!!link}; the room says Coding=${/Coding/.test(roomHead)}`);
  if (!link) throw new Error('no invite link');
  cand = await person('cand', null);
  keepMiloVoice(cand.page);
  const cp = cand.page;
  await cp.goto(`${PORTAL}${link}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  const firstStep = await Promise.any(['join-interview', 'join-consents'].map((id) => cp.getByTestId(id).first().waitFor({ timeout: 30_000 }).then(() => id))).catch(() => null);
  // v1.2 trim 1: the cut also takes the invite's first page (no line on it), so the setup on screen starts at the three choices.
  if (firstStep === 'join-interview') await cp.getByTestId('join-continue').first().click({ timeout: 10_000 });
  await cp.getByTestId('join-consents').waitFor({ timeout: 30_000 });
  await cp.waitForTimeout(250);
  cutLink();
  scene(2, 'The candidate\'s door: no account, three plain choices.', '');
  const radiosChecked = () => cp.evaluate(() => [...document.querySelectorAll('[data-testid="join-questions"] input[type="radio"]')].filter((r) => r.checked).length).catch(() => -1);
  const fresh = await radiosChecked();
  const invite = say(cand, 'p00', 0);
  await glide(cp, cp.getByTestId('join-consents').first(), { pause: 300 });
  await invite;
  const reading = say(cand, 'p01', 150);
  await scrollThrough(cp, cp.getByTestId('join-notice').first(), Math.max(1500, (CLIPS.p01?.durMs ?? 4400) - 2600));
  // The three choices, empty, held on screen through the end of the line before the first one is read.
  await glide(cp, cp.getByTestId('join-questions').first(), { pause: 300 });
  await reading;
  for (const [part, line] of [['recording', 'p02'], ['transcription', 'p03'], ['milo', 'p04']]) {
    const read = say(cand, line, 150);
    await glide(cp, cp.getByTestId(`join-consent-${part}`).locator('p').first(), { pause: 200 });
    await nearEnd(line, 1100);
    await press(cp, cp.getByTestId(`join-consent-${part}-choice`).locator('label').filter({ hasText: /^Yes$/ }).first(), { pause: 200 });
    await read;
  }
  step('2a nothing pre-selected', fresh === 0 && (await radiosChecked()) === 3, `radios checked when the questions first showed: ${fresh}; after the candidate's three answers: ${await radiosChecked()}`);
  await press(cp, cp.getByTestId('join-consents-continue'), { pause: 100 });
  const devices = say(cand, 'p05', 0);
  await cp.getByTestId('join-devices').waitFor({ timeout: 30_000 });
  await glide(cp, cp.getByTestId('join-devices').first(), { pause: 300 });
  await nearEnd('p05', 1100);
  await press(cp, cp.getByTestId('join-devices-continue'), { pause: 200 });
  await devices;
  const admit = hp.getByTestId('interview-room-ask').getByRole('button', { name: /^Admit$/ }).first();
  const waiting = say(cand, 'p06', 200);
  await admit.waitFor({ timeout: 30_000 });
  await waiting;
  const bringIn = say(lead, 'h01', 150);
  await glide(hp, admit, { pause: 200 });
  // He admits him as he says "let me bring him in": the call connects under the end of the line.
  await nearEnd('h01', 2000);
  await press(hp, admit, { pause: 150 });
  mark('admitted');
  await bringIn;
  await cp.getByTestId('join-room').first().waitFor({ timeout: 30_000 });
  const join = cp.getByTestId('join-room-bar-start').or(cp.getByTestId('join-room-bar-join')).first();
  await join.waitFor({ timeout: 30_000 });
  for (let i = 0; i < 40 && await join.isDisabled(); i++) await sleep(250);
  await press(cp, join, { pause: 150 });
  const now = cp.getByRole('button', { name: 'Join now', exact: true });
  if (await now.first().waitFor({ timeout: 300 }).then(() => true, () => false)) await press(cp, now.first(), { pause: 150 });
  const cams = async (pg) => pg.evaluate(() => [...document.querySelectorAll('video')].filter((v) => v.videoWidth > 0 && v.readyState >= 2).length).catch(() => 0);
  const tilesP = until(async () => ((await cams(hp)) >= 2 && (await cams(cp)) >= 2 ? true : null), 30_000, 150);
  // Hugo greets him as the call connects (the tiles come up under the greeting), not after a silent wait for both cameras.
  await Promise.race([tilesP, sleep(900)]);
  const greeting = (async () => { await say(lead, 'h02', 0); await say(cand, 'c01', 300); })();
  await cp.getByTestId('join-room-time-left').first().waitFor({ timeout: 30_000 });
  const tiles = await tilesP;
  mark('camera tiles');
  const roundFrom = Date.now();
  step('2 both in the call with cameras', !!tiles, `live camera tiles: lead ${await cams(hp)}, candidate ${await cams(cp)}`);
  // From here until the lead ends the interview, the call must hold (the room's own lost-call notice on either side fails it).
  const lostSeen = { lead: null, cand: null };
  const watchLost = setInterval(() => {
    for (const [who, page, id] of [['lead', hp, 'interview-room-call-lost'], ['cand', cp, 'join-room-call-lost']]) {
      if (lostSeen[who] === null) void page.getByTestId(id).first().isVisible().then((v) => { if (v && lostSeen[who] === null) lostSeen[who] = Date.now(); }, () => undefined);
    }
  }, 2000);
  // Every suggestion Hugo's footer shows, with when it first showed (the steps on the coach's timing read it).
  const decksSeen = [];
  const watchDeck = setInterval(() => {
    void deckShown(hp).then((t) => { if (t && !decksSeen.some((d) => d.text === t)) decksSeen.push({ text: t, atMs: Date.now() }); }, () => undefined);
  }, 700);

  // Act 2. Hello, and Milo says hello. Hugo invites Milo and turns its voice on while they say good morning; the caption comes
  // when Milo is listening.
  let A = null;
  const booked = { listeningSeconds: null, readStatus: null };
  const miloState = async () => {
    const r = await lead.api.get(A('state'));
    booked.readStatus = r.status();
    const body = r.ok() ? await r.json().catch(() => ({})) : {};
    if (typeof body.listeningSeconds === 'number') booked.listeningSeconds = body.listeningSeconds;
    return body;
  };
  await warmMic(cp);
  for (const pg of [hp, cp]) await letSound(pg);
  const miloReady = (async () => {
    if (!MILO) { scene(3, 'The interview starts. Milo is listening.', ''); return; }
    await press(hp, hp.getByTestId('assistant-invite').first(), { timeout: 15_000 });
    const goAhead = hp.getByTestId('assistant-budget-ask').getByRole('button', { name: /go ahead/i });
    if (await goAhead.waitFor({ timeout: 2000 }).then(() => true, () => false)) await press(hp, goAhead);
    await until(async () => callId, 10_000);
    A = (rest) => `${PORTAL}/api/calls/${encodeURIComponent(callId)}/assistant/${rest}`;
    const listening = await until(async () => ((await miloState()).state === 'listening' ? true : null), 30_000, 1000);
    if (listening) scene(3, 'The interview starts. Milo is listening.', '');
    await press(hp, hp.getByTestId('assistant-status-mark').first(), { timeout: 10_000 }).catch(() => undefined);
    await press(hp, hp.getByRole('menuitem', { name: /Turn Milo's voice on/ }), { timeout: 10_000 }).catch(() => undefined);
    const voiceOn = await until(async () => ((await miloState()).voice === true ? true : null), 10_000, 500);
    if (!voiceOn) { const r = await lead.api.post(A('voice'), { data: { on: true } }); note(`voice on from the footer did not take; by the API ${r.status()}`); }
    scriptedEar.on = SCRIPTED && !!listening;
    step('3 Milo listening, voice on', !!listening, `Milo listening=${!!listening}; voice on from the footer=${!!voiceOn}; call ${callId}`);
  })();
  await greeting;
  /**
   * --name-required: the 20 November coding round (ten minutes; Milo acts only on his name or the hold). Hugo welcomes Mateo and
   * reads the round's opening line (Milo silent); by the hold, Milo introduces himself; Two Sum in Python, typed in the pad; Mateo
   * asks Milo for test cases by name (they wait for Hugo's yes); Hugo has Milo ask a probe on the complexity of Mateo's code and
   * Mateo answers; the question asked without the name and a mention of Milo get no reply; Hugo cuts in on a repeated probe; near
   * the end Mateo asks the time. Each Milo turn is measured (report.turns, report.silences, report.barge). No code is run.
   */
  async function namedRound() {
    await miloReady;
    const s = {};
    await line('n01', 400);
    await line('n02', 300);
    s.opening = await watchSilence('opening line', 'n03', 5000);
    s.intro = await askByHold('introduce (hold)', 'n04', /algorithm|test cases|speed/i);
    // The pad: Hugo's question in Mateo's language; Hugo lets the candidate ask Milo for the pad.
    const padReady = (async () => { await padTab(hp); await padTab(cp); return !!(await until(async () => ((await synced(hp)) && (await synced(cp))) || null, 20_000, 500)); })();
    // The coach's first suggestion is the chosen question: Hugo takes it as his own (I'll ask it), so its card is closed before the menu.
    const s1p = answerSuggestion(hp, /array of integers/i, 'ask', 8000);
    await line('n05', 400);
    const sync = await padReady;
    await s1p;
    const python = chooseLanguage(cp, 'Python').catch((e) => note(`language Python: ${String(e).slice(0, 100)}`));
    await line('n06', 300);
    await python;
    for (let k = 0; k < 3; k += 1) {
      await press(hp, hp.getByTestId('interview-pad-insert'), { timeout: 8000 });
      if (await hp.getByRole('menuitem').first().waitFor({ timeout: 2500 }).then(() => true, () => false)) { await press(hp, hp.getByRole('menuitem').first(), { timeout: 5000 }); break; }
      note('the insert menu did not open; pressed again');
    }
    const help = hp.getByTestId('interview-pad-milo-help-switch').first();
    if ((await help.getAttribute('aria-checked').catch(() => null)) !== 'true') await press(hp, help, { timeout: 8000 }).catch((e) => note(`help switch: ${String(e).slice(0, 100)}`));
    const helpOn = (await (await lead.api.get(`${PORTAL}/api/interviews/interviews/${IV}/milo-settings`)).json().catch(() => ({}))).settings?.candidateMayAsk === true;
    const starter = !!(await until(async () => ((await padText(cp)) ?? '').includes('def two_sum(') || null, 10_000, 400));
    scene(4, 'Two Sum, in the candidate\'s language.', '');
    problemAt = Date.now();
    step('4 the question in the pad, Python', sync && starter && (await padLanguage(cp)) === 'python', `synced=${sync}; starter=${starter}; language ${await padLanguage(cp)}; candidate may ask Milo for the pad=${helpOn}`);
    // Mateo codes, thinking out loud.
    scene(5, 'Mateo codes, thinking out loud.', '');
    const thinking = line('c07', 400);
    await nearEnd('c07', 2200);
    const typing = replaceStarterBody(cp, GOOD_BODY);
    await thinking;
    await line('c08', 300);
    await typing;
    const caseLine = line('c10', 300);
    await sleep(1200);
    await typeAtEnd(cp, SECOND_CASE);
    await caseLine;
    solvedAt = Date.now();
    await line('n22', 300);
    // Test cases by name; a candidate's pad request waits for the lead's yes.
    scene(6, 'Mateo asks Milo for test cases.', '');
    s.tests = await askByVoice('test cases (candidate, name first)', 'cand', 'n07', 'hey milo', /test|lead|go ahead/i, 30_000);
    // The lead's yes: Hugo presses Confirm on the footer's "Pad change?" question (it opens by itself, like a knock).
    if (/lead|go ahead|allow|confirm/i.test(s.tests.said)) {
      const shown = await pressPadConfirm(hp, 20_000);
      s.confirm = { said: shown ? `[Confirm pressed] ${shown.slice(0, 160)}` : '[no Pad change? question]', latencyS: null, replied: !!shown, right: !!shown };
      step('6 the lead confirms the pad request in the footer', !!shown, shown ? `"${shown.slice(0, 200)}"` : 'the Pad change? question never showed');
    }
    let block = await until(async () => (CASES_BLOCK.test((await padText(cp)) ?? '') ? true : null), 6000, 400);
    const inPad = async () => (CASES_BLOCK.test((await padText(cp)) ?? '') ? true : null);
    if (!block) { await line('n20', 400); await line('n21', 300); block = await until(inPad, 3000, 300); }
    // Still writing: the edit skips the wait (never over Milo's voice), so the film has no long silence.
    if (!block) { const cut = skipFrom('Skipping ahead: Milo writes the test cases'); block = await until(inPad, 90_000, 400); cut(); }
    await until(async () => Date.now() > busy.until + 200, 30_000, 100);
    const padNow = (await padText(cp)) ?? '';
    const cases = padNow.slice(Math.max(0, padNow.search(CASES_BLOCK)));
    report.testCases = block ? cases : null;
    // The rendered cases are rows like (([3, 2, 4], 6), [1, 2]): the first list is nums.
    const numsOf = [...cases.matchAll(/\(\(\s*\[([^\]]*)\]/g)].map((m) => m[1].split(',').map((x) => x.trim()).filter(Boolean));
    const hasEmpty = numsOf.some((n) => n.length === 0); const hasDup = numsOf.some((n) => new Set(n).size < n.length);
    step('6 Milo\'s test cases in the pad (empty array, duplicates)', !!block && hasEmpty && hasDup, `empty array=${hasEmpty}; duplicates=${hasDup}; block ${block ? `"${squash(cases).slice(0, 400)}"` : 'never appeared'}`);
    // Mateo's line names both kinds: said only when both are there.
    if (block) { await padToEnd(cp, 1500); if (hasEmpty && hasDup) await line('n09', 300); }
    // A probe by name, written on Mateo's code; his answer.
    scene(7, 'Hugo has Milo ask a probe on Mateo\'s code.', '');
    s.probe = await askByVoice('probe (lead, hey milo)', 'lead', 'n10', 'hey milo', /complex|O\(|linear|time|seen|dictionary|loop/i, 30_000);
    await line('c18', 400);
    // No name: silence by design; Hugo reads the question himself. A mention: silence.
    s.noName = await watchSilence('no name', 'n11', 6000);
    await line('n12', 300);
    s.mention = await watchSilence('a mention', 'n13', 5000);
    // Hugo cuts in on a repeated probe.
    const nB = milo.utterances; const posts0 = (await miloPosts()).length;
    await line('n14', 300);
    const askedEnd = Date.now();
    const began = await until(async () => (milo.utterances > nB ? true : null), 20_000, 50);
    const barge = began ? await bargeOver(nB) : null;
    report.barge = barge;
    s.repeat = await turn('probe again, cut in (lead, name first)', 'lead', LINES.n14[1], askedEnd, nB, posts0, !!began);
    s.repeat.how = 'name first'; s.repeat.barge = barge;
    await line('n19', 300);
    // Near the end of the ten minutes (the round's clock starts when Mateo joins): the time question.
    const target = roundFrom + 8.2 * 60_000;
    if (Date.now() < target) {
      const cut = skipFrom('Skipping ahead: Mateo works on, near the end of the ten minutes');
      await padToEnd(cp, 1500);
      await sleep(Math.max(0, target - Date.now()));
      cut();
    }
    await line('n15', 300);
    s.time = await askByVoice('time left (candidate, name last)', 'cand', 'n16', 'name last', /minute|end of its time/i, 20_000);
    await line('n17', 400);
    bye = line('n18', 300);
    await nearEnd('n18', 1300);
    report.named = Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v && { said: v.said, latencyS: v.latencyS, replied: v.replied, right: v.right }]));
  }
  let problemAt = Date.now(); let solvedAt = problemAt; let bye = Promise.resolve();
  if (NAME_REQUIRED) await namedRound();
  else {
  const nIntro = milo.utterances;
  await say(lead, 'h03', 500);
  await miloReady;
  await say(lead, 'h24', 250);
  const introAt = Date.now();
  const intro = A ? await miloSays(nIntro, 15_000) : false;
  if (A) step('3i Milo introduces itself aloud', intro, `Milo spoke=${intro} ${intro ? `${((milo.lastStartMs - introAt) / 1000).toFixed(1)} s after Hugo finished` : ''}`);
  await say(cand, 'c02', 500);
  // v1.2 trim 2: no "how's your week" exchange; the check that Milo hears the call runs under Hugo's next line.
  if (A) {
    const heard = await until(async () => { const l = (await (await lead.api.get(A('transcript?limit=50'))).json()).lines ?? []; return l.length ? l : null; }, 15_000, 1500);
    if (!heard) { note('Milo heard nothing; dismissed to stop the spend'); await lead.api.post(A('dismiss'), { data: {} }); await miloState().catch(() => undefined); A = null; }
  }
  await say(lead, 'h05', 600); await say(cand, 'c04', 600); await say(lead, 'h06', 600);
  // The in-call chat (owner): Hugo drops the news page into the call's chat through the real composer; Mateo opens his Chat tab
  // and sees it. Say, then do: the paste follows "I'll drop it in the chat".
  const chatOk = await (async () => {
    const tip = say(lead, 'h40', 400);
    await nearEnd('h40', 1800);
    await press(hp, hp.getByTestId('interview-room-pane').getByRole('tab', { name: /^chat$/i }), { pause: 150, timeout: 8000 });
    const box = hp.getByTestId('interview-room-chat').getByRole('textbox').first();
    await press(hp, box, { pause: 100, timeout: 8000 });
    await hp.keyboard.type(NEWS_URL, { delay: 30 });
    await hp.keyboard.press('Enter');
    await tip;
    await press(cp, cp.getByTestId('join-room-pane').getByRole('tab', { name: /^chat$/i }), { pause: 150, timeout: 8000 }).catch((e) => note(`candidate chat tab: ${String(e).slice(0, 100)}`));
    const seen = !!(await until(async () => ((await cp.getByTestId('join-room-chat').innerText().catch(() => '')).includes(NEWS_URL) || null), 10_000, 300));
    await say(cand, 'c40', 300);
    return seen;
  })().catch((e) => { note(`chat beat: ${String(e).slice(0, 120)}`); return false; });
  step('2c the link in the call chat on both sides', chatOk && (await hp.getByTestId('interview-room-chat').innerText().catch(() => '')).includes(NEWS_URL), `candidate's chat shows ${NEWS_URL}=${chatOk}`);

  // Act 3. The problem. The coach's first suggestion is the chosen question itself: if it shows while Hugo reads it, he takes it
  // as his own (I'll ask it). The caption comes when the Python starter is on both screens.
  const s1p = answerSuggestion(hp, /array of integers/i, 'ask', 4000);
  const padReady = (async () => {
    await padTab(hp); await padTab(cp);
    const ok = !!(await until(async () => ((await synced(hp)) && (await synced(cp))) || null, 20_000, 500));
    await chooseLanguage(hp, 'Java').catch((e) => note(`language Java: ${String(e).slice(0, 100)}`));
    return ok;
  })();
  await say(lead, 'h07', 600);
  const s1 = await s1p;
  const sync = await padReady;
  // v1.3: h07 asks about Java itself (Hugo no longer reads the problem aloud); Mateo answers straight away.
  await say(cand, 'c05', 300);
  const python = chooseLanguage(cp, 'Python').catch((e) => note(`language Python: ${String(e).slice(0, 100)}`));
  const h09 = say(lead, 'h09', 400);
  await python;
  await press(hp, hp.getByTestId('interview-pad-insert'), { timeout: 8000 });
  await press(hp, hp.getByRole('menuitem').first(), { timeout: 5000 });
  await h09;
  const langBoth = !!(await until(async () => ((await padLanguage(hp)) === 'python' && (await padLanguage(cp)) === 'python') || null, 10_000, 400));
  const starter = !!(await until(async () => ((await padText(cp)) ?? '').includes('def two_sum(') || null, 10_000, 400));
  scene(4, 'Two Sum, in the candidate\'s language.', '');
  problemAt = Date.now();
  step('4 language switch and the question in the pad', sync && langBoth && starter,
    `both synced=${sync}; both read Python=${langBoth} (lead ${await padLanguage(hp)}, candidate ${await padLanguage(cp)}); Python starter in the candidate's pad=${starter}; the coach's first suggestion ${s1 ? `"${s1.slice(0, 60)}" (I'll ask it)` : 'not shown while Hugo read it'}`);
  // He looks at it: his cursor goes down the problem's comment lines while he reads under his breath.
  const look = say(cand, 'c29', 400);
  await glide(cp, padOf(cp).locator('.cm-line').filter({ hasText: /Given an array/ }).first(), { pause: 300 });
  await look;
  const mumble = say(cand, 'c30', 200);
  for (const re of [/indices of the two numbers/, /input has exactly one answer/, /be used twice/]) {
    await glide(cp, padOf(cp).locator('.cm-line').filter({ hasText: re }).first(), { pause: 500, ms: 1100 });
  }
  await mumble;
  await say(cand, 'c31', 400); await say(lead, 'h31', 300);
  await say(cand, 'c06', 400); await say(lead, 'h10', 500);

  // Act 4. Thinking out loud, then real runs: the body typed under the lines, the duplicate case, a failing run, the fix, a pass.
  scene(5, 'Thinking out loud, then real runs.', '');
  const thinking = say(cand, 'c07', 600);
  await nearEnd('c07', 2200);
  const typing = replaceStarterBody(cp, BUGGY_BODY);
  await thinking;
  await say(cand, 'c08', 300);
  await typing;
  const caseLine = say(cand, 'c10', 300);
  await sleep(1200);
  await typeAtEnd(cp, SECOND_CASE);
  await caseLine;
  const firstRunAt = Date.now();
  const r1 = runAndRead(cp, hp, /\[0, 0\]/, 'c11');
  await say(cand, 'c11', 300);
  await say(lead, 'h11', 400);
  const run1 = await r1;
  // Say, then do (rule 9): the pad is untouched while he explains the bug; the edit is typed under "Let me swap those two
  // lines", the last two seconds of the clip, and lands as the line ends.
  const fix = (async () => { await nearEnd('c12', 2100); await moveSeenAfterReturn(cp); })();
  await say(cand, 'c12', 400);
  await fix;
  const r2 = runAndRead(cp, hp, /\[0, 1\]\s*\[0, 1\]/, 'c13');
  await say(cand, 'c13', 300);
  await say(lead, 'h12', 300);
  const run2 = await r2;
  solvedAt = Date.now();
  await say(cand, 'c14', 400);
  await say(lead, 'h32', 500);
  step('6 first run fails the duplicate case', !!run1.cand && !!run1.lead, `candidate "${squash(run1.cand ?? run1.lastCand).slice(0, 120)}"; lead sees it=${!!run1.lead}`);
  step('6b fixed run passes', !!run2.cand && !!run2.lead, `candidate "${squash(run2.cand ?? run2.lastCand).slice(0, 120)}"; lead sees it=${!!run2.lead}`);
  // The computed outputs are the proof; the docker events poll can miss a short-lived container, so one sighting is enough.
  step('R code executed for real', run1.containers + run2.containers > 0 && !!run1.cand && !!run2.cand,
    `run containers seen: ${run1.containers} and ${run2.containers} (label interviews.run=1); outputs computed by the code ([0, 0] then [0, 1]), which the mock runner (literal prints only) cannot produce`);

  // Act 5. Hugo's own complexity question straight after the pass; the talk covers the coach's suggestion arriving; its caption
  // only once it is in Hugo's footer; he hands over, then presses Have Milo ask; the repeat; the answer.
  const complexityAt = Date.now();
  const before = decksSeen.filter((d) => !/array of integers/i.test(d.text));
  await say(lead, 'h14', 500);
  await say(cand, 'c18', 500);
  await say(lead, 'h15', 500);
  await say(cand, 'c19', 500);
  // v1.2 trim 3: no "day job" exchange; the sorted-array answer alone covers the suggestion arriving (a late one is noted).
  let testing = { deck: '', spoken: false, receipt: false, candQ: '', voiceAfterS: null, receiptText: '' }; let repeated = false; let repeatLine = '';
  if (A) {
    const waitFrom = Date.now();
    const deck = await waitSuggestion(hp, /test this function/i, 150_000);
    if (deck && Date.now() - waitFrom > 1500) note(`the testing suggestion came ${((Date.now() - waitFrom) / 1000).toFixed(1)} s after Mateo's answer ended (silent film)`);
    testing.deck = deck ?? '';
    if (deck) {
      scene(6, 'Milo suggests a follow-up, to Hugo only.', '');
      const handOver = say(lead, 'h18', 300);
      await glide(hp, deckOf(hp).getByRole('button', { name: /have milo ask/i }).first(), { pause: 300 });
      await handOver;
      const n0 = milo.utterances;
      await press(hp, deckOf(hp).getByRole('button', { name: /have milo ask/i }).first(), { pause: 200 });
      const pressedAt = Date.now();
      const RECEIPT = /Milo asked it aloud|Milo posted the question in the chat \([^)]*\)|Not sent: [^.]*\.|Milo did not say whether it was sent/;
      const receiptP = until(async () => RECEIPT.exec(await hp.locator('body').innerText())?.[0] ?? null, 20_000, 500);
      testing.spoken = await miloSays(n0, 30_000);
      testing.voiceAfterS = testing.spoken ? Number(((milo.lastStartMs - pressedAt) / 1000).toFixed(1)) : null;
      testing.receiptText = (await receiptP) ?? '';
      testing.receipt = testing.receiptText === 'Milo asked it aloud';
      testing.candQ = squash(await until(async () => (await cp.getByTestId('guest-milo-question').first().innerText().catch(() => '')).trim() || null, 20_000) ?? '');
      const p1 = (await miloPosts()).length;
      const n1 = milo.utterances;
      // v1.1: one line. The fast path matches "... repeat the question?" only from the start of a request (milo-tools toolOfPhrase),
      // so the scripted session is handed the phrase it matches today; the Milo lane widens the phrases for the real take.
      await say(cand, 'c36', 300, { heard: 'Milo, could you repeat the question?' });
      repeated = await miloSays(n1, 25_000);
      repeatLine = (await miloPosts()).slice(p1).find((t) => /test this function/i.test(t)) ?? '';
    }
    const firstAfter = decksSeen.find((d) => !/array of integers/i.test(d.text));
    step('Q1 Hugo asks complexity before any suggestion', before.length === 0, `suggestions shown before his question: ${before.length ? before.map((d) => `"${d.text.slice(0, 60)}" ${((complexityAt - d.atMs) / 1000).toFixed(0)} s before`).join('; ') : 'none'}`);
    step('Q2 the suggestion comes only after a run', !!firstAfter && firstAfter.atMs > firstRunAt, `first suggestion after the question: ${firstAfter ? `"${firstAfter.text.slice(0, 60)}" ${((firstAfter.atMs - firstRunAt) / 1000).toFixed(0)} s after the first run` : 'none'}`);
    step('7 coach testing suggestion shown', !!deck, `testing suggestion "${squash(deck).slice(0, 120)}"`);
    step('8 Have Milo ask, read aloud', testing.receipt && testing.spoken && !!testing.candQ, `receipt "${testing.receiptText || 'none shown'}"; Milo spoke=${testing.spoken}${testing.voiceAfterS !== null ? ` ${testing.voiceAfterS} s after the press` : ''}; candidate's Milo line "${testing.candQ.slice(0, 80)}"`);
    step('9 repeat the question, spoken', repeated && !!repeatLine, `Milo spoke=${repeated}; Milo's post "${repeatLine.slice(0, 120)}"`);
  }
  await say(cand, 'c23', 700);

  // Act 6. The switch, then a dozen test cases from Milo. "On it." first; the cover lines only after it; the block; the run.
  const helpSwitch = hp.getByTestId('interview-pad-milo-help-switch').first();
  const switchLine = say(lead, 'h25', 500);
  await sleep(4200);
  await press(hp, helpSwitch, { timeout: 10_000 }).catch((e) => note(`pad-help switch: ${String(e).slice(0, 100)}`));
  scene(7, 'The candidate may ask Milo for setup help, when the lead allows it.', '');
  await switchLine;
  const helpOn = await helpSwitch.evaluate((e) => e.getAttribute('aria-checked') ?? e.getAttribute('data-state') ?? String(e.checked ?? '')).catch(() => '?');
  if (A) step('5s Hugo lets the candidate ask Milo', /true|checked|on/.test(helpOn), `the switch reads ${helpOn}`);
  const casePosts0 = A ? (await miloPosts()).length : 0;
  await say(cand, 'c34', 400);
  const nCases = milo.utterances;
  // --scripted: the stand-in serves the request in the same moment and never says "On it." (scripted-session.ts emitToolCall raises
  // the delegation and the call together). To rehearse the real shape (request, cover lines while the slow tool works, the block,
  // "Added ..."), the request reaches the stand-in only after the cover lines.
  await say(cand, 'c15', 200, SCRIPTED ? { heard: false } : {});
  const askedAt = Date.now();
  const scrolled = padToEnd(cp, 1500);
  let caseCount = null;
  const hasBlock = async () => {
    await padToEnd(cp, 0);
    caseCount = CASES_BLOCK.exec((await padText(cp)) ?? '')?.[1] ?? null;
    return caseCount !== null;
  };
  const filledAt = A ? scrolled.then(() => until(async () => ((await hasBlock()) ? Date.now() : null), 45_000, 400)) : Promise.resolve(null);
  const saidSince = async (re) => (await miloPosts()).slice(casePosts0).some((t) => re.test(t));
  const onIt = A && !SCRIPTED ? !!(await until(async () => (await saidSince(/^On it\b/i)) || null, 4000, 300)) : false;
  if (onIt) { await until(async () => Date.now() > busy.until + 200, 10_000, 200); await say(lead, 'h26', 300); await say(cand, 'c28', 400); }
  if (A && SCRIPTED) {
    await say(lead, 'h26', 300); await say(cand, 'c28', 300);
    await heardByScript(cand, LINES.c15[1]);
    note('scripted: the test-case request was handed to the stand-in after the cover lines (no "On it." from the stand-in)');
  }
  // He speaks as soon as Milo's "Added ..." has been said (its voice, not its chat post, which lands later).
  if (A) await miloSays(nCases + (onIt ? 1 : 0), 45_000);
  const filled = await filledAt;
  // The chat post of "Added ..." lands after its voice: read it while he speaks, not before.
  const casesSaidP = A ? until(async () => (await saidSince(/^Added \w+ test cases/i)) || null, 15_000, 400).then((v) => !!v) : Promise.resolve(false);
  const step7t = async () => { const casesSaid = await casesSaidP; if (A) step('7t Milo fills the pad with twelve test cases', !!filled && caseCount === '12', `the block in the pad=${!!filled} (${caseCount ?? 0} cases)${filled ? ` ${((filled - askedAt) / 1000).toFixed(1)} s after the request` : ''}; "On it." posted=${onIt}; "Added ... test cases" posted=${casesSaid}`); };
  if (!filled) await step7t();
  if (filled) {
    const r3 = runAndRead(cp, hp, /\bok\b/, 'c16');
    await say(cand, 'c16', 300);
    await step7t();
    await say(lead, 'h13', 400);
    const run3 = await r3;
    await say(cand, 'c17', 500);
    const outText = squash(run3.cand ?? run3.lastCand);
    const oks = (outText.match(/\bok\b/g) ?? []).length; const diffs = (outText.match(/\bDIFF\b/g) ?? []).length;
    step('7r the generated cases run and pass', !!run3.cand && oks > 0 && diffs === 0, `ok ${oks}, DIFF ${diffs}; candidate "${outText.slice(0, 120)}"`);
  }

  // Act 7. The import: Hugo's twist, Mateo's idea, Hugo asks Milo; silence while Milo works; Mateo types the decorator.
  await say(lead, 'h33', 700);
  await say(cand, 'c35', 500);
  await say(lead, 'h34', 500);
  scene(8, 'The lead asks Milo to save the candidate some typing.', '');
  const nImport = milo.utterances;
  await padToEnd(cp, 0, true);
  await say(lead, 'h23', 200);
  const imported = A ? !!(await until(async () => { await padToEnd(cp, 0, true); return ((await padLines(cp))[0] ?? '').includes(LRU_IMPORT) || null; }, 30_000, 400)) : false;
  const importSaid = A ? await miloSays(nImport, 15_000) : false;
  if (A) step('5i Milo adds the import at the top', imported, `first line "${(await padLines(cp))[0] ?? ''}"; Milo said so=${importSaid}`);
  const wrapLine = say(cand, 'c27', 400);
  await sleep(2600);
  await typeAboveDef(cp, DECORATOR);
  await wrapLine;
  await say(lead, 'h35', 500);

  // Act 8. Goodbye (v1.2: no time check in the film).
  await say(lead, 'h39', 400);
  await say(cand, 'c24', 400); await say(lead, 'h21', 400); await say(cand, 'c25', 400);
  bye = say(lead, 'h22', 400);
  await nearEnd('h22', 1300);
  if (A) await miloState().catch((e) => note(`Milo's state at the end: ${String(e).slice(0, 120)}`));
  // --scripted: Milo's words, for the compose step's spoken stand-in (its tones replaced by a third TTS voice; never a real take).
  if (A && SCRIPTED) {
    timeline.film.scripted = true;
    const r = await lead.api.get(`${PORTAL}/api/calls/${encodeURIComponent(callId)}/chat?limit=100`).catch(() => null);
    const msgs = r && r.ok() ? ((await r.json().catch(() => ({}))).messages ?? []) : [];
    timeline.miloSaid = msgs.filter((m) => String(m.metadata?.kind ?? '').startsWith('assistant'))
      .map((m) => ({ text: squash(m.message ?? m.text ?? ''), at: m.timestamp ?? m.createdAt ?? m.sentAt ?? null })).filter((m) => m.text);
  }
  } // the round before --name-required
  clearInterval(watchDeck);

  // Act 9. After the call. End and its confirmation land as "have a great rest of your day" ends; Mateo's ended page is on screen
  // and held about a second (v1.4) before Hugo's one line (v1.2), which covers the ratings and the recap opening.
  await press(hp, hp.getByTestId('interview-end'), { pause: 150 });
  // The confirmation is on the footer's ask card, which a lead may have folded to its button (an answered suggestion): open it.
  // It opens by itself: open it by hand only when it has not shown within 3 s (a click while it is opening would close it).
  const endBtn = hp.getByTestId('interview-room-ask').getByRole('button', { name: /^End interview$/ });
  if (!(await endBtn.waitFor({ timeout: 3000 }).then(() => true, () => false))) await openAsk(hp);
  await press(hp, endBtn, { timeout: 10_000, pause: 150 });
  const endedAt = Date.now();
  await bye;
  clearInterval(watchLost);
  const at = (t) => (t === null ? 'never' : `${Math.round((t - timeline.film.fromMs) / 1000)} s into the film`);
  step('C the call held', lostSeen.lead === null && lostSeen.cand === null, `the lead's room said the call dropped: ${at(lostSeen.lead)}; the candidate's page: ${at(lostSeen.cand)}`);
  const candEnded = await cp.getByTestId('join-ended').first().waitFor({ timeout: 30_000 }).then(() => true, () => false);
  const endedSeenAt = Date.now();
  mark('candidate ended page');
  await sleep(1000);
  const endedStill = await cp.getByTestId('join-ended').first().isVisible().catch(() => false);
  const closingAt = Date.now();
  const sourced = say(lead, 'h29', 0);
  step('V the candidate\'s ended page shows before the closing line', candEnded && endedStill && endedSeenAt < closingAt,
    `ended page seen ${((endedSeenAt - endedAt) / 1000).toFixed(1)} s after End, held ${((closingAt - endedSeenAt) / 1000).toFixed(1)} s before Hugo's line; still on screen=${endedStill}`);
  await hp.waitForURL(new RegExp(`/interviews/rounds/${IV}/scorecard$`), { timeout: 20_000 }).catch(() => undefined);
  const onScorecard = /\/scorecard$/.test(new URL(hp.url()).pathname);
  if (!onScorecard) await hp.goto(`${PORTAL}/interviews/rounds/${IV}/scorecard`, { waitUntil: 'domcontentloaded' });
  await hp.getByTestId('interviews-scorecard-form').first().waitFor({ timeout: 30_000 });
  scene(9, 'Hugo scores; Milo only supplies evidence.', '');
  const scorecardText = squash(await hp.getByTestId('interviews-scorecard-form').first().innerText().catch(() => ''));
  // He rates each competency with the cursor (a brisker glide than elsewhere), then opens the recap, all under his line.
  const groups = hp.locator('[data-ui-control="rating"]');
  await groups.first().waitFor({ timeout: 30_000 }).catch(() => undefined);
  const nGroups = await groups.count();
  let rated = 0;
  for (let i = 0; i < nGroups; i += 1) {
    await press(hp, groups.nth(i).getByRole('radio', { name: /^3 / }).first(), { pause: 100, timeout: 5000, ms: 420 }).then(() => { rated += 1; }, (e) => note(`rating ${i}: ${String(e).slice(0, 100)}`));
  }
  // His Problem solving note, typed through the form, with the film's own minutes from the problem in the pad to the green run.
  const mins = Math.max(1, Math.round((solvedAt - problemAt) / 60_000));
  const minsWords = mins === 1 ? 'about a minute' : `about ${['two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'][mins - 2] ?? mins} minutes`;
  const psNoteText = NAME_REQUIRED ? 'Understood the problem, named brute force first, then a hash map, and explained the linear time when asked.' : `Understood the problem well and asked a clarifying question. Had a working solution in ${minsWords}; the first run failed on the duplicate case, and he explained and fixed it.`;
  const psNote = hp.getByTestId('interviews-scorecard-required').filter({ hasText: /Problem solving/ }).first().getByTestId('interviews-scorecard-note');
  const noted = await (async () => {
    await press(hp, psNote, { pause: 100, timeout: 5000, ms: 500 });
    await hp.keyboard.type(psNoteText, { delay: 22 });
    return (await psNote.inputValue()) === psNoteText;
  })().catch((e) => { note(`problem solving note: ${String(e).slice(0, 120)}`); return false; });
  step('N Hugo\'s Problem solving note typed through the form', noted, `"${psNoteText}" (${((solvedAt - problemAt) / 1000).toFixed(0)} s from the problem to the green run)`);
  try {
    await press(hp, hp.getByTestId('interviews-scorecard-to-recap'), { pause: 100, timeout: 10_000, ms: 500 });
    await press(hp, hp.getByTestId('interviews-scorecard-ask-option-open'), { pause: 100, timeout: 10_000, ms: 500 });
    await hp.getByTestId('interviews-scorecard-recap-step').first().waitFor({ timeout: 30_000 });
  } catch (e) { note(`recap step: ${String(e).slice(0, 120)}`); }
  const recapOk = await hp.getByTestId('interviews-recap-competency').first().waitFor({ timeout: 90_000 }).then(() => true, () => false);
  // Milo's recommendation pill stays on screen about 3 s and Hugo answers whatever it says.
  await sourced;
  const adviceBox = hp.getByTestId('interviews-scorecard-milo-advice').first();
  const adviceShown = await adviceBox.waitFor({ timeout: 20_000 }).then(() => true, () => false);
  const adviceText = adviceShown ? squash(await adviceBox.innerText().catch(() => '')) : '';
  if (adviceShown) {
    const shownAt = Date.now();
    await glide(hp, adviceBox, { pause: 300 });
    const verdict = /Don.t advance/i.test(adviceText) ? 'h41d' : /Inconclusive/i.test(adviceText) ? 'h41i' : /Advance/i.test(adviceText) ? 'h41a' : /No recommendation/i.test(adviceText) ? 'h41n' : null;
    if (verdict) await say(lead, verdict, 300);
    const held = Date.now() - shownAt; if (held < 3200) await sleep(3200 - held);
  }
  step('G Milo\'s recommendation on screen', adviceShown && /Milo recommends\s*(Advance|Inconclusive|Don.t advance)|Milo has no recommendation yet/i.test(adviceText), `pill "${adviceText.slice(0, 160)}"`);
  // The evidence sits under a closed "Milo's evidence" disclosure: open it, then a quote row.
  const evidence = hp.getByTestId('interviews-recap-evidence').first();
  if (await evidence.count()) await press(hp, evidence.getByText(/Milo.s evidence/).first(), { pause: 150, timeout: 5000 }).catch((e) => note(`evidence disclosure: ${String(e).slice(0, 100)}`));
  const claims = hp.getByTestId('interviews-recap-claim');
  const nClaims = await claims.count();
  if (nClaims) await press(hp, claims.first(), { timeout: 5000 }).catch(() => undefined);
  const recapText = squash(await hp.getByTestId('interviews-scorecard-recap-step').first().innerText().catch(() => ''));
  step('K the scorecard shows only the Coding round\'s competencies', !/System design/i.test(scorecardText) && /Problem solving/i.test(scorecardText), `scorecard reads "${scorecardText.slice(0, 200)}"`);
  const designSaid = Object.values(LINES).filter(([, t]) => /design/i.test(t));
  const designOn = Object.entries({ scorecard: scorecardText, recap: recapText, room: roomHead, prepare: prepText }).filter(([, s]) => /design/i.test(s)).map(([k, s]) => `${k} "…${s.slice(Math.max(0, s.search(/design/i) - 40), s.search(/design/i) + 20)}…"`);
  step('D nothing says design', designSaid.length === 0 && designOn.length === 0, `lines saying design: ${designSaid.length}; on screen: ${designOn.length ? designOn.join('; ') : 'none'}`);
  await hp.waitForTimeout(1000);
  timeline.film.toMs = Date.now();
  const ivState = (await (await lead.api.get(`${PORTAL}/api/interviews/interviews/${IV}`)).json()).interview?.state;
  step('11 end, scorecard', ivState === 'ended' && candEnded && rated > 0, `state ${ivState}; candidate ended page=${candEnded}; lead landed on the scorecard=${onScorecard}; ${rated} ratings`);
  if (A) {
    const recap = (await (await lead.api.get(`${PORTAL}/api/interviews/interviews/${IV}/recap`)).json().catch(() => ({}))).recap ?? {};
    const ps = (recap.competencies ?? []).find((c) => c.id === 'problem-solving');
    const quotes = (ps?.evidence ?? []).map((e) => e.source?.quote ?? '');
    if (!NAME_REQUIRED) step('12 the recap cites the Two Sum and testing answers', recapOk && !!ps && quotes.some((q) => /hash map|brute force|dictionary|duplicate case|two pointers|linear time/i.test(q)) && quotes.some((q) => /\btest\b|duplicates|negative/i.test(q)),
      // The screenplay asks for both answers cited. A competency no asked question was tagged with shows "Nothing was said about
      // this" (the scripted recap covers a competency only through its own questions: recap/model.ts scriptedRecap); listed, not failed.
      `recap opened=${recapOk}, ${nClaims} statements; problem solving quotes ${JSON.stringify(quotes.map((q) => q.slice(0, 70)))}; not covered ${JSON.stringify((recap.notCovered ?? []).map((c) => c.name))}`);
  }

  // The pad log and the runs, as the lead reads them: the language switch, a snapshot per run, both runs with their output.
  const log = (await (await lead.api.get(`${PORTAL}/api/interviews/interviews/${IV}/pad/log`)).json().catch(() => ({})));
  const evs = log.events ?? [];
  const kinds = evs.reduce((m, e) => ({ ...m, [e.kind]: (m[e.kind] ?? 0) + 1 }), {});
  // The runs as the record keeps them (the live runs list closes with the interview).
  const runs = ((await (await lead.api.get(`${PORTAL}/api/interviews/interviews/${IV}/record`)).json().catch(() => ({}))).record?.runs ?? []);
  const miloEdits = evs.filter((e) => (e.who?.side ?? e.side) === 'milo' && ['tests', 'imports'].includes(e.kind)).map((e) => e.kind);
  if (A && !NAME_REQUIRED) step('E Milo\'s edits credited to Milo', miloEdits.includes('tests') && miloEdits.includes('imports'), `pad log events on Milo's side: ${JSON.stringify(miloEdits)}`);
  if (!NAME_REQUIRED) step('P the pad log and the runs on the record', evs.some((e) => e.kind === 'language' && e.language === 'python') && (kinds.snapshot ?? 0) >= 2 && runs.length >= 2,
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
    if (!NAME_REQUIRED) step('T transcript, two speakers credited', hugoCredited && candCredited && wrong === 0, `lines ${lines.length} by side ${JSON.stringify(sides)}; Hugo credited=${hugoCredited}; candidate credited=${candCredited}; wrongly credited ${wrong}`);
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
  voiceLog?.end();
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

#!/usr/bin/env node
// "Design Twitter on the shared whiteboard": a short scripted film of a system design round, the coding film's sibling
// (scripts/demo/interviews-call-film.mjs). The lead (Hugo Marchetti) on the left, the candidate (Mateo Alvarez) on the right,
// both in the call; Mateo draws with Excalidraw's own tools (toolbar, mouse and keyboard) on the round's shared board and
// each side shows the other's named pointer. No Milo and no model: nobody is listening, so the lines (interviews-board-film-
// lines.json, synthesised beforehand by interviews-film-voices.py) are placed in the edit at the moment each was "said".
//
//   node scripts/demo/interviews-board-film.mjs --out <dir> --voices <dir> [--final <mp4>] [--rehearse] [--compose-only] [--milo]
//
// --milo: Milo is in the call for real, on the meeting assistant's live session (the provider; spends money, capped by
// --max-minutes, default 8). The provider key is read in this process from the file IVFILM_KEY_FILE names and handed only to the
// middleware's environment; IVFILM_MEDIA_ADMIN_TOKEN and IVFILM_SINK_SECRET as for the coding film. Each line is then also played
// into its speaker's microphone, so Milo hears the call, and a line that follows Milo starts when his voice ends (his audio frames
// as the candidate's browser receives them). The Milo beats: Mateo asks Milo how much time is left (time_left, allowed for a
// candidate); the coach's opening suggestion is answered "I'll ask it"; at "where to go deep" the coach's follow-up is in Hugo's
// footer and he presses Have Milo ask, Milo asks it aloud and Mateo answers it at the board; after End, the scorecard: Hugo's
// ratings, the red flags list, the recap with "Milo recommends" and its evidence (closed). Each Milo turn is measured in
// report.json (`turns`: the asking line's end to Milo's first audio, Milo's words from the call chat).
//
// The story: the recruiter assigns Mateo's System design round (POST /interviews), Hugo accepts it, it gets a time and Hugo
// chooses "Design Twitter" (q-be-twitter) in Prepare's route; Hugo starts the call, the candidate opens the link and is
// admitted (all before the film starts). On film: Hugo welcomes Mateo to his second round and puts the question's "Master
// template" board (the prompt, "Your design" with the components palette) on the board; Mateo reads the prompt and asks
// about reads and freshness; in "Your design" he types the functional and non-functional notes, copies components from
// the palette (Alt-drag) into the High-level design, joins them with arrows labelled "writes" and "reads", hesitates and
// drags the workers aside, notes the read-time merge and the services' purposes, asks where to go deep; Hugo picks the
// fan-out, and while Mateo walks it Hugo's side follows Mateo's view ("Following Mateo") and Hugo looks at the Provided
// design tab (lead only); Hugo ends the round and opens its record page's board (the closing board and the snapshot picker).
// The checks (report.json): after every drawing beat both sides hold the same number of elements; each side sees the other's
// named pointer; Hugo follows Mateo; the candidate's page holds nothing of the provided design; the record page shows the
// board as it closed.
// The stack, as for the coding film (its header): the media server and platform-api already running; this script starts its
// own mock middleware and portal (IVFILM_MW_PORT, IVFILM_PORTAL_PORT) and stops them. Env as the coding film's
// (IVFILM_MEDIA_URL, IVFILM_VIDEO_PUBLIC_URL, IVFILM_PLATFORM_PUBLIC_URL, IVFILM_PLATFORM_INTERNAL_URL, IVFILM_DYNAMODB).
// The edit is interviews-film-compose.py `compose`, unchanged.
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const OUT = flag('--out');
if (!OUT) { console.error('usage: interviews-board-film.mjs --out <dir> --voices <dir> [--final <mp4>] [--rehearse] [--compose-only]'); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });
const COMPOSE = path.join(ROOT, 'scripts', 'demo', 'interviews-film-compose.py');
const FINAL = flag('--final') ?? path.join(OUT, 'system-design.mp4');
const py = (...a) => new Promise((resolve) => spawn('python3', [COMPOSE, ...a], { stdio: 'inherit' }).on('exit', (c) => resolve(c ?? 1)));
if (args.includes('--compose-only')) process.exit(await py('compose', '--out', OUT, '--final', FINAL));
const REHEARSE = args.includes('--rehearse');
// --no-call (a check of the board alone, without a media server): the round is started by its route and nobody joins the call.
const NO_CALL = args.includes('--no-call');
const MILO = args.includes('--milo') && !NO_CALL;
// --handsfree (with --milo): the middleware runs Milo hands-free (MEETING_ASSISTANT_HANDSFREE=1); people talk to him by name, and
// Hugo holds the bar's talk button once.
const HANDSFREE = MILO && args.includes('--handsfree');
// --turn-owner (with --handsfree): the middleware runs MILO_TURN_OWNER=1, so the interviews call is heard and answered by the turn
// owner (floor, Decide, Act, Speak) in the hands-free runtime's place. The report says which path the take ran on.
const TURN_OWNER = HANDSFREE && args.includes('--turn-owner');
const MAX_MINUTES = Number(flag('--max-minutes') ?? 8);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MW_PORT = Number(process.env.IVFILM_MW_PORT || 4180);
const PORTAL_PORT = Number(process.env.IVFILM_PORTAL_PORT || 5280);
const PORTAL = `http://localhost:${PORTAL_PORT}`;
const MIDDLEWARE = `http://127.0.0.1:${MW_PORT}`;
const HUGO = 'u-hugo';
const GRETA = 'u-greta';
const APP = 'app-7b69njmx'; // Mateo Alvarez, Senior Backend Engineer
const ROUND = 'rd-design';
const QUESTION = 'q-be-twitter';

// ── Lines: the kept take of each, trimmed and levelled as the coding film does (LINE_LUFS) ──
const LINE_LUFS = -16;
const LINES = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'demo', 'interviews-board-film-lines.json'), 'utf8')).lines;
const VOICES = flag('--voices');
if (!VOICES && !REHEARSE) { console.error('film: --voices <dir> is required to record'); process.exit(2); }
const takes = VOICES ? JSON.parse(fs.readFileSync(path.join(VOICES, 'takes.json'), 'utf8')) : {};
const AUDIO = path.join(OUT, 'audio');
fs.mkdirSync(AUDIO, { recursive: true });
const ff = (...a) => execFileSync('ffmpeg', ['-y', '-v', 'error', ...a]);
const CLIPS = {};
for (const [id, t] of Object.entries(takes)) {
  if (!LINES[id]) continue;
  const file = path.join(AUDIO, `${id}.wav`); const trimmed = path.join(AUDIO, `${id}.trim.wav`);
  ff('-i', t.kept.file, '-af', 'silenceremove=start_periods=1:start_threshold=-50dB,areverse,silenceremove=start_periods=1:start_threshold=-50dB,areverse', '-ar', '48000', '-ac', '1', trimmed);
  const m = /I:\s+(-?[\d.]+) LUFS\s*\n\s*Threshold/.exec(spawnSync('ffmpeg', ['-nostats', '-hide_banner', '-i', trimmed, '-af', 'ebur128', '-f', 'null', '-'], { encoding: 'utf8' }).stderr ?? '');
  const gain = m ? Math.max(-12, Math.min(14, LINE_LUFS - Number(m[1]))) : 0;
  ff('-i', trimmed, '-af', `volume=${gain.toFixed(2)}dB,alimiter=limit=0.89:level=disabled`, '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', file);
  fs.rmSync(trimmed, { force: true });
  const secs = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]).toString().trim());
  CLIPS[id] = { who: t.who, text: t.text, file, durMs: Math.round(secs * 1000) };
}
console.log(`film: ${Object.keys(CLIPS).length} of ${Object.keys(LINES).length} lines have a take`);
if (!fs.existsSync(path.join(OUT, 'media', 'lead.y4m'))) { const c = await py('cameras', '--out', OUT); if (c) process.exit(c); }

// ── This film's middleware (mock world; Milo live only with --milo; the coach is the scripted stand-in) and portal ──
const answers = (port, host) => new Promise((resolve) => {
  const sock = net.connect({ port, host }); sock.setTimeout(1000);
  sock.once('connect', () => { sock.destroy(); resolve(true); });
  sock.once('timeout', () => { sock.destroy(); resolve(false); });
  sock.once('error', () => resolve(false));
});
for (const port of [MW_PORT, PORTAL_PORT]) {
  if ((await answers(port, '127.0.0.1')) || (await answers(port, '::1'))) { console.error(`port ${port} is in use; nothing was started.`); process.exit(2); }
}
const devMock = {};
for (const tok of JSON.parse(fs.readFileSync(path.join(ROOT, 'middleware', 'package.json'), 'utf8')).scripts['dev:mock'].split(/\s+/)) {
  const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(tok); if (!m) break; devMock[m[1]] = m[2].replace(/^\$\{[A-Z_]+:-(.*)\}$/, '$1');
}
/** --milo: the meeting assistant's settings, as the coding film's live take has them; the key read here, never printed. */
function miloEnv() {
  if (!MILO) return {};
  const need = (k) => { const v = process.env[k]; if (!v) { console.error(`film: --milo needs ${k}`); process.exit(2); } return v; };
  const line = fs.readFileSync(need('IVFILM_KEY_FILE'), 'utf8').split('\n').find((l) => /^\s*OPENAI_API_KEY\s*=/.test(l)) ?? '';
  const key = line.replace(/^\s*OPENAI_API_KEY\s*=\s*/, '').trim().replace(/^['"]|['"]$/g, '');
  if (!key) { console.error('film: no provider key in IVFILM_KEY_FILE'); process.exit(2); }
  return {
    OPENAI_API_KEY: key, MEETING_ASSISTANT_ENABLED: 'true', MEETING_ASSISTANT_LIVE: '1', ...(HANDSFREE ? { MEETING_ASSISTANT_HANDSFREE: '1' } : {}), MILO_TURN_OWNER: TURN_OWNER ? '1' : '0',
    MEETING_ASSISTANT_MAX_MINUTES: String(MAX_MINUTES), MEETING_ASSISTANT_HARD_MAX_MINUTES: String(MAX_MINUTES),
    MEETING_ASSISTANT_TRACE_FILE: path.join(WORK, 'trace.jsonl'),
    MEETING_ASSISTANT_MEDIA_URL: process.env.IVFILM_MEDIA_URL || 'http://127.0.0.1:3911',
    MEETING_ASSISTANT_MEDIA_ADMIN_TOKEN: need('IVFILM_MEDIA_ADMIN_TOKEN'),
    MEETING_ASSISTANT_SINK_BASE_URL: MIDDLEWARE, MEETING_ASSISTANT_SINK_SECRET: need('IVFILM_SINK_SECRET'),
    NODE_OPTIONS: `--require ${path.join(ROOT, 'scripts', 'meeting-assistant', 'lib', 'deadman.cjs')}`, MA_DEADMAN_MS: String(25 * 60_000),
  };
}
const started = [];
function start(name, argv, cwd, env) {
  const out = fs.openSync(path.join(WORK, `${name}.log`), 'w');
  const base = { ...process.env };
  for (const k of ['AWS_PROFILE', 'AWS_DEFAULT_PROFILE', 'AWS_SESSION_TOKEN', 'OPENAI_API_KEY']) delete base[k];
  const child = spawn(process.execPath, argv, { cwd, env: { ...base, ...env }, stdio: ['ignore', out, out], detached: true });
  started.push(child);
  console.log(`film: ${name} pid ${child.pid}`);
}
const stopAll = () => { for (const c of started.splice(0)) { try { process.kill(-c.pid, 'SIGTERM'); } catch { /* gone */ } } };
process.on('SIGINT', () => { stopAll(); process.exit(130); });
process.on('SIGTERM', () => { stopAll(); process.exit(143); });
const WORK = path.join(OUT, 'work');
fs.mkdirSync(WORK, { recursive: true });
const platform = process.env.IVFILM_PLATFORM_INTERNAL_URL || 'http://127.0.0.1:23011';
const dynamo = process.env.IVFILM_DYNAMODB || 'http://127.0.0.1:8011';
start('middleware', [path.join(ROOT, 'middleware', 'node_modules', '.bin', 'tsx'), 'src/index.ts'], path.join(ROOT, 'middleware'), {
  ...devMock, PORT: String(MW_PORT), VOICE_LOG_DIR: path.join(WORK, 'voice-log'), MOCK_PERSIST_PAIRINGS: '0', INSECURE_DEV_MODE: 'true',
  ORGIQ_PRESENCE_CONFIG: path.join(WORK, 'presence.json'), REALTIME_GATEWAY_URL: `http://localhost:${MW_PORT}`,
  SOCIAL_PLATFORM_INTERNAL_URL: platform, DOCUMENT_PLATFORM_INTERNAL_URL: platform,
  REALTIME_PLATFORM_PUBLIC_URL: process.env.IVFILM_PLATFORM_PUBLIC_URL || 'http://localhost:23011',
  REALTIME_VIDEO_PUBLIC_URL: process.env.IVFILM_VIDEO_PUBLIC_URL || 'http://localhost:3911',
  SOCIAL_CHAT_DYNAMODB_ENDPOINT: dynamo, DOCUMENT_COMMENT_IMPORT_DYNAMODB_ENDPOINT: dynamo, DOCUMENT_COMMENT_IMPORT_TABLE: 'document-comments',
  // No Bedrock: refused by these keys; the coach is the scripted stand-in. Milo's live session only with --milo (miloEnv).
  AWS_ACCESS_KEY_ID: 'film-blocks-bedrock', AWS_SECRET_ACCESS_KEY: 'film-blocks-bedrock', AWS_EC2_METADATA_DISABLED: 'true',
  INTERVIEWS_COACH_MODEL: 'scripted', OPENAI_API_KEY: '', ...miloEnv(),
});
start('portal', [path.join(ROOT, 'scripts', 'journeys', 'journey-vite.mjs'), '--port', String(PORTAL_PORT)], path.join(ROOT, 'portal'), {
  VITE_GATEWAY_URL: `http://localhost:${MW_PORT}`, API_PROXY_TARGET: MIDDLEWARE,
});
const until = async (fn, ms, every = 400) => { const end = Date.now() + ms; for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() > end) return null; await sleep(every); } };
const up = async (url) => until(async () => (await fetch(url)).status < 500, 180_000, 1000);
if (!(await up(`${MIDDLEWARE}/api/health`) && await up(`${PORTAL}/`))) { console.error('film: the stack did not come up; see work/*.log'); stopAll(); process.exit(2); }
const ceiling = setTimeout(() => { console.error('film: hard timeout (15 min)'); stopAll(); process.exit(3); }, 15 * 60_000);

const req = createRequire(path.join(ROOT, 'portal', 'package.json'));
const pw = await import(pathToFileURL(req.resolve('playwright')).href);
const chromium = pw.chromium ?? pw.default.chromium;
const { joinCall, letSound } = await import('../journeys/interviews/h8-room.mjs');

// ── The record ──
const VIEW = { width: 1280, height: 800 };
const timeline = { size: VIEW, videos: {}, film: { fromMs: null, toMs: null }, scenes: [], cuts: [], speech: [], labels: { lead: 'Hugo Marchetti (lead)', cand: 'Mateo Alvarez' } };
const report = { startedAt: new Date().toISOString(), turnOwner: TURN_OWNER, interview: null, steps: [], notes: [], turns: [], floorReads: {} };
const step = (id, ok, detail) => { report.steps.push({ id, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${id}: ${detail}`); };
const note = (s) => { report.notes.push(s); console.log(`note: ${s}`); };
// Scenes are numbered in the order they come (a --milo take has more of them).
const scene = (_n, title) => { const n = timeline.scenes.length + 1; timeline.scenes.push({ n, title, caption: '', atMs: Date.now() }); console.log(`scene ${n}: ${title}`); };
const at = () => (timeline.film.fromMs ? ((Date.now() - timeline.film.fromMs) / 1000).toFixed(1) : '-');

// ── The people: one Chromium each (its fake camera is a still card), recorded; the room pane opened wide for the board ──
const RAW = path.join(OUT, 'raw');
const browsers = [];
// The film's cursor (the coding film's amber ring), so the viewer sees each hand.
const CURSOR = () => {
  const put = () => {
    if (document.getElementById('__film-cursor')) return;
    const c = document.createElement('div'); c.id = '__film-cursor';
    Object.assign(c.style, { position: 'fixed', left: '-40px', top: '-40px', width: '24px', height: '24px', marginLeft: '-12px', marginTop: '-12px', borderRadius: '50%',
      background: 'rgba(245, 158, 11, 0.30)', border: '2px solid rgba(245, 158, 11, 0.95)', boxShadow: '0 0 16px 7px rgba(245, 158, 11, 0.45)', pointerEvents: 'none', zIndex: '2147483647' });
    document.documentElement.appendChild(c);
    addEventListener('mousemove', (e) => { c.style.left = `${e.clientX}px`; c.style.top = `${e.clientY}px`; }, true);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', put); else put();
  // Read-only view of an Excalidraw canvas on the page (its App component's state), for the checks and to aim the mouse.
  window.__board = (scope) => {
    const root = document.querySelector(`[data-testid="${scope}"] .excalidraw`);
    const key = root && Object.keys(root).find((k) => k.startsWith('__reactFiber$'));
    let f = key ? root[key] : null;
    while (f && !(f.stateNode?.scene && f.stateNode?.state?.zoom)) f = f.return;
    const app = f?.stateNode; if (!app) return null;
    const s = app.state; const els = app.scene.getNonDeletedElements();
    return { zoom: s.zoom.value, scrollX: s.scrollX, scrollY: s.scrollY, left: s.offsetLeft, top: s.offsetTop, width: s.width, height: s.height,
      count: els.length, texts: els.filter((e) => e.type === 'text').map((e) => e.text.replace(/\s+/g, ' ')),
      labels: els.filter((e) => e.type === 'text' && !e.containerId).map((e) => [e.text.replace(/\s+/g, ' '), e.x, e.y, e.width]),
      textAt: Object.fromEntries(els.filter((e) => e.type === 'text').map((e) => [e.text.replace(/\s+/g, ' '), [Math.round(e.x), Math.round(e.y)]]).reverse()),
      pointers: [...(s.collaborators?.values?.() ?? [])].filter((c) => c.pointer).map((c) => c.username) };
  };
};
// --milo: the page's microphone is a WebAudio stream; window.__filmSay(url) plays a line into it and resolves when it ends (the
// coding film's MIC). The camera stays Chromium's fake device.
const MIC = () => {
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
  window.__filmWarm = async () => {
    const d = ensure(); await ac.resume();
    const src = ac.createBufferSource(); src.buffer = ac.createBuffer(1, ac.sampleRate, ac.sampleRate); src.connect(d);
    await new Promise((resolve) => { src.onended = resolve; src.start(); });
  };
  window.__filmSay = async (url) => {
    const d = ensure(); await ac.resume();
    const buf = await ac.decodeAudioData(await (await fetch(url)).arrayBuffer());
    const src = ac.createBufferSource(); src.buffer = buf; src.connect(d);
    return new Promise((resolve) => { src.onended = () => resolve(buf.duration); src.start(); });
  };
};
async function person(key, userId) {
  const b = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required',
    `--use-file-for-fake-video-capture=${path.join(OUT, 'media', `${key}.y4m`)}`] });
  browsers.push(b);
  const context = await b.newContext({ viewport: VIEW, recordVideo: { dir: path.join(RAW, key), size: VIEW }, permissions: ['camera', 'microphone'] });
  if (userId && (await context.request.post(`${PORTAL}/api/session/login`, { data: { userId } })).status() !== 200) throw new Error(`login ${userId}`);
  await context.addInitScript(() => {
    try {
      for (const k of ['orgiq.call-prejoin.v1', 'interviews.guest-prejoin.v1']) localStorage.setItem(k, JSON.stringify({ micOn: true, cameraOn: true, remember: true }));
      // The room pane as wide as it goes (the person's own divider position), so the board gets the room.
      for (const k of ['shell.conversation-pane.ratio.interview-room', 'join.room-pane.ratio.interview-room']) localStorage.setItem(k, '0.4');
    } catch { /* none */ }
  });
  await context.addInitScript(CURSOR);
  if (MILO) {
    await context.addInitScript(MIC);
    await context.route(`${PORTAL}/__film-audio/**`, (route) => route.fulfill({ path: path.join(AUDIO, path.basename(new URL(route.request().url()).pathname)), contentType: 'audio/wav' }));
  }
  const page = await context.newPage();
  timeline.videos[key] = { startMs: Date.now(), file: null };
  const p = { key, context, page, api: context.request, errors: [] };
  page.on('pageerror', (e) => p.errors.push(e.message.slice(0, 160)));
  // Milo's floor is pushed after one read: every GET of an assistant `/floor` is logged so repeats show up.
  page.on('request', (r) => { if (r.method() === 'GET' && /\/floor(\?|$)/.test(new URL(r.url()).pathname + (new URL(r.url()).search ? '?' : ''))) (report.floorReads[key] ??= []).push({ atS: Number(((Date.now() - (timeline.film?.fromMs ?? Date.now())) / 1000).toFixed(1)), path: new URL(r.url()).pathname }); });
  return p;
}

/** A line: its clip is placed in the edit now; resolves when it would end. Lines never overlap. */
const busy = { until: 0 };
async function say(id, gapMs = 350, { now = false } = {}) {
  const wait = now ? 0 : busy.until + gapMs - Date.now(); if (wait > 0) await sleep(wait);
  const c = CLIPS[id] ?? { who: LINES[id][0], text: LINES[id][1], file: null, durMs: 900 + 62 * LINES[id][1].length };
  const atMs = Date.now();
  timeline.speech.push({ id, who: c.who, text: c.text, file: c.file ? path.relative(OUT, c.file) : null, atMs, durMs: c.durMs });
  busy.until = atMs + c.durMs;
  console.log(`  [${at()}] ${c.who}: ${c.text}`);
  const p = c.who === 'hugo' ? lead : cand;
  if (MILO && c.file && p) {
    await p.page.evaluate((u) => window.__filmSay(u), `${PORTAL}/__film-audio/${id}.wav`).catch((e) => note(`line ${id} did not play: ${String(e).slice(0, 120)}`));
    busy.until = Math.max(busy.until, Date.now());
  } else await sleep(c.durMs);
}
/** Waits until line `id` is `leadMs` from its end. */
async function nearEnd(id, leadMs) {
  const s = await until(async () => timeline.speech.findLast((x) => x.id === id) ?? null, 15_000, 40);
  if (s) { const w = s.atMs + s.durMs - leadMs - Date.now(); if (w > 0) await sleep(w); }
}

// ── Milo (--milo): his voice as the candidate's browser receives it, his words in the call chat, the coach's footer deck ──
let callId = null;
const deckWatch = { stop: false };
const voiceLog = MILO ? fs.createWriteStream(path.join(OUT, 'assistant-voice.jsonl')) : null;
const milo = { frames: 0, utterances: 0, cur: null, lastStartMs: 0 };
timeline.milo = [];
function keepMiloVoice(page) {
  page.on('websocket', (ws) => ws.on('framereceived', ({ payload }) => {
    if (typeof payload !== 'string' || !payload.includes('assistant-audio')) return;
    let f; try { f = JSON.parse(payload); } catch { return; }
    if (f?.type !== 'assistant-audio' || typeof f.data?.pcm !== 'string') return;
    const now = Date.now();
    milo.frames += 1;
    const c = milo.cur;
    if (!c || c.done || c.runId !== f.data.runId || f.data.seq !== c.seq + 1 || now - (c.lastAtMs ?? now) > 1500) { milo.cur = { runId: f.data.runId, seq: f.data.seq, startMs: now, ms: 0, done: false }; milo.utterances += 1; milo.lastStartMs = now; timeline.milo.push(milo.cur); }
    const u = milo.cur;
    u.seq = f.data.seq; u.done = f.data.last === true; u.lastAtMs = now;
    u.ms += (Buffer.from(f.data.pcm, 'base64').length / 2 / (f.data.sampleRate || 24000)) * 1000;
    busy.until = Math.max(busy.until, u.startMs + u.ms);
    voiceLog?.write(`${JSON.stringify({ atMs: now, runId: f.data.runId, seq: f.data.seq, sampleRate: f.data.sampleRate, last: f.data.last === true, pcm: f.data.pcm })}\n`);
  }));
}
/** Waits until Milo has said something new (an utterance after `n`) and finished it; → true when he did. */
async function miloSays(n, ms) {
  if (!(await until(async () => milo.utterances > n, ms, 100))) return false;
  const quiet = async () => (Date.now() > busy.until + 120 && Date.now() - (milo.cur?.lastAtMs ?? 0) > 600 ? true : null);
  await until(quiet, 60_000, 60);
  // --handsfree: one answer can come as two utterances (the model's first words, then the server's held answer said over them),
  // so a short settle: an utterance starting within 1 s belongs to the same answer.
  for (let k = milo.utterances; HANDSFREE && (await until(async () => (milo.utterances > k ? true : null), 1000, 50)); k = milo.utterances) {
    await until(quiet, 60_000, 60);
  }
  return true;
}
/** Milo's posts in the call chat (his words, as captioned), oldest first. */
async function miloPosts() {
  if (!callId) return [];
  const r = await lead.api.get(`${PORTAL}/api/calls/${encodeURIComponent(callId)}/chat?limit=100`).catch(() => null);
  if (!r?.ok()) return [];
  return ((await r.json().catch(() => ({}))).messages ?? []).filter((m) => String(m.metadata?.kind ?? '').startsWith('assistant')).map((m) => String(m.message ?? m.text ?? m.body ?? ''));
}
/** One Milo turn, measured: the asking line's end to Milo's first audio, and what he said (his new post). */
async function turn(kind, asker, asked, endMs, n, posts0, spoke) {
  const u = timeline.milo[n] ?? null;
  const said = spoke ? ((await until(async () => { const p = await miloPosts(); return p.length > posts0 ? p.slice(posts0).join(' | ') : null; }, 6000, 400)) ?? '') : '';
  const t = { kind, asker, asked, askedEndS: Number(((endMs - timeline.film.fromMs) / 1000).toFixed(1)), spoke,
    firstAudioS: u ? Number(((u.startMs - timeline.film.fromMs) / 1000).toFixed(1)) : null, latencyS: u ? Number(((u.startMs - endMs) / 1000).toFixed(1)) : null,
    voiceS: u ? Number((u.ms / 1000).toFixed(1)) : null, said };
  report.turns.push(t);
  console.log(`milo turn ${kind}: ${JSON.stringify(t)}`);
  return t;
}
/** --handsfree: a line said to Milo by voice, and his answer measured (the line's end to his first audio). */
async function askByVoice(kind, asker, id, how, expect, ms = 20_000) {
  const n = milo.utterances; const posts0 = (await miloPosts()).length;
  await say(id, 300);
  const endMs = Date.now();
  const spoke = await miloSays(n, ms);
  const t = await turn(kind, asker, LINES[id][1], endMs, n, posts0, spoke);
  t.how = how; t.right = spoke && expect.test(t.said);
  return t;
}
/** --handsfree: Hugo talks over Milo's utterance `n` about 2.5 s in ("Okay, thanks, that's enough"); measured to his silence. */
const BARGE_ON = flag('--barge-on') ?? 'cand';
async function bargeOver(n) {
  const u = timeline.milo[n];
  await sleep(Math.max(0, u.startMs + 2500 - Date.now()));
  if (u.done) { note('Milo finished before the barge-in could start'); return null; }
  const startMs = Date.now();
  const x01 = say('x01', 0, { now: true });
  await until(async () => (u.done || (u.lastAtMs && Date.now() - u.lastAtMs > 700) ? true : null), 12_000, 50);
  const barge = { on: BARGE_ON, startS: Number(((startMs - timeline.film.fromMs) / 1000).toFixed(1)), lastFrameAfterS: Number((((u.lastAtMs ?? startMs) - startMs) / 1000).toFixed(2)),
    playoutEndAfterS: Number(((u.startMs + u.ms - startMs) / 1000).toFixed(2)), closed: u.done, voiceS: Number((u.ms / 1000).toFixed(1)) };
  await x01;
  await until(async () => Date.now() > busy.until + 120, 30_000, 60);
  return barge;
}
/** --handsfree: Hugo holds the bar's talk button through line `id`, then lets go; his answer measured from the release. */
async function askByHold(kind, id, expect) {
  const btn = lead.page.getByTestId('assistant-bar-hold').first();
  const b = await btn.boundingBox({ timeout: 8000 }).catch(() => null);
  if (!b) { note('no hold-to-talk button in Hugo\'s bar'); return null; }
  await moveTo(lead.page, b.x + b.width / 2, b.y + b.height / 2, 700);
  const n = milo.utterances; const posts0 = (await miloPosts()).length;
  await sleep(Math.max(0, busy.until + 300 - Date.now()));
  await lead.page.mouse.down();
  const holding = await until(async () => ((await lead.page.getByTestId('assistant-bar').first().getAttribute('data-holding').catch(() => null)) === 'true' ? true : null), 3000, 100);
  report.holdAtS = Number(((Date.now() - timeline.film.fromMs) / 1000).toFixed(1));
  const line = say(id, 0, { now: true });
  // Both seats during the hold: the "<who> is talking to Milo" chip, the bar's floor holder, and the ring on the speaker's tile (each framed once).
  const seat = async (p, bar) => {
    await until(async () => ((await p.page.getByTestId(`${bar}-floor`).first().isVisible().catch(() => false)) ? true : null), 2500, 100);
    const r = { chip: squash(await p.page.getByTestId(`${bar}-floor`).first().textContent({ timeout: 500 }).catch(() => '')),
      floor: await p.page.getByTestId(bar).first().getAttribute('data-floor').catch(() => null),
      rings: await p.page.getByTestId('tile-highlight-ring').evaluateAll((els) => els.filter((e) => e.getBoundingClientRect().width > 0).length).catch(() => -1),
      atS: Number(((Date.now() - timeline.film.fromMs) / 1000).toFixed(1)) };
    await p.page.screenshot({ path: path.join(OUT, `hold-${p.key}.png`) }).catch(() => {});
    return r;
  };
  const [cl, cc] = await Promise.all([seat(lead, 'assistant-bar'), seat(cand, 'guest-milo-requests')]);
  const chips = { lead: cl, cand: cc };
  await line;
  await sleep(300);
  await lead.page.mouse.up();
  const relMs = Date.now();
  let barge = null;
  if (BARGE_ON === 'hold' && (await until(async () => (milo.utterances > n ? true : null), 15_000, 50))) { barge = await bargeOver(n); report.barge = barge; }
  const spoke = barge ? true : await miloSays(n, 20_000);
  const t = await turn(kind, 'lead (hold)', LINES[id][1], relMs, n, posts0, spoke);
  t.how = 'hold'; t.right = spoke && expect.test(t.said); t.holding = !!holding; t.chips = chips; t.barge = barge;
  return t;
}
const deckOf = (page) => page.getByTestId('interview-room-ask');
const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
// The suggestion waits as a button on the footer's row (nothing is drawn above the row): the lead opens it to read and answer it.
const openAsk = async (page) => { if (!(await deckOf(page).isVisible().catch(() => false))) await page.getByTestId('interview-room-ask-open').click({ timeout: 1500 }).catch(() => undefined); };
const deckShown = async (page) => { await openAsk(page); return (await deckOf(page).getByRole('button', { name: /have milo ask/i }).isVisible().catch(() => false)) ? squash(await deckOf(page).innerText()) : null; };

// ── Hands: the mouse at a hand's pace, the keyboard ──
const cursorAt = new Map();
async function moveTo(page, x, y, ms = 450) {
  const [x0, y0] = cursorAt.get(page) ?? [VIEW.width * 0.7, VIEW.height * 0.6];
  const t0 = Date.now();
  for (;;) {
    const t = Math.min(1, (Date.now() - t0) / ms); const e = t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2;
    await page.mouse.move(x0 + (x - x0) * e, y0 + (y - y0) * e);
    if (t >= 1) break;
    await sleep(16);
  }
  cursorAt.set(page, [x, y]);
}
async function press(page, locator, { pause = 300, ms = 500, timeout = 30_000 } = {}) {
  await locator.waitFor({ timeout });
  const box = await locator.boundingBox({ timeout: 3000 }).catch(() => null);
  if (box) { await moveTo(page, box.x + box.width / 2, box.y + box.height / 2, ms); await page.waitForTimeout(pause); }
  await locator.click({ timeout });
}

// ── The board, as each person sees it ──
const CANVAS = 'interview-board-canvas';
const board = (page, scope = CANVAS) => page.evaluate((s) => window.__board(s), scope).catch(() => null);
/** Scene point → the page's pixels, by the canvas's own scroll and zoom. */
const px = (v, sx, sy) => [(sx + v.scrollX) * v.zoom + v.left, (sy + v.scrollY) * v.zoom + v.top];
const TOOLBAR_H = 70; // Excalidraw's tool island over the canvas's top
/** Brings the scene rectangle [x0, y0, x1, y1] into view with the wheel (Ctrl + wheel to zoom, the wheel to pan), as a hand does. */
// The drawer's canvas keeps Excalidraw's shape properties panel on its left while a tool is in hand: the camera puts the
// target to the right of it (`reserve` px), so no stroke starts on the panel.
async function camera(page, [x0, y0, x1, y1], maxZoom = 1.3, reserve = 0) {
  let v = await board(page); if (!v) { note(`camera: no board on ${page === lead?.page ? 'lead' : 'cand'}`); return; }
  const cx = v.left + reserve + (v.width - reserve) / 2; const cy = v.top + TOOLBAR_H + (v.height - TOOLBAR_H) / 2;
  await moveTo(page, cx, cy, 350);
  const zt = Math.min(maxZoom, (v.width - reserve) / (x1 - x0), (v.height - TOOLBAR_H) / (y1 - y0));
  await page.keyboard.down('Control');
  for (let i = 0; i < 60 && Math.abs(v.zoom - zt) > 0.02; i++) {
    await page.mouse.wheel(0, Math.max(-10, Math.min(10, (v.zoom - zt) * 100))); await sleep(25);
    v = await board(page);
  }
  await page.keyboard.up('Control');
  // Then pan: the wheel moves the scene by delta / zoom.
  const tx = (cx - v.left) / v.zoom - (x0 + x1) / 2; const ty = (cy - v.top) / v.zoom - (y0 + y1) / 2;
  const dx = -(tx - v.scrollX) * v.zoom; const dy = -(ty - v.scrollY) * v.zoom;
  for (let i = 0; i < 12; i++) { await page.mouse.wheel(dx / 12, dy / 12); await sleep(30); }
}
/** Picks one of Excalidraw's tools from its toolbar (the key when the toolbar button is not on screen). */
async function tool(page, name, key) {
  const b = page.getByTestId(CANVAS).locator(`label:has([data-testid="toolbar-${name}"])`).first(); // the radio's label takes the click
  if (await b.isVisible().catch(() => false)) await press(page, b, { pause: 120, ms: 280 }); else await page.keyboard.press(key);
}
/** An arrow from one shape to another: the arrow tool and a drag between points inside them (Excalidraw binds both ends). */
async function arrow(page, [sx, sy], [ex, ey]) {
  await tool(page, 'arrow', 'a');
  const v = await board(page);
  const [ax, ay] = px(v, sx, sy); const [bx, by] = px(v, ex, ey);
  await moveTo(page, ax, ay, 300); await page.mouse.down(); await moveTo(page, bx, by, 380); await page.mouse.up();
  await page.keyboard.press('Escape');
  await sleep(100);
}
/** Drags a shape by a point inside it, with the selection tool. */
async function drag(page, [sx, sy], [ex, ey]) {
  await tool(page, 'selection', 'v');
  const v = await board(page);
  const [ax, ay] = px(v, sx, sy); const [bx, by] = px(v, ex, ey);
  await moveTo(page, ax, ay, 400); await page.mouse.down(); await sleep(150); await moveTo(page, bx, by, 900); await page.mouse.up();
  await page.keyboard.press('Escape');
}
/** Both sides hold the same elements (by count) within a few seconds of a beat; `min` is what the beat must have reached. */
async function same(id, label, min) {
  const r = await until(async () => { const [a, b] = [await board(lead.page), await board(cand.page)]; return a && b && a.count === b.count && a.count >= min ? [a, b] : null; }, 8000, 250);
  const [a, b] = r ?? [await board(lead.page), await board(cand.page)];
  if (NO_CALL) await cand.page.screenshot({ path: path.join(OUT, `beat-${id.split(' ')[0]}.png`) }).catch(() => undefined);
  step(id, !!r, `${label}: lead ${a?.count ?? '?'} elements, candidate ${b?.count ?? '?'} (at least ${min} expected)`);
  return a?.count ?? min;
}

// ── The board's plan, in scene units: the question's "Master template" board (middleware/src/lib/interviews/board/
// templates.ts masterBoard, with the palette): the prompt (part A) at x 0..620, "Your design" (part B) from x 700, its
// High-level design frame at 700..1700 × 130..1620 with the palette's twelve components in two rows at the top, and the
// written sections (Purpose(s) of each service, API signatures, Data model, the questions) in a column at x 1760..2400.
// The positions are the template's own, moved by where the board's title actually landed (ORIGIN).
const ICON = { w: 100, h: 64 };
/** A palette component's icon box (its top-left corner), by its column and row in the palette. */
const pal = (col, row) => [749 + col * 150, 220 + row * 140];
const PALETTE = { web: pal(0, 0), lb: pal(3, 0), app: pal(4, 0), cache: pal(0, 1), queue: pal(1, 1), workers: pal(2, 1), db: pal(3, 1) };
/** Where each copy goes in the drawing area under the palette (its icon's top-left corner). */
const PLACE = { web: [740, 640], lb: [920, 640], app: [1100, 640], cache: [1300, 640], db: [1100, 820], queue: [1300, 820], workers: [1500, 820] };
const NOTES = { functional: [724, 552], nonfunctional: [724, 608], bigAccounts: [900, 1000], purposes: [1784, 272] };
const VIEW_PALETTE = [700, 200, 1700, 940]; // the palette and the drawing area under it
const VIEW_DRAWING = [700, 530, 1700, 1100]; // the drawing area alone
const VIEW_PURPOSES = [1700, 120, 2420, 470];
const VIEW_PROMPT = [-30, -20, 1000, 700];
let ORIGIN = [0, 0];
const o = ([x, y]) => [x + ORIGIN[0], y + ORIGIN[1]];
/** Where an arrow starts or ends on each copy (icon-relative points inside its shapes, so Excalidraw binds the arrow). */
const ANCHOR = { web: { r: [90, 40] }, lb: { l: [26, 40], r: [76, 40] }, app: { l: [12, 32], r: [90, 32], b: [50, 58], br: [88, 58], c: [50, 32] },
  db: { t: [50, 20] }, cache: { l: [20, 32], br: [78, 50], c: [50, 32] }, queue: { l: [16, 32], r: [84, 32] }, workers: { l: [20, 25], tr: [66, 10], c: [46, 30], b: [50, 50] } };
const box = (k, where = 'c') => { const [x, y] = o(PLACE[k]); const [dx, dy] = ANCHOR[k][where] ?? [ICON.w / 2, ICON.h / 2]; return [x + dx, y + dy]; };
/** The copy of a palette component (by its label) lowest on the board: its icon's top-left corner. */
const lowest = (v, label) => (v?.labels ?? []).filter((l) => l[0] === label).map(([, x, y, w]) => [Math.round(x + w / 2 - ICON.w / 2), Math.round(y - 72)]).sort((a, b) => b[1] - a[1])[0] ?? null;
const region = ([x0, y0, x1, y1]) => [x0 + ORIGIN[0], y0 + ORIGIN[1], x1 + ORIGIN[0], y1 + ORIGIN[1]];

/** A palette component copied into the drawing area: Alt held, a press on the component, a drag to its place (Excalidraw
 *  duplicates the selection on an Alt-drag; a press on a grouped component selects the whole group). */
async function copyFromPalette(page, k) {
  await tool(page, 'selection', 'v');
  const v = await board(page);
  const [sx, sy] = o(PALETTE[k]); const [tx, ty] = o(PLACE[k]);
  const [ax, ay] = px(v, sx + ICON.w / 2, sy + ICON.h / 2); const [bx, by] = px(v, tx + ICON.w / 2, ty + ICON.h / 2);
  await moveTo(page, ax, ay, 300);
  await page.keyboard.down('Alt');
  await page.mouse.down(); await sleep(80); await moveTo(page, bx, by, 520); await page.mouse.up();
  await page.keyboard.up('Alt');
  await page.keyboard.press('Escape');
  await sleep(60);
}
/** An arrow between two components with a label typed on it (Excalidraw's own: a double-click on the arrow). */
async function labelledArrow(page, from, to, label) {
  await arrow(page, from, to);
  if (!label) return;
  await tool(page, 'selection', 'v');
  const v = await board(page);
  const [mx, my] = px(v, (from[0] + to[0]) / 2, (from[1] + to[1]) / 2);
  await moveTo(page, mx, my, 200);
  await page.mouse.dblclick(mx, my);
  await sleep(120);
  await page.keyboard.type(label, { delay: 30 });
  await page.keyboard.press('Escape');
  await sleep(80);
}
/** A note typed on the board: the text tool, a click where it goes, the words, Escape. */
async function note2(page, [x, y], text) {
  await tool(page, 'text', 't');
  const v = await board(page);
  const [ax, ay] = px(v, x, y);
  await moveTo(page, ax, ay, 300); await page.mouse.click(ax, ay); await sleep(100);
  for (const [i, part] of text.split('\n').entries()) { if (i) await page.keyboard.press('Enter'); await page.keyboard.type(part, { delay: 22 }); }
  await page.keyboard.press('Escape');
  await sleep(80);
}
/** Lines said back to back while the hands work; resolves when both are done. */
async function beat(ids, work, gapMs = 250) {
  const talk = (async () => { for (const [i, id] of ids.entries()) await say(id, i ? 200 : gapMs); })();
  await Promise.all([talk, work ? work() : null]);
}

let lead; let cand; let greta; let IV = null;
try {
  greta = { api: await (pw.request ?? pw.default.request).newContext() };
  if ((await greta.api.post(`${PORTAL}/api/session/login`, { data: { userId: GRETA } })).status() !== 200) throw new Error('login the recruiter');
  lead = await person('lead', HUGO);
  const hp = lead.page;
  hp.on('request', (rq) => { const m = /\/api\/calls\/([^/?]+)\//.exec(new URL(rq.url()).pathname); if (m && !callId && m[1] !== 'null') callId = decodeURIComponent(m[1]); });
  const api = (p) => `${PORTAL}/api/interviews/interviews${p}`;
  const row = async () => (await (await lead.api.get(api(`/${IV}`))).json()).interview;

  // 0. Before the day (not filmed), through the product's routes: the recruiter assigns Mateo's System design round to Hugo,
  // Hugo accepts it, it gets a time, and Hugo chooses Design Twitter in Prepare.
  const made = await greta.api.post(api(''), { data: { applicationId: APP, roundId: ROUND, leadId: HUGO, panelIds: [] } });
  IV = (await made.json().catch(() => ({}))).interview?.id ?? null;
  report.interview = IV;
  if (!IV) throw new Error(`assign: ${made.status()}`);
  const notice = await (await lead.api.get(api('/panel-notice'))).json().catch(() => ({}));
  if (notice.acknowledged === false && notice.notice?.version) await lead.api.post(api(`/${IV}/panel-notice`), { data: { version: notice.notice.version } });
  const acc = await lead.api.post(api(`/${IV}/answer`), { data: { revision: (await row()).revision, answer: 'accept' } });
  const when = new Date(Math.ceil((Date.now() + 5 * 60_000) / 60_000) * 60_000).toISOString();
  const timed = await greta.api.put(api(`/${IV}/time`), { data: { revision: (await row()).revision, scheduledAt: when } });
  const prep = await lead.api.put(api(`/${IV}/questions`), { data: { revision: (await row()).revision, questionIds: [QUESTION] } });
  const chosen = ((await prep.json().catch(() => ({}))).interview?.questionsChosen ?? []).map((q) => q.id);
  step('0 round scheduled and prepared', made.status() === 201 && acc.status() === 200 && timed.status() === 200 && chosen.join() === QUESTION,
    `assign ${made.status()} (${IV}); accept ${acc.status()}; time ${timed.status()}; questions ${prep.status()} ${JSON.stringify(chosen)}`);

  // Hugo opens the room and starts the call; the recruiter's link; the candidate's door; admitted; both in the call.
  await hp.goto(`${PORTAL}/interviews/rounds/${IV}/room`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await hp.getByTestId('interview-room').first().waitFor({ timeout: 60_000 });
  // --milo: the round is started by the API and Hugo joins the call only once the candidate has consented, so the coach's first
  // read already sees the consent (a read before it backs off two minutes).
  if (NO_CALL || MILO) await lead.api.post(api(`/${IV}/start`), { data: { revision: (await row()).revision } }); else await joinCall(hp);
  await until(async () => ((await row()).state === 'live' ? true : null), 20_000, 1000);
  const link = (await (await greta.api.post(api(`/${IV}/invite`), { data: {} })).json().catch(() => ({}))).linkPath;
  if (!link) throw new Error('no invite link');
  cand = await person('cand', null);
  if (MILO) keepMiloVoice(cand.page);
  const cp = cand.page;
  await cp.goto(`${PORTAL}${link}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await cp.getByTestId('join-continue').first().click({ timeout: 15_000 }).catch(() => undefined);
  await cp.getByTestId('join-consents').waitFor({ timeout: 30_000 });
  for (const part of ['recording', 'transcription', 'milo']) await cp.getByTestId(`join-consent-${part}-choice`).locator('label').filter({ hasText: /^Yes$/ }).first().click({ timeout: 5000 });
  await cp.getByTestId('join-consents-continue').click({ timeout: 8000 });
  await cp.getByTestId('join-devices-continue').click({ timeout: 30_000 });
  await hp.getByTestId('interview-room-ask').getByRole('button', { name: /^Admit$/ }).first().click({ timeout: 30_000 })
    .catch(async (e) => { if (!MILO) throw e; note('Admit not on the page before the call; admitted by the API'); await lead.api.post(api(`/${IV}/admit`), { data: { admit: true } }); });
  if (MILO && !NO_CALL) await joinCall(hp);
  const join = cp.getByTestId('join-room-bar-start').or(cp.getByTestId('join-room-bar-join')).or(cp.getByTestId('join-room-bar').getByRole('button', { name: /join|start/i })).first();
  await join.waitFor({ timeout: 30_000 });
  if (!NO_CALL) {
    await until(async () => !(await join.isDisabled()), 10_000, 250);
    await join.click();
    await cp.getByRole('button', { name: 'Join now', exact: true }).first().click({ timeout: 2000 }).catch(() => undefined);
  }
  const cams = (pg) => pg.evaluate(() => [...document.querySelectorAll('video')].filter((v) => v.videoWidth > 0 && v.readyState >= 2).length).catch(() => 0);
  const tiles = NO_CALL || await until(async () => ((await cams(hp)) >= 2 && (await cams(cp)) >= 2 ? true : null), 30_000, 300);
  const synced = (pg) => pg.locator('[data-testid="interview-board"][data-connection="synced"]').first().waitFor({ timeout: 30_000 }).then(() => true, () => false);
  const [ls, cs] = [await synced(hp), await synced(cp)];
  await until(async () => (await board(hp)) && (await board(cp)), 20_000, 300);
  const [lv, cv] = [await board(hp), await board(cp)];
  step('1 both in the call, the board open and in sync on both sides', !!tiles && ls && cs && !!lv && !!cv,
    `camera tiles ${await cams(hp)}/${await cams(cp)}; board synced lead=${ls} candidate=${cs}; canvas lead ${Math.round(lv?.width)}x${Math.round(lv?.height)}, candidate ${Math.round(cv?.width)}x${Math.round(cv?.height)}`);
  // --milo: Hugo invites Milo and turns his voice on before the film starts (the footer's own controls).
  let A = null;
  const booked = { listeningSeconds: null };
  const miloState = async () => {
    const r = await lead.api.get(A('state'));
    const body = r.ok() ? await r.json().catch(() => ({})) : {};
    if (typeof body.listeningSeconds === 'number') booked.listeningSeconds = body.listeningSeconds;
    return body;
  };
  if (MILO) {
    for (const pg of [hp, cp]) { await pg.evaluate(() => window.__filmWarm?.()).catch(() => undefined); await letSound(pg); }
    await press(hp, hp.getByTestId('assistant-invite').first(), { timeout: 15_000 });
    const goAhead = hp.getByTestId('assistant-budget-ask').getByRole('button', { name: /go ahead/i });
    if (await goAhead.waitFor({ timeout: 2000 }).then(() => true, () => false)) await press(hp, goAhead);
    await until(async () => callId, 10_000);
    A = (rest) => `${PORTAL}/api/calls/${encodeURIComponent(callId)}/assistant/${rest}`;
    const listening = await until(async () => ((await miloState()).state === 'listening' ? true : null), 40_000, 1000);
    await press(hp, hp.getByTestId('assistant-status-mark').first(), { timeout: 10_000 }).catch(() => undefined);
    await press(hp, hp.getByRole('menuitem', { name: /Turn Milo's voice on/ }), { timeout: 10_000 }).catch(() => undefined);
    let voiceOn = await until(async () => ((await miloState()).voice === true ? true : null), 10_000, 500);
    if (!voiceOn) { const r = await lead.api.post(A('voice'), { data: { on: true } }); note(`voice on from the footer did not take; by the API ${r.status()}`); voiceOn = (await miloState()).voice === true; }
    for (const pg of [hp, cp]) await letSound(pg);
    step('M Milo listening, voice on', !!listening && !!voiceOn, `Milo listening=${!!listening}; voice on=${!!voiceOn}; call ${callId}`);
    if (!listening) throw new Error('Milo is not listening');
  }
  await sleep(1500);

  // ── On film ──
  timeline.film.fromMs = Date.now() - 600;
  scene(1, 'Mateo\'s second round: system design, with Hugo.');
  const insert = hp.getByTestId('interview-board-insert').first();
  const i01 = say('i01', 0);
  await press(hp, insert, { pause: 400 });
  await press(hp, hp.getByRole('menuitem', { name: /Master template/ }).first(), { pause: 350 });
  await i01;
  await say('i02', 300);
  if (HANDSFREE) {
    const t = await askByHold('introduce', 'h00', /Milo|assistant/i);
    step('H Hugo holds the talk button; Milo introduces himself', !!t?.right && t.holding, t ? `holding=${t.holding}; chips ${JSON.stringify(t.chips)}; ${t.latencyS ?? '-'} s after the release; said "${t.said.slice(0, 120)}"` : 'no hold button');
  }
  const i03 = say('i03', 300);
  // The coach's first suggestion (the round's own question, before anyone said it): Hugo asks it himself.
  if (MILO) {
    const first = await until(deckShown.bind(null, hp), 4000, 400);
    if (first) await press(hp, deckOf(hp).getByRole('button', { name: /^I.ll ask it$/i }).first(), { pause: 300 }).catch((e) => note(`first suggestion: ${String(e).slice(0, 80)}`));
    note(`the coach's first suggestion by "It's a classic": ${first ? `"${first.slice(0, 100)}", answered I'll ask it` : 'none yet'}`);
    // Until "where to go deep", any other suggestion is the one Hugo asks himself (a waiting one would hold the follow-up back).
    (async () => {
      while (!deckWatch.stop) {
        const t = await deckShown(hp);
        if (t && (HANDSFREE || !/home timeline built|tens of millions of followers/i.test(t))) {
          await deckOf(hp).getByRole('button', { name: /^I.ll ask it$/i }).first().click({ timeout: 2000 }).then(() => note(`[${at()}] answered "I'll ask it" to "${t.slice(0, 80)}"`), () => undefined);
        }
        await sleep(1500);
      }
    })();
  }
  await i03;
  const n0 = await same('2 the Design Twitter master template on both sides', 'after "Start from a board"', 80);
  const title = (await board(cp))?.textAt['Design Twitter'];
  if (title) ORIGIN = [title[0], title[1]]; else note('no "Design Twitter" title on the candidate\'s board');
  const cv0 = await board(cp);
  const seen = cv0 ? [-cv0.scrollX, -cv0.scrollY, -cv0.scrollX + cv0.width / cv0.zoom, -cv0.scrollY + cv0.height / cv0.zoom].map(Math.round) : null;
  step('3 the board opens readable on the prompt', !!cv0 && cv0.zoom >= 0.5 && seen[0] <= ORIGIN[0] + 10 && seen[2] >= ORIGIN[0] + 600,
    `candidate's zoom ${cv0?.zoom?.toFixed(2)}, the scene from ${JSON.stringify(seen)} (the prompt at x ${ORIGIN[0]}..${ORIGIN[0] + 620})`);

  scene(2, 'Mateo reads the prompt, then asks about reads, writes and freshness.');
  // His hand down the prompt as he reads, and the wheel down to the user stories.
  const read = (async () => {
    let v = await board(cp);
    for (const [x, y] of [[40, 40], [300, 200], [300, 400]]) { const [a, b] = px(v, x + ORIGIN[0], y + ORIGIN[1]); await moveTo(cp, a, b, 800); await sleep(250); }
    for (let i = 0; i < 10; i++) { await cp.mouse.wheel(0, 36); await sleep(40); }
    v = await board(cp);
    for (const [x, y] of [[120, 620], [300, 760], [200, 880]]) { const [a, b] = px(v, x + ORIGIN[0], y + ORIGIN[1]); await moveTo(cp, a, b, 700); await sleep(200); }
  })();
  await say('r01', 300);
  await read;
  await say('b02', 250);
  // Hugo's hand over his board while he answers (a pointer move only: a press or the wheel would stop his follow).
  const vl = await board(hp);
  const hugoPoint = (async () => { for (const [x, y] of [[300, 300], [200, 520], [420, 560]]) { const [a, b] = px(vl, x + ORIGIN[0], y + ORIGIN[1]); await moveTo(hp, a, b, 700); await sleep(250); } })();
  await say('b03');
  await hugoPoint;
  const seesHugo = (await board(cp))?.pointers ?? [];
  step('4 the candidate sees Hugo\'s named pointer', seesHugo.some((n) => /Hugo/.test(n)), `pointers on the candidate's board: ${JSON.stringify(seesHugo)}`);
  await say('b04');
  await say('b05');
  if (HANDSFREE) {
    scene(3, 'Mateo asks Milo how much time is left, his name last.');
    // Hugo talks over Milo's answer about 2.5 s in ("Okay, thanks, that's enough"): the barge-in, measured to his silence.
    const n = milo.utterances; const posts0 = (await miloPosts()).length;
    await say('t02', 300);
    const endMs = Date.now();
    const began = await until(async () => (milo.utterances > n ? true : null), 15_000, 50);
    const barge = began && BARGE_ON === 'cand' ? await bargeOver(n) : null;
    await until(async () => Date.now() > busy.until + 120, 30_000, 60);
    const t = await turn('time_left', 'candidate', LINES.t02[1], endMs, n, posts0, !!began);
    t.how = 'name last'; t.right = !!began && /minute|end of its time/i.test(t.said); t.barge = barge; if (barge) report.barge = barge;
    step('T Milo tells Mateo the time left (name last)', t.right, `spoke=${!!began}; ${t.latencyS ?? '-'} s after the question; said "${t.said.slice(0, 120)}"`);
    step('X Hugo talks over Milo and Milo stops', !!report.barge && report.barge.playoutEndAfterS <= 2.5, `barge-in ${JSON.stringify(report.barge ?? null)}`);
  } else if (MILO) {
    scene(3, 'Mateo asks Milo how much time is left.');
    const n = milo.utterances; const posts0 = (await miloPosts()).length;
    await say('t01', 300);
    const endMs = Date.now();
    const spoke = await miloSays(n, 20_000);
    const t = await turn('time_left', 'candidate', LINES.t01[1], endMs, n, posts0, spoke);
    step('T Milo tells Mateo the time left, aloud', spoke && /minutes? (?:are|is) left|end of its time|minutes long/i.test(t.said), `spoke=${spoke}; ${t.latencyS ?? '-'} s after the question; said "${t.said.slice(0, 120)}"`);
  }

  scene(3, 'Your design: the requirements noted, then the high-level design from the palette.');
  const PANEL = 215;
  await beat(['d01', 'b07'], async () => {
    await camera(cp, region(VIEW_PALETTE), 1.0, PANEL);
    await note2(cp, o(NOTES.functional), 'Functional: post a tweet, follow someone, home timeline');
    await nearEnd('d01', 300);
    await note2(cp, o(NOTES.nonfunctional), 'Non-functional: fast timeline reads, highly available, a few seconds stale is OK');
  }, 150);
  const follow = hp.getByTestId('interview-board-follow').first();
  const fState = await follow.getAttribute('data-follow', { timeout: 3000 }).catch(() => null);
  const fText = (await follow.textContent({ timeout: 3000 }).catch(() => '')) ?? '';
  const seesCand = (await board(hp))?.pointers ?? [];
  step('5 Hugo follows Mateo and sees his named pointer', fState === 'following' && /Following/.test(fText) && seesCand.length > 0,
    `follow control "${fText.trim()}" (${fState}); pointers on Hugo's board: ${JSON.stringify(seesCand)}`);
  const n1 = await same('6 the requirement notes, same on both sides', 'after two notes', n0 + 2);

  await beat(['d02'], async () => {
    for (const k of ['web', 'lb', 'app']) await copyFromPalette(cp, k);
    await labelledArrow(cp, box('web', 'r'), box('lb', 'l'));
    await labelledArrow(cp, box('lb', 'r'), box('app', 'l'));
  }, 200);
  const n2 = await same('7 web client, load balancer, app servers and two arrows, same on both sides', 'after three copies and two arrows', n1 + 5);
  await beat(['d03'], async () => {
    await copyFromPalette(cp, 'db');
    await labelledArrow(cp, box('app', 'b'), box('db', 't'), 'writes');
  }, 200);
  await beat(['d04'], async () => {
    await copyFromPalette(cp, 'cache');
    await labelledArrow(cp, box('app', 'r'), box('cache', 'l'), 'reads');
  }, 200);
  const n3 = await same('8 the database and the cache with labelled arrows, same on both sides', 'after "writes" and "reads"', n2 + 4);
  const labels = (await board(hp))?.texts ?? [];
  if (!labels.includes('writes') || !labels.includes('reads')) note(`arrow labels on Hugo's board: writes=${labels.includes('writes')} reads=${labels.includes('reads')}`);
  await beat(['d05'], async () => {
    await copyFromPalette(cp, 'queue');
    await copyFromPalette(cp, 'workers');
    await labelledArrow(cp, box('app', 'br'), box('queue', 'l'));
    await labelledArrow(cp, box('queue', 'r'), box('workers', 'l'));
    await labelledArrow(cp, box('workers', 'tr'), box('cache', 'br'));
  }, 200);
  const n4 = await same('9 the queue and the workers, same on both sides', 'after two copies and three arrows', n3 + 4);

  scene(4, 'A second thought: what about an account with fifty million followers?');
  const [wx, wy] = box('workers', 'b');
  const b10 = say('b10', 250);
  await camera(cp, region(VIEW_DRAWING), 1.0, PANEL);
  await nearEnd('b10', 4200); // "Actually, wait."
  await drag(cp, [wx, wy], [wx, wy + 130]);
  await b10;
  await beat(['d06'], async () => { await nearEnd('d06', 2200); await note2(cp, o(NOTES.bigAccounts), 'Big accounts: no fan-out, merge at read time'); }, 200);
  const moved = await until(async () => { const [a, b] = [lowest(await board(hp), 'Workers'), lowest(await board(cp), 'Workers')]; return a && b && a[1] === b[1] && a[1] > PLACE.workers[1] + ORIGIN[1] + 80 ? [a, b] : null; }, 6000, 250);
  step('10 the workers moved down on both sides, the note added', !!moved, `Workers at ${JSON.stringify(moved ?? [lowest(await board(hp), 'Workers'), lowest(await board(cp), 'Workers')])} (lead, candidate); copied to ${JSON.stringify(o(PLACE.workers))}`);
  await beat(['d07'], async () => {
    await camera(cp, region(VIEW_PURPOSES), 1.0, PANEL);
    await note2(cp, o(NOTES.purposes), 'App servers: post tweets, serve timelines\nWorkers: fan new tweets out to followers\' caches');
  }, 200);
  const n5 = await same('11 the purposes, same on both sides', 'after the drag and two notes', n4 + 2);

  scene(5, 'Where to go deep? Hugo picks the fan-out.');
  if (HANDSFREE) {
    scene(4, 'Hugo asks Milo the time, then the question again without the name.');
    const t = await askByVoice('time_left', 'lead', 't03', 'name first', /minute|end of its time/i);
    step('U Milo tells Hugo the time left (name first)', t.right, `spoke=${t.spoke}; ${t.latencyS ?? '-'} s after the question; said "${t.said.slice(0, 120)}"`);
    const f = await askByVoice('repeat_question', 'lead', 'f01', 'follow-up (no name)', /twitter|timeline|tweet|post/i, 15_000);
    step('F Milo answers the follow-up without his name', f.right, `spoke=${f.spoke}; ${f.latencyS ?? '-'} s after the follow-up; said "${f.said.slice(0, 120)}"`);
  }
  await beat(['b12'], () => camera(cp, region(VIEW_DRAWING), 1.0, 0), 250);
  const lv2 = await board(hp);
  const wk = lowest(lv2, 'Workers');
  const point = wk ? (async () => { const [hx, hy] = px(lv2, wk[0] + 50, wk[1] + 32); await moveTo(hp, hx, hy, 800); })() : null;
  await point;
  // --milo: the coach's follow-up is in Hugo's footer by now (it waits 90 s after the first one); he has Milo ask it aloud.
  let askedByMilo = false;
  deckWatch.stop = true;
  if (MILO && !HANDSFREE) {
    const FOLLOW_UP = /home timeline built|tens of millions of followers/i;
    const deck = await until(async () => {
      const t = await deckShown(hp);
      if (!t) return null;
      if (FOLLOW_UP.test(t)) return t;
      note(`skipped the suggestion "${t.slice(0, 80)}"`);
      await deckOf(hp).getByRole('button', { name: /^Skip$/ }).first().click().catch(() => undefined);
      return null;
    }, 30_000, 700);
    if (deck) {
      scene(6, 'Milo suggests a follow-up to Hugo only; Hugo has Milo ask it.');
      const glideTo = (async () => { const b = await deckOf(hp).getByRole('button', { name: /have milo ask/i }).first().boundingBox().catch(() => null); if (b) await moveTo(hp, b.x + b.width / 2, b.y + b.height / 2, 900); })();
      await say('m01', 250);
      await glideTo;
      const n = milo.utterances; const posts0 = (await miloPosts()).length;
      await press(hp, deckOf(hp).getByRole('button', { name: /have milo ask/i }).first(), { pause: 150 });
      const pressedAt = Date.now();
      const receipt = until(async () => /Milo asked it aloud|Milo posted the question in the chat \([^)]*\)|Not sent: [^.]*\.|Milo did not say whether it was sent/.exec(await hp.locator('body').innerText())?.[0] ?? null, 20_000, 500);
      askedByMilo = await miloSays(n, 30_000);
      const t = await turn('have_milo_ask', 'lead (button)', deck, pressedAt, n, posts0, askedByMilo);
      const rc = (await receipt) ?? '';
      step('S Have Milo ask: Milo asks the follow-up aloud', askedByMilo && rc === 'Milo asked it aloud' && FOLLOW_UP.test(t.said), `deck "${deck.slice(0, 120)}"; receipt "${rc || 'none'}"; voice ${t.latencyS ?? '-'} s after the press; said "${t.said.slice(0, 120)}"`);
    } else note('no follow-up suggestion within 30 s; Hugo asks his own');
  }
  if (!askedByMilo) await say('h13');
  // Mateo walks the fan-out with his pointer while Hugo looks at the provided design in his own pane.
  const walk = (async () => { const v = await board(cp); const w2 = lowest(v, 'Workers') ?? o(PLACE.workers);
    for (const [x, y] of [[w2[0] + 50, w2[1] + 32], box('cache', 'c'), box('app', 'c'), box('cache', 'c')]) { const [a, b] = px(v, x, y); await moveTo(cp, a, b, 900); await sleep(400); } })();
  const d08 = say('d08', 250);
  await sleep(2500);
  await press(hp, hp.getByRole('tab', { name: 'Provided design' }).first(), { pause: 250 });
  const pd = await hp.getByTestId('interview-design-canvas').first().waitFor({ timeout: 10_000 }).then(() => true, () => false);
  const candTab = await cp.getByRole('tab', { name: 'Provided design' }).count().catch(() => 0);
  const candCanvas = await cp.getByTestId('interview-design-canvas').count().catch(() => 0);
  const candText = await cp.evaluate(() => document.body.innerText.includes('Provided design')).catch(() => null);
  step('12 Hugo sees the provided design; the candidate nothing of it', pd && candTab === 0 && candCanvas === 0 && candText === false,
    `lead's design canvas ${pd}; candidate: tab ${candTab}, canvas ${candCanvas}, the words "Provided design" on the page ${candText}`);
  await d08; await walk;
  await say('h14', 250);

  scene(6, 'Hugo ends the round. The board is kept on the record.');
  const nFinal = (await board(cp))?.count ?? n5;
  if (MILO) await miloState().catch(() => undefined);
  const b15 = say(MILO ? 's15' : 'b15', 250);
  await press(hp, hp.getByRole('tab', { name: 'Board' }).first(), { pause: 150 }).catch(() => note('no Board tab to go back to'));
  let b16 = null;
  if (HANDSFREE) {
    // A mention, not a request: Milo must stay silent. Watched for 4 s from its end while Hugo goes to End.
    await b15;
    const nM = milo.utterances;
    await say('b16m', 200);
    const mEnd = Date.now();
    await press(hp, hp.getByTestId('interview-end'), { pause: 150 });
    const replied = await until(async () => (milo.utterances > nM ? true : null), Math.max(200, mEnd + 4000 - Date.now()), 100);
    report.mention = { atS: Number(((mEnd - timeline.film.fromMs) / 1000).toFixed(1)), replied: !!replied };
    step('N a mention of Milo gets no reply', !replied, `Milo ${replied ? 'REPLIED' : 'stayed silent'} within 4 s of "I liked how Milo kept time"`);
    await press(hp, hp.getByTestId('interview-room-ask').getByRole('button', { name: /^End interview$/ }), { pause: 150, timeout: 10_000 });
  } else {
    await nearEnd(MILO ? 's15' : 'b15', 1500);
    await press(hp, hp.getByTestId('interview-end'), { pause: 150 });
    await press(hp, hp.getByTestId('interview-room-ask').getByRole('button', { name: /^End interview$/ }), { pause: 150, timeout: 10_000 });
    await b15;
    b16 = say('b16', 200);
  }
  const ended = await cp.getByTestId('join-ended').first().waitFor({ timeout: 15_000 }).then(() => true, () => false);
  if (b16) await b16;
  const state = await until(async () => ((await row()).state === 'ended' ? 'ended' : null), 10_000, 500);
  if (MILO) {
    await miloState().catch(() => undefined);
    report.spend = { listeningSeconds: booked.listeningSeconds, maxMinutes: MAX_MINUTES };
    // The scorecard: Hugo's ratings, the red flags list, then the recap with Milo's recommendation and its evidence (closed).
    await hp.waitForURL(new RegExp(`/interviews/rounds/${IV}/scorecard$`), { timeout: 8000 }).catch(() => undefined);
    if (!/\/scorecard$/.test(new URL(hp.url()).pathname)) await hp.goto(`${PORTAL}/interviews/rounds/${IV}/scorecard`, { waitUntil: 'domcontentloaded' });
    await hp.getByTestId('interviews-scorecard-form').first().waitFor({ timeout: 30_000 });
    scene(8, 'Hugo scores the round; Milo recommends, with its evidence.');
    const talk = say('s01', 300);
    const groups = hp.locator('[data-ui-control="rating"]');
    await groups.first().waitFor({ timeout: 20_000 }).catch(() => undefined);
    const nGroups = await groups.count();
    let rated = 0;
    for (let i = 0; i < nGroups; i += 1) await press(hp, groups.nth(i).getByRole('radio', { name: /^3 / }).first(), { pause: 120, timeout: 5000, ms: 420 }).then(() => { rated += 1; }, (e) => note(`rating ${i}: ${String(e).slice(0, 100)}`));
    const flags = hp.getByTestId('interviews-scorecard-red-flags').first();
    const nFlags = await flags.locator('input[type="checkbox"]').count().catch(() => 0);
    if (nFlags) {
      await flags.scrollIntoViewIfNeeded().catch(() => undefined);
      // He reads down the list; this design shows none of them, so nothing is ticked.
      for (const k of [0, Math.floor(nFlags / 2), nFlags - 1]) { const b = await flags.locator('input[type="checkbox"]').nth(k).boundingBox().catch(() => null); if (b) { await moveTo(hp, b.x + 200, b.y + b.height / 2, 500); await sleep(250); } }
    }
    await talk;
    step('R ratings and the red flags list on the board round\'s scorecard', rated === nGroups && nGroups > 0 && nFlags > 0, `${rated} of ${nGroups} competencies rated; ${nFlags} red flags listed, none ticked`);
    try {
      await press(hp, hp.getByTestId('interviews-scorecard-to-recap'), { pause: 100, timeout: 10_000, ms: 500 });
      const open = hp.getByTestId('interviews-scorecard-ask-option-open');
      if (await open.waitFor({ timeout: 3000 }).then(() => true, () => false)) await press(hp, open, { pause: 100, ms: 500 });
      await hp.getByTestId('interviews-scorecard-recap-step').first().waitFor({ timeout: 30_000 });
    } catch (e) { note(`recap step: ${String(e).slice(0, 120)}`); }
    const adviceBox = hp.getByTestId('interviews-scorecard-milo-advice').first();
    const adviceShown = await adviceBox.waitFor({ timeout: 90_000 }).then(() => true, () => false);
    const adviceText = adviceShown ? squash(await adviceBox.innerText().catch(() => '')) : '';
    if (adviceShown) {
      const shownAt = Date.now();
      const b = await adviceBox.boundingBox().catch(() => null); if (b) await moveTo(hp, b.x + Math.min(160, b.width / 2), b.y + b.height / 2, 600);
      const verdict = /Don.t advance/i.test(adviceText) ? 's41d' : /Inconclusive/i.test(adviceText) ? 's41i' : /Advance/i.test(adviceText) ? 's41a' : /no recommendation/i.test(adviceText) ? 's41n' : null;
      if (verdict) await say(verdict, 300);
      const held = Date.now() - shownAt; if (held < 3200) await sleep(3200 - held);
    }
    const evidence = hp.getByTestId('interviews-recap-evidence').first();
    const evidenceOpen = (await evidence.count()) ? await evidence.evaluate((el) => !!(el.closest('details')?.open ?? el.querySelector('details')?.open ?? el.getAttribute('aria-expanded') === 'true')).catch(() => null) : null;
    step('G Milo recommends on the scorecard, its evidence closed', adviceShown && /Milo recommends\s*(Advance|Inconclusive|Don.t advance)|Milo has no recommendation yet/i.test(adviceText),
      `pill "${adviceText.slice(0, 200)}"; evidence disclosure present=${(await evidence.count()) > 0}, open=${evidenceOpen}`);
  }
  await hp.goto(`${PORTAL}/interviews/rounds/${IV}/record`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  const recCanvas = hp.getByTestId('interviews-record-board-canvas').first();
  const onRecord = await recCanvas.waitFor({ timeout: 30_000 }).then(() => true, () => false);
  await recCanvas.scrollIntoViewIfNeeded().catch(() => undefined);
  const rec = await until(async () => board(hp, 'interviews-record-board-canvas'), 15_000, 400);
  const picks = await hp.getByTestId('interviews-record-board').getByRole('radio').count().catch(() => 0);
  if (MILO) scene(9, 'The board is kept on the record.');
  const b17 = say('b17', 300);
  const picker = hp.getByTestId('interviews-record-board').getByRole('radio').first();
  if (picks > 0) { const pb = await picker.boundingBox().catch(() => null); if (pb) await moveTo(hp, pb.x + pb.width / 2, pb.y + pb.height / 2, 700); }
  await b17;
  await sleep(1200);
  step('13 the round ended and its record shows the closing board', state === 'ended' && ended && onRecord && rec?.count === nFinal,
    `state ${state}; candidate's ended page ${ended}; record board ${onRecord ? `${rec?.count} elements` : 'not shown'} (live board ${nFinal}); snapshot picker ${picks} choices`);
  timeline.film.toMs = Date.now();
  report.pageErrors = [...lead.errors, ...cand.errors].slice(0, 20);
} catch (e) {
  step('X the take', false, `stopped: ${String(e?.stack ?? e).split('\n').filter((l) => !/^\s*-\s+(waiting|  )/.test(l)).slice(0, 8).join(' | ')}`);
  for (const p of [lead, cand].filter(Boolean)) await p.page.screenshot({ path: path.join(OUT, `stopped-${p.key}.png`) }).catch(() => undefined);
  if (!timeline.film.toMs) timeline.film.toMs = Date.now();
} finally {
  await greta?.api.dispose().catch(() => undefined);
  for (const p of [lead, cand].filter(Boolean)) {
    await p.context.close().catch(() => undefined);
    timeline.videos[p.key].file = path.relative(OUT, (await p.page.video()?.path().catch(() => null)) ?? '');
  }
  await Promise.all(browsers.map((b) => b.close().catch(() => undefined)));
  fs.writeFileSync(path.join(OUT, 'timeline.json'), JSON.stringify(timeline, null, 1));
  report.passed = report.steps.filter((s) => s.ok).length;
  report.failed = report.steps.filter((s) => !s.ok).length;
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 1));
  stopAll();
  clearTimeout(ceiling);
}
console.log(`film: report ${report.passed} passed, ${report.failed} failed`);
if (REHEARSE || !timeline.film.fromMs) process.exit(0);
process.exit(await py('compose', '--out', OUT, '--final', FINAL));

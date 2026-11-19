#!/usr/bin/env node
// "Design Twitter on the shared whiteboard": a short scripted film of a system design round, the coding film's sibling
// (scripts/demo/interviews-call-film.mjs). The lead (Hugo Marchetti) on the left, the candidate (Mateo Alvarez) on the right,
// both in the call; Mateo draws with Excalidraw's own tools (toolbar, mouse and keyboard) on the round's shared board and
// each side shows the other's named pointer. No Milo and no model: nobody is listening, so the lines (interviews-board-film-
// lines.json, synthesised beforehand by interviews-film-voices.py) are placed in the edit at the moment each was "said".
//
//   node scripts/demo/interviews-board-film.mjs --out <dir> --voices <dir> [--final <mp4>] [--rehearse] [--compose-only]
//
// The story: the recruiter assigns Mateo's System design round (POST /interviews), Hugo accepts it, it gets a time and Hugo
// chooses "Design Twitter" (q-be-twitter) in Prepare's route; Hugo starts the call, the candidate opens the link and is
// admitted (all before the film starts). On film: Hugo puts the question's "Prompt and empty frames" board on the board; Mateo asks
// about reads and freshness, types the functional and non-functional stickies, draws the high-level design (boxes with
// labels, arrows), hesitates and drags the fan-out worker aside, asks where to go deep; Hugo picks the fan-out; a Deep dive
// sticky; Hugo ends the round and opens its record page's board (the closing board and the snapshot picker).
// The checks (report.json): after every drawing beat both sides hold the same number of elements; each side sees the other's
// named pointer; the record page shows the board as it closed.
//
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

// ── This film's middleware (mock world, no Milo, no model) and portal ──
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
  // No model: Bedrock is refused by these keys, Milo is never invited, the coach is the scripted stand-in.
  AWS_ACCESS_KEY_ID: 'film-blocks-bedrock', AWS_SECRET_ACCESS_KEY: 'film-blocks-bedrock', AWS_EC2_METADATA_DISABLED: 'true',
  INTERVIEWS_COACH_MODEL: 'scripted', OPENAI_API_KEY: '',
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
const { joinCall } = await import('../journeys/interviews/h8-room.mjs');

// ── The record ──
const VIEW = { width: 1280, height: 800 };
const timeline = { size: VIEW, videos: {}, film: { fromMs: null, toMs: null }, scenes: [], cuts: [], speech: [], labels: { lead: 'Hugo Marchetti (lead)', cand: 'Mateo Alvarez' } };
const report = { startedAt: new Date().toISOString(), interview: null, steps: [], notes: [] };
const step = (id, ok, detail) => { report.steps.push({ id, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${id}: ${detail}`); };
const note = (s) => { report.notes.push(s); console.log(`note: ${s}`); };
const scene = (n, title) => { timeline.scenes.push({ n, title, caption: '', atMs: Date.now() }); console.log(`scene ${n}: ${title}`); };
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
      boxes: Object.fromEntries(els.filter((e) => e.type === 'rectangle' && e.boundElements?.some((b) => b.type === 'text'))
        .map((e) => [els.find((t) => t.containerId === e.id)?.text.replace(/\s+/g, ' ') ?? e.id, [Math.round(e.x), Math.round(e.y)]])),
      pointers: [...(s.collaborators?.values?.() ?? [])].filter((c) => c.pointer).map((c) => c.username) };
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
  const page = await context.newPage();
  timeline.videos[key] = { startMs: Date.now(), file: null };
  const p = { key, context, page, api: context.request, errors: [] };
  page.on('pageerror', (e) => p.errors.push(e.message.slice(0, 160)));
  return p;
}

/** A line: its clip is placed in the edit now; resolves when it would end. Lines never overlap. */
const busy = { until: 0 };
async function say(id, gapMs = 350) {
  const wait = busy.until + gapMs - Date.now(); if (wait > 0) await sleep(wait);
  const c = CLIPS[id] ?? { who: LINES[id][0], text: LINES[id][1], file: null, durMs: 900 + 62 * LINES[id][1].length };
  const atMs = Date.now();
  timeline.speech.push({ id, who: c.who, text: c.text, file: c.file ? path.relative(OUT, c.file) : null, atMs, durMs: c.durMs });
  busy.until = atMs + c.durMs;
  console.log(`  [${at()}] ${c.who}: ${c.text}`);
  await sleep(c.durMs);
}
/** Waits until line `id` is `leadMs` from its end. */
async function nearEnd(id, leadMs) {
  const s = await until(async () => timeline.speech.findLast((x) => x.id === id) ?? null, 15_000, 40);
  if (s) { const w = s.atMs + s.durMs - leadMs - Date.now(); if (w > 0) await sleep(w); }
}

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
/** The background swatch for the next shapes (Excalidraw's own picker), when its panel is on screen. */
async function fill(page, color) {
  const sw = page.getByTestId(CANVAS).locator(`[data-testid="color-top-pick-${color}"]`).first();
  if (await sw.isVisible().catch(() => false)) await press(page, sw, { pause: 100, ms: 260 }); else note(`no background swatch ${color} on screen`);
}
/** A labelled shape: the rectangle tool, a drag, Enter, the words typed, Escape. */
async function shape(page, [x, y, w, h], label, color = null) {
  await tool(page, 'rectangle', 'r');
  if (color) await fill(page, color);
  const v = await board(page);
  const [ax, ay] = px(v, x, y); const [bx, by] = px(v, x + w, y + h);
  await moveTo(page, ax, ay, 320); await page.mouse.down(); await moveTo(page, bx, by, 320); await page.mouse.up();
  await page.keyboard.press('Enter');
  await page.keyboard.type(label, { delay: 26 });
  await page.keyboard.press('Escape');
  await sleep(120);
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

// ── The board's plan, in scene units (the "Prompt and empty frames" board: the prompt card above frames of 440 × 300, three to a row) ──
const FR = { functional: [500, 160], nonfunctional: [1000, 160], hld: [0, 520], deepdive: [500, 520] };
const sticky = (frame, j) => [FR[frame][0] + 20 + (j % 2) * 210, FR[frame][1] + 30 + Math.floor(j / 2) * 110, 190, 80];
const B = { w: 120, h: 64 };
const cell = (col, row) => [FR.hld[0] + 15 + col * 145, FR.hld[1] + 25 + row * 98, B.w, B.h];
const HLD = { client: cell(0, 0), api: cell(1, 0), tweets: cell(2, 0), fanout: cell(1, 1), store: cell(2, 1), cache: cell(0, 2), timeline: cell(1, 2) };
const side = ([x, y, w, h], where, inset = 14) => ({ l: [x + inset, y + h / 2], r: [x + w - inset, y + h / 2], t: [x + w / 2, y + inset], b: [x + w / 2, y + h - inset],
  tl: [x + inset, y + inset], bl: [x + inset, y + h - inset], br: [x + w - inset, y + h - inset], tr: [x + w - inset, y + inset] })[where];

let lead; let cand; let greta; let IV = null;
try {
  greta = { api: await (pw.request ?? pw.default.request).newContext() };
  if ((await greta.api.post(`${PORTAL}/api/session/login`, { data: { userId: GRETA } })).status() !== 200) throw new Error('login the recruiter');
  lead = await person('lead', HUGO);
  const hp = lead.page;
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
  if (NO_CALL) await lead.api.post(api(`/${IV}/start`), { data: { revision: (await row()).revision } }); else await joinCall(hp);
  await until(async () => ((await row()).state === 'live' ? true : null), 20_000, 1000);
  const link = (await (await greta.api.post(api(`/${IV}/invite`), { data: {} })).json().catch(() => ({}))).linkPath;
  if (!link) throw new Error('no invite link');
  cand = await person('cand', null);
  const cp = cand.page;
  await cp.goto(`${PORTAL}${link}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await cp.getByTestId('join-continue').first().click({ timeout: 15_000 }).catch(() => undefined);
  await cp.getByTestId('join-consents').waitFor({ timeout: 30_000 });
  for (const part of ['recording', 'transcription', 'milo']) await cp.getByTestId(`join-consent-${part}-choice`).locator('label').filter({ hasText: /^Yes$/ }).first().click({ timeout: 5000 });
  await cp.getByTestId('join-consents-continue').click({ timeout: 8000 });
  await cp.getByTestId('join-devices-continue').click({ timeout: 30_000 });
  await hp.getByTestId('interview-room-ask').getByRole('button', { name: /^Admit$/ }).first().click({ timeout: 30_000 });
  const join = cp.getByTestId('join-room-bar-start').or(cp.getByTestId('join-room-bar-join')).first();
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
    `camera tiles ${await cams(hp)}/${await cams(cp)}; board synced lead=${ls} candidate=${cs}; canvas lead ${lv?.width}x${lv?.height}, candidate ${cv?.width}x${cv?.height}`);
  await sleep(1500);

  // ── On film ──
  timeline.film.fromMs = Date.now() - 600;
  scene(1, 'Mateo\'s System design round. Hugo puts the question on the shared board.');
  const insert = hp.getByTestId('interview-board-insert').first();
  const b01 = say('b01', 0);
  await press(hp, insert, { pause: 400 });
  await press(hp, hp.getByRole('menuitem', { name: /Prompt and empty frames/ }).first(), { pause: 350 });
  await b01;
  const n0 = await same('2 the Design Twitter board on both sides', 'after "Start from a board"', 7);
  const prompt = (await board(cp))?.texts.some((t) => /Design Twitter/.test(t));
  if (!prompt) note('the candidate\'s board shows no "Design Twitter" card');

  scene(2, 'Clarifying questions first: reads, writes and freshness.');
  const vc = await board(cp); const vl = await board(hp);
  const clarify = (async () => { for (const [x, y] of [[220, 50], [220, 300], [700, 50]]) { const [a, b] = px(vc, x, y); await moveTo(cp, a, b, 900); await sleep(300); } })();
  await say('b02', 0);
  // Hugo's hand over his board while he answers: his named pointer on Mateo's screen.
  const hugoPoint = (async () => { for (const [x, y] of [[720, 60], [600, 300], [760, 320]]) { const [a, b] = px(vl, x, y); await moveTo(hp, a, b, 700); await sleep(250); } })();
  await say('b03');
  await hugoPoint; await clarify;
  const seesHugo = (await board(cp))?.pointers ?? [];
  step('3 the candidate sees Hugo\'s named pointer', seesHugo.some((n) => /Hugo/.test(n)), `pointers on the candidate's board: ${JSON.stringify(seesHugo)}`);
  await say('b04');
  await say('b05');

  scene(3, 'Requirements on stickies, typed straight onto the board.');
  const PANEL = 215;
  await Promise.all([camera(cp, [480, 130, 960, 480], 1.1, PANEL), camera(hp, [480, 130, 1460, 480], 0.9)]);
  const b06 = say('b06', 150);
  let first = true;
  for (const [j, text] of ['Post a tweet', 'Follow someone', 'Home timeline'].entries()) { await shape(cp, sticky('functional', j), text, first ? '#ffec99' : null); first = false; }
  await b06;
  const seesCand = (await board(hp))?.pointers ?? [];
  step('4 Hugo sees the candidate\'s named pointer', seesCand.length > 0, `pointers on Hugo's board: ${JSON.stringify(seesCand)}`);
  const n1 = await same('5 functional stickies, same on both sides', 'after three functional stickies', n0 + 6);
  const b07 = say('b07', 150);
  await camera(cp, [980, 130, 1460, 480], 1.1, PANEL);
  for (const [j, text] of ['Fast timeline reads', 'Highly available', 'A few seconds stale is OK'].entries()) await shape(cp, sticky('nonfunctional', j), text);
  await b07;
  const n2 = await same('6 non-functional stickies, same on both sides', 'after three non-functional stickies', n1 + 6);

  scene(4, 'The high-level design, drawn with Excalidraw\'s own tools.');
  const look2 = [-20, 490, 460, 830];
  await Promise.all([camera(cp, look2, 1.3, PANEL), camera(hp, look2)]);
  const b08 = say('b08', 150);
  await shape(cp, HLD.client, 'Client', '#a5d8ff');
  await shape(cp, HLD.api, 'API');
  await arrow(cp, side(HLD.client, 'r'), side(HLD.api, 'l'));
  await shape(cp, HLD.tweets, 'Tweet service');
  await arrow(cp, side(HLD.api, 'r'), side(HLD.tweets, 'l'));
  await shape(cp, HLD.store, 'Tweet store');
  await arrow(cp, side(HLD.tweets, 'b'), side(HLD.store, 't'));
  await b08;
  const n3 = await same('7 first boxes and arrows, same on both sides', 'after Client, API, Tweet service, Tweet store and three arrows', n2 + 11);
  const b09 = say('b09', 150);
  await shape(cp, HLD.fanout, 'Fan-out worker');
  await arrow(cp, side(HLD.tweets, 'bl'), side(HLD.fanout, 'tr'));
  await shape(cp, HLD.cache, 'Timeline cache');
  await arrow(cp, side(HLD.fanout, 'bl'), side(HLD.cache, 'tr'));
  await shape(cp, HLD.timeline, 'Timeline service');
  await arrow(cp, side(HLD.timeline, 'l'), side(HLD.cache, 'r'));
  await b09;
  const n4 = await same('8 the whole high-level design, same on both sides', 'after Fan-out worker, Timeline cache, Timeline service and three arrows', n3 + 9);

  scene(5, 'A second thought: what about an account with fifty million followers?');
  const b10 = say('b10', 300);
  await nearEnd('b10', 4200); // "Actually, wait."
  const [fx, fy] = HLD.fanout;
  await drag(cp, [fx + 12, fy + 10], [fx + 12 - 145, fy + 10]);
  await b10;
  const b11 = say('b11', 200);
  await arrow(cp, side(HLD.store, 'bl'), side(HLD.timeline, 'tr'));
  await b11;
  const n5 = await same('9 the drag and the new arrow, same on both sides', 'after moving the fan-out worker and adding the read-time arrow', n4 + 1);
  const moved = await until(async () => { const [a, b] = [(await board(hp))?.boxes['Fan-out worker'], (await board(cp))?.boxes['Fan-out worker']]; return a && b && a[0] === b[0] && a[1] === b[1] && a[0] < fx - 100 ? [a, b] : null; }, 6000, 250);
  step('10 the fan-out worker moved aside on both sides', !!moved, `fan-out worker at ${JSON.stringify(moved ?? [(await board(hp))?.boxes['Fan-out worker'], (await board(cp))?.boxes['Fan-out worker']])} (lead, candidate); drawn at [${fx}, ${fy}]`);

  scene(6, 'Where to go deep? Hugo picks the fan-out.');
  await say('b12', 300);
  const lv2 = await board(hp);
  const [hx, hy] = px(lv2, fx - 145 + B.w / 2, fy + B.h / 2);
  const point = moveTo(hp, hx, hy, 800);
  await say('b13');
  await point;
  const seesHugo2 = (await board(cp))?.pointers ?? [];
  if (!seesHugo2.some((n) => /Hugo/.test(n))) note(`Hugo's pointer not on the candidate's board when he picked the fan-out: ${JSON.stringify(seesHugo2)}`);
  const look3 = [-20, 490, 960, 830];
  await Promise.all([camera(cp, [480, 490, 960, 830], 1.1, PANEL), camera(hp, look3)]);
  const b14 = say('b14', 150);
  await shape(cp, [FR.deepdive[0] + 20, FR.deepdive[1] + 30, 400, 110], 'Fan-out on write for most accounts; celebrity tweets merged at read time', '#ffec99');
  await b14;
  const nFinal = await same('11 the deep dive sticky, same on both sides', 'after the Deep dive sticky', n5 + 2);

  scene(7, 'Hugo ends the round. The board is kept on the record.');
  const b15 = say('b15', 300);
  await nearEnd('b15', 1500);
  await press(hp, hp.getByTestId('interview-end'), { pause: 150 });
  await press(hp, hp.getByTestId('interview-room-ask').getByRole('button', { name: /^End interview$/ }), { pause: 150, timeout: 10_000 });
  await b15;
  const b16 = say('b16', 200);
  const ended = await cp.getByTestId('join-ended').first().waitFor({ timeout: 15_000 }).then(() => true, () => false);
  await b16;
  const state = await until(async () => ((await row()).state === 'ended' ? 'ended' : null), 10_000, 500);
  await hp.goto(`${PORTAL}/interviews/rounds/${IV}/record`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  const recCanvas = hp.getByTestId('interviews-record-board-canvas').first();
  const onRecord = await recCanvas.waitFor({ timeout: 30_000 }).then(() => true, () => false);
  await recCanvas.scrollIntoViewIfNeeded().catch(() => undefined);
  const rec = await until(async () => board(hp, 'interviews-record-board-canvas'), 15_000, 400);
  const picks = await hp.getByTestId('interviews-record-board').getByRole('radio').count().catch(() => 0);
  const b17 = say('b17', 300);
  const picker = hp.getByTestId('interviews-record-board').getByRole('radio').first();
  if (picks > 0) { const box = await picker.boundingBox().catch(() => null); if (box) await moveTo(hp, box.x + box.width / 2, box.y + box.height / 2, 700); }
  await b17;
  await sleep(1200);
  step('12 the round ended and its record shows the closing board', state === 'ended' && ended && onRecord && rec?.count === nFinal,
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

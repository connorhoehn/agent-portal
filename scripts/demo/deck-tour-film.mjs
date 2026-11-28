#!/usr/bin/env node
// "Build a deck by hand": a recorded tour of the deck builder, every feature in the order a person reaches it. One Chromium
// (1440 by 900), one person (Vera Green, u-vera, org-leader on the initiative p-auth-migration: she may edit its decks and read the
// spend report), no voice (the provider account is out of credit, so the voice navigator is never started).
//
//   node scripts/demo/deck-tour-film.mjs --out <dir>                  a take: record, then compose <dir>/deck-tour.mp4
//   node scripts/demo/deck-tour-film.mjs --out <dir> --probe          no film: build a deck, add each layout, print its form's fields
//   node scripts/demo/deck-tour-film.mjs --out <dir> --compose-only   compose again from <dir>/timeline.json
//
// Machinery borrowed from deck-voice-film.mjs: its own mock middleware (:4190) and portal (:5290, journey-vite.mjs), refusing ports
// already in use and stopping only the process groups it started; a cursor overlay drawn by the film, not the product; timeline.json
// and report.json. Captions are the film's too: an init script draws a caption card over the page (pointer-events none, the top
// layer), placed per scene away from the action, so the MP4 is the page at 1440x900 with nothing added in the edit but a trim.
// After the take the downloaded .pptx is opened (unzipped) and its slides and charts counted (report.json `pptx`).
import { spawn, spawnSync } from 'node:child_process';
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
if (!OUT) { console.error('usage: deck-tour-film.mjs --out <dir> [--probe | --compose-only]'); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });
const PROBE = args.includes('--probe');
const FINAL = path.join(OUT, 'deck-tour.mp4');

function compose() {
  const tl = JSON.parse(fs.readFileSync(path.join(OUT, 'timeline.json'), 'utf8'));
  const raw = path.join(OUT, tl.video.file);
  const from = Math.max(0, (tl.film.fromMs - tl.video.startMs) / 1000);
  const to = (tl.film.toMs - tl.video.startMs) / 1000;
  // The film's window, cut into spans at 1x and spans at FAST x, joined again. Each scene plays at 1x for its first READ seconds
  // (its caption is read) and its last second; the rest of the scene (the hand at work) plays at FAST x. The opening, the examples,
  // present mode and the ending play at 1x throughout.
  const READ = 4.5; const k = tl.fastFactor ?? 2.5;
  const whole = /^(A new presentation|Example decks|Present|Done)$/;
  const sec = (ms) => (ms - tl.video.startMs) / 1000;
  const fast = [];
  tl.scenes.forEach((sc, i) => {
    if (whole.test(sc.title)) return;
    const a = sec(sc.atMs) + READ; const b = (i + 1 < tl.scenes.length ? sec(tl.scenes[i + 1].atMs) : to) - 1;
    if (b - a >= 2) fast.push([a, b]);
  });
  const spans = []; let at = from;
  for (const [a, b] of fast) { if (a < at || b > to) continue; if (a > at) spans.push([at, a, 1]); spans.push([a, b, k]); at = b; }
  spans.push([at, to, 1]);
  const graph = spans.map(([a, b, k], i) => `[0:v]trim=start=${a.toFixed(3)}:end=${b.toFixed(3)},setpts=(PTS-STARTPTS)/${k}[v${i}]`).join(';')
    + `;${spans.map((_, i) => `[v${i}]`).join('')}concat=n=${spans.length}:v=1:a=0,fps=30,format=yuv420p[out]`;
  const length = spans.reduce((t, [a, b, k]) => t + (b - a) / k, 0);
  const r = spawnSync('ffmpeg', ['-y', '-v', 'error', '-i', raw, '-filter_complex', graph, '-map', '[out]', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-movflags', '+faststart', '-an', FINAL], { stdio: 'inherit' });
  if (r.status === 0) console.log(`film: ${FINAL} (${length.toFixed(1)} s from ${(to - from).toFixed(1)} s recorded; ${spans.filter((x) => x[2] !== 1).length} spans at ${k}x)`);
  return r.status ?? 1;
}
if (args.includes('--compose-only')) process.exit(compose());

const MW_PORT = 4190;
const PORTAL_PORT = 5290;
const PORTAL = `http://127.0.0.1:${PORTAL_PORT}`;
const MIDDLEWARE = `http://127.0.0.1:${MW_PORT}`;
const P = 'p-auth-migration';
const IP = 'initiative-deck';
const E = `${IP}-editor`;
const TB = `${E}-toolbar`;
const VIEW = { width: 1440, height: 900 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const until = async (fn, ms, every = 150) => { const end = Date.now() + ms; for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() > end) return null; await sleep(every); } };

// ── The stack: this film's own mock middleware and portal ──
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
    // node:http, not fetch: fetch refuses 4190 (on the WHATWG bad-ports list; the browser is launched with it allowed).
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
  REALTIME_GATEWAY_URL: `http://localhost:${MW_PORT}`,
  // No Bedrock in this film: anything that reaches for it is refused by these keys.
  AWS_ACCESS_KEY_ID: 'film-blocks-bedrock', AWS_SECRET_ACCESS_KEY: 'film-blocks-bedrock', AWS_EC2_METADATA_DISABLED: 'true',
}, path.join(WORK, 'middleware.log'));
start('portal', process.execPath, [path.join(ROOT, 'scripts', 'journeys', 'journey-vite.mjs'), '--port', String(PORTAL_PORT)], path.join(ROOT, 'portal'), {
  VITE_GATEWAY_URL: `http://localhost:${MW_PORT}`, API_PROXY_TARGET: MIDDLEWARE,
}, path.join(WORK, 'portal.log'));
if (!(await waitUp(`${MIDDLEWARE}/livez`, 180_000) && await waitUp(`${PORTAL}/`, 180_000))) { console.error('film: the stack did not come up; see work/*.log'); stopAll(); process.exit(2); }
const ceiling = setTimeout(() => { console.error('film: hard timeout (15 min)'); stopAll(); process.exit(3); }, 15 * 60_000);

// ── The record ──
const timeline = { size: VIEW, video: null, film: { fromMs: null, toMs: null }, scenes: [], marks: [], fast: [] };
// Spans the edit plays faster (FAST times): filling a form's remaining fields after its title was typed at a person's pace.
const FAST = 2.5;
const fastOn = () => { timeline.fast.push({ fromMs: Date.now(), toMs: null }); };
const fastOff = () => { const f = timeline.fast.at(-1); if (f && f.toMs === null) f.toMs = Date.now(); };
const report = { startedAt: new Date().toISOString(), mode: PROBE ? 'probe' : 'take', persona: 'u-vera (org-leader)', steps: [], notes: [], api: {} };
const fs_ = (ms) => (timeline.film.fromMs ? Number(((ms - timeline.film.fromMs) / 1000).toFixed(1)) : null);
const step = (id, ok, detail) => { report.steps.push({ id, ok: !!ok, detail, atS: fs_(Date.now()) }); console.log(`${ok ? 'PASS' : 'FAIL'} ${id}: ${detail}`); };
const note = (s) => { report.notes.push(s); console.log(`note: ${s}`); };
const mark = (label) => { timeline.marks.push({ label, atMs: Date.now(), atS: fs_(Date.now()) }); console.log(`  [${fs_(Date.now()) ?? '-'}] · ${label}`); };
const save = () => {
  fs.writeFileSync(path.join(OUT, 'timeline.json'), JSON.stringify(timeline, null, 1));
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 1));
};

// ── The page: cursor and caption, both the film's ──
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
// The caption card: a feature's name and one line, drawn over the page. Its text and place survive navigation (sessionStorage).
const CAPTION = () => {
  const KEY = '__film-caption';
  const draw = () => {
    let st = null; try { st = JSON.parse(sessionStorage.getItem(KEY) ?? 'null'); } catch { /* none */ }
    let c = document.getElementById(KEY);
    if (!st) { c?.remove(); return; }
    if (!c) {
      c = document.createElement('div'); c.id = KEY; c.setAttribute('aria-hidden', 'true');
      Object.assign(c.style, { position: 'fixed', zIndex: '2147483646', pointerEvents: 'none', maxWidth: '520px', padding: '14px 18px 15px', borderRadius: '12px',
        background: 'rgba(15, 23, 42, 0.92)', color: '#f1f5f9', boxShadow: '0 10px 30px rgba(0,0,0,0.35)', border: '1px solid rgba(245, 158, 11, 0.55)',
        fontFamily: '-apple-system, "Helvetica Neue", Helvetica, Arial, sans-serif', transition: 'opacity 220ms ease' });
      c.innerHTML = '<div data-k="n" style="font:600 12px/1.2 inherit;letter-spacing:.08em;text-transform:uppercase;color:#f59e0b;margin-bottom:6px"></div><div data-k="t" style="font:600 20px/1.25 inherit;margin-bottom:5px"></div><div data-k="s" style="font:400 15px/1.4 inherit;color:#cbd5e1"></div>';
      document.documentElement.appendChild(c);
    }
    c.querySelector('[data-k="n"]').textContent = st.n; c.querySelector('[data-k="t"]').textContent = st.title; c.querySelector('[data-k="s"]').textContent = st.line;
    const at = { side: { right: '20px', top: '350px', maxWidth: '340px' }, 'bottom-right': { right: '24px', bottom: '64px' }, 'bottom-left': { left: '24px', bottom: '64px' }, 'top-right': { right: '24px', top: '72px' }, 'top-left': { left: '24px', top: '72px' }, 'bottom-center': { left: '50%', bottom: '64px', transform: 'translateX(-50%)' } }[st.at] ?? { right: '24px', bottom: '64px' };
    Object.assign(c.style, { left: '', right: '', top: '', bottom: '', transform: '', maxWidth: '520px' }, at);
  };
  window.__filmCaption = (st) => { try { if (st) sessionStorage.setItem(KEY, JSON.stringify(st)); else sessionStorage.removeItem(KEY); } catch { /* none */ } draw(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', draw); else draw();
};

const req = createRequire(path.join(ROOT, 'portal', 'package.json'));
const pw = await import(pathToFileURL(req.resolve('playwright')).href);
const chromium = pw.chromium ?? pw.default.chromium;
const RAW = path.join(OUT, 'raw');
const browser = await chromium.launch({ args: [`--explicitly-allowed-ports=${MW_PORT}`] });
const context = await browser.newContext({ viewport: VIEW, ...(PROBE ? {} : { recordVideo: { dir: RAW, size: VIEW } }), acceptDownloads: true });
const api = context.request;
const login = await api.post(`${PORTAL}/api/session/login`, { data: { userId: 'u-vera' } });
if (login.status() !== 200) { console.error(`film: login answered ${login.status()}`); stopAll(); process.exit(2); }
const role = await api.post(`${PORTAL}/api/session/role`, { data: { tenant: 'orgiq', role: 'org-leader' } });
if (role.status() !== 200) { console.error(`film: role answered ${role.status()}`); stopAll(); process.exit(2); }
await context.addInitScript(CURSOR);
await context.addInitScript(CAPTION);
const page = await context.newPage();
timeline.video = { startMs: Date.now(), file: null };
const errors = [];
page.on('pageerror', (e) => errors.push(e.message.slice(0, 160)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 160)}`); });

// ── Pointer at a hand's pace ──
let cursorAt = [VIEW.width * 0.55, VIEW.height * 0.8];
async function moveTo(x, y, ms = 650) {
  const [x0, y0] = cursorAt; const t0 = Date.now();
  for (;;) { const t = Math.min(1, (Date.now() - t0) / ms); const e = t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2; await page.mouse.move(x0 + (x - x0) * e, y0 + (y - y0) * e); if (t >= 1) break; await sleep(16); }
  cursorAt = [x, y];
}
async function point(locator, pause = 350, ms = 650) {
  await locator.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => undefined);
  const box = await locator.boundingBox({ timeout: 3000 }).catch(() => null);
  if (box) { await moveTo(box.x + Math.min(box.width / 2, 160), box.y + Math.min(box.height / 2, 28), ms); await sleep(pause); }
}
async function press(locator, { pause = 350, timeout = 20_000, ms = 650 } = {}) {
  await locator.waitFor({ timeout });
  await point(locator, pause, ms);
  await locator.click({ timeout });
}
/** Click a field, clear it, type into it at a person's pace. */
/** Into a field: keystroke by keystroke when `keys` (a title, or the scene about typing), else filled at once after pointing. */
async function type(locator, text, keys = false) {
  await press(locator, { pause: 80, ms: 300 });
  await locator.fill('');
  if (keys) await locator.pressSequentially(text, { delay: 30 }); else { await locator.fill(text); await sleep(160); }
}
const typeKeys = (locator, text) => type(locator, text, true);
const go = async (p) => { await page.goto(`${PORTAL}${p}`, { waitUntil: 'domcontentloaded', timeout: 40_000 }); await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => undefined); };
const jget = async (url) => { const r = await api.get(`${PORTAL}${url}`); return { status: r.status(), body: await r.json().catch(() => null) }; };
const deckIdOf = () => decodeURIComponent((page.url().match(/\/decks\/([^/?#]+)/) ?? [])[1] ?? '');
async function headSpec(deckId) {
  const d = await jget(`/api/initiative-decks/${encodeURIComponent(deckId)}`);
  const rev = d.body?.activeRevisionId;
  const s = await jget(`/api/initiative-decks/${encodeURIComponent(deckId)}/revisions/${encodeURIComponent(rev)}/spec`);
  return { rev, spec: s.body?.spec ?? s.body, revisions: d.body?.revisions ?? [] };
}
const stageSrc = () => page.evaluate((t) => document.querySelector(`[data-testid="${t}"]`)?.getAttribute('src') ?? '', `${E}-editor-stage-image`).catch(() => '');
// The stage is drawn (complete); an SVG stage reports no natural width, so `complete` is the whole test, and it is bounded short.
const stageLoaded = async (ms = 4000) => until(async () => page.evaluate((t) => { const i = document.querySelector(`[data-testid="${t}"]`); return !!i && (i.tagName !== 'IMG' || i.complete); }, `${E}-editor-stage-image`), ms, 150);
const stageChanged = async (before, ms = 6000) => { const r = await until(async () => { const s = await stageSrc(); return s && s !== before ? s : null; }, ms, 200); if (r) await stageLoaded(); return !!r; };
const slideIds = () => page.evaluate((p) => [...document.querySelectorAll(`[data-testid^="${p}-slide-select-"]`)].map((e) => e.getAttribute('data-testid').slice(`${p}-slide-select-`.length)), E);
const findings = () => page.evaluate((t) => document.querySelector(`[data-testid="${t}"]`)?.innerText ?? '', `${IP}-preview-warnings`).then(squash).catch(() => '');
const form = () => page.getByTestId(`${E}-slide-form`);
const field = (suffix) => page.getByTestId(`${E}-slide-${suffix}`);

let caps = 0;
/** A new caption: the feature's name and one line, placed away from what the scene works on. Held at least `hold` ms. */
async function caption(title, line, at = 'bottom-right', hold = 2600) {
  caps += 1;
  const st = { n: `${caps}`.padStart(2, '0'), title, line, at };
  timeline.scenes.push({ n: caps, title, caption: line, at, atMs: Date.now(), atS: fs_(Date.now()) });
  console.log(`scene ${caps}: ${title}`);
  await page.evaluate((s) => window.__filmCaption?.(s), st).catch(() => undefined);
  await sleep(hold);
}
async function openGallery() {
  const direct = page.getByTestId(`${TB}-insert-all`);
  // "All layouts…" is the last row of the toolbar's Insert menu (ui-components 2.549.0).
  if (!(await direct.isVisible().catch(() => false))) await press(page.getByTestId(`${TB}-insert`));
  await press(page.getByTestId(`${TB}-insert-all`));
  await page.getByTestId(`${E}-layout-panel`).waitFor({ timeout: 10_000 });
}
/** Select slide `id` in the filmstrip (scrolled into the list's view first), then add `layout` from the gallery after it. */
async function addSlide(layout, { after, look = 900 } = {}) {
  if (after) { await press(page.getByTestId(`${E}-slide-select-${after}`)); await sleep(500); }
  const before = await slideIds();
  await openGallery();
  const tile = page.getByTestId(`${E}-layout-gallery-${layout}`);
  await point(tile, look);
  await tile.click();
  await form().waitFor({ timeout: 10_000 });
  const id = (await until(async () => (await slideIds()).find((i) => !before.includes(i)), 5000)) ?? null;
  await sleep(500);
  return id;
}
async function formFields() {
  return page.evaluate((p) => [...document.querySelectorAll(`[data-testid="${p}-slide-form"] input, [data-testid="${p}-slide-form"] textarea, [data-testid="${p}-slide-form"] select, [data-testid="${p}-slide-form"] button`)]
    .filter((e) => e.offsetParent !== null)
    .map((e) => `${e.tagName.toLowerCase()}${e.type && e.tagName === 'INPUT' ? `[${e.type}]` : ''} ${e.getAttribute('data-testid') ?? '-'} "${e.getAttribute('aria-label') ?? e.getAttribute('placeholder') ?? e.textContent?.trim().slice(0, 30) ?? ''}" = "${(e.value ?? '').slice(0, 40)}"`), E);
}

let exitCode = 0;
const deck = { id: '', url: '' };
try {
  if (PROBE) {
    // ── Probe: the facts deck, then each layout's form ──
    await go(`/iq/decks/new?projectId=${P}`);
    await page.getByTestId(`${IP}-new-submit`).waitFor({ timeout: 20_000 });
    report.api.newPage = { templates: await page.evaluate((p) => [...document.querySelectorAll(`button[data-testid^="${p}-template-"]`)].map((b) => `${b.getAttribute('data-testid')}: ${b.innerText.replace(/\s+/g, ' ').trim().slice(0, 120)}`), IP).catch(() => []) };
    await page.getByTestId(`${IP}-new-title`).fill('Probe deck');
    await page.getByTestId(`${IP}-new-submit`).click();
    await page.waitForURL(/\/iq\/decks\/(?!new)[^/?#]+$/, { timeout: 60_000 });
    deck.id = deckIdOf(); await stageLoaded();
    const h = await headSpec(deck.id);
    report.api.factsDeck = (h.spec?.slides ?? []).map((s) => ({ id: s.id, layout: s.layout, title: s.title, notes: (s.notes ?? '').slice(0, 120), chart: s.chart?.kind, body: JSON.stringify(s).slice(0, 400) }));
    report.api.toolbar = await page.evaluate((p) => [...document.querySelectorAll(`[data-testid^="${p}"]`)].map((e) => e.getAttribute('data-testid')).filter((t) => !/slide-(select|thumb|row|menu|findings|viewers)/.test(t)), E);
    report.api.pageIds = await page.evaluate((p) => [...new Set([...document.querySelectorAll('[data-testid]')].map((e) => e.getAttribute('data-testid')))].filter((t) => t.startsWith(p) && !t.startsWith(`${p}-editor`)), IP);
    report.api.findings = await findings();
    report.api.forms = {};
    for (const layout of ['title', 'agenda', 'key-figures', 'table', 'comparison', 'timeline', 'chart', 'bullets', 'closing']) {
      try { await addSlide(layout, { look: 50 }); report.api.forms[layout] = await formFields(); } catch (e) { report.api.forms[layout] = `failed: ${String(e.message).slice(0, 200)}`; }
    }
    report.api.findingsAfter = await findings();
    await page.getByTestId(`${TB}-theme`).click().catch(() => undefined); await sleep(400);
    report.api.themeItems = await page.evaluate(() => [...document.querySelectorAll('[role^=menuitem]')].map((e) => `${e.getAttribute('data-testid')}: ${e.textContent.trim()}`));
    await page.keyboard.press('Escape');
    console.log(JSON.stringify(report.api, null, 1));
    throw Object.assign(new Error('probe done'), { probe: true });
  }
  // ── 1. The new-deck page: the examples, then the facts ──
  await go(`/iq/projects/${P}?tab=docs`);
  await page.getByTestId('initiative-files-new').waitFor({ timeout: 20_000 });
  await sleep(1000);
  timeline.film.fromMs = Date.now() - 400;
  await caption('A new presentation', 'Vera owns the Auth Migration initiative. Her steering review is Friday: she starts a deck from the initiative.', 'bottom-right', 3200);
  await press(page.getByTestId('initiative-files-new'));
  await press(page.getByRole('menuitem', { name: /Presentation/ }));
  await page.waitForURL(/\/iq\/decks\/new/, { timeout: 15_000 });
  await page.getByTestId(`${IP}-new-submit`).waitFor({ timeout: 15_000 });
  await caption('Example decks', 'Five worked examples to start from: a status update, a proposal, a review, an interview debrief, a run report.', 'top-right', 1200);
  const tiles = page.locator(`button[data-testid^="${IP}-template-"]`);
  for (let i = 0; i < Math.min(5, await tiles.count()); i++) { await point(tiles.nth(i), 650); }
  await sleep(800);
  await caption('Build from the initiative\'s facts', 'Counts, story points, sprints, budget and decisions are read from the initiative record, not invented.', 'top-right', 1500);
  await typeKeys(page.getByTestId(`${IP}-new-title`), 'Auth Migration: December steering review');
  await sleep(700);
  await press(page.getByTestId(`${IP}-new-submit`), { pause: 600 });
  await page.waitForURL(/\/iq\/decks\/(?!new)[^/?#]+$/, { timeout: 60_000 });
  deck.id = deckIdOf(); deck.url = new URL(page.url()).pathname;
  await stageLoaded();
  const h0 = await headSpec(deck.id);
  report.api.facts = (h0.spec?.slides ?? []).map((s) => `${s.id}:${s.layout}:${s.title}`);
  step('built from facts', (h0.spec?.slides ?? []).length >= 6, report.api.facts.join(' | '));
  await caption('The editor', 'Eight slides built from the record: the filmstrip on the left, the slide in the middle, its form below.', 'side', 3000);

  // ── 2. Things to check before sharing: an overflow, then the fix ──
  await until(async () => /overflow/i.test(await findings()) || null, 8000, 300);
  const warn0 = await findings();
  report.api.findingsAtStart = warn0;
  await caption('Things to check before sharing', 'The preview measures every slide. Slide 1 overflows, and its thumbnail carries a warning marker.', 'side', 600);
  await point(page.getByTestId(`${IP}-preview-warnings`), 900);
  await press(page.getByTestId(`${IP}-preview-warnings-summary`)).catch(() => undefined);
  await sleep(2200);
  const ids0 = await slideIds();
  await point(page.getByTestId(`${E}-slide-findings-${ids0[0]}`).or(page.getByTestId(`${E}-slide-select-${ids0[0]}`)).first(), 1600);
  await press(page.getByTestId(`${E}-slide-select-${ids0[0]}`));
  await stageLoaded();
  await sleep(800);
  report.api.titleForm = await formFields();
  // The title slide carries five lines from the record (its standfirst), but the Title layout's form has no field for them
  // (a finding): under the Bullets layout they are editable, so Vera trims two there and switches the layout back.
  await caption('Fixing it', 'The title layout\'s form has no field for those five lines, so Vera trims two under Bullets and switches back.', 'side', 1200);
  await press(page.getByTestId(`${TB}-layout`)); await sleep(700);
  await press(page.getByTestId(`${TB}-layout-bullets`), { pause: 500 });
  await sleep(1400);
  let fixed = false;
  for (const re of [/^As of/i, /^Repository/i]) {
    const inputs = page.locator(`input[data-testid^="${E}-slide-bullets-"]`);
    const n = await inputs.count();
    for (let i = n - 1; i >= 0; i--) {
      if (re.test(await inputs.nth(i).inputValue().catch(() => ''))) {
        const rm = page.getByTestId(`${E}-slide-bullets-remove-${i}`);
        if (await rm.count()) { await press(rm, { pause: 500 }); fixed = true; await sleep(900); }
        break;
      }
    }
  }
  await press(page.getByTestId(`${TB}-layout`)); await sleep(700);
  await press(page.getByTestId(`${TB}-layout-title`), { pause: 500 });
  await stageLoaded();
  await caption('Fixed', 'Three lines fit the title slide, and the overflow leaves the list of things to check.', 'side', 200);
  const cleared = await until(async () => (!/overflow/i.test(await findings()) ? true : null), 10_000, 300);
  step('overflow fixed', fixed && !!cleared, `before "${warn0}"; after "${await findings()}"; bullets removed ${fixed}${fixed ? '' : `; title form ${JSON.stringify(report.api.titleForm)}`}`);
  await sleep(2000);
  await press(page.getByTestId(`${IP}-preview-warnings-summary`)).catch(() => undefined); // fold the list again
  await sleep(800);

  // ── 3. Slides from the layout gallery, typed with the stage pinned ──
  await caption('The layout gallery', 'Insert, then All layouts: thirteen layouts open in place of the editor, no dialog.', 'side', 200);
  const agenda = await addSlide('agenda', { after: ids0[0], look: 1600 });
  await caption('Typing into a slide', 'Each slide is a form. The stage stays pinned in view and redraws as Vera types.', 'side', 300);
  await typeKeys(field('title'), 'What we will cover');
  for (let i = 0; i < 2; i++) await press(field('agenda-items-add'), { pause: 150 });
  const agendaItems = ['Where the migration stands', 'Work and budget', 'The cutover decision', 'The plan to January'];
  for (let i = 0; i < agendaItems.length; i++) await type(field(`agenda-items-${i}`), agendaItems[i], i < 2);
  await stageLoaded(); await sleep(1500);

  await caption('Key figures', 'Three headline numbers from the record, each with a label.', 'side', 200);
  const kf = await addSlide('key-figures', { after: 'summary' });
  await typeKeys(field('title'), 'December at a glance');
  fastOn();
  await press(field('figures-add'), { pause: 150 });
  const figs = [['16 of 31', 'Story points done', '+16 this month'], ['$66.93', 'Budget left this period', 'of $75.00'], ['1', 'Decision escalated', 'needs an org leader']];
  for (let i = 0; i < figs.length; i++) { await type(field(`figures-value-${i}`), figs[i][0]); await type(field(`figures-label-${i}`), figs[i][1]); }
  fastOff();
  await stageLoaded(); await sleep(1500);

  await caption('A stacked bar chart', 'Open and done work by type, from the same record: nine items, six still open.', 'side', 200);
  const stacked = await addSlide('chart', { after: 'work-status' });
  await typeKeys(field('title'), 'Open and done work, by type');
  fastOn();
  const kind = field('chart-kind');
  const native = await kind.evaluate((e) => e.tagName === 'SELECT').catch(() => false);
  if (native) { await point(kind); await kind.selectOption('stacked-bar'); } else { await press(kind); await press(page.getByRole('option', { name: /Stacked bar/i }).first()); }
  await sleep(600);
  await press(field('chart-add-label'), { pause: 150 });
  await press(field('chart-add-series'), { pause: 150 });
  for (const [i, l] of ['Epics', 'Stories', 'Bugs'].entries()) await type(field(`chart-label-${i}`), l);
  await type(field('chart-series-name-0'), 'Open'); await type(field('chart-series-name-1'), 'Done');
  for (const [s, vals] of [[0, [2, 2, 2]], [1, [0, 3, 0]]]) for (const [i, v] of vals.entries()) await type(field(`chart-value-${s}-${i}`), String(v));
  fastOff();
  await stageLoaded(); await sleep(2000);

  await caption('A table', 'The two sprints as a small grid; the bullet slide it replaces is deleted from its menu.', 'side', 200);
  const table = await addSlide('table', { after: 'sprints' });
  await typeKeys(field('title'), 'Sprints');
  fastOn();
  await press(field('table-add-column'), { pause: 150 });
  await press(field('table-add-row'), { pause: 150 });
  for (const [i, h] of ['Sprint', 'Focus', 'Points done'].entries()) await type(field(`table-header-${i}`), h);
  const rows = [['Sprint 9', 'OIDC core', '16 of 16'], ['Sprint 10', 'Session hygiene', '0 of 15']];
  for (const [r, row] of rows.entries()) for (const [c, v] of row.entries()) await type(field(`table-cell-${r}-${c}`), v);
  fastOff();
  await stageLoaded(); await sleep(1200);
  await press(page.getByTestId(`${E}-slide-menu-sprints`));
  await sleep(700);
  await press(page.getByTestId(`${E}-slide-delete-sprints`), { pause: 600 });
  await sleep(1500);

  await caption('A comparison', 'The escalated decision, both options weighed, and the line that settles it.', 'side', 200);
  const cmp = await addSlide('comparison', { after: 'decisions' });
  await typeKeys(field('title'), 'Cutover order for legacy SSO tenants');
  fastOn();
  await type(field('comparison-left-title'), 'Largest tenants first');
  await press(field('comparison-left-points-add'), { pause: 150 });
  await type(field('comparison-left-points-0'), 'Retires most legacy sessions early');
  await type(field('comparison-left-points-1'), 'A rollback would hit the most people');
  await type(field('comparison-right-title'), 'Smallest tenants first');
  await press(field('comparison-right-points-add'), { pause: 150 });
  await type(field('comparison-right-points-0'), 'Rehearses the cutover on low traffic');
  await type(field('comparison-right-points-1'), 'Legacy service runs two weeks longer');
  await type(field('comparison-verdict'), 'Recommend smallest first: a rehearsed rollback is worth two weeks of overlap.');
  fastOff();
  await stageLoaded(); await sleep(1200);
  await caption('Speaker notes', 'What to say while the slide is up. Notes go into the .pptx notes pane, not onto the slide.', 'top-right', 200);
  await type(field('notes'), 'Ask for the decision here. We need an org leader to sign off before Sprint 11 planning on 4 December.', true);
  await sleep(1800);

  await caption('A timeline', 'The cutover plan, three dated steps.', 'side', 200);
  const tl = await addSlide('timeline', { after: cmp });
  await typeKeys(field('title'), 'Cutover plan');
  fastOn();
  const steps = [['8 Dec', 'Pilot tenants move'], ['15 Dec', 'Remaining tenants move'], ['12 Jan', 'Legacy auth service off']];
  for (const [i, st] of steps.entries()) { await type(field(`timeline-date-${i}`), st[0]); await type(field(`timeline-label-${i}`), st[1]); }
  fastOff();
  await stageLoaded(); await sleep(1500);

  await caption('A closing slide', 'The ask, the next steps and who to contact.', 'side', 200);
  const closing = await addSlide('closing', { after: tl });
  await typeKeys(field('title'), 'The ask');
  fastOn();
  await type(field('closing-line'), 'One decision keeps the January date.');
  await press(field('closing-steps-add'), { pause: 150 });
  const stepInputs = page.locator(`input[data-testid^="${E}-slide-closing-steps-"]`);
  const ns = ['An org leader approves smallest-first by 5 December'];
  for (let i = 0; i < Math.min(1, await stepInputs.count()); i++) await type(stepInputs.nth(i), ns[i]);
  await type(field('closing-contact'), 'Vera Green, Auth Migration owner');
  fastOff();
  await stageLoaded(); await sleep(1500);
  await caption('A chart slide for a report', 'One more chart after the budget slide; its figures will come from a report, not by hand.', 'side', 200);
  const spend = await addSlide('chart', { after: 'budget', look: 500 });
  await typeKeys(field('title'), 'Where the money goes');
  await stageLoaded(); await sleep(1000);
  report.api.added = { agenda, kf, stacked, table, cmp, tl, closing, spend };

  // ── 4. Reorder, then save ──
  await caption('Reordering', 'Lead with the numbers: the key figures slide moves up from its menu (or Alt+Up).', 'side', 200);
  await press(page.getByTestId(`${E}-slide-menu-${kf}`));
  await sleep(700);
  await press(page.getByTestId(`${E}-slide-up-${kf}`), { pause: 600 });
  await sleep(1500);
  const order1 = await slideIds();
  step('reordered', order1.indexOf(kf) < order1.indexOf('summary'), `order ${order1.join(', ')}`);
  await caption('Save', 'Each save is a new version of the deck.', 'side', 200);
  await press(page.getByTestId(`${IP}-save`), { pause: 500 });
  const saved1 = await until(async () => (!(await page.getByTestId(`${IP}-save`).isEnabled().catch(() => true)) ? true : null), 15_000, 300);
  step('saved v2', !!saved1, `findings "${await findings()}"`);
  await sleep(1500);

  // ── 5. Fill from a report: a pie on the sprint envelopes slide ──
  await caption('Fill from a report', 'Spend by initiative, run under Vera\'s own access, as a pie on the slide she picks.', 'side', 200);
  await press(page.getByTestId(`${E}-slide-select-${spend}`));
  await stageLoaded(); await sleep(800);
  await press(page.getByTestId(`${IP}-report-open`));
  await page.getByTestId(`${IP}-report-panel`).waitFor({ timeout: 10_000 });
  await sleep(1200);
  const sel = page.getByTestId(`${IP}-report-select`);
  const selNative = await sel.evaluate((e) => (e.tagName === 'SELECT' ? 'self' : e.querySelector('select') ? 'inner' : '')).catch(() => '');
  if (selNative) { await point(sel); await (selNative === 'self' ? sel : sel.locator('select')).selectOption('spend-by-initiative'); }
  else { await press(sel); await press(page.getByRole('option', { name: /spend per initiative|spend by initiative/i }).first()); }
  await sleep(1000);
  await press(page.getByTestId(`${IP}-report-panel`).getByText('Pie', { exact: true }).first());
  await sleep(1500);
  const srcBeforePie = await stageSrc();
  await press(page.getByTestId(`${IP}-report-apply`), { pause: 600 });
  // The report fills the saved head through the operations route; wait for the head to carry the pie, then for the stage.
  await until(async () => ((await headSpec(deck.id)).spec?.slides ?? []).some((x) => x.chart?.kind === 'pie') || null, 20_000, 400);
  await stageChanged(srcBeforePie, 5000);
  await sleep(3500);
  const hPie = await headSpec(deck.id);
  const pie = (hPie.spec?.slides ?? []).find((s) => s.chart?.kind === 'pie');
  report.api.findingsAfterPie = await findings();
  step('pie from report', !!pie, pie ? `"${pie.title}" labels ${JSON.stringify(pie.chart.labels)}; findings "${report.api.findingsAfterPie}"` : 'no pie in the head');
  // The report's pie keeps the slide's old bullets beside it; if the preview says the slide overflows, the leftovers come off.
  if (/overflow/i.test(report.api.findingsAfterPie)) {
    await caption('A second overflow', 'The report\'s pie does not fit its slide.', 'side', 1800);
    for (let k = 0; k < 6; k++) {
      const rm = page.locator(`[data-testid^="${E}-slide-bullets-remove-"]`);
      if (!(await rm.count())) break;
      await press(rm.last(), { pause: 300, ms: 400 }); await sleep(500);
    }
    const ok = await until(async () => (!/overflow/i.test(await findings()) ? true : null), 8000, 300);
    step('pie overflow fixed', !!ok, `findings "${await findings()}"; pie slide form ${JSON.stringify((await formFields()).filter((f) => !/source|eyebrow/.test(f)).slice(0, 12))}`);
    if (await page.getByTestId(`${IP}-save`).isEnabled().catch(() => false)) await press(page.getByTestId(`${IP}-save`), { pause: 400 });
    await until(async () => (!(await page.getByTestId(`${IP}-save`).isEnabled().catch(() => true)) ? true : null), 15_000, 300);
    await sleep(1500);
  }

  // ── 6. Theme, undo, redo ──
  await caption('Theme', 'The deck\'s look is one choice: Product, Engineering, Plain or the tenant\'s own.', 'side', 200);
  const firstId = (await slideIds())[0];
  await press(page.getByTestId(`${E}-slide-select-${firstId}`)); await stageLoaded(); await sleep(600);
  let src = await stageSrc();
  const themeLabel = () => page.getByTestId(`${TB}-theme`).innerText().then(squash).catch(() => '');
  const themeIs = async (re) => !!(await until(async () => (re.test(await themeLabel()) ? true : null), 5000, 150));
  await press(page.getByTestId(`${TB}-theme`));
  await sleep(900);
  await press(page.getByTestId(`${TB}-theme-engineering`), { pause: 600 });
  const themed = await themeIs(/Engineering/); await stageLoaded(); await sleep(2200);
  await caption('Undo and redo', 'Every edit can be taken back, and put back.', 'side', 200);
  src = await stageSrc();
  await press(page.getByTestId(`${TB}-undo`), { pause: 600 });
  const undone = await themeIs(/Work/); await stageLoaded(); await sleep(1800);
  src = await stageSrc();
  await press(page.getByTestId(`${TB}-redo`), { pause: 600 });
  const redone = await themeIs(/Engineering/); await stageLoaded(); await sleep(1800);
  step('theme, undo, redo', themed && undone && redone, `theme changed ${themed}, undo ${undone}, redo ${redone}; label now "${await themeLabel()}"`);
  if (await page.getByTestId(`${IP}-save`).isEnabled().catch(() => false)) await press(page.getByTestId(`${IP}-save`), { pause: 400 });
  await until(async () => (!(await page.getByTestId(`${IP}-save`).isEnabled().catch(() => true)) ? true : null), 15_000, 300);
  await sleep(1200);

  // ── 7. Version history ──
  await caption('Version history', 'Every saved version is kept. v1 is the deck as the facts built it.', 'bottom-left', 200);
  const versions = page.getByRole('button', { name: /Presentation versions/ });
  await press(versions); await sleep(1400);
  src = await stageSrc();
  const v1 = page.getByRole('menuitem', { name: /^v1\b/ }).or(page.getByRole('menuitemradio', { name: /^v1\b/ })).or(page.getByRole('menuitemcheckbox', { name: /^v1\b/ })).first();
  await press(v1, { pause: 700 });
  const finalCount = (await slideIds()).length;
  const onV1 = !!(await until(async () => ((await slideIds()).length !== finalCount ? true : null), 8000, 200)); await stageLoaded(); await sleep(2200);
  const v1Count = (await slideIds()).length;
  await point(page.getByTestId(`${E}-slide-list`), 1500);
  await press(versions); await sleep(1000);
  const items = page.locator('[role^="menuitem"]');
  src = await stageSrc();
  await press(items.first(), { pause: 600 });
  await until(async () => ((await slideIds()).length === finalCount ? true : null), 8000, 200); await stageLoaded(); await sleep(1500);
  step('version history', v1Count < (await slideIds()).length, `stage changed on v1 ${onV1}; v1 shows ${v1Count} slides; back on the newest with ${(await slideIds()).length}`);

  // ── 8. Present: both rails fold, no dialog ──
  await caption('Present', 'Present folds both left rails and fills the page with the slide: no dialog, Escape to leave.', 'bottom-left', 200);
  await press(page.getByTestId(`${E}-slide-select-${(await slideIds())[0]}`)); await sleep(600);
  await press(page.getByTestId(`${TB}-present`), { pause: 500 });
  await page.getByTestId(`${E}-present`).waitFor({ timeout: 10_000 });
  await moveTo(VIEW.width * 0.62, VIEW.height * 0.93, 700); // off the slide and off Exit
  await sleep(1500);
  await page.evaluate(() => window.__filmCaption?.(null));
  await sleep(1500);
  const pos = async () => squash(await page.getByTestId(`${E}-present-position`).innerText().catch(() => ''));
  const seen = [await pos()];
  for (let i = 0; i < 6; i++) { await page.keyboard.press('ArrowRight'); await sleep(2100); seen.push(await pos()); }
  await page.keyboard.press('Escape'); await sleep(1800);
  step('present', (await page.getByTestId(`${E}-present`).count()) === 0, `positions ${seen.join(' -> ')}`);

  // ── 9. Download ──
  await caption('Download', 'The saved version as PowerPoint, with native charts and the speaker notes, or as a PDF.', 'side', 200);
  const download = async (testId, name) => {
    await press(page.getByTestId(`${IP}-download-menu`)); await sleep(1100);
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), press(page.getByTestId(testId), { pause: 600 })]);
    const file = path.join(OUT, name.replace('{}', dl.suggestedFilename()));
    await dl.saveAs(file); await sleep(1800);
    return { file, suggested: dl.suggestedFilename(), bytes: fs.statSync(file).size };
  };
  const pptx = await download(`${IP}-download`, '{}');
  const pdf = await download(`${IP}-download-pdf`, '{}');
  report.api.downloads = { pptx: { name: pptx.suggested, bytes: pptx.bytes }, pdf: { name: pdf.suggested, bytes: pdf.bytes } };
  report.pptxFile = path.basename(pptx.file);
  step('downloads', pptx.bytes > 10_000 && fs.readFileSync(pdf.file).subarray(0, 4).toString('latin1') === '%PDF', JSON.stringify(report.api.downloads));

  // ── 10. Share: not shown. A deck with budget figures cannot be shared to a channel (the page says so above the findings line). ──
  report.api.shareOffered = (await page.getByTestId('deck-share-open').count()) > 0;
  await caption('Done', 'A fifteen-slide steering deck, built from the record, checked, versioned and downloaded.', 'side', 200);
  await moveTo(VIEW.width * 0.6, VIEW.height * 0.45, 900);
  await sleep(3500);

  const hEnd = await headSpec(deck.id);
  report.api.final = (hEnd.spec?.slides ?? []).map((s) => ({ layout: s.layout, title: s.title, chart: s.chart?.kind, notes: !!s.notes, theme: undefined }));
  report.api.finalTheme = hEnd.spec?.theme;
  report.api.revisions = hEnd.revisions.length;
} catch (e) {
  if (!e.probe) { exitCode = 1; note(`stopped: ${String(e?.message ?? e).split('\n')[0].slice(0, 300)}`); await page.screenshot({ path: path.join(OUT, 'stopped.png') }).catch(() => undefined); }
} finally {
  timeline.film.toMs = Date.now(); timeline.fastFactor = FAST; fastOff();
  report.pageErrors = errors.slice(0, 30);
  await page.close().catch(() => undefined);
  timeline.video.file = path.relative(OUT, (await page.video()?.path().catch(() => null)) ?? '');
  await context.close().catch(() => undefined);
  await browser.close().catch(() => undefined);
  save();
  clearTimeout(ceiling);
  stopAll();
  await sleep(1500);
  for (const port of [MW_PORT, PORTAL_PORT]) console.log(`film: port ${port} free after the run: ${await portFree(port)}`);
}
if (!PROBE && report.pptxFile) {
  // The .pptx opened: a zip whose slides and charts are counted, the chart kinds read from each chart part.
  const file = path.join(OUT, report.pptxFile);
  const list = spawnSync('unzip', ['-Z1', file], { encoding: 'utf8' });
  const parts = (list.stdout ?? '').split('\n');
  const slides = parts.filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p)).length;
  const charts = parts.filter((p) => /^ppt\/charts\/chart\d+\.xml$/.test(p));
  const kinds = charts.map((c) => { const x = spawnSync('unzip', ['-p', file, c], { encoding: 'utf8' }).stdout ?? ''; const k = /<c:(pieChart|barChart|lineChart|areaChart|doughnutChart)/.exec(x)?.[1] ?? '?'; const g = /<c:grouping val="(\w+)"/.exec(x)?.[1]; return g && k === 'barChart' ? `${k}/${g}` : k; });
  const notes = parts.filter((p) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(p)).length;
  report.pptx = { zipOk: list.status === 0, slides, charts: kinds, notesSlides: notes };
  console.log(`pptx: ${JSON.stringify(report.pptx)}`);
  save();
}
if (!PROBE && timeline.film.fromMs) exitCode = compose() || exitCode;
process.exit(exitCode);

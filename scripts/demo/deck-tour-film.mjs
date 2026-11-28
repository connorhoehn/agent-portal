#!/usr/bin/env node
// "Edit on the slide, or ask": a recorded tour of the deck builder the way its owner uses it. Nothing is typed into a form: a seeded
// sample deck shows the designed layouts, a new deck starts from a template, then every edit is made by clicking on the slide (title in
// place, emphasis bar, icon and graphic pickers in the side pane, cards added and removed on the slide, the style picker) or by asking
// the composer's agent mode (the mock's deterministic proposer: add a kpi slide, put a report's chart on it, emphasise words, switch
// style) and pressing Apply on its card. Then present (both rails fold) and download the .pptx, which is opened and checked.
// One Chromium (1440 by 900), one person (Vera Green, u-vera, org-leader on p-auth-migration), no voice (the provider account is out
// of credit, so the voice navigator is never started).
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
  const whole = /^(A sample deck|Designed layouts|Present|Done)$/;
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
  // ── 1. A sample deck: the rich look, before anything is built ──
  const R = `${E}-regions`;
  const region = (p) => page.getByTestId(`${R}-region-${p}`);
  const selectSlide = async (id, pause = 350) => { await press(page.getByTestId(`${E}-slide-select-${id}`), { pause }); await stageLoaded(); };
  const opsPost = (ms = 20_000) => page.waitForResponse((r) => r.request().method() === 'POST' && /\/operations(\?|$)/.test(r.url()), { timeout: ms }).catch(() => null);
  const SAMPLE = 'idk-5a301e00-0000-4000-8000-000000000001';
  await go(`/iq/projects/${P}?tab=docs`);
  await page.getByTestId('initiative-files-new').waitFor({ timeout: 20_000 });
  await sleep(1000);
  timeline.film.fromMs = Date.now() - 400;
  await caption('A sample deck', 'Vera owns the Auth Migration initiative. Its steering update is already a deck, drawn by the deck engine.', 'bottom-right', 3000);
  const row = page.getByText(/steering update/i).first();
  if (await row.isVisible().catch(() => false)) { await press(row, { pause: 500 }); await page.waitForURL(/\/iq\/decks\/[^/?#]+/, { timeout: 15_000 }).catch(() => undefined); }
  if (!page.url().includes(SAMPLE)) await go(`/iq/decks/${SAMPLE}`);
  await stageLoaded(10_000); await sleep(1500);
  const sampleIds = await slideIds();
  step('sample deck', sampleIds.length >= 6, `${sampleIds.length} slides: ${sampleIds.join(', ')}`);
  await caption('Designed layouts', 'Cover, agenda, KPIs over a chart, icon cards, a timeline: layouts with real structure, in the corporate style.', 'bottom-left', 1500);
  for (const id of sampleIds.slice(1, 5)) { await selectSlide(id, 250); await sleep(1700); }

  // ── 2. A new deck from a template ──
  await go(`/iq/decks/new?projectId=${P}`);
  await page.getByTestId(`${IP}-new-template-submit`).waitFor({ timeout: 20_000 });
  await caption('Start from a template', 'Eight templates, each a finished deck to rework: status update, proposal, review and more.', 'bottom-right', 400);
  const tiles = page.locator(`button[data-testid^="${IP}-template-"]:not([data-testid$="-strip"]):not([data-testid$="-facts"])`);
  const nTiles = await tiles.count();
  for (let i = 0; i < Math.min(4, nTiles); i++) await point(tiles.nth(i), 350, 450);
  await press(page.getByTestId(`${IP}-template-status-update`), { pause: 500 });
  const titleField = page.getByTestId(`${IP}-new-title`);
  if (!(await titleField.inputValue().catch(() => ''))) await titleField.fill('Auth Migration: December status');
  await press(page.getByTestId(`${IP}-new-template-submit`), { pause: 400 });
  await page.waitForURL(/\/iq\/decks\/(?!new)[^/?#]+$/, { timeout: 60_000 });
  deck.id = deckIdOf(); deck.url = new URL(page.url()).pathname;
  await stageLoaded(10_000); await sleep(1200);
  const h0 = await headSpec(deck.id);
  report.api.template = (h0.spec?.slides ?? []).map((x) => `${x.id}:${x.layout}`);
  step('template deck', (h0.spec?.slides ?? []).length >= 5, report.api.template.join(' | '));
  const ids = await slideIds();
  const first = ids[0];

  // ── 3. Edit on the slide ──
  await caption('Edit in place', 'Click the title on the slide: the editor opens on its box, in the slide\'s own font, size and colour.', 'bottom-right', 600);
  await selectSlide(first);
  await press(region('title'), { pause: 400 });
  const ed = page.getByTestId(`${R}-editor`);
  await ed.waitFor({ timeout: 8000 });
  await sleep(900);
  await ed.press('ControlOrMeta+a');
  await ed.pressSequentially('Auth migration: one login path', { delay: 45 });
  await sleep(500);
  let posted = opsPost();
  await page.keyboard.press('Enter');
  const r1 = await posted; await stageLoaded(); await sleep(1600);
  step('retitle in place', !!r1 && r1.ok(), `operations ${r1 ? r1.status() : 'none'}`);

  await caption('Emphasis', 'Select words and the emphasis bar sits beside the box: highlight, accent, gradient, underline. Vera picks Highlight.', 'bottom-right', 400);
  await press(region('title'), { pause: 300 });
  await ed.waitFor({ timeout: 8000 });
  await ed.evaluate((e) => { const v = e.value; const at = v.indexOf('one login'); e.focus(); e.setSelectionRange(at < 0 ? 0 : at, at < 0 ? 4 : at + 'one login path'.length); e.dispatchEvent(new Event('select', { bubbles: true })); document.dispatchEvent(new Event('selectionchange')); });
  await sleep(900);
  const hl = page.getByRole('button', { name: /^Highlight/ }).first();
  const hlShown = await hl.isVisible().catch(() => false);
  posted = opsPost();
  if (hlShown) await press(hl, { pause: 500 });
  await sleep(400);
  if (await ed.count()) { await ed.focus().catch(() => undefined); await page.keyboard.press('Enter'); }
  const r2 = await posted; await stageLoaded(); await sleep(1800);
  step('highlight', hlShown && !!r2 && r2.ok(), `bar shown ${hlShown}; operations ${r2 ? r2.status() : 'none'}`);

  const cardsId = (h0.spec?.slides ?? []).find((x) => Array.isArray(x.items) && x.items.length && x.items[0].icon)?.id ?? '';
  await caption('Icons', 'Click a card\'s icon: the icon picker opens in the side pane, and the slide redraws with the new one.', 'top-right', 400);
  await selectSlide(cardsId); await sleep(700);
  await press(region('items[0].icon'), { pause: 400 });
  const picker = page.getByTestId(`${E}-icon-picker`);
  await picker.waitFor({ timeout: 8000 }); await sleep(700);
  const choice = picker.locator('button[aria-pressed="false"], [role="option"][aria-selected="false"], [role="radio"][aria-checked="false"]').nth(5);
  posted = opsPost();
  await press(choice, { pause: 500 });
  const r3 = await posted; await stageLoaded(); await sleep(1600);
  step('icon swap', !!r3 && r3.ok(), `operations ${r3 ? r3.status() : 'none'}`);
  if (await page.getByTestId(`${E}-pick-close`).isVisible().catch(() => false)) { await press(page.getByTestId(`${E}-pick-close`), { pause: 200 }); }

  await caption('Cards on the slide', 'Hover a card for its plus and minus: add a card, the row reflows; remove it again. No dialog.', 'top-right', 400);
  await point(region('items[0].title'), 500); await page.getByTestId(`${R}-region-items[0].title`).hover(); await sleep(400);
  posted = opsPost();
  await press(page.getByTestId(`${R}-row-add-items[0].title`), { pause: 400 });
  const r4 = await posted; await stageLoaded(); await sleep(2000);
  await page.getByTestId(`${R}-region-items[1].title`).hover(); await sleep(400);
  posted = opsPost();
  await press(page.getByTestId(`${R}-row-remove-items[1].title`), { pause: 400 });
  const r5 = await posted; await stageLoaded(); await sleep(1600);
  step('card add and remove', !!r4 && r4.ok() && !!r5 && r5.ok(), `add ${r4 ? r4.status() : 'none'}, remove ${r5 ? r5.status() : 'none'}`);

  await caption('Graphics', 'A decoration from the graphic picker: each tile is the artwork itself, in the deck\'s colours.', 'top-left', 400);
  await selectSlide(first); await sleep(500);
  const toggle = page.getByTestId(`${E}-decoration-toggle`);
  if (!/done/i.test(await toggle.innerText().catch(() => ''))) await press(toggle, { pause: 400 });
  const deco = page.getByTestId(`${E}-decoration`);
  await deco.waitFor({ timeout: 8000 }); await sleep(1200);
  const decoChoices = deco.locator('button:not([data-testid$="-toggle"]):not([role="tab"]), [role="radio"], [role="option"]');
  let picked = null;
  for (let i = 0, n = await decoChoices.count(); i < n && !picked; i++) {
    const c = decoChoices.nth(i); const lbl = squash((await c.getAttribute('aria-label')) ?? (await c.innerText().catch(() => '')));
    if (lbl && !/style default|^none|no graphic|default|corner|background|beside/i.test(lbl) && (await c.getAttribute('aria-checked')) !== 'true' && (await c.getAttribute('aria-pressed')) !== 'true' && i >= 3) { picked = lbl; posted = opsPost(); await press(c, { pause: 500 }); }
  }
  const r6 = await posted; await stageLoaded(); await sleep(2000);
  step('decoration', !!picked && !!r6 && r6.ok(), `picked "${picked}"; operations ${r6 ? r6.status() : 'none'}`);
  if (await page.getByTestId(`${E}-pick-close`).isVisible().catch(() => false)) await press(page.getByTestId(`${E}-pick-close`), { pause: 200 });
  if (/done/i.test(await toggle.innerText().catch(() => ''))) await press(toggle, { pause: 200 });

  // ── 4. Styles: the whole deck restyles ──
  await caption('Styles', 'One choice restyles every slide: bold, then editorial, then playful. Same words, new design.', 'top-left', 400);
  await selectSlide(cardsId); await sleep(400);
  const summary = page.getByTestId(`${E}-style-summary`);
  if (await summary.count() && !(await page.getByTestId(`${E}-style-picker-editorial`).isVisible().catch(() => false))) await press(summary, { pause: 300 });
  const styled = [];
  for (const st of ['bold', 'editorial', 'playful']) {
    const before = await stageSrc();
    posted = opsPost();
    await press(page.getByTestId(`${E}-style-picker-${st}`), { pause: 300 });
    const r = await posted; styled.push(`${st} ${r ? r.status() : 'none'}`);
    await stageChanged(before, 8000); await sleep(2200);
  }
  step('styles', styled.every((x) => /20\d$/.test(x)), styled.join(', '));

  // ── 5. The agent does the rest ──
  await caption('Ask the agent', 'Agent mode in the composer: "put the spend by initiative pie on slide 3". Read the card, Apply: a chart from the report.', 'top-left', 400);
  const action = page.getByRole('button', { name: /Presentation agent action/ });
  if (await action.count()) { await press(action, { pause: 300 }); await press(page.getByRole('menuitem', { name: /Edit saved slides/ }), { pause: 300 }); }
  const input = page.getByRole('textbox', { name: /Presentation message/ }).first();
  const ask = async (text, sceneTitle, line) => {
    if (sceneTitle) await caption(sceneTitle, line, 'top-left', 300);
    await press(input, { pause: 200 });
    await input.pressSequentially(text, { delay: 28 });
    await sleep(300);
    await page.keyboard.press('Enter');
    const card = page.getByTestId('deck-composer-proposal').last();
    if (!(await card.waitFor({ timeout: 30_000 }).then(() => true).catch(() => false))) { step(`agent: ${text}`, false, 'no proposal card'); return; }
    await sleep(1600);
    const words = squash(await card.innerText()).slice(0, 160);
    const before = await stageSrc();
    const p = opsPost(30_000);
    await press(card.getByRole('button', { name: 'Apply' }), { pause: 500 });
    const r = await p;
    await stageChanged(before, 10_000); await sleep(1800);
    step(`agent: ${text}`, !!r && r.ok(), `card "${words}"; operations ${r ? r.status() : 'none'}`);
  };
  // "add a kpi slide after the agenda" is refused by the mock's proposer: a new kpi slide needs its chart in the same list, and
  // set_chart cannot name a slide add_slide has not made yet (docs/deck-tour-film-report.md). The kpi slide the template has takes it.
  await selectSlide(ids[2]); await sleep(300);
  await ask('put the spend by initiative pie on slide 3', null, null);
  const tlId = (await headSpec(deck.id)).spec?.slides?.find((x) => x.layout === 'timeline')?.id;
  if (tlId) await selectSlide(tlId);
  await ask('emphasise "comes next" in the title', 'Emphasis by asking', 'The same highlight as the toolbar, on the selected slide\'s title.');
  await ask('switch to the corporate style', 'Style by asking', 'And back to corporate for the steering group.');

  // ── 6. Present ──
  await caption('Present', 'Present folds both left rails and fills the page with the slide: no dialog, Escape to leave.', 'bottom-left', 400);
  await selectSlide((await slideIds())[0]);
  await press(page.getByTestId(`${TB}-present`), { pause: 400 });
  await page.getByTestId(`${E}-present`).waitFor({ timeout: 10_000 });
  await moveTo(VIEW.width * 0.62, VIEW.height * 0.93, 600);
  await sleep(1400);
  await page.evaluate(() => window.__filmCaption?.(null));
  const pos = async () => squash(await page.getByTestId(`${E}-present-position`).innerText().catch(() => ''));
  const seen = [await pos()];
  for (let i = 0; i < 6; i++) { await page.keyboard.press('ArrowRight'); await sleep(1900); seen.push(await pos()); }
  await page.keyboard.press('Escape'); await sleep(1500);
  step('present', (await page.getByTestId(`${E}-present`).count()) === 0, `positions ${seen.join(' -> ')}`);

  // ── 7. Download ──
  await caption('Download', 'The saved version as PowerPoint: native shapes, icons, gradients and charts, editable in PowerPoint.', 'side', 400);
  await press(page.getByTestId(`${IP}-download-menu`)); await sleep(900);
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), press(page.getByTestId(`${IP}-download`), { pause: 500 })]);
  const file = path.join(OUT, dl.suggestedFilename());
  await dl.saveAs(file); await sleep(1500);
  report.api.downloads = { pptx: { name: dl.suggestedFilename(), bytes: fs.statSync(file).size } };
  report.pptxFile = path.basename(file);
  step('download', fs.statSync(file).size > 10_000, JSON.stringify(report.api.downloads));
  await caption('Done', 'A status deck from a template, edited on the slide and by asking, presented and downloaded. Nothing typed into a form.', 'side', 400);
  await moveTo(VIEW.width * 0.6, VIEW.height * 0.45, 800);
  await sleep(3000);

  const hEnd = await headSpec(deck.id);
  report.api.final = (hEnd.spec?.slides ?? []).map((x) => ({ layout: x.layout, title: x.title, chart: x.chart?.kind, decoration: x.decoration }));
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
  // Native drawing: icons as custom geometry, gradients as gradFill, counted over the slide parts.
  let custGeom = 0; let gradFill = 0;
  for (const sp of parts.filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))) {
    const x = spawnSync('unzip', ['-p', file, sp], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).stdout ?? '';
    custGeom += (x.match(/<a:custGeom[ >]/g) ?? []).length; gradFill += (x.match(/<a:gradFill/g) ?? []).length;
  }
  report.pptx = { zipOk: list.status === 0, slides, charts: kinds, notesSlides: notes, custGeom, gradFill };
  console.log(`pptx: ${JSON.stringify(report.pptx)}`);
  save();
}
if (!PROBE && timeline.film.fromMs) exitCode = compose() || exitCode;
process.exit(exitCode);

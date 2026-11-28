#!/usr/bin/env node
// The deck builder walk (docs/deck-edit-operations.md): the new-deck pages, the editor on the new engine, the layout
// gallery, overflow findings, charts from reports, themes, presenting in place, the three exports, the voice driving
// the open deck (the navigator's tools through the scripted session, no microphone) and the other tenants' decks.
// It writes, so it resets the mock world first and again at the end. Screenshots, the downloaded files and
// decks-facts.json go to --out; every screenshot records sideways scroll, dialogs and clipping.
//
//   cd portal && JOURNEY_MIDDLEWARE_PORT=3997 JOURNEY_PORTAL_PORT=5197 npm run journey:decks -- --out <dir>
//
// Pass rules describe correct behaviour: a step that finds a defect stays FAIL (exit 1).
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const req = createRequire(path.join(ROOT, 'portal', 'package.json'));
const pw = await import(pathToFileURL(req.resolve('playwright')).href);
const chromium = pw.chromium ?? pw.default.chromium;

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const PORTAL = (process.env.PORTAL_URL ?? 'http://localhost:5166').replace(/\/$/, '');
const MIDDLEWARE = (process.env.MIDDLEWARE_URL ?? 'http://127.0.0.1:3966').replace(/\/$/, '');
const OUT = flag('--out');
if (!OUT) { console.error('--out <dir> is required'); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });

const ONLY = (flag('--only') ?? '').split(',').map((x) => x.trim()).filter(Boolean);
const P = 'p-auth-migration';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const facts = [];
const consoleErrors = [];
const why = (e) => (e instanceof Error ? e.message.split('\n')[0] : String(e)).slice(0, 400);
const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const saveFacts = () => fs.writeFileSync(path.join(OUT, 'decks-facts.json'), JSON.stringify({ facts, consoleErrors, results }, null, 2));

async function resetMock() {
  const r = await fetch(`${MIDDLEWARE}/api/__mock/reset`, { method: 'POST' });
  if (r.status !== 200) throw new Error(`POST /api/__mock/reset answered ${r.status}`);
}

// The fake microphone lets the voice dock start headless; nothing is captured.
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
let currentStep = '';

async function signIn(userId, { tenant, role, width = 1440 } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, permissions: ['microphone'], acceptDownloads: true });
  const login = await ctx.request.post(`${PORTAL}/api/session/login`, { data: { userId } });
  if (login.status() !== 200) throw new Error(`login ${userId}: ${login.status()}`);
  if (role) {
    const r = await ctx.request.post(`${PORTAL}/api/session/role`, { data: { tenant: tenant ?? 'orgiq', role } });
    if (r.status() !== 200) throw new Error(`role ${role}: ${r.status()}`);
  } else if (tenant) {
    const r = await ctx.request.post(`${PORTAL}/api/session/tenant`, { data: { tenant } });
    if (r.status() !== 200) throw new Error(`tenant ${tenant}: ${r.status()}`);
  }
  await ctx.addInitScript(() => {
    window.__voiceFrames = [];
    window.addEventListener('voice-mock-frame', (e) => window.__voiceFrames.push(e.detail));
  });
  return ctx;
}
function watch(page) {
  page.on('pageerror', (e) => consoleErrors.push({ step: currentStep, kind: 'pageerror', text: String(e).slice(0, 240) }));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push({ step: currentStep, kind: 'console', text: m.text().slice(0, 240) }); });
  page.on('response', (r) => {
    if (r.status() < 400 || !r.url().includes('/api/')) return;
    const at = currentStep;
    r.text().catch(() => '').then((t) => consoleErrors.push({ step: at, kind: `http ${r.status()}`, text: `${r.request().method()} ${r.url().replace(PORTAL, '')} ${t.slice(0, 160)}` }));
  });
}

async function step(name, fn) {
  if (ONLY.length && !name.startsWith('D1 ') && !ONLY.some((o) => name.startsWith(`${o} `) || name.startsWith(o))) return;
  currentStep = name;
  const errsBefore = consoleErrors.length;
  let ok = false; let detail;
  try { const r = await fn(); ok = r.ok; detail = r.detail; } catch (e) { detail = why(e); }
  const errs = consoleErrors.length - errsBefore;
  const line = `${ok ? 'PASS' : 'FAIL'} ${name}: ${detail}${errs ? ` [${errs} console/http error(s)]` : ''}`;
  results.push({ step: name, ok, detail, errors: errs });
  console.log(line);
  saveFacts();
}

// The two dialogs the owner allows are not counted: the voice dock's own confirm card (identified by its test id,
// `voice-confirm-card`, on the element or inside it) and the library's ConfirmDialog for a destructive confirmation
// (identified by its `confirm-dialog-confirm` button). Every other role=dialog or aria-modal element counts.
const dialogsIn = (page) => page.evaluate(() => [...document.querySelectorAll('[role="dialog"],[aria-modal="true"]')]
  .filter((e) => !e.closest('[data-testid="voice-confirm-card"]') && !e.querySelector('[data-testid="voice-confirm-card"], [data-testid="confirm-dialog-confirm"]'))
  .map((e) => e.getAttribute('aria-label') || e.getAttribute('data-testid') || e.tagName));

/** One screenshot per width; `sel` is the element under test (a test id), judged for clipped text. */
async function snap(page, name, widths, sel) {
  const rows = [];
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    await sleep(500);
    const f = await page.evaluate((s) => {
      const el = s ? document.querySelector(`[data-testid="${s}"]`) : null;
      return {
        horizontalScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        elementFound: s ? !!el : null,
        elementClipped: el ? (el.scrollWidth > el.clientWidth + 1) : null,
      };
    }, sel ?? null);
    const dialogs = await dialogsIn(page);
    const file = `${name}-${width}.png`;
    await page.screenshot({ path: path.join(OUT, file) });
    rows.push({ file, width, ...f, dialogs });
    facts.push({ step: currentStep, file, width, ...f, dialogs });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  return rows;
}
const fmt = (rows) => rows.map((r) => `@${r.width}${r.horizontalScroll ? ' HSCROLL' : ''}${r.elementClipped ? ' CLIPPED' : ''}${r.dialogs.length ? ` DIALOG(${r.dialogs.join(',')})` : ''}`).join(' ');
const noDialogs = (rows) => rows.every((r) => r.dialogs.length === 0);
// The voice steps hold the dock's confirm card open; dialogsIn already leaves it (and only it, with ConfirmDialog) out.
const noDeckDialogs = noDialogs;

async function go(page, p) {
  await page.goto(`${PORTAL}${p}`, { waitUntil: 'domcontentloaded', timeout: 40000 });
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => undefined);
}
const jget = async (ctx, url) => { const r = await ctx.request.get(`${PORTAL}${url}`); return { status: r.status(), body: await r.json().catch(() => null) }; };
const ids = (page, re) => page.evaluate((r) => [...new Set([...document.querySelectorAll('[data-testid]')].map((e) => e.getAttribute('data-testid')))].filter((i) => new RegExp(r).test(i)), re);

/** Natural widths of the images under a selector, after waiting for them to load. */
async function imagesLoaded(page, sel, ms = 15000) {
  const end = Date.now() + ms; let last = { n: 0, loaded: 0 };
  while (Date.now() < end) {
    last = await page.evaluate((s) => { const imgs = [...document.querySelectorAll(`${s} img`)]; return { n: imgs.length, loaded: imgs.filter((i) => i.complete && i.naturalWidth > 0).length }; }, sel);
    if (last.n > 0 && last.loaded === last.n) return last;
    await sleep(300);
  }
  return last;
}
const stageLoaded = async (page, p, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const w = await page.evaluate((t) => { const i = document.querySelector(`[data-testid="${t}"]`); return i && i.complete ? i.naturalWidth : 0; }, `${p}-editor-stage-image`).catch(() => 0);
    if (w > 0) { await sleep(600); return w; }
    await sleep(300);
  }
  return 0;
};
const waitSrcChange = async (page, p, before, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const src = await page.evaluate((t) => document.querySelector(`[data-testid="${t}"]`)?.getAttribute('src') ?? '', `${p}-editor-stage-image`);
    if (src && src !== before) return true;
    await sleep(300);
  }
  return false;
};
const stageSrc = (page, p) => page.evaluate((t) => document.querySelector(`[data-testid="${t}"]`)?.getAttribute('src') ?? '', `${p}-editor-stage-image`);

const IP = 'initiative-deck';
/** The findings line's full text: opens its disclosure (as a reader would) when it is closed. */
async function findingsText(page, p = IP) {
  const root = page.getByTestId(`${p}-preview-warnings`);
  if (!(await root.count())) return '';
  const open = await root.evaluate((e) => (e.tagName === 'DETAILS' ? e : e.querySelector('details'))?.open ?? true);
  if (!open) await root.locator('summary').first().click().catch(() => undefined);
  return squash(await root.innerText().catch(() => ''));
}
const E = `${IP}-editor`;
const deckIdOf = (page) => decodeURIComponent((page.url().match(/\/decks\/([^/?#]+)/) ?? [])[1] ?? '');
async function headSpec(ctx, deckId) {
  const d = await jget(ctx, `/api/initiative-decks/${encodeURIComponent(deckId)}`);
  const rev = d.body?.activeRevisionId;
  const s = await jget(ctx, `/api/initiative-decks/${encodeURIComponent(deckId)}/revisions/${encodeURIComponent(rev)}/spec`);
  return { deck: d.body, rev, spec: s.body?.spec ?? s.body };
}
/** Save through the page and read the server's answer: a refusal fails the step, never "saved" on a 400. */
async function saveDeck(page) {
  const save = page.getByTestId(`${IP}-save`);
  if (!(await save.isEnabled().catch(() => false))) return { ok: false, line: `Save is disabled (${(await save.getAttribute('title')) ?? 'no hint'})` };
  const answer = page.waitForResponse((r) => r.request().method() === 'POST' && /\/api\/initiative-decks\/[^/]+\/revisions(\?|$)/.test(r.url()), { timeout: 20000 });
  await save.click();
  const res = await answer.catch(() => null);
  if (!res) return { ok: false, line: 'Save posted nothing within 20 s' };
  const body = await res.json().catch(() => null);
  await sleep(1500);
  const shown = squash(await page.getByTestId(`${IP}-save-error`).innerText().catch(() => ''));
  if (!res.ok()) return { ok: false, line: `Save answered ${res.status()} (${JSON.stringify(body).slice(0, 200)}); the page shows "${shown}"` };
  return { ok: true, line: `saved (${res.status()}, revision ${body?.id ?? body?.revision?.id ?? '?'})` };
}
/** Distinct strong colours in the stage's painted PNG (the slide as drawn), clustered so anti-aliasing does not count. */
async function stageColours(page) {
  return page.evaluate(async (t) => {
    const src = document.querySelector(`[data-testid="${t}"]`)?.getAttribute('src') ?? '';
    const text = decodeURIComponent(src.replace(/^data:image\/svg\+xml;charset=utf-8,/, ''));
    const png = (text.match(/data:image\/png;base64,([A-Za-z0-9+/=]+)/) ?? [])[1];
    if (!png) return { error: 'the stage is not a painted PNG', colours: [] };
    const img = new Image(); img.src = `data:image/png;base64,${png}`; await img.decode();
    const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
    const g = c.getContext('2d'); g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data; const counts = new Map();
    for (let i = 0; i < d.length; i += 4) {
      const [r, gg, b] = [d[i], d[i + 1], d[i + 2]]; const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b);
      if (mx - mn < 40) continue; // greys, white, black and the text: not a slice colour
      const k = `${r >> 3},${gg >> 3},${b >> 3}`; counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const min = (c.width * c.height) * 0.002; const out = [];
    for (const [k, n] of [...counts].sort((a, b) => b[1] - a[1])) {
      if (n < min) break;
      const rgb = k.split(',').map((v) => Number(v) * 8 + 4);
      if (out.every((o) => Math.hypot(o.rgb[0] - rgb[0], o.rgb[1] - rgb[1], o.rgb[2] - rgb[2]) > 40)) out.push({ rgb, share: Math.round((n / (c.width * c.height)) * 1000) / 10 });
    }
    return { colours: out.map((o) => `#${o.rgb.map((v) => Math.min(255, v).toString(16).padStart(2, '0')).join('')} ${o.share}%`) };
  }, `${IP}-editor-stage-image`);
}
async function openLayoutGallery(page) {
  await page.getByTestId(`${E}-toolbar-more`).click();
  await page.getByTestId(`${E}-toolbar-insert-all`).click();
  await page.getByTestId(`${E}-layout-panel`).waitFor({ timeout: 10000 });
}
/** Fill every empty text input of the slide form (except title, eyebrow, source search) with a short word. */
async function fillForm(page, scope = '') {
  const inputs = page.locator(`[data-testid="${E}-slide-form"] input:not([data-testid$="-slide-source-search"]):not([data-testid$="-slide-eyebrow"]), [data-testid="${E}-slide-form"] textarea`);
  const n = await inputs.count(); let filled = 0;
  for (let i = 0; i < n; i++) {
    const el = inputs.nth(i);
    if (!(await el.isVisible().catch(() => false))) continue;
    const t = await el.getAttribute('type');
    if (t === 'checkbox' || t === 'radio' || t === 'file') continue;
    const tid = (await el.getAttribute('data-testid')) ?? '';
    if (/-slide-title$/.test(tid)) continue;
    const num = t === 'number' || /value|figure|cell/i.test(`${tid} ${await el.getAttribute('aria-label')}`);
    await el.fill(num ? String(10 + i) : `${scope}Item ${i}`).catch(() => undefined);
    filled++;
  }
  return filled;
}

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

await resetMock();
const vera = await signIn('u-vera', { role: 'org-leader' });
const page = await vera.newPage();
watch(page);
let deckId = '';
let deckUrl = '';

// D1 ───────────────────────────────────────────────────────────────────────────────────────────────────────────
await step('D1 new deck from a template', async () => {
  await go(page, `/iq/projects/${P}?tab=docs`);
  await page.getByTestId('initiative-files-new').click();
  await page.getByRole('menuitem', { name: /Presentation/ }).click();
  await page.waitForURL(/\/iq\/decks\/new/, { timeout: 15000 });
  await page.getByTestId(`${IP}-new-submit`).waitFor({ timeout: 15000 });
  // Both choices on arrival, no click: the facts row at the top and the gallery directly under it, at 1440 and 390.
  await page.locator(`button[data-testid^="${IP}-template-"]`).first().waitFor({ timeout: 15000 });
  await imagesLoaded(page, `[data-testid="${IP}-template"]`);
  const arrival = [];
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 }); await sleep(600);
    arrival.push(await page.evaluate((p) => {
      const top = (id) => { const r = document.querySelector(`[data-testid="${id}"]`)?.getBoundingClientRect(); return r ? Math.round(r.top) : null; };
      const tile = document.querySelector(`button[data-testid^="${p}-template-"]`)?.getBoundingClientRect();
      const h1 = [...document.querySelectorAll('h1')].find((h) => h.offsetParent !== null && h.textContent.trim());
      const cut = h1 ? (h1.scrollWidth > h1.clientWidth + 1 || [h1, ...h1.querySelectorAll('*')].some((e) => getComputedStyle(e).textOverflow === 'ellipsis' && e.scrollWidth > e.clientWidth + 1)) : null;
      return { width: innerWidth, facts: top(`${p}-new-facts`), examples: top(`${p}-new-examples`), tileTop: tile ? Math.round(tile.top) : null, vh: innerHeight, heading: h1?.textContent.trim() ?? null, headingCut: cut };
    }, IP));
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  const facts1 = await snap(page, 'D1a-new-arrival', [1440, 390], `${IP}-new`);
  const choice = await page.getByText("From this initiative's facts", { exact: true }).count();
  const onArrival = arrival.every((a) => a.facts !== null && a.examples !== null && a.facts < a.examples && a.examples < a.vh && a.tileTop !== null && a.tileTop < a.vh && a.headingCut === false);
  const tiles = await page.evaluate((p) => [...document.querySelectorAll(`button[data-testid^="${p}-template-"]`)].filter((b) => !/-(strip|facts)$/.test(b.getAttribute('data-testid'))).map((b) => ({ id: b.getAttribute('data-testid'), imgs: [...b.querySelectorAll('img')].map((i) => i.complete && i.naturalWidth > 0) })), IP);
  const shots = await snap(page, 'D1b-new-examples', [1440, 900, 390], `${IP}-new`);
  const allLoaded = tiles.length > 0 && tiles.every((t) => t.imgs.length > 0 && t.imgs.every(Boolean));
  await page.getByTestId(`${IP}-new-title`).fill('Walk: status update');
  await page.getByTestId(`${IP}-template-status-update`).click();
  await page.getByTestId(`${IP}-new-template-submit`).click();
  await page.waitForURL(/\/iq\/decks\/(?!new)[^/?#]+$/, { timeout: 30000 });
  deckId = deckIdOf(page); deckUrl = new URL(page.url()).pathname;
  const ok = tiles.length === 5 && allLoaded && choice > 0 && onArrival && noDialogs([...facts1, ...shots]) && !shots.some((r) => r.horizontalScroll);
  return { ok, detail: `${tiles.length} templates, every tile preview loaded: ${allLoaded} (images per tile ${tiles.map((t) => t.imgs.length).join('/')}); "from this initiative's facts" choice shown: ${choice > 0}; on arrival ${arrival.map((a) => `@${a.width}: facts row y ${a.facts}, gallery y ${a.examples}, first tile y ${a.tileTop} of ${a.vh}, heading "${a.heading}" truncated ${a.headingCut}`).join('; ')} (both visible without a click: ${onArrival}); landed on ${deckUrl}; ${fmt(shots)}` };
});

// D2 ───────────────────────────────────────────────────────────────────────────────────────────────────────────
await step('D2 the editor on the new engine', async () => {
  const w = await stageLoaded(page, IP);
  const thumbs = await imagesLoaded(page, `[data-testid="${E}-slide-list"]`);
  const warn = await findingsText(page);
  const geo = await page.evaluate((p) => {
    const img = document.querySelector(`[data-testid="${p}-editor-stage-image"]`)?.getBoundingClientRect();
    const ban = document.querySelector(`[data-testid="${p}-preview-warnings"]`)?.getBoundingClientRect();
    return { stageTop: img ? Math.round(img.top) : null, stageBottom: img ? Math.round(img.bottom) : null, bannerHeight: ban ? Math.round(ban.height) : null, vh: innerHeight };
  }, IP);
  const shots = await snap(page, 'D2-editor', [1440, 900], `${E}`);
  // The slide is the main thing: the assistant pane opens folded away, so the toolbar keeps Theme inline even at 900.
  const room = [];
  for (const width of [1440, 900]) {
    await page.setViewportSize({ width, height: 900 }); await sleep(600);
    room.push(await page.evaluate((e) => {
      const theme = [...document.querySelectorAll(`[data-testid="${e}-toolbar"] [data-testid*="theme"], [data-testid="${e}-toolbar"] button[aria-label*="heme" i]`)].find((x) => x.offsetParent !== null);
      const pane = document.querySelector('[data-testid="deck-assistant-pane"]');
      return { width: innerWidth, theme: theme ? theme.getAttribute('data-testid') || theme.getAttribute('aria-label') : null, pane: !!pane && pane.offsetParent !== null };
    }, E));
  }
  await page.setViewportSize({ width: 1440, height: 900 }); await sleep(400);
  const roomOk = room.every((r) => r.theme && !r.pane);
  facts.push({ step: 'D2', geo, warn, room });
  const exampleWarn = /example/i.test(warn);
  const visible = geo.stageTop !== null && geo.stageBottom !== null && (Math.min(geo.stageBottom, geo.vh) - Math.max(geo.stageTop, 0)) >= 0.5 * (geo.stageBottom - geo.stageTop);
  return { ok: w > 0 && thumbs.n > 0 && thumbs.loaded === thumbs.n && exampleWarn && visible && roomOk && noDialogs(shots), detail: `${room.map((r) => `@${r.width}: Theme in the toolbar ${r.theme ?? 'NO (in the overflow menu)'}, assistant pane open ${r.pane}`).join('; ')}; stage image natural width ${w}; thumbnails ${thumbs.loaded}/${thumbs.n} loaded; warnings: "${warn.slice(0, 160)}"; warning banner ${geo.bannerHeight}px tall, stage spans y ${geo.stageTop}-${geo.stageBottom} of a ${geo.vh}px viewport (at least half visible: ${visible}); ${fmt(shots)}` };
});

// D3 ───────────────────────────────────────────────────────────────────────────────────────────────────────────
await step('D3 the layout gallery, in place', async () => {
  const srcBefore = await stageSrc(page, IP);
  await openLayoutGallery(page);
  // the gallery's images load lazily: bring each tile into view before judging it
  for (const t of await page.locator(`[data-testid^="${E}-layout-gallery-"]`).all()) { await t.scrollIntoViewIfNeeded().catch(() => undefined); await sleep(120); }
  await sleep(1200);
  const state = await page.evaluate((p) => ({ form: !!document.querySelector(`[data-testid="${p}-slide-form"]`), stage: !!document.querySelector(`[data-testid="${p}-stage-image"]`) }), E);
  const tiles = await page.evaluate((p) => [...document.querySelectorAll(`[data-testid^="${p}-layout-gallery-"]`)].filter((e) => e.tagName === 'BUTTON' || e.getAttribute('role') === 'button' || e.querySelector('img,svg')).map((e) => ({ id: e.getAttribute('data-testid').replace(`${p}-layout-gallery-`, ''), visual: !!e.querySelector('img,svg'), loaded: [...e.querySelectorAll('img')].every((i) => i.complete && i.naturalWidth > 0) })), E);
  const shots = await snap(page, 'D3a-layout-gallery', [1440, 900], `${E}-layout-panel`);
  const dlg = noDialogs(shots);
  // timeline
  const before = srcBefore;
  await page.getByTestId(`${E}-layout-gallery-timeline`).click();
  await page.getByTestId(`${E}-slide-timeline-date-2`).waitFor({ timeout: 10000 });
  // The new slide starts with its layout's title, selected so typing replaces it; Save stays on.
  await sleep(400);
  const added = await page.evaluate((e) => {
    const t = document.querySelector(`[data-testid="${e}-slide-title"]`);
    return { title: t?.value ?? null, focused: document.activeElement === t, selected: t ? t.selectionStart === 0 && t.selectionEnd === t.value.length && t.value.length > 0 : false };
  }, E);
  const saveOnAdded = await page.getByTestId(`${IP}-save`).isEnabled().catch(() => false);
  await stageLoaded(page, IP);
  const a2 = await snap(page, 'D3a2-added-from-gallery', [1440], `${E}-stage`);
  for (const [i, [d, l]] of [['Jan', 'Plan'], ['Feb', 'Build'], ['Mar', 'Ship']].entries()) {
    await page.getByTestId(`${E}-slide-timeline-date-${i}`).fill(d);
    await page.getByTestId(`${E}-slide-timeline-label-${i}`).fill(l);
  }
  const changed = await waitSrcChange(page, IP, before);
  await stageLoaded(page, IP);
  // The slide being edited stays in view while its form is filled.
  const inView = await page.evaluate((p) => {
    const r = document.querySelector(`[data-testid="${p}-editor-stage-image"]`)?.getBoundingClientRect();
    if (!r || r.height === 0) return { fraction: 0 };
    const seen = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
    const scrolled = [...document.querySelectorAll('*')].filter((e) => e.scrollTop > 0).map((e) => `${e.getAttribute('data-testid') ?? e.tagName.toLowerCase()}:${Math.round(e.scrollTop)}`).slice(0, 6);
    return { fraction: Math.round((seen / r.height) * 100) / 100, top: Math.round(r.top), bottom: Math.round(r.bottom), vh: innerHeight, scrolled, pageScroll: Math.round(document.scrollingElement?.scrollTop ?? 0) };
  }, IP);
  facts.push({ step: 'D3', added, saveOnAdded, inView });
  const t = await snap(page, 'D3b-timeline', [1440], `${E}-stage`);
  // key figures and table
  const more = [];
  for (const layout of ['key-figures', 'table']) {
    const b = await stageSrc(page, IP);
    await openLayoutGallery(page);
    await page.getByTestId(`${E}-layout-gallery-${layout}`).click();
    await page.getByTestId(`${E}-slide-form`).waitFor({ timeout: 10000 });
    const n = await fillForm(page, layout === 'table' ? 'Cell ' : 'Fig ');
    await waitSrcChange(page, IP, b, 8000);
    await stageLoaded(page, IP);
    const s = await snap(page, `D3c-${layout}`, [1440], `${E}-stage`);
    more.push(`${layout}: ${n} inputs filled${noDialogs(s) ? '' : ' DIALOG'}`);
  }
  const visualMissing = tiles.filter((x) => !x.visual || !x.loaded).map((x) => `${x.id}${x.visual ? '(img not loaded)' : '(none)'}`);
  facts.push({ step: 'D3', tiles });
  const addedOk = added.title === 'Timeline' && added.focused && added.selected && saveOnAdded;
  const stageOk = inView.fraction >= 0.5;
  return { ok: !state.form && !state.stage && dlg && tiles.length >= 13 && visualMissing.length === 0 && changed && addedOk && stageOk && noDialogs(a2), detail: `gallery replaced the editor's main area (form present: ${state.form}, stage present: ${state.stage}); ${tiles.length} layout tiles, without a loaded preview: [${visualMissing.join(',')}]; ${fmt(shots)}; the added slide's title "${added.title}" focused ${added.focused} selected ${added.selected}, Save enabled ${saveOnAdded}; timeline filled, preview changed: ${changed}; after typing the stage is ${Math.round(inView.fraction * 100)}% in view (y ${inView.top}-${inView.bottom} of ${inView.vh}; scrolled: ${(inView.scrolled ?? []).join(' ') || 'nothing'}; page scroll ${inView.pageScroll}); ${more.join('; ')}` };
});

// D4 ───────────────────────────────────────────────────────────────────────────────────────────────────────────
await step('D4 overflow is reported', async () => {
  const countOf = (w) => (/^One thing to check/.test(w) ? 1 : Number((w.match(/^(\d+) things to check/) ?? [])[1] ?? 0));
  const warnBefore = await findingsText(page);
  const slidesBefore = await page.locator(`[data-testid^="${E}-slide-select-"]`).count();
  await openLayoutGallery(page);
  await page.getByTestId(`${E}-layout-gallery-bullets`).click();
  await page.getByTestId(`${E}-slide-form`).waitFor({ timeout: 10000 });
  await page.getByTestId(`${E}-slide-title`).fill('Overflow check');
  const bulletIds = await ids(page, 'bullet');
  const area = page.locator(`[data-testid="${E}-slide-form"] textarea`).first();
  const long = (i) => `Bullet ${i}: the migration plan covers every legacy session store, each downstream service owner, and the full rollback rehearsal in detail`;
  const eight = Array.from({ length: 8 }, (_, i) => long(i + 1));
  if (await area.count()) await area.fill(eight.join('\n'));
  else {
    const first = page.locator(`[data-testid^="${E}-slide-bullet"] input, [data-testid^="${E}-slide-bullets"] input`);
    if (!(await first.count())) throw new Error(`no bullets field found (test ids with "bullet": ${bulletIds.join(', ') || 'none'})`);
    await first.first().fill(eight[0]);
    for (let i = 1; i < 8; i++) { await page.locator(`[data-testid^="${E}-slide-bullet"][data-testid$="add"]`).first().click(); await page.locator(`[data-testid^="${E}-slide-bullet"] input`).nth(i).fill(eight[i]); }
  }
  await sleep(3500);
  const warn = await findingsText(page);
  const position = squash(await page.getByTestId(`${E}-position`).innerText().catch(() => ''));
  const slideNo = (position.match(/Slide (\d+)/) ?? [])[1];
  const overflow = (warn.match(/[^.]*(overflow|too long|does not fit|doesn't fit|too many|too much)[^.]*\./i) ?? [])[0] ?? '';
  const shots = await snap(page, 'D4a-overflow', [1440], `${IP}-preview-warnings`);
  const slidesAfter = await page.locator(`[data-testid^="${E}-slide-select-"]`).count();
  facts.push({ step: 'D4', warnBefore, warnDuring: warn, slidesBefore, slidesAfter, countBefore: countOf(warnBefore), countDuring: countOf(warn) });
  const named = overflow && new RegExp(`Slide ${slideNo}\\b`).test(overflow);
  // shorten
  const short = ['One', 'Two', 'Three'];
  if (await area.count()) await area.fill(short.join('\n'));
  await sleep(3500);
  const warn2 = await findingsText(page);
  const cleared = !/(overflow|too long|does not fit|doesn't fit|too many|too much)/i.test(warn2) || !new RegExp(`Slide ${slideNo} \\([^)]*\\)[^.]*(overflow|does not fit|too)`, 'i').test(warn2);
  const s2 = await snap(page, 'D4b-shortened', [1440], `${IP}-preview-warnings`);
  return { ok: !!overflow && !!named && cleared && noDialogs([...shots, ...s2]), detail: `warning count ${countOf(warnBefore)} before and ${countOf(warn)} after adding ${slidesAfter - slidesBefore} slide(s) (the list is ${countOf(warnBefore) === countOf(warn) ? 'UNCHANGED, so it does not follow the edits' : 'updated'}); overflow sentence ${overflow ? `"${squash(overflow).slice(0, 160)}"` : 'NOT PRESENT (warnings: ' + warn.slice(0, 200) + ')'}; names slide ${slideNo}: ${!!named}; cleared after shortening: ${cleared}; ${fmt(shots)}` };
});

await step('D4c a draft the server would refuse says so plainly', async () => {
  const title = page.getByTestId(`${E}-slide-title`);
  const was = await title.inputValue();
  await title.fill('');
  await sleep(500);
  const save = page.getByTestId(`${IP}-save`);
  const disabled = !(await save.isEnabled().catch(() => true));
  const hint = (await save.getAttribute('title')) ?? '';
  const blocked = squash(await page.getByTestId(`${IP}-save-blocked`).innerText().catch(() => ''));
  const position = squash(await page.getByTestId(`${E}-position`).innerText().catch(() => ''));
  const n = (position.match(/Slide (\d+)/) ?? [])[1];
  const shots = await snap(page, 'D4c-save-blocked', [1440], `${IP}-save-blocked`);
  await title.fill(was || 'Overflow check');
  await sleep(500);
  const back = await save.isEnabled().catch(() => false);
  const plain = new RegExp(`Slide ${n} needs a title`).test(blocked) && new RegExp(`Slide ${n} needs a title`).test(hint) && !/slides\[|DeckSpec|required/.test(`${blocked} ${hint}`);
  return { ok: disabled && plain && back && noDialogs(shots), detail: `title cleared on slide ${n}: Save disabled ${disabled}, its hint "${hint}", the line above the stage "${blocked}"; title restored, Save enabled again ${back}` };
});

// D5 ───────────────────────────────────────────────────────────────────────────────────────────────────────────
await step('D5a save, then fill a chart from a report', async () => {
  const saved = await saveDeck(page);
  const saveEnabled = saved.ok;
  const note = saved.line;
  const titleBefore = (await headSpec(vera, deckId)).spec?.slides?.find((s) => s.id === 'chart')?.title ?? '';
  // Without a saved head the report panel cannot run; reload to the saved head and go on from there.
  await go(page, deckUrl);
  await stageLoaded(page, IP);
  const rep = await jget(vera, `/api/initiative-decks/${encodeURIComponent(deckId)}/chart-reports`);
  const offered = (rep.body?.reports ?? []).map((r) => r.id);
  await page.getByTestId(`${E}-slide-select-chart`).click();
  await page.getByTestId(`${IP}-report-open`).click();
  await page.getByTestId(`${IP}-report-panel`).waitFor({ timeout: 10000 });
  const panelRect = await page.getByTestId(`${IP}-report-panel`).evaluate((e) => { const r = e.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height), vh: innerHeight }; });
  const panelVisible = panelRect.height > 40 && panelRect.top < panelRect.vh - 40 && panelRect.bottom > 0;
  const shotsA = await snap(page, 'D5a-report-panel', [1440], `${IP}-report-panel`);
  const sel = page.getByTestId(`${IP}-report-select`);
  // Spend by initiative as a pie (the film's story): eight initiatives become the top five and "Other", six slices.
  const wanted = (rep.body?.reports ?? []).find((r) => r.id === 'spend-by-initiative');
  const native = await sel.evaluate((e) => (e.tagName === 'SELECT' ? 'self' : e.querySelector('select') ? 'inner' : '')).catch(() => '');
  if (native) await (native === 'self' ? sel : sel.locator('select')).selectOption('spend-by-initiative');
  else { await sel.click(); await page.getByRole('option', { name: wanted?.description ?? /spend per initiative/i }).first().click(); }
  await page.getByText('Pie', { exact: true }).first().click();
  const titleNote = squash(await page.getByTestId(`${IP}-report-title-note`).innerText().catch(() => ''));
  await page.getByTestId(`${IP}-report-apply`).click();
  await sleep(4000);
  await stageLoaded(page, IP);
  const shotsB = await snap(page, 'D5b-pie-applied', [1440], `${E}-stage`);
  const h = await headSpec(vera, deckId);
  const chartSlide = (h.spec?.slides ?? []).find((s) => s.id === 'chart');
  const cites = JSON.stringify(chartSlide?.sources ?? []);
  const ok = !!chartSlide?.chart && chartSlide.chart.kind === 'pie' && /report:spend-by-initiative/.test(cites);
  // The title follows the report, and the panel said so before Apply.
  const titled = /^Spend by initiative, /.test(chartSlide?.title ?? '') && chartSlide.title !== titleBefore && titleNote.includes(`"${titleBefore}"`) && titleNote.includes(`"${chartSlide.title}"`);
  // One plain "Figures read" line in the notes, no machine timestamp.
  const notes = chartSlide?.notes ?? '';
  const readLines = notes.split('\n').filter((l) => /^Figures read /.test(l));
  const notesOk = readLines.length === 1 && /^Figures read \d{1,2} [A-Z][a-z]+ \d{4}, \d{2}:\d{2} UTC from the report "/.test(readLines[0]) && !/\d{4}-\d{2}-\d{2}T\d/.test(notes);
  // Six slices, six colours, sampled from the painted slide.
  const slices = chartSlide?.chart?.labels?.length ?? 0;
  const painted = await stageColours(page);
  const coloursOk = slices === 6 && painted.colours.length >= 6;
  facts.push({ step: 'D5', offered, saveEnabled, headRevision: h.rev, chart: chartSlide?.chart ?? null, sources: chartSlide?.sources ?? null, title: chartSlide?.title, titleBefore, titleNote, notes, painted });
  return { ok: ok && titled && notesOk && coloursOk && noDialogs([...shotsA, ...shotsB]) && saveEnabled && panelVisible, detail: `${note}; reports offered to Vera: [${offered.join(', ')}]; head revision ${h.rev}: chart slide kind ${chartSlide?.chart?.kind ?? 'none'}, labels ${JSON.stringify(chartSlide?.chart?.labels ?? [])}, sources ${cites.slice(0, 120)}; title "${titleBefore}" became "${chartSlide?.title}" (panel said: "${titleNote}") ok ${titled}; notes line "${readLines.join(' | ')}" ok ${notesOk}; ${slices} slices, painted colours [${painted.colours.join(', ')}]${painted.error ? ` (${painted.error})` : ''} ok ${coloursOk}; report panel at y ${panelRect.top}-${panelRect.bottom} of ${panelRect.vh}px (on screen: ${panelVisible}); ${fmt(shotsA)}` };
});

await step('D5b a persona without the budget read tier', async () => {
  const nora = await signIn('u-nora', { role: 'sme' });
  const rep = await jget(nora, `/api/initiative-decks/${encodeURIComponent(deckId)}/chart-reports`);
  const offered = (rep.body?.reports ?? []).map((r) => r.id);
  const spend = offered.filter((i) => /^spend-/.test(i));
  let refusal = '';
  if (spend.length === 0 && rep.status === 200) { refusal = 'not offered'; }
  const h = await jget(vera, `/api/initiative-decks/${encodeURIComponent(deckId)}`);
  const ops = await nora.request.post(`${PORTAL}/api/initiative-decks/${encodeURIComponent(deckId)}/operations`, { data: { baseRevisionId: h.body.activeRevisionId, operations: [{ op: 'set_chart', slideId: 'chart', kind: 'pie', report: { report: 'spend-by-initiative' } }] } });
  const body = await ops.json().catch(() => null);
  await nora.close();
  const plain = typeof body?.error === 'string' && body.error.length > 10 && !/^\{|stack|undefined/.test(body.error);
  return { ok: spend.length === 0 && ops.status() >= 400 && plain, detail: `Nora: chart-reports ${rep.status} offers [${offered.join(', ')}] (${refusal || 'spend offered'}); forced spend-by-initiative set_chart answered ${ops.status()} ${JSON.stringify(body)?.slice(0, 160)}` };
});

// D6 ───────────────────────────────────────────────────────────────────────────────────────────────────────────
await step('D6 theme', async () => {
  const themeIds = await ids(page, 'theme');
  const accent = () => page.evaluate((p) => { const i = document.querySelector(`[data-testid="${p}-editor-stage-image"]`); return i?.getAttribute('src') ?? ''; }, IP);
  // The stage image is an SVG wrapping one PNG painted with the bundled fonts: compare the painted image itself.
  const colours = (src) => { const t = decodeURIComponent(src.replace(/^data:image\/svg\+xml;charset=utf-8,/, '')); const png = (t.match(/data:image\/png;base64,([A-Za-z0-9+/=]+)/) ?? [])[1]; return png ? [`png:${png.length}:${png.slice(-64)}`] : [...new Set(t.match(/#[0-9a-fA-F]{6}\b/g) ?? [])].slice(0, 12); };
  const before = await accent();
  const s1 = await snap(page, 'D6a-theme-before', [1440], `${E}-stage`);
  // the toolbar's theme control: a menu or select named for the theme
  const control = page.locator(`[data-testid="${E}-toolbar"] [data-testid*="theme"], [data-testid="${E}-toolbar"] button[aria-label*="heme" i]`).first();
  let how = '';
  if (await control.count()) { await control.click(); how = `toolbar control ${await control.getAttribute('data-testid')}`; }
  else { await page.getByTestId(`${E}-toolbar-more`).click(); how = 'More menu'; }
  const items = await page.evaluate(() => [...document.querySelectorAll('[role=menuitem],[role=option],[role=menuitemradio],[role=menuitemcheckbox]')].map((e) => [e.getAttribute('data-testid'), (e.textContent || '').trim(), e.getAttribute('aria-checked') === 'true']));
  // A fresh template deck already wears the tenant theme: move it to an unchecked built-in first, then back to the tenant's.
  const pick = items.find(([tid, , on]) => /-theme-ref-/.test(tid ?? '') && !on) ?? items.find(([tid, t, on]) => !on && /-theme-(?!ref-)/.test(tid ?? '') && !/product/i.test(t));
  if (!pick) { await page.keyboard.press('Escape'); return { ok: false, detail: `no theme choice found in ${how}; theme test ids: [${themeIds.join(', ')}]; menu items ${JSON.stringify(items.map((i) => i[1]))}; toolbar buttons ${JSON.stringify(await page.locator(`[data-testid="${E}-toolbar"] button`).evaluateAll((l) => l.map((b) => b.getAttribute('aria-label') || b.innerText.trim())))}` }; }
  if (pick[0]) await page.locator(`[data-testid="${pick[0]}"]`).click();
  else await page.getByRole('menuitem', { name: new RegExp(pick[1].slice(0, 20)) }).first().click();
  await sleep(3500); await stageLoaded(page, IP);
  const after = await accent();
  const s2 = await snap(page, 'D6b-theme-after', [1440], `${E}-stage`);
  const cb = colours(before); const ca = colours(after);
  // Then the tenant theme (a `{ ref }`), which must change the slide again and be written into the spec.
  let back = { ok: true, line: 'tenant theme was already chosen' };
  if (!/-theme-ref-/.test(pick[0] ?? '')) {
    if (await control.count()) await control.click(); else await page.getByTestId(`${E}-toolbar-more`).click();
    const ref = page.locator('[data-testid*="-theme-ref-"]').first();
    if (!(await ref.count())) back = { ok: false, line: 'no tenant theme row offered' };
    else {
      const name = squash(await ref.innerText());
      await ref.click(); await sleep(3500); await stageLoaded(page, IP);
      const third = await accent();
      back = { ok: third !== after, line: `then chose the tenant theme "${name}": slide changed again ${third !== after}` };
    }
  }
  return { ok: before !== after && JSON.stringify(cb) !== JSON.stringify(ca) && back.ok, detail: `chose "${pick[1]}" from ${how}; slide image before ${cb.join(' ')} after ${ca.join(' ')}; ${back.line}; ${fmt(s2)}` };
});

// D7 ───────────────────────────────────────────────────────────────────────────────────────────────────────────
await step('D7 present in place', async () => {
  const widths = () => page.evaluate(() => {
    const els = [...document.querySelectorAll('aside, [data-testid*="rail"]:not([data-testid*="toggle"]), [data-testid*="sidebar"]')];
    const seen = new Map();
    for (const e of els) { const r = e.getBoundingClientRect(); const k = e.getAttribute('data-testid') || e.getAttribute('aria-label') || e.tagName; if (r.height > 100 && r.left < 600) seen.set(k, Math.round(r.width)); }
    return Object.fromEntries(seen);
  });
  // one open, one folded: open the primary rail (the toggle), keep whatever else the page has as it is
  const toggle = page.getByTestId('shell-rail-toggle');
  if (await toggle.count() && /expand/i.test((await toggle.getAttribute('aria-label')) ?? '')) { await toggle.click(); await sleep(700); }
  await go(page, deckUrl); await stageLoaded(page, IP);
  if (await toggle.count() && /expand/i.test((await toggle.getAttribute('aria-label')) ?? '')) { await toggle.click(); await sleep(700); }
  const before = await widths();
  await page.getByTestId(`${E}-toolbar-present`).click();
  await page.getByTestId(`${E}-present`).waitFor({ timeout: 10000 });
  await sleep(2500);
  const during = await widths();
  const dlg = await dialogsIn(page);
  const shots = await snap(page, 'D7-present', [1440, 900], `${E}-present`);
  const pos = async () => squash(await page.getByTestId(`${E}-present-position`).innerText().catch(() => ''));
  const p0 = await pos();
  await page.keyboard.press('ArrowRight'); await sleep(500); const p1 = await pos();
  await page.keyboard.press('ArrowLeft'); await sleep(500); const p2 = await pos();
  await page.keyboard.press('Escape'); await sleep(2500);
  const gone = (await page.getByTestId(`${E}-present`).count()) === 0;
  const after = await widths();
  const shotsAfter = await snap(page, 'D7b-after-exit', [1440], `${E}`);
  // Folded is the shell's own folded state: a rail gone, or down to its icon strip (48px or less), never open.
  const folded = Object.keys(before).filter((k) => before[k] > 100).every((k) => (during[k] ?? 0) <= 48);
  const restored = JSON.stringify(before) === JSON.stringify(after);
  return { ok: folded && restored && dlg.length === 0 && gone && !!p1 && p1 !== p0 && p2 === p0, detail: `sidebars before ${JSON.stringify(before)}, while presenting ${JSON.stringify(during)}, after exit ${JSON.stringify(after)} (every open one folded: ${folded}; restored exactly: ${restored}); dialogs while presenting: ${dlg.length}; position ${p0 || 'none'} -> ArrowRight ${p1 || 'none'} -> ArrowLeft ${p2 || 'none'}; Escape exited: ${gone}; ${fmt(shots)}; after exit ${fmt(shotsAfter)}` };
});

// D8 ───────────────────────────────────────────────────────────────────────────────────────────────────────────
await step('D8 exports', async () => {
  const out = [];
  const checks = {};
  await go(page, deckUrl); await stageLoaded(page, IP);
  const h = await headSpec(vera, deckId);
  const slideCount = (h.spec?.slides ?? []).length;
  const seenTypes = [];
  const onR = (r) => { const ct = r.headers()['content-type'] ?? ''; if (/presentationml|pdf|zip|octet-stream/.test(ct)) seenTypes.push({ url: r.url(), ct, disposition: r.headers()['content-disposition'] ?? '' }); };
  page.on('response', onR);
  for (const fmtId of ['pptx', 'pdf', 'png']) {
    await page.getByTestId(`${IP}-download-menu`).click();
    const item = page.locator(`[data-testid="${IP}-download${fmtId === 'pptx' ? '' : `-${fmtId}`}"]`);
    if (!(await item.count())) { out.push(`${fmtId}: no menu item (${(await ids(page, 'download')).join(',')})`); await page.keyboard.press('Escape'); continue; }
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), item.click()]);
    const file = path.join(OUT, `deck-${dl.suggestedFilename()}`);
    await dl.saveAs(file);
    const size = fs.statSync(file).size;
    await sleep(300);
    const head = seenTypes.length ? seenTypes[seenTypes.length - 1].ct : 'no download response seen';
    out.push(`${fmtId}: ${dl.suggestedFilename()} ${size} bytes, ${head}`);
    if (fmtId === 'pptx') {
      const { stdout } = await run('unzip', ['-Z1', file]);
      const names = stdout.split('\n');
      checks.pptx = { presentationXml: names.includes('ppt/presentation.xml'), slideParts: names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).length };
    } else if (fmtId === 'pdf') {
      const buf = fs.readFileSync(file).toString('latin1');
      checks.pdf = { magic: buf.startsWith('%PDF'), pages: (buf.match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length };
    } else {
      const { stdout } = await run('unzip', ['-Z1', file]);
      checks.images = { png: stdout.split('\n').filter((n) => /\.png$/i.test(n)).length };
    }
  }
  page.off('response', onR);
  const want = slideCount + 1;
  facts.push({ step: 'D8', slideCount, checks });
  const ok = checks.pptx?.presentationXml && checks.pptx.slideParts === want && checks.pdf?.magic && checks.pdf.pages === want && checks.images?.png === want;
  return { ok: !!ok, detail: `${slideCount} slides (+ Sources = ${want}); ${out.join('; ')}; checks ${JSON.stringify(checks)}` };
});

// D11 (Share to Social, inline) ───────────────────────────────────────────────────────────────────────────────
await step('D11 Share to Social opens inline, not as a modal', async () => {
  await page.getByTestId('deck-share-open').click();
  await sleep(1200);
  const d = await dialogsIn(page);
  const rect = await page.getByTestId('deck-share-panel').evaluate((e) => { const r = e.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height), vh: innerHeight }; }).catch(() => null);
  const onScreen = !!rect && rect.height > 40 && rect.top >= 0 && rect.top < rect.vh - 40;
  const shots = await snap(page, 'D11-share-picker', [1440], 'deck-share-panel');
  await page.getByTestId('deck-share-close').click().catch(() => undefined); await sleep(500);
  const closed = (await page.getByTestId('deck-share-panel').count()) === 0;
  return { ok: d.length === 0 && onScreen && closed && noDialogs(shots), detail: `dialog elements while the picker is open: ${d.length} (${d.join(',')}); inline panel ${rect ? `at y ${rect.top}-${rect.bottom} of ${rect.vh}px` : 'NOT FOUND'} (on screen: ${onScreen}); closed by its Close: ${closed}; ${fmt(shots)}` };
});

// D9 ───────────────────────────────────────────────────────────────────────────────────────────────────────────
const UPDATE = (ops) => ({ name: 'update', arguments: { ref: `deck:${deckId}`, fields: { operations: ops } } });
const LISTK = (kind) => ({ name: 'list', arguments: { kind, filter: null, scope: null, limit: null, detail: null } });
const OPEN = { page: null, ref: null, kind: null, name: null, scope: null, tab: null, params: null };
const voiceOutputs = (p) => p.evaluate(() => (window.__voiceFrames ?? []).filter((f) => f.dir === 'out' && f.event?.type === 'response.item.create' && f.event.item?.type === 'function_call_output').map((f) => { try { return JSON.parse(f.event.item.output); } catch { return { raw: String(f.event.item.output) }; } }));
async function nth(p, n, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const o = await voiceOutputs(p); if (o.length >= n) return o[n - 1]; await sleep(250); }
  const frames = await p.evaluate(() => (window.__voiceFrames ?? []).map((f) => `${f.dir}:${f.event?.type}${f.event?.item?.type ? '/' + f.event.item.type : ''}`).slice(-12));
  const started = await p.getByTestId('shell-voice-dock-start').count();
  await p.screenshot({ path: path.join(OUT, `voice-stuck-${n}.png`) }).catch(() => undefined);
  const toast = squash(await p.getByTestId('toast-stack').innerText().catch(() => ''));
  const titles = await p.evaluate(() => [...document.querySelectorAll('[data-testid^="shell-voice-dock"], [data-testid^="shell-voice-dock"] *')].map((e) => e.getAttribute('title') || e.getAttribute('aria-label')).filter(Boolean).slice(0, 6)).catch(() => []);
  const dockText = squash(await p.evaluate(() => document.querySelector('[data-testid^="shell-voice-dock"]')?.parentElement?.innerText ?? '').catch(() => ''));
  throw new Error(`voice result ${n} never came back in ${ms} ms (start button present: ${started}; dock says "${dockText.slice(0, 120)}" (hover/aria: ${JSON.stringify(titles).slice(0, 300)}); toast "${toast.slice(0, 220)}"; last frames ${JSON.stringify(frames)})`);
}
async function startVoice(p, turns) {
  const r = await p.context().request.put(`${PORTAL}/api/voice/mock-script`, { data: { turns } });
  if (r.status() !== 204) throw new Error(`PUT /api/voice/mock-script answered ${r.status()}`);
  await p.evaluate(() => { window.__voiceFrames = []; window.__voiceStarted = true; });
  await p.getByTestId('shell-voice-dock-start').click();
}
async function stopVoice(p) { const s = p.getByTestId('shell-voice-dock-stop'); if (await s.count()) await s.click().catch(() => undefined); await sleep(500); }
async function freshDeck(p) { await go(p, deckUrl); await stageLoaded(p, IP); await sleep(1500); }

await step('D9a voice: the templates and the reports lists', async () => {
  await freshDeck(page);
  await startVoice(page, [{ said: 'What example decks are there?', call: LISTK('deck-template') }, { said: 'And which reports can I chart?', call: LISTK('deck-report') }]);
  const t = await nth(page, 1); const r = await nth(page, 2);
  await stopVoice(page);
  return { ok: t.kind !== 'refused' && r.kind !== 'refused' && /template|example|status/i.test(t.say ?? '') && /report|spend|outcome|finding|job/i.test(r.say ?? ''), detail: `templates: ${JSON.stringify(t.say ?? t.reason)} (count ${t.count}); reports: ${JSON.stringify(r.say ?? r.reason)} (count ${r.count})` };
});

await step('D9b voice: "open example slides"', async () => {
  await freshDeck(page);
  await startVoice(page, [{ said: 'Open example slides.', call: { name: 'open', arguments: { ...OPEN, scope: 'this-page', tab: 'layouts' } } }]);
  const o = await nth(page, 1);
  await sleep(2500);
  const url = new URL(page.url());
  const panel = (await page.getByTestId(`${IP}-layouts`).count()) > 0;
  const shots = await snap(page, 'D9b-voice-layouts-tab', [1440], `${IP}-layouts`);
  await stopVoice(page);
  await freshDeck(page);
  await startVoice(page, [{ said: 'Open the example decks.', call: { name: 'open', arguments: { ...OPEN, page: 'deck-templates' } } }]);
  const o2 = await nth(page, 1);
  await sleep(2500);
  const url2 = new URL(page.url());
  await stopVoice(page);
  return { ok: (url.searchParams.get('tab') === 'layouts' && panel) && /\/decks\/new/.test(url2.pathname) && noDialogs(shots), detail: `open tab layouts: say ${JSON.stringify(o.say ?? o.reason)}, url ${url.pathname}${url.search}, layouts panel (${IP}-layouts) shown: ${panel}; open page deck-templates: say ${JSON.stringify(o2.say ?? o2.reason)}, url ${url2.pathname}${url2.search}; ${fmt(shots)}` };
});

/** One deck operation by voice in two passes: the card (words and a screenshot), then the same spoken and confirmed. */
async function voiceEdit(label, op, expect) {
  await freshDeck(page);
  await startVoice(page, [{ said: label, call: UPDATE([op]) }]);
  const card = page.getByTestId('voice-confirm-card');
  await card.waitFor({ timeout: 20000 });
  const words = squash(await card.innerText());
  const shot = await snap(page, `D9-${expect.name}-card`, [1440], 'voice-confirm-card');
  await stopVoice(page);
  await freshDeck(page);
  const before = await headSpec(vera, deckId);
  const sent = page.waitForResponse((r) => /\/operations$/.test(r.url()) && r.request().method() === 'POST', { timeout: 30000 }).catch(() => null);
  await startVoice(page, [{ said: label, call: UPDATE([op]) }, { said: 'Confirm.', on: 'card' }]);
  const res = await sent;
  const out = await nth(page, 1, 30000).catch(() => null);
  await sleep(1500);
  const done = await nth(page, 2, 20000).catch(() => null);
  await stopVoice(page);
  const after = await headSpec(vera, deckId);
  return { words, shot, status: res?.status() ?? null, out, done, before, after };
}

await step('D9c voice: add a timeline after slide 3', async () => {
  const r = await voiceEdit('Add a timeline after slide 3.', { op: 'add_slide', layout: 'timeline', after: '3', title: 'Plan' }, { name: 'add-timeline' });
  const slides = r.after.spec?.slides ?? [];
  const added = slides[3];
  return { ok: r.status === 201 && r.after.rev !== r.before.rev && added?.layout === 'timeline' && noDeckDialogs(r.shot), detail: `card words: ${JSON.stringify(r.words)}; POST operations ${r.status}; revision ${r.before.rev} -> ${r.after.rev}; slide 4 is now layout ${added?.layout} "${added?.title}" (of ${slides.length}); voice said ${JSON.stringify(r.done?.say ?? r.out?.say ?? r.out?.reason)}; ${fmt(r.shot)}` };
});

await step('D9d voice: fill slide 4 with a pie from a report', async () => {
  const r = await voiceEdit('Fill slide 4 with a pie of runs by outcome.', { op: 'set_chart', slide: '4', kind: 'pie', report: 'runs-by-outcome' }, { name: 'set-chart' });
  const slides = r.after.spec?.slides ?? [];
  const s4 = slides[3];
  const cites = JSON.stringify(s4?.sources ?? []);
  return { ok: r.status === 201 && s4?.chart?.kind === 'pie' && /report:runs-by-outcome/.test(cites) && noDeckDialogs(r.shot), detail: `card words: ${JSON.stringify(r.words)}; POST operations ${r.status}; slide 4 chart kind ${s4?.chart?.kind}, sources ${cites.slice(0, 140)}; voice said ${JSON.stringify(r.done?.say ?? r.out?.say ?? r.out?.reason)}; ${fmt(r.shot)}` };
});

await step('D9e voice: removing a slide needs a click', async () => {
  await freshDeck(page);
  const before = await headSpec(vera, deckId);
  let posted = false;
  const onResp = (resp) => { if (/\/operations$/.test(resp.url()) && resp.request().method() === 'POST') posted = true; };
  page.on('response', onResp);
  await startVoice(page, [{ said: 'Remove slide 2.', call: UPDATE([{ op: 'remove_slide', slide: '2' }]) }, { said: 'Confirm.', on: 'card' }]);
  const card = page.getByTestId('voice-confirm-card');
  await card.waitFor({ timeout: 20000 });
  await sleep(6000);
  const still = await card.count();
  const words = squash(await card.innerText().catch(() => ''));
  const buttons = await card.locator('button').allInnerTexts();
  const shot = await snap(page, 'D9e-remove-card', [1440], 'voice-confirm-card');
  page.off('response', onResp);
  await stopVoice(page);
  const after = await headSpec(vera, deckId);
  const out = (await voiceOutputs(page).catch(() => []))[0];
  return { ok: !posted && still > 0 && after.rev === before.rev && noDeckDialogs(shot), detail: `after a spoken "Confirm." the card is ${still ? 'still waiting' : 'gone'}, operations POST sent: ${posted}, revision unchanged: ${after.rev === before.rev}; card words ${JSON.stringify(words.slice(0, 220))}; card buttons [${buttons.map(squash).join(' | ')}]; the model was told ${JSON.stringify(out?.say ?? out?.reason ?? out?.next ?? '')}` };
});

await step('D9f voice: no deck open, the same operation is refused', async () => {
  await go(page, `/iq/projects/${P}`);
  await sleep(1500);
  await startVoice(page, [{ said: 'Add a timeline after slide 3.', call: UPDATE([{ op: 'add_slide', layout: 'timeline', after: '3' }]) }]);
  const o = await nth(page, 1);
  const cardShown = await page.getByTestId('voice-confirm-card').count();
  await stopVoice(page);
  return { ok: o.kind === 'refused' && cardShown === 0, detail: `result kind ${o.kind}: ${JSON.stringify(o.reason ?? o.say)}; next ${JSON.stringify(o.next ?? '')}; a confirm card opened: ${cardShown > 0}` };
});

// D10 ──────────────────────────────────────────────────────────────────────────────────────────────────────────
async function otherTenant(name, who, tenantId, newPath, prefix, editorPrefix, lead) {
  await step(`D10 ${name}: new deck from an example`, async () => {
    const ctx = await signIn(who, { tenant: tenantId });
    const p = await ctx.newPage(); watch(p);
    try {
      const target = await lead(ctx);
      await go(p, `${newPath}${target}`);
      // Both choices show on arrival (no click): the example gallery carries its own create button.
      await p.getByTestId(`${prefix}-new-template-submit`).waitFor({ timeout: 20000 });
      await p.locator(`button[data-testid^="${prefix}-template-"]`).first().waitFor({ timeout: 15000 });
      await imagesLoaded(p, `[data-testid="${prefix}-template"]`);
      const shots = await snap(p, `D10-${name.toLowerCase().replace(/[^a-z]+/g, '-')}-new`, [1440], `${prefix}-new`);
      await p.getByTestId(`${prefix}-new-title`).fill(`Walk: ${name}`);
      await p.locator(`button[data-testid^="${prefix}-template-"]`).first().click();
      await p.getByTestId(`${prefix}-new-template-submit`).click();
      await p.waitForURL(/\/decks\/(?!new)[^/?#]+$/, { timeout: 30000 });
      await p.getByTestId(`${editorPrefix}-editor`).waitFor({ timeout: 30000 });
      await stageLoaded(p, editorPrefix);
      const reportBtn = await p.getByTestId(`${editorPrefix}-report-open`).count();
      const shotsE = await snap(p, `D10-${name.toLowerCase().replace(/[^a-z]+/g, '-')}-editor`, [1440], `${editorPrefix}-editor`);
      return { ok: reportBtn === 0 && noDialogs([...shots, ...shotsE]), detail: `editor opened at ${new URL(p.url()).pathname}; "Fill from a report" present: ${reportBtn > 0}; ${fmt(shots)} then editor ${fmt(shotsE)}` };
    } finally { await ctx.close(); }
  });
}
await otherTenant('Assessment', 'u-asha', 'assessment', '/assessment/decks/new', 'assessment-deck', 'deck', async () => '?teamId=TEAM-001');
await otherTenant('Pipelines', 'u-kofi', 'pipelines', '/pipelines/decks/new', 'run-deck', 'run-deck', async (ctx) => {
  const list = await jget(ctx, '/api/pipelines/runs?limit=200');
  for (const r of list.body?.runs ?? []) { const s = await jget(ctx, `/api/pipelines/runs/${encodeURIComponent(r.id)}/steps`); if ((s.body?.steps ?? []).length) return `?runId=${encodeURIComponent(r.id)}`; }
  throw new Error('no pipeline run with steps in the mock world');
});
const socialChannel = async (ctx) => {
  const r = await jget(ctx, '/api/social/channels');
  const list = Array.isArray(r.body) ? r.body : r.body?.channels ?? [];
  const slug = (list.find((c) => c.member !== false) ?? list[0])?.slug;
  if (!slug) throw new Error(`no social channel for Sana (GET /api/social/channels ${r.status})`);
  return slug;
};
// The page's own conversation picker offers each channel's slug; the create route wants the chat channel id (social:ch:<slug>).
await otherTenant('Social (the picker slug)', 'u-sana', 'social', '/social/decks/new', 'social-deck', 'social-deck', async (ctx) => `?channel=${encodeURIComponent(await socialChannel(ctx))}`);
await otherTenant('Social', 'u-sana', 'social', '/social/decks/new', 'social-deck', 'social-deck', async (ctx) => `?channel=${encodeURIComponent(`social:ch:${await socialChannel(ctx)}`)}`);

await step('D10 pipelines deck list', async () => {
  const ctx = await signIn('u-kofi', { tenant: 'pipelines' });
  const p = await ctx.newPage(); watch(p);
  try {
    await go(p, '/pipelines/decks'); await sleep(2500);
    const g = await p.evaluate(() => { const row = document.querySelector('table tbody tr, [role="row"][data-row], [data-testid*="row"]'); return { top: row ? Math.round(row.getBoundingClientRect().top) : null, vh: innerHeight, tables: document.querySelectorAll('table').length }; });
    const shots = await snap(p, 'D10-pipelines-list', [1440], null);
    return { ok: g.top !== null && g.top < g.vh && noDialogs(shots), detail: `first row top ${g.top} of ${g.vh} (tables ${g.tables}); ${fmt(shots)}` };
  } finally { await ctx.close(); }
});

await resetMock();
saveFacts();
await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} steps passed; ${consoleErrors.length} console/http error(s) recorded in decks-facts.json`);
process.exit(failed ? 1 : 0);

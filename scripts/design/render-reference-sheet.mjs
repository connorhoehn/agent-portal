#!/usr/bin/env node
// Renders the dev-only reference sheet (/dev/reference-sheet) and the real
// portal layouts to docs/design/ with the portal's own Playwright (headless
// chromium). Needs the portal dev server running (default http://localhost:5183)
// with the middleware behind it; the demo session needs no cookies under
// INSECURE_DEV_MODE. Nothing here signs in, switches persona or changes data.
//
//   node scripts/design/render-reference-sheet.mjs [--base http://localhost:5183]
//
// Writes:
//   docs/design/reference-sheet.png            whole sheet, light, full page
//   docs/design/reference-sheet-<section>.png  each section, light
//   docs/design/reference-sheet-voice-dark.png the voice section in dark
//   docs/design/layout-<page>.png              real pages at 1440x900, light
//   docs/design/layout-social-dark.png         the social page in dark
//   docs/design/reference-sheet.json           every tile: id, component, subpath, state, box

import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(repo, 'portal', 'package.json'));
const { chromium } = require('playwright');

const argBase = process.argv.indexOf('--base');
const BASE = argBase > 0 ? process.argv[argBase + 1] : (process.env.PORTAL_URL ?? 'http://localhost:5183');
const OUT = path.join(repo, 'docs', 'design');
const SCALE = 2;
const SHEET_MAX_BYTES = 8 * 1024 * 1024;

// The existing layouts the mock-ups must match. Orgiq routes, the demo
// session's own tenant, so no persona or tenant switch is needed.
const PAGES = [
  { name: 'projects', path: '/iq/projects' },
  { name: 'search', path: '/iq/search?q=kubernetes&type=person' },
  { name: 'computer-lab', path: '/iq/local-compute' },
  { name: 'social', path: '/iq/communication/channels' },
];

mkdirSync(OUT, { recursive: true });
const rel = (file) => path.relative(repo, file);
const written = [];
const note = (file) => { written.push(file); console.log(`wrote ${rel(file)} (${(statSync(file).size / 1024).toFixed(0)} KB)`); };

async function settle(page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
}

// Make the viewport as tall as the page, so nothing positions itself against a
// short viewport (the dock's confirmation popover flips above its row when the
// viewport has no room below it).
async function fitViewport(page, width) {
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.setViewportSize({ width, height });
  await page.evaluate(() => window.dispatchEvent(new Event('resize')));
  await page.waitForTimeout(500);
}

async function setTheme(page, theme) {
  await page.evaluate((t) => {
    if (t === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
  }, theme);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(400);
}

// Use the chromium Playwright expects; if that revision is not in the cache,
// fall back to the newest headless shell already there (never download one).
function cachedHeadlessShell() {
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH ?? path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  if (!existsSync(cache)) return undefined;
  const dirs = readdirSync(cache).filter((d) => d.startsWith('chromium_headless_shell-')).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const dir of dirs) {
    for (const sub of ['chrome-headless-shell-mac-arm64', 'chrome-headless-shell-mac-x64', 'chrome-headless-shell-linux64']) {
      const exe = path.join(cache, dir, sub, 'chrome-headless-shell');
      if (existsSync(exe)) return exe;
    }
  }
  return undefined;
}
const expected = chromium.executablePath();
const executablePath = existsSync(expected) ? undefined : cachedHeadlessShell();
if (executablePath) console.log(`using cached ${executablePath}`);
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
try {
  // ── The sheet ──
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: SCALE, reducedMotion: 'reduce', colorScheme: 'light' });
  const page = await context.newPage();
  page.on('pageerror', (error) => console.warn(`page error: ${error.message}`));
  await page.goto(`${BASE}/dev/reference-sheet`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-reference-sheet][data-ready]', { timeout: 30_000 });
  await settle(page);
  await setTheme(page, 'light');
  await fitViewport(page, 1600);
  // Close any popover the bell or composer opened, and move the pointer off the sheet.
  await page.mouse.move(0, 0);

  let sheetFile = path.join(OUT, 'reference-sheet.png');
  await page.screenshot({ path: sheetFile, fullPage: true });
  if (statSync(sheetFile).size > SHEET_MAX_BYTES) {
    // Too heavy at 2x: retake the full sheet at 1x so it stays attachable.
    const small = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1, reducedMotion: 'reduce', colorScheme: 'light' });
    const p1 = await small.newPage();
    await p1.goto(`${BASE}/dev/reference-sheet`, { waitUntil: 'domcontentloaded' });
    await p1.waitForSelector('[data-reference-sheet][data-ready]', { timeout: 30_000 });
    await settle(p1);
    await p1.screenshot({ path: sheetFile, fullPage: true });
    await small.close();
    console.log('full sheet over 8 MB at 2x; retaken at 1x');
  }
  note(sheetFile);

  const sections = await page.$$eval('[data-section]', (els) => els.map((el) => el.getAttribute('data-section')));
  // Section shots are clips of a full-page capture, not element screenshots:
  // an element screenshot scrolls the page, and the dock's confirmation
  // popover (anchored, viewport-positioned) then lands in the wrong place.
  const shootSection = async (id, file) => {
    const box = await page.locator(`[data-section="${id}"]`).evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height };
    });
    await page.screenshot({ path: file, clip: box });
  };
  for (const id of sections) {
    const file = path.join(OUT, `reference-sheet-${id}.png`);
    await shootSection(id, file);
    note(file);
  }

  // Tile boxes in CSS pixels on the full page; image pixels are these times the scale.
  const tiles = await page.$$eval('[data-tile]', (els) => els.map((el) => {
    const r = el.getBoundingClientRect();
    const section = el.closest('[data-section]')?.getAttribute('data-section') ?? null;
    return {
      id: el.getAttribute('data-tile'),
      section,
      component: el.getAttribute('data-component'),
      subpath: el.getAttribute('data-subpath'),
      state: el.getAttribute('data-state'),
      box: { x: Math.round(r.left + window.scrollX), y: Math.round(r.top + window.scrollY), width: Math.round(r.width), height: Math.round(r.height) },
    };
  }));
  const sheetSize = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }));

  // Overlap check: tiles in one sheet must not intersect.
  const overlaps = [];
  for (let i = 0; i < tiles.length; i++) for (let j = i + 1; j < tiles.length; j++) {
    const a = tiles[i].box, b = tiles[j].box;
    if (a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height) overlaps.push(`${tiles[i].id} × ${tiles[j].id}`);
  }
  if (overlaps.length) console.warn(`overlapping tiles: ${overlaps.join(', ')}`);

  // The voice section again, in dark.
  await setTheme(page, 'dark');
  await fitViewport(page, 1600);
  const voiceDark = path.join(OUT, 'reference-sheet-voice-dark.png');
  await shootSection('voice', voiceDark);
  note(voiceDark);
  const layoutDark = path.join(OUT, 'reference-sheet-layout-dark.png');
  await shootSection('layout', layoutDark);
  note(layoutDark);
  await setTheme(page, 'light');
  await context.close();

  // ── The real pages ──
  const real = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: SCALE, reducedMotion: 'reduce', colorScheme: 'light' });
  const rp = await real.newPage();
  rp.on('pageerror', (error) => console.warn(`page error: ${error.message}`));
  const layouts = [];
  for (const target of PAGES) {
    await rp.goto(`${BASE}${target.path}`, { waitUntil: 'domcontentloaded' });
    await rp.waitForSelector('[data-testid="shell-footer"]', { timeout: 30_000 }).catch(() => console.warn(`${target.path}: no shell footer`));
    await settle(rp);
    await rp.waitForTimeout(1500);
    await rp.mouse.move(0, 0);
    const file = path.join(OUT, `layout-${target.name}.png`);
    await rp.screenshot({ path: file });
    note(file);
    layouts.push({ name: target.name, path: target.path, landed: new URL(rp.url()).pathname, file: path.basename(file), viewport: '1440x900' });
    if (target.name === 'social') {
      await setTheme(rp, 'dark');
      const dark = path.join(OUT, 'layout-social-dark.png');
      await rp.screenshot({ path: dark });
      note(dark);
      layouts.push({ name: 'social-dark', path: target.path, landed: new URL(rp.url()).pathname, file: path.basename(dark), viewport: '1440x900' });
      await setTheme(rp, 'light');
    }
  }
  await real.close();

  const manifest = {
    generatedBy: 'scripts/design/render-reference-sheet.mjs',
    source: '/dev/reference-sheet (portal/src/dev/ReferenceSheet.tsx)',
    library: '@connorhoehn/ui-components 2.510.0',
    sheet: { file: 'reference-sheet.png', cssWidth: sheetSize.width, cssHeight: sheetSize.height, deviceScaleFactor: SCALE, note: 'box values are CSS pixels on the full sheet; multiply by deviceScaleFactor for image pixels (unless the sheet was retaken at 1x, see the render log)' },
    sections: sections.map((id) => ({ id, file: `reference-sheet-${id}.png`, tiles: tiles.filter((t) => t.section === id).length })),
    tiles,
    layouts,
    overlaps,
  };
  const json = path.join(OUT, 'reference-sheet.json');
  writeFileSync(json, `${JSON.stringify(manifest, null, 2)}\n`);
  note(json);
  console.log(`${tiles.length} tiles in ${sections.length} sections`);
} finally {
  await browser.close();
}

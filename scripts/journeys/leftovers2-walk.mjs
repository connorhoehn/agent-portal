#!/usr/bin/env node
// Headless walk of the "leftovers 2" features (10 November): the initiative discussion without Social access, the
// channel-backed pane, /comment, waiting stories' next steps, agent-question cards, and the responsive column
// tables. Reports; asserts little. Screenshots + results.json go to OUT_DIR. The steps live in leftovers2-steps.mjs.
//   PORTAL_URL=http://localhost:5153 MIDDLEWARE_URL=http://127.0.0.1:3953 OUT_DIR=... node scripts/journeys/leftovers2-walk.mjs [--only 1,2]
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const req = createRequire(path.join(ROOT, 'portal', 'package.json'));
const playwright = await import(pathToFileURL(req.resolve('playwright')).href);
const chromium = playwright.chromium ?? playwright.default.chromium;
const PORTAL = (process.env.PORTAL_URL ?? 'http://localhost:5153').replace(/\/$/, '');
const MIDDLEWARE = (process.env.MIDDLEWARE_URL ?? 'http://127.0.0.1:3953').replace(/\/$/, '');
const OUT = process.env.OUT_DIR ?? fs.mkdtempSync('/tmp/leftovers2-');
const ONLY = new Set((process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : '1,2,3,4,5').split(','));
fs.mkdirSync(OUT, { recursive: true });

const P = { vera: ['u-vera', 'org-leader', 'orgiq'], hr: ['u-hr', 'hr-admin', 'orgiq'], nora: ['u-nora', 'sme', 'orgiq'], asha: ['u-asha', 'assessor', 'assessment'], jonas: ['u-jonas', 'lead-assessor', 'assessment'] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const errors = [];
const note = (id, ok, detail) => { results.push({ id, ok, detail }); console.log(ok ? 'PASS' : 'FAIL', id, '-', typeof detail === 'string' ? detail.slice(0, 600) : JSON.stringify(detail).slice(0, 600)); };

async function ctxFor(browser, who, width = 1440, height = 900) {
  const [userId, role, tenant] = P[who];
  const ctx = await browser.newContext({ viewport: { width, height }, permissions: ['microphone'] });
  const l = await ctx.request.post(`${PORTAL}/api/session/login`, { data: { userId } });
  if (l.status() !== 200) throw new Error(`login ${userId}: ${l.status()}`);
  const r = await ctx.request.post(`${PORTAL}/api/session/role`, { data: { tenant, role } });
  if (r.status() !== 200) throw new Error(`role ${role}: ${r.status()}`);
  await ctx.addInitScript(() => { window.__voiceFrames = []; window.addEventListener('voice-mock-frame', (e) => window.__voiceFrames.push(e.detail)); });
  return ctx;
}
function watch(page, label) {
  page.on('pageerror', (e) => errors.push({ label, kind: 'pageerror', text: String(e).slice(0, 300), url: page.url() }));
  page.on('console', (m) => { if (m.type() === 'error') errors.push({ label, kind: 'console', text: m.text().slice(0, 300), url: page.url() }); });
  page.on('response', (r) => { if (r.url().includes('/api/') && r.status() >= 400) errors.push({ label, kind: 'http', text: `${r.request().method()} ${r.url().replace(PORTAL, '')} ${r.status()}`, url: page.url() }); });
}
async function go(page, p) {
  await page.goto(`${PORTAL}${p}`, { waitUntil: 'domcontentloaded', timeout: 40000 });
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => undefined);
  await sleep(1500);
}
const body = (page, sel = 'body') => page.evaluate((s) => (document.querySelector(s)?.innerText ?? '').replace(/\s+/g, ' ').trim(), sel);
const shot = async (page, name) => { const f = path.join(OUT, `${name}.png`); await page.screenshot({ path: f, fullPage: false }); return f; };
const reset = () => fetch(`${MIDDLEWARE}/api/__mock/reset`, { method: 'POST' });
const H = { P, sleep, note, errors, results, ctxFor, watch, go, body, shot, reset, PORTAL, MIDDLEWARE, OUT };

const steps = (await import('./leftovers2-steps.mjs')).default;
const browser = await chromium.launch({ headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
await reset();
for (const [id, fn] of Object.entries(steps)) {
  if (!ONLY.has(id)) continue;
  try { await fn(browser, H); } catch (e) { note(`${id}-crash`, false, String(e).slice(0, 500)); }
}
await browser.close();
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ results, errors }, null, 2));
console.log(`errors collected: ${errors.length}`);
process.exit(results.some((r) => !r.ok) ? 1 : 0);

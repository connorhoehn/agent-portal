// node --test scripts/journeys/tests/ — the browser half against a fixture page (no stack needed).
// Skips when the portal's Playwright/Chromium is not installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { walkMap } from '../walk.mjs';

const require = createRequire(new URL('../../../portal/package.json', import.meta.url));
let chromium = null;
try { chromium = require('@playwright/test').chromium; } catch { /* not installed */ }

const BASE = 'http://journeys.test';
const PAGES = {
  '/list': `<header class="shell-header">h</header><main><h1>Catalog</h1>
    <input aria-label="Search the catalog" oninput="document.getElementById('e').hidden=this.value!=='zz'">
    <p id="e" hidden>No catalog item matches.</p>
    <table><tbody><tr tabindex="0" onkeydown="if(event.key==='Enter')location.href='/record'"><td>row</td></tr></tbody></table>
    <button id="save" onclick="fetch('/api/save',{method:'POST'})">Save</button></main>`,
  '/record': '<main><h1>Record</h1></main>',
  '/gone': '<script>location.replace("/list")</script>',
};

async function harness(t) {
  if (!chromium) return t.skip('Playwright is not installed under portal/');
  let browser;
  try { browser = await chromium.launch(); } catch (e) { return t.skip(`Chromium unavailable: ${e.message.split('\n')[0]}`); }
  t.after(() => browser.close());
  const writes = [];
  const open = async (b, map, { viewport }) => {
    const context = await b.newContext({ baseURL: BASE, viewport });
    await context.route(`${BASE}/**`, (route) => {
      const u = new URL(route.request().url());
      if (u.pathname.startsWith('/api/')) { writes.push(`${route.request().method()} ${u.pathname}`); return route.fulfill({ status: u.pathname === '/api/forbidden' ? 403 : 200, body: '{}' }); }
      return route.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html><title>t</title>${PAGES[u.pathname] ?? '<main><h1>404</h1></main>'}` });
    });
    return { context, principal: { sub: `${map.persona.user}-clone-1`, tenant: map.persona.tenant, role: map.persona.role }, clone: `${map.persona.user}-clone-1`, close: () => context.close() };
  };
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walk-test-'));
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));
  const api = async (_c, { method, url }) => { writes.push(`${method} ${url}`); return url === '/api/forbidden' ? 403 : url === '/api/me' ? 410 : 200; };
  const ctx = { baseURL: BASE, outDir, open, api, measure: async () => ({ findings: 0, rules: {}, recorded: 0, recordedRules: {}, issues: [] }), focusWalk: async () => ({ total: 3, steps: [{ lost: false, visible: true, selector: 'input', name: 'Search' }, { lost: false, visible: true, selector: 'tr', name: 'row' }] }), scoped: false };
  return { browser, ctx, writes };
}
const map = (steps, over = {}) => ({ family: 'access', log: 'r/s', kind: 'surface', scenario: 'shared', persona: { user: 'u-x', tenant: 'access', role: 'requester' }, goal: 'g', steps, ...over });

test('steps act, expectations judge, and every step gets a screenshot', async (t) => {
  const h = await harness(t); if (!h) return;
  const r = await walkMap(h.browser, map([
    { do: 'navigate', url: '/list', name: 'open', expect: { url: '/list', visible: [{ role: 'heading', name: 'Catalog', level: 1 }], absent: [{ role: 'button', name: 'Approve' }] } },
    { do: 'fill', target: { label: 'Search the catalog' }, value: 'zz', name: 'empty', expect: { text: ['No catalog item matches.'] } },
    { do: 'press', key: 'Enter', target: { css: 'tbody tr', nth: 0 }, name: 'enter', expect: { url: '/record' } },
    { do: 'back', name: 'back', expect: { url: '/list' } },
    { do: 'tab-walk', name: 'tab', expect: { minVisited: 2 } },
  ]), h.ctx);
  assert.equal(r.error, undefined);
  assert.deepEqual(r.steps.map((s) => s.status), ['pass', 'pass', 'pass', 'pass', 'pass'], JSON.stringify(r.steps.map((s) => s.failures)));
  assert.equal(r.steps[4].keyboard.visited, 2);
  for (const s of r.steps) assert.ok(fs.existsSync(path.join(h.ctx.outDir, s.screenshot)));
  assert.equal(r.screenshotStep, 1);
});

test('a failed expectation fails the step without stopping the walk', async (t) => {
  const h = await harness(t); if (!h) return;
  const r = await walkMap(h.browser, map([
    { do: 'navigate', url: '/list', name: 'open', expect: { absent: [{ role: 'button', name: 'Save' }] } },
    { do: 'navigate', url: '/record', name: 'record', expect: { text: ['Record'] } },
  ]), h.ctx);
  assert.equal(r.steps[0].status, 'fail');
  assert.match(r.steps[0].failures[0], /present \(expected absent/);
  assert.equal(r.steps[1].status, 'pass');
});

test('a read-only walk blocks the writes a click sends and fails that step', async (t) => {
  const h = await harness(t); if (!h) return;
  const r = await walkMap(h.browser, map([
    { do: 'navigate', url: '/list', name: 'open' },
    { do: 'click', target: { role: 'button', name: 'Save' }, name: 'save' },
  ]), h.ctx);
  assert.deepEqual(h.writes.filter((w) => w.includes('/api/save')), [], 'the write never reached the server');
  assert.deepEqual(r.blockedWrites, ['POST /api/save']);
  assert.equal(r.steps[1].status, 'fail');
  assert.match(r.steps[1].failures.join(' '), /tried to write \(blocked\): POST \/api\/save/);
});

test('api steps report their status; a refused deep link is judged by where it lands', async (t) => {
  const h = await harness(t); if (!h) return;
  const r = await walkMap(h.browser, map([
    { do: 'navigate', url: '/gone', name: 'refused', expect: { urlNot: /^\/gone/, url: '/list' } },
    { do: 'api', method: 'POST', url: '/api/forbidden', body: {}, refusal: 'test', name: 'refused api', expect: { status: 403 } },
  ]), h.ctx);
  assert.deepEqual(r.steps.map((s) => s.status), ['pass', 'pass'], JSON.stringify(r.steps.map((s) => s.failures)));
  assert.equal(r.steps[1].api.status, 403);
});

test('a writing map without a scope is skipped, never walked', async (t) => {
  const h = await harness(t); if (!h) return;
  const r = await walkMap(h.browser, map([{ do: 'navigate', url: '/list', name: 'open' }], { writes: true, scenario: { scope: 'default' } }), h.ctx);
  assert.equal(r.skipped, 'needs-scope');
  assert.equal(r.steps.length, 0);
});

test('a session that answers 401 or 410 marks the walk for a retry', async (t) => {
  const h = await harness(t); if (!h) return;
  const r = await walkMap(h.browser, map([{ do: 'navigate', url: '/list', name: 'open' }, { do: 'api', url: '/api/me', name: 'me' }]), h.ctx);
  assert.equal(r.authLost, '410 /api/me');
});

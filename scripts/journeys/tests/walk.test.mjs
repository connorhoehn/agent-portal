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
  '/tabs': `<header class="shell-header" style="height:40px">h</header><main><h1>Tabs</h1><p id="n">3 items</p>
    <div role="tablist" id="tl"><button role="tab" onclick="document.getElementById('p').style.height='10px'">Calm</button>
    <button role="tab" onclick="document.getElementById('tl').style.paddingTop='6px'">Jumpy</button></div>
    <ul id="p"><li>a</li><li>b</li><li>c</li></ul></main>`,
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
  const scopes = [];
  const setScope = async (_c, scope) => { scopes.push(scope); return { dispose: async () => { scopes.push(`disposed ${scope}`); } }; };
  const ctx = { baseURL: BASE, outDir, open, api, setScope, measure: async () => ({ findings: 0, rules: {}, recorded: 0, recordedRules: {}, issues: [] }), focusWalk: async () => ({ total: 3, steps: [{ lost: false, visible: true, selector: 'input', name: 'Search' }, { lost: false, visible: true, selector: 'tr', name: 'row' }] }), scoped: false };
  return { browser, ctx, writes, scopes };
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

test('a tab click that moves the tab strip fails its stability check; a calm one passes', async (t) => {
  const h = await harness(t); if (!h) return;
  const still = [{ css: 'header' }, { role: 'tablist' }];
  const r = await walkMap(h.browser, map([
    { do: 'navigate', url: '/tabs', name: 'open' },
    { do: 'click', target: { role: 'tab', name: 'Calm' }, name: 'calm', stable: still },
    { do: 'click', target: { role: 'tab', name: 'Jumpy' }, name: 'jumpy', stable: still },
  ]), h.ctx);
  assert.deepEqual(r.steps.map((s) => s.status), ['pass', 'pass', 'fail'], JSON.stringify(r.steps.map((s) => s.failures)));
  assert.match(r.steps[2].failures[0], /stable: tablist moved \(height /);
});

test('numbers agree with the rows they count; reload, viewport, theme and scope act', async (t) => {
  const h = await harness(t); if (!h) return;
  const r = await walkMap(h.browser, map([
    { do: 'navigate', url: '/tabs', name: 'open', expect: { numbers: [{ of: { css: '#n' }, eqCount: { css: '#p li' } }] } },
    { do: 'navigate', url: '/tabs', name: 'wrong', expect: { numbers: [{ of: { css: '#n' }, eq: 4 }] } },
    { do: 'viewport', width: 900, height: 800, name: 'narrow' },
    { do: 'theme', value: 'dark', name: 'dark', expect: { attr: [{ target: { css: 'html' }, name: 'data-theme', value: 'dark' }] } },
    { do: 'reload', name: 'reload', expect: { url: '/tabs' } },
    { do: 'scope', scope: 'empty', url: '/list', name: 'empty world', state: 'empty', expect: { url: '/list' } },
    { do: 'scope', scope: 'error', name: 'error world' },
  ]), h.ctx);
  assert.deepEqual(r.steps.map((s) => s.status), ['pass', 'fail', 'pass', 'pass', 'pass', 'pass', 'pass'], JSON.stringify(r.steps.map((s) => s.failures)));
  assert.match(r.steps[1].failures[0], /number in #n is 3 \(expected 4\)/);
  assert.deepEqual(r.steps[2].viewport, { width: 900, height: 800 });
  assert.deepEqual(h.scopes, ['empty', 'disposed empty', 'error', 'disposed error']);
  assert.equal(r.steps[5].landed, '/list');
  assert.equal(r.steps[6].audit, undefined, 'a scope switch with no url is not a page step');
});

// node --test scripts/journeys/tests/ — the browser half against a fixture page (no stack needed).
// Skips when the portal's Playwright/Chromium is not installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { walkMap, checkExpect } from '../walk.mjs';
import { gatewayRefusal } from '../gateway-refusal.mjs';

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
  '/call-start': `<main><h1>Call</h1><script>fetch('/api/calls/call-test/chat')</script></main>`,
  '/other-error': `<main><h1>Call</h1><script>fetch('/api/unrelated')</script></main>`,
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
      if (u.pathname.startsWith('/api/')) { writes.push(`${route.request().method()} ${u.pathname}`); return route.fulfill({ status: u.pathname === '/api/forbidden' ? 403 : ['/api/calls/call-test/chat', '/api/unrelated'].includes(u.pathname) ? 404 : 200, body: '{}' }); }
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

test('negative text expectations wait for a live update but fail if the text remains', async (t) => {
  const h = await harness(t); if (!h) return;
  const context = await h.browser.newContext();
  const page = await context.newPage();
  await page.setContent('<p id="status">Nobody is here</p>');
  await page.evaluate(() => setTimeout(() => { document.querySelector('#status').textContent = 'A peer arrived'; }, 250));
  assert.deepEqual(await checkExpect(page, { noText: ['Nobody is here'] }), []);
  assert.deepEqual(await checkExpect(page, { noText: [/A peer arrived/g] }), ['text present (expected none): /A peer arrived/g']);
  await context.close();
});

test('gateway refusal requires every denial and no channel disclosure, and always closes its socket', async (t) => {
  const h = await harness(t); if (!h) return;
  const open = h.ctx.open;
  h.ctx.open = async (...args) => {
    const actor = await open(...args);
    await actor.context.addInitScript(() => {
      const original = window.fetch;
      window.fetch = (url, options) => url === '/api/session/realtime-token'
        ? Promise.resolve(new Response(JSON.stringify({ token: 'test-token', ...(window.probeMode === 'no-endpoint' ? {} : { gatewayUrl: location.origin }) })))
        : original(url, options);
      window.probeSent = []; window.probeClosed = 0;
      window.WebSocket = class {
        constructor(url) { window.probeSocketUrl = url; setTimeout(() => this.onopen?.(), 0); }
        send(data) {
          const frame = JSON.parse(data); window.probeSent.push(frame);
          if (window.probeMode === 'silent' || (window.probeMode === 'missing-presence' && frame.service === 'presence')) return;
          if (window.probeMode === 'membership-denied' && frame.action === 'join') {
            this.onmessage?.({ data: JSON.stringify({ type: 'error', service: 'chat', channel: frame.channel, error: { code: 'not-a-member' } }) }); return;
          }
          this.onmessage?.({ data: JSON.stringify({ type: 'error', code: 'AUTHZ_CHANNEL_DENIED', service: frame.service, kind: 'subscribe', channel: window.probeMode === 'wrong-channel' ? 'elsewhere' : frame.channel }) });
          if (window.probeMode === 'leak' && frame.action === 'history') this.onmessage?.({ data: JSON.stringify({ type: 'chat', action: 'history', channel: frame.channel, messages: ['must not appear in the result'] }) });
        }
        close() { window.probeClosed++; }
      };
    });
    return actor;
  };
  for (const mode of ['denied', 'membership-denied', 'no-endpoint', 'leak', 'wrong-channel', 'missing-presence', 'silent']) {
    let observed;
    h.ctx.gatewayRefusal = async (page, channel) => {
      await page.evaluate(mode => { window.probeMode = mode; }, mode);
      try { return await gatewayRefusal(page, channel, 500, 'http://configured-gateway.test/ws'); }
      finally { observed = await page.evaluate(() => ({ sent: window.probeSent, closed: window.probeClosed, url: window.probeSocketUrl })); }
    };
    const result = await walkMap(h.browser, map([
      { do: 'navigate', url: '/list', name: 'open' },
      { do: 'gateway-refusal', channel: 'social:ch:general', name: 'refusal' },
    ]), h.ctx);
    const step = result.steps[1];
    assert.equal(step.status, ['denied', 'membership-denied', 'no-endpoint'].includes(mode) ? 'pass' : 'fail', `${mode}: ${JSON.stringify(step)}`);
    assert.equal(observed.closed, 1, mode);
    assert.equal(observed.url, mode === 'no-endpoint' ? 'ws://configured-gateway.test/ws' : 'ws://journeys.test/ws');
    assert.deepEqual(observed.sent.map(f => `${f.service}/${f.action}`), ['chat/join', 'chat/history', 'presence/subscribe']);
    assert.ok(!JSON.stringify(result).includes('must not appear in the result'));
    if (mode === 'denied') assert.equal(step.gateway.denied.length, 3);
    if (mode === 'leak') assert.match(step.failures.join(' '), /disclosed 1 channel frame/);
  }
});

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


test('peer steps keep distinct pages and close every context after a failed step', async (t) => {
  const h = await harness(t); if (!h) return;
  const originalOpen = h.ctx.open;
  const closed = [];
  h.ctx.open = async (...args) => {
    const person = await originalOpen(...args);
    return { ...person, close: async () => { closed.push(args[1].persona.user); await person.close(); } };
  };
  h.ctx.scoped = true;
  const result = await walkMap(h.browser, map([
    { do: 'navigate', url: '/list', name: 'primary list' },
    { do: 'navigate', actor: 'peer', url: '/record', name: 'peer record' },
    { do: 'wait', target: { role: 'heading', name: 'Catalog' }, name: 'primary page persists', expect: { url: '/list' } },
    { do: 'wait', actor: 'peer', target: { role: 'heading', name: 'Record' }, name: 'peer page persists', expect: { url: '/record', text: ['missing expectation'] } },
  ], { writes: true, scenario: { scope: 'default' }, peers: { peer: { user: 'u-peer', tenant: 'access', role: 'approver' } } }), h.ctx);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.steps.map(s => s.status), ['pass', 'pass', 'pass', 'fail']);
  assert.equal(result.steps[1].actor, 'peer');
  assert.deepEqual(closed.sort(), ['u-peer', 'u-x']);
});


test('shared meeting walks still block HTTP business writes', async (t) => {
  const h = await harness(t); if (!h) return;
  h.ctx.scoped = true;
  const r = await walkMap(h.browser, map([
    { do: 'navigate', url: '/list', name: 'open' },
    { do: 'click', target: { role: 'button', name: 'Save' }, writes: true, name: 'business write' },
  ], { writes: true, scenario: { realtime: 'meeting' } }), h.ctx);
  assert.deepEqual(h.writes.filter(w => w.includes('/api/save')), []);
  assert.deepEqual(r.blockedWrites, ['POST /api/save']);
  assert.equal(r.steps[1].status, 'fail');
});

test('expected console failures match HTTP paths and cannot hide an unrelated 404', async (t) => {
  const h = await harness(t); if (!h) return;
  const expectConsole = /^Failed to load resource:.*404.*\[404 GET \/api\/calls\/[^/]+\/chat\]$/;
  const r = await walkMap(h.browser, map([
    { do: 'navigate', url: '/call-start', name: 'registration retry', expectConsole },
    { do: 'navigate', url: '/other-error', name: 'unrelated failure', expectConsole },
  ]), h.ctx);
  assert.equal(r.steps[0].status, 'pass');
  assert.equal(r.steps[0].expectedConsole.length, 1);
  assert.equal(r.steps[1].status, 'fail');
  assert.match(r.steps[1].unexpectedConsole[0], /404 GET \/api\/unrelated/);
});

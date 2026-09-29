// Crawl the portal as a signed-in admin and report everything the browser
// complains about, via a real CDP session rather than only Playwright's
// console shim.
//
// Why a crawl and not a route list: App.tsx declares 137 route *fragments*
// (nested, relative), so any hand-written list of full URLs is a guess — and a
// sweep that visits paths which do not exist reports green for coverage it
// never had. Following the rendered nav tests exactly what a user can reach.
//
// Why CDP on top of Playwright: `Runtime.exceptionThrown` carries the real
// stack for an uncaught error, `Log.entryAdded` catches browser-level warnings
// (CSP, deprecations, failed subresources) that never reach `console`, and
// `Network.loadingFailed` distinguishes "server said 500" from "request never
// completed". Playwright's `page.on('console')` alone conflates those.
//
// Findings are CLASSIFIED, because on this app the categories mean very
// different things: a module-resolution error is a real regression, a 403 is
// authorization working as designed for the signed-in role, and the /ws 404 is
// a known library-vs-BFF contract gap (ui-components' compute bundle dials a
// path lib/unsupported-upgrades.ts deliberately refuses).

import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = process.env.PORTAL_URL ?? 'http://localhost:5183';
const MAX_PAGES = Number(process.env.MAX_PAGES ?? 40);
const OUT = '/tmp/cdp-smoke';
mkdirSync(OUT, { recursive: true });

// Signed in as the cross-tenant operator: it holds every role gate, so the
// crawl reaches the widest set of pages. A narrower role would report its own
// 403s as failures and hide whole sections behind HomeRedirect.
const SIGN_IN_AS = process.env.SIGN_IN_AS ?? 'Platform Operator';

const KNOWN = [
  {
    id: 'ws-404',
    // Recorded rather than silenced: it is real, it is not caused by this run,
    // and calling it a failure on every page would drown the signal.
    test: (t) => /ws:\/\/[^\s]*\/ws.*(404|handshake)/i.test(t),
    note: 'ui-components compute bundle dials /ws; the BFF 404s every upgrade except /realtime',
  },
];

// Offline-by-design, not broken. `dev:mock` deliberately BLANKS
// POLICY_STORE_ID (and the Cognito vars), so every Verified-Permissions-backed
// route answers 503 "not configured" — the honest answer rather than a
// fabricated schema. Counting that as a blocking failure made the first run of
// this harness report FAIL against a healthy app.
const EXPECTED_OFFLINE = /not configured|Aurora not configured|authorization unavailable/i;

// Keyed on the ENDPOINT, not the message. CDP's `Network.responseReceived`
// reports status + URL and never the response body, so the body's own
// "POLICY_STORE_ID not configured" is invisible here — matching on text alone
// could not classify it. These paths are Verified-Permissions-backed and 503 by
// design whenever POLICY_STORE_ID is blank, which `dev:mock` guarantees.
// Verified by hand: GET /api/identity/schema as admin → 503
// {"error":"POLICY_STORE_ID not configured"}.
const OFFLINE_503_PATHS = [/\/api\/identity\//];

const classify = (text) => {
  if (/does not provide an export|Failed to fetch dynamically imported|Importing a module script failed/i.test(text)) return 'MODULE';
  if (KNOWN.some((k) => k.test(text))) return 'known';
  if (EXPECTED_OFFLINE.test(text)) return 'offline-expected';
  if (/\b503\b/.test(text) && OFFLINE_503_PATHS.some((p) => p.test(text))) return 'offline-expected';
  if (/\b(50\d)\b/.test(text)) return 'HTTP5xx';
  if (/\b40[13]\b|Forbidden|Unauthorized/i.test(text)) return 'authz';
  if (/\b404\b/.test(text)) return 'HTTP404';
  return 'other';
};

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await context.newPage();

// ── CDP ───────────────────────────────────────────────────────────────────────
const cdp = await context.newCDPSession(page);
await cdp.send('Runtime.enable');
await cdp.send('Log.enable');
await cdp.send('Network.enable');
await cdp.send('Page.enable');

let bucket = [];
const push = (source, text, extra) => {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return;
  // The browser logs a bare "Failed to load resource: … status NNN" alongside
  // every failed request, with no URL. `cdp:http` already reports the same
  // failure WITH the URL, so keeping both double-counts each fault and leaves a
  // finding nothing can be done about because it names no endpoint.
  if (/^Failed to load resource:/i.test(t)) return;
  bucket.push({ source, kind: classify(t), text: t.slice(0, 300), ...(extra ?? {}) });
};

cdp.on('Runtime.exceptionThrown', (e) => {
  const d = e.exceptionDetails;
  push('cdp:exception', d.exception?.description ?? d.text, {
    at: d.url ? `${d.url}:${d.lineNumber ?? '?'}` : undefined,
  });
});
cdp.on('Runtime.consoleAPICalled', (e) => {
  if (e.type !== 'error' && e.type !== 'assert') return;
  push('cdp:console', e.args?.map((a) => a.description ?? a.value).filter(Boolean).join(' '));
});
cdp.on('Log.entryAdded', (e) => {
  if (e.entry.level !== 'error') return;
  push(`cdp:log/${e.entry.source}`, e.entry.text, { at: e.entry.url });
});
cdp.on('Network.loadingFailed', (e) => {
  if (e.canceled) return;   // a navigation supersedes in-flight requests; not a fault
  push('cdp:net-failed', `${e.type} ${e.errorText}`);
});
cdp.on('Network.responseReceived', (e) => {
  if (e.response.status >= 400) push('cdp:http', `${e.response.status} ${e.response.url}`);
});

// ── Sign in ───────────────────────────────────────────────────────────────────
console.log(`\n▸ signing in as ${SIGN_IN_AS}`);
await page.goto(`${BASE}/select`, { waitUntil: 'networkidle' });
await page.getByRole('tab', { name: /Sign in as/i }).click().catch(() => {});
await page.waitForTimeout(700);
const btn = page.getByRole('button', { name: `Sign in as ${SIGN_IN_AS}` }).first();
if (!(await btn.isVisible().catch(() => false))) {
  console.log('  ✗ could not find that identity on the picker — aborting');
  await browser.close();
  process.exit(2);
}
await btn.click();
await page.waitForTimeout(2500);

// Two steps, not one. The picker's own copy says it: "Pick an account, then the
// role to assume in it" — signing in as an identity re-scopes who you are and
// leaves you ON /select to choose a workspace. A single click therefore looks
// like it worked (no error, session minted) while the crawl never leaves the
// picker and reports one page as a pass.
if (new URL(page.url()).pathname.startsWith('/select')) {
  await page.getByRole('tab', { name: /Workspaces/i }).click().catch(() => {});
  await page.waitForTimeout(600);
  const enter = page.getByRole('button', { name: /^Enter Org as (Admin|HR Admin)/ }).first();
  if (await enter.isVisible().catch(() => false)) {
    await enter.click().catch(() => {});
    await page.waitForURL((u) => !u.pathname.startsWith('/select'), { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(2500);
  }
}
console.log(`  landed on ${new URL(page.url()).pathname}`);
if (new URL(page.url()).pathname.startsWith('/select')) {
  console.log('  ✗ still on the picker — the crawl would test nothing; aborting');
  await browser.close();
  process.exit(2);
}

// ── Crawl ─────────────────────────────────────────────────────────────────────
const seen = new Set();
const queue = [new URL(page.url()).pathname];
const results = [];

const linksOnPage = () => page.evaluate(() => [...document.querySelectorAll('a[href]')]
  .map((a) => a.getAttribute('href'))
  .filter((h) => h && h.startsWith('/') && !h.startsWith('//')));

while (queue.length && seen.size < MAX_PAGES) {
  const path = queue.shift();
  if (seen.has(path)) continue;
  seen.add(path);

  bucket = [];
  let navErr = null;
  try {
    // `domcontentloaded`, NOT `networkidle`. Several pages hold a live
    // EventSource open (/api/work/events, /api/local-compute/events), so the
    // network is never idle by construction and networkidle times out on
    // exactly the pages whose streaming is the feature — reporting the harness's
    // own wait strategy as an app failure.
    await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(1600);   // let deferred effects, polls and lazy chunks fire
  } catch (e) {
    navErr = e.message.split('\n')[0];
  }
  if (navErr) push('nav', navErr);

  const found = bucket.slice();
  results.push({ path, findings: found });

  const worst = found.find((f) => f.kind === 'MODULE') ?? found.find((f) => f.kind === 'HTTP5xx');
  const tag = worst ? worst.kind : (found.length ? 'noted' : 'ok');
  const counts = found.reduce((a, f) => { a[f.kind] = (a[f.kind] ?? 0) + 1; return a; }, {});
  const summary = Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(' ');
  console.log(`  ${tag === 'ok' ? '✓' : tag === 'noted' ? '·' : '✗'} ${path.padEnd(40)} ${summary}`);

  for (const href of await linksOnPage().catch(() => [])) {
    const p = href.split('#')[0];
    if (p && !seen.has(p) && !queue.includes(p)) queue.push(p);
  }
}

await browser.close();

// ── Report ────────────────────────────────────────────────────────────────────
const all = results.flatMap((r) => r.findings.map((f) => ({ ...f, path: r.path })));
const by = (k) => all.filter((f) => f.kind === k);
const uniq = (arr) => [...new Map(arr.map((f) => [f.text, f])).values()];

console.log(`\n═══ ${seen.size} pages crawled ═══`);
for (const k of ['MODULE', 'HTTP5xx', 'other', 'HTTP404', 'authz', 'known']) {
  const rows = by(k);
  if (!rows.length) continue;
  const u = uniq(rows);
  console.log(`\n${k}  (${rows.length} occurrence(s), ${u.length} distinct)`);
  u.slice(0, 8).forEach((f) => {
    console.log(`  • ${f.text.slice(0, 150)}`);
    console.log(`      on ${[...new Set(rows.filter((r) => r.text === f.text).map((r) => r.path))].slice(0, 4).join(', ')}`);
  });
}

writeFileSync(`${OUT}/report.json`, JSON.stringify({ pages: seen.size, results }, null, 2));
const blocking = by('MODULE').length + by('HTTP5xx').length;
console.log(`\n${blocking === 0 ? '✅ PASS' : '❌ FAIL'} — ${blocking} blocking finding(s); full report ${OUT}/report.json`);
process.exit(blocking === 0 ? 0 : 1);

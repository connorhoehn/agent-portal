// Walk one journey map in a browser context (docs/journeys.md "Journey maps").
// Pure Playwright: no @playwright/test import, no repo knowledge — everything
// that knows the repo (sign-in, the audit, route classification) comes in
// through `ctx`, so a node --test can drive this against a fixture page.
//
//   const result = await walkMap(browser, map, ctx)
//   ctx = {
//     baseURL, outDir,                         // where the per-step screenshots go
//     open(browser, map, { viewport }) -> { context, principal, clone?, close },  // a fresh signed-in context (realSession signIn, or lane M's clone and scope)
//     measure(page, step) -> { findings, rules, issues, unclassified } | null,
//     focusWalk(page, { count }) -> { total, steps },   // the skill's probe
//     api?(context, { method, url, body }) -> status,   // default: the context's own APIRequestContext (its cookies)
//     scoped: boolean,                                   // open() puts the context under a request-scoped mock scenario (lane M)
//     setScope?(context, scope) -> { dispose },          // a `scope` step: move this context into another scoped mock world
//   }
import fs from 'node:fs';
import path from 'node:path';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
const T = { action: 8000, expect: 8000, settle: 15000 };
const asList = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const describe = (t) => t ? (t.role ? `${t.role}${t.name ? ` "${t.name instanceof RegExp ? t.name.source : t.name}"` : ''}` : t.testId ? `[data-testid=${t.testId}]` : t.label ? `label "${t.label}"` : t.placeholder ? `placeholder "${t.placeholder}"` : t.text ? `text "${t.text instanceof RegExp ? t.text.source : t.text}"` : t.css) + (t.within ? ` within ${describe(t.within)}` : '') : '(none)';

/** All matches of a target (a Locator). */
export function locate(page, t) {
  const root = t.within ? locate(page, t.within).first() : page;
  let l;
  if (t.role) l = root.getByRole(t.role, { ...(t.name != null ? { name: t.name } : {}), ...(t.exact ? { exact: true } : {}), ...(t.level ? { level: t.level } : {}) });
  else if (t.testId) l = root.getByTestId(t.testId);
  else if (t.label) l = root.getByLabel(t.label, t.exact ? { exact: true } : {});
  else if (t.placeholder) l = root.getByPlaceholder(t.placeholder);
  else if (t.text) l = root.getByText(t.text, t.exact ? { exact: true } : {});
  else if (t.css) l = root.locator(t.css);
  else throw new Error(`target has no locator: ${JSON.stringify(t)}`);
  return t.nth != null ? l.nth(t.nth) : l;
}
const visibleCount = (l) => l.evaluateAll((els) => els.filter((e) => { const b = e.getBoundingClientRect(); const s = getComputedStyle(e); return b.width > 0 && b.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; }).length);

/** Wait, bounded, for the page to stop loading: network idle, no loading rows. Never throws. */
export async function settle(page) {
  await page.waitForLoadState('domcontentloaded', { timeout: T.settle }).catch(() => undefined);
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);
  await page.waitForFunction(() => !document.querySelector('[data-testid="loading-state"], [data-testid="datatable-loading-row"]'), null, { timeout: T.settle }).catch(() => undefined);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))).catch(() => undefined);
}

/** Descriptive layout facts for the log (the protocol's numbers); the audit judges, these describe. */
export async function layoutFacts(page) {
  return page.evaluate(() => {
    const vis = (e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
    const r = (n) => Math.round(n);
    const h1s = [...document.querySelectorAll('h1')].filter(vis);
    const h1 = h1s[0];
    const trail = document.querySelector('[data-testid="section-crumbs"]');
    const rows = [...document.querySelectorAll('[data-shell-nav] table tbody tr')].filter(vis).filter((tr) => !tr.querySelector('[colspan]'));
    const composer = [...document.querySelectorAll('[data-composer-surface]')].filter(vis).pop();
    // The first data row (a table body row, a grid row, a list or listbox item) — the density rule's first-row-top.
    // Not inside a section rail or the trail (navigation, not data).
    const first = [...document.querySelectorAll('main tbody tr, main [role="row"], main [role="listitem"], main li, main [role="option"]')]
      .filter(vis).filter((e) => !e.querySelector('[colspan], [role="columnheader"], th') && !e.closest('aside, [role="complementary"], nav[aria-label="Breadcrumb"], [data-testid="section-crumbs"]'))[0];
    const cs = h1 && getComputedStyle(h1);
    return {
      scrollWidth: document.documentElement.scrollWidth, innerWidth, innerHeight,
      h1Count: h1s.length,
      h1: h1 ? { text: h1.textContent.trim().slice(0, 60), size: parseFloat(cs.fontSize), weight: Number(cs.fontWeight), left: r(h1.getBoundingClientRect().left), top: r(h1.getBoundingClientRect().top) } : null,
      trail: trail && vis(trail) ? { left: r(trail.getBoundingClientRect().left), top: r(trail.getBoundingClientRect().top) } : null,
      rows: rows.length ? { count: rows.length, heights: [...new Set(rows.map((tr) => r(tr.getBoundingClientRect().height)))].sort((a, b) => a - b) } : null,
      composer: composer ? { top: r(composer.getBoundingClientRect().top), bottom: r(composer.getBoundingClientRect().bottom) } : null,
      firstRowTop: first ? r(first.getBoundingClientRect().top) : null,
    };
  });
}

/** Check one step's expectations; returns failure sentences ([] = pass). */
export async function checkExpect(page, e = {}, ctx = {}) {
  const f = [];
  const poll = async (fn, timeout = T.expect) => { const end = Date.now() + timeout; for (;;) { if (await fn().catch(() => false)) return true; if (Date.now() > end) return false; await page.waitForTimeout(150); } };
  const here = () => { const u = new URL(page.url()); return { path: u.pathname, full: u.pathname + u.search }; };
  if (e.url != null) {
    const ok = await poll(async () => { const h = here(); return e.url instanceof RegExp ? e.url.test(h.full) : (e.url.includes('?') ? h.full === e.url : h.path === e.url); });
    if (!ok) f.push(`expected url ${e.url}, on ${here().full}`);
  }
  if (e.urlNot && e.urlNot.test(here().full)) {
    // A refused deep link may take a moment to redirect away.
    if (!(await poll(async () => !e.urlNot.test(here().full)))) f.push(`still on ${here().full} (expected to be sent away from ${e.urlNot})`);
  }
  for (const t of asList(e.visible)) if (!(await locate(page, t).first().waitFor({ state: 'visible', timeout: T.expect }).then(() => true, () => false))) f.push(`not visible: ${describe(t)}`);
  for (const t of asList(e.absent)) { const n = await locate(page, t).count(); if (n) f.push(`present (expected absent from the DOM): ${describe(t)} ×${n}`); }
  for (const t of asList(e.hidden)) { const n = await visibleCount(locate(page, t)); if (n) f.push(`visible (expected hidden): ${describe(t)} ×${n}`); }
  for (const x of asList(e.text)) if (!(await page.getByText(x).first().waitFor({ state: 'visible', timeout: T.expect }).then(() => true, () => false))) f.push(`text not visible: ${x}`);
  if (e.noText?.length) {
    const body = await page.evaluate(() => document.body.innerText);
    for (const x of e.noText) if (x instanceof RegExp ? x.test(body) : body.includes(x)) f.push(`text present (expected none): ${x}`);
  }
  for (const t of asList(e.disabled)) if (!(await poll(() => locate(page, t).first().isDisabled({ timeout: 1000 })))) f.push(`not disabled: ${describe(t)}`);
  for (const t of asList(e.enabled)) if (!(await poll(() => locate(page, t).first().isEnabled({ timeout: 1000 })))) f.push(`not enabled: ${describe(t)}`);
  if (e.focused && !(await poll(() => locate(page, e.focused).first().evaluate((el) => el === document.activeElement || el.contains(document.activeElement))))) f.push(`not focused: ${describe(e.focused)}`);
  for (const c of asList(e.count)) {
    const n = await visibleCount(locate(page, c.target));
    if ((c.eq != null && n !== c.eq) || (c.min != null && n < c.min) || (c.max != null && n > c.max)) f.push(`count of visible ${describe(c.target)} is ${n} (expected ${c.eq != null ? `= ${c.eq}` : ''}${c.min != null ? `≥ ${c.min}` : ''}${c.max != null ? ` ≤ ${c.max}` : ''})`);
  }
  for (const a of asList(e.attr)) {
    const got = await locate(page, a.target).first().getAttribute(a.name, { timeout: T.expect }).catch(() => undefined);
    const ok = a.value === null ? got === null : a.value instanceof RegExp ? a.value.test(got ?? '') : got === a.value;
    if (!ok) f.push(`${describe(a.target)} [${a.name}] is ${JSON.stringify(got)} (expected ${a.value})`);
  }
  for (const n of asList(e.numbers)) {
    // A number on screen agrees with another: the count of visible rows, another element's number, or a constant.
    const read = async (t, re) => { const txt = await locate(page, t).first().innerText({ timeout: T.expect }).catch(() => null); if (txt == null) return null; const m = txt.replace(/,/g, '').match(re ?? /-?\d+(?:\.\d+)?/); return m ? Number(m[1] ?? m[0]) : null; };
    const got = await read(n.of, n.re);
    const want = n.eq != null ? n.eq : n.eqCount ? await visibleCount(locate(page, n.eqCount)) : n.eqNumberOf ? await read(n.eqNumberOf, n.reOther) : undefined;
    if (got == null || want == null || got !== want) f.push(`number in ${describe(n.of)} is ${got ?? 'missing'} (expected ${n.eq != null ? n.eq : `${want ?? 'missing'}, ${n.eqCount ? `the visible count of ${describe(n.eqCount)}` : `the number in ${describe(n.eqNumberOf)}`}`})`);
  }
  if (e.status != null && ctx.status != null && !asList(e.status).includes(ctx.status)) f.push(`status ${ctx.status} (expected ${asList(e.status).join(' or ')})`);
  if (e.minVisited != null && ctx.keyboard && ctx.keyboard.visited < e.minVisited) f.push(`Tab visited ${ctx.keyboard.visited} visible controls (expected ≥ ${e.minVisited})`);
  return f;
}

/** Bounding boxes of the first visible match of each target (null when none is visible). */
export async function rects(page, targets) {
  const out = [];
  for (const t of targets) {
    const box = await locate(page, t).first().boundingBox({ timeout: 1000 }).catch(() => null);
    out.push(box ? { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) } : null);
  }
  return out;
}
/** Tab stability: each target's box after the step equals its box before (±1px), so nothing shifted, grew or was pushed. */
export function shifted(targets, before, after) {
  const f = [];
  targets.forEach((t, i) => {
    const a = before[i]; const b = after[i];
    if (!a || !b) { f.push(`stable: ${describe(t)} not visible ${!a ? 'before' : 'after'} the step`); return; }
    const moved = ['x', 'y', 'width', 'height'].filter((k) => Math.abs(a[k] - b[k]) > 1);
    if (moved.length) f.push(`stable: ${describe(t)} moved (${moved.map((k) => `${k} ${a[k]}→${b[k]}`).join(', ')})`);
  });
  return f;
}

/** Walk the map; never throws for a step failure (the protocol says keep going), only for setup. */
export async function walkMap(browser, map, ctx) {
  const viewport = map.viewport ?? { width: 1680, height: 940 };
  const result = { map, steps: [], viewport, startedAt: new Date().toISOString(), blockedWrites: [], browser: browser.version?.() };
  const readOnly = !map.writes;
  if (!readOnly && !ctx.scoped) {
    return { ...result, endedAt: new Date().toISOString(), skipped: 'needs-scope', error: 'the map writes and no mock scope / clone is available (lane M)' };
  }
  fs.mkdirSync(ctx.outDir, { recursive: true });
  const actors = new Map();
  try {
    let current = null;
    for (const [name, persona] of [['main', map.persona], ...Object.entries(map.peers ?? {})]) {
      // A peer is a clone unless it names its own identity (a seed persona, for presence a clone cannot show).
      const actorMap = { ...map, persona, ...(name === 'main' ? {} : { identity: persona.identity ?? 'clone' }) };
      const person = await ctx.open(browser, actorMap, { viewport });
      const actor = { ...person, page: null, scopeHandle: null };
      actors.set(name, actor);
      if (name === 'main') {
        result.session = person.principal; result.clone = person.clone;
      }
      const principal = person.principal;
      if (principal && (principal.tenant !== persona.tenant || principal.role !== persona.role)) {
        result.error = `actor ${name} signed in as ${principal.sub} ${principal.tenant}/${principal.role}, the map wants ${persona.tenant}/${persona.role}`;
        return result;
      }
      if (readOnly || map.scenario?.realtime === 'meeting') await person.context.route('**/*', (route) => {
        const r = route.request();
        if (SAFE.has(r.method())) return route.fallback();
        if ((ctx.fixtureOrigins ?? []).includes(new URL(r.url()).origin)) return route.fallback();
        // The gateway owns call state outside mock scopes. Only the call's page binding
        // may write over HTTP in a meeting walk; business-record writes stay blocked.
        if (map.scenario?.realtime === 'meeting' && /^(PUT|DELETE)$/.test(r.method()) && /^\/api\/calls\/[^/]+\/page$/.test(new URL(r.url()).pathname)) return route.fallback();
        if ((map.readOnlyPosts ?? []).some((p) => new URL(r.url()).pathname === p.path)) return route.fallback();
        const what = `${r.method()} ${new URL(r.url()).pathname}`;
        result.blockedWrites.push(what); current?.blocked.push(what);
        return route.abort('blockedbyclient');
      });
      const page = await person.context.newPage(); actor.page = page;
      page.setDefaultTimeout(T.action);
      page.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.text())) current?.console.push(m.text()); });
      page.on('pageerror', (e) => current?.console.push(`pageerror: ${e.message}`));
      page.on('response', (r) => { if (r.status() >= 400 && current) current.http.push(`${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`); });
      page.on('response', (r) => { if ([401, 410].includes(r.status()) && new URL(r.url()).pathname.startsWith('/api/')) result.authLost = `${r.status()} ${new URL(r.url()).pathname}`; });
    }
    let shotStep = map.steps.findIndex((s) => s.screenshot === 'log');
    if (shotStep < 0) shotStep = map.steps.findIndex((s) => s.do === 'navigate');
    for (const [i, step] of map.steps.entries()) {
      const s = { index: i + 1, do: step.do, name: step.name, state: step.state ?? (step.do === 'navigate' ? 'default' : undefined), proves: step.proves, url: step.do === 'navigate' || (step.do === 'scope' && step.url) ? step.url : undefined, failures: [], console: [], blocked: [], http: [], auditReason: step.auditReason };
      const actor = actors.get(step.actor ?? 'main');
      if (!actor) throw new Error(`unknown peer ${step.actor}`);
      const { page, context } = actor;
      if (step.actor) s.actor = step.actor;
      current = s;
      let status = null;
      const before = step.stable?.length ? await rects(page, step.stable) : null;
      try {
        switch (step.do) {
          case 'reload': await page.reload({ waitUntil: 'domcontentloaded', timeout: T.settle }); break;
          case 'viewport': await page.setViewportSize({ width: step.width, height: step.height }); s.viewport = { width: step.width, height: step.height }; break;
          case 'theme': await page.evaluate((v) => { localStorage.setItem('theme', v); document.documentElement.dataset.theme = v; }, step.value); s.theme = step.value; break;
          case 'scope': {
            if (!ctx.setScope) throw new Error('this runner cannot switch mock scopes');
            await actor.scopeHandle?.dispose?.();
            actor.scopeHandle = await ctx.setScope(context, step.scope);
            s.scope = typeof step.scope === 'string' ? step.scope : JSON.stringify(step.scope);
            if (step.url) await page.goto(step.url, { waitUntil: 'domcontentloaded', timeout: T.settle });
            break;
          }
          case 'navigate': await page.goto(step.url, { waitUntil: 'domcontentloaded', timeout: T.settle }); break;
          case 'click': await locate(page, step.target).first().click({ timeout: T.action }); break;
          case 'press': if (step.target) await locate(page, step.target).first().press(step.key, { timeout: T.action }); else await page.keyboard.press(step.key); break;
          case 'fill': await locate(page, step.target).first().fill(step.value, { timeout: T.action }); break;
          case 'back': await page.goBack({ waitUntil: 'domcontentloaded', timeout: T.settle }); break;
          case 'wait': await locate(page, step.target).first().waitFor({ state: 'visible', timeout: T.settle }); break;
          case 'tab-walk': {
            const walk = await ctx.focusWalk(page, { count: step.max ?? 40 });
            const seen = new Set(walk.steps.filter((x) => !x.lost && x.visible).map((x) => `${x.selector}|${x.name}`));
            s.keyboard = { total: walk.total, visited: seen.size, lost: walk.steps.filter((x) => x.lost).length, invisible: walk.steps.filter((x) => !x.lost && !x.visible).length };
            break;
          }
          case 'api': {
            const method = step.method ?? 'GET';
            status = ctx.api ? await ctx.api(context, { method, url: step.url, body: step.body })
              : (await context.request.fetch(step.url, { method, ...(step.body !== undefined ? { data: step.body } : {}), failOnStatusCode: false })).status();
            s.api = { method, url: step.url, status };
            if ([401, 410].includes(status)) result.authLost = `${status} ${step.url}`;
            break;
          }
          default: throw new Error(`unknown action ${step.do}`);
        }
      } catch (e) { s.failures.push(`${step.do} failed: ${String(e.message).split('\n')[0]}`); }
      if (step.do !== 'api' && !step.noSettle) await settle(page);
      if (before) { s.stable = await rects(page, step.stable); s.failures.push(...shifted(step.stable, before, s.stable)); }
      s.failures.push(...await checkExpect(page, step.expect, { status, keyboard: s.keyboard }).catch((e) => [`expectation error: ${e.message.split('\n')[0]}`]));
      const u = new URL(page.url());
      s.landed = u.pathname + u.search;
      const pageStep = step.do !== 'api' && step.do !== 'tab-walk' && !(step.do === 'scope' && !step.url);
      if (pageStep) {
        s.facts = await layoutFacts(page).catch(() => null);
        if (step.expect?.noHscroll !== false && s.facts && s.facts.scrollWidth > s.facts.innerWidth) s.failures.push(`horizontal scroll (${s.facts.scrollWidth} > ${s.facts.innerWidth})`);
        const max = step.expect?.firstRowTopMax;
        if (max != null && !(s.facts?.firstRowTop != null && s.facts.firstRowTop <= max)) s.failures.push(`first-row-top ${s.facts?.firstRowTop ?? 'none'} (expected a data row at ≤ ${max}px)`);
      }
      if (step.audit ?? pageStep) {
        try { s.audit = await ctx.measure(page, step); } catch (e) { s.failures.push(`DOM audit could not measure: ${e.message.split('\n')[0]}`); }
        if (s.audit?.skipped) { s.auditReason = s.audit.skipped; s.audit = undefined; }
        if (s.audit?.findings) s.failures.push(`${s.audit.findings} ui-dom-audit finding(s): ${Object.entries(s.audit.rules).map(([r, c]) => `${r} ×${c}`).join(', ')}`);
      }
      const file = `${String(i + 1).padStart(2, '0')}-${step.do}.jpg`;
      await page.screenshot({ path: path.join(ctx.outDir, file), type: 'jpeg', quality: 70 }).catch(() => undefined);
      s.screenshot = file;
      if (i === shotStep) result.screenshotStep = s.index;
      // A user action in a read-only map that tried to write is a map/page defect, not a pass.
      if (s.blocked.length && step.do !== 'navigate' && step.do !== 'back') s.failures.push(`the action tried to write (blocked): ${[...new Set(s.blocked)].join(', ')}`);
      const blockedNoise = (m) => /ERR_BLOCKED_BY_CLIENT|net::ERR_FAILED/.test(m) && s.blocked.length;
      // Chromium resource errors omit URLs. Attach this step's failed responses
      // before matching narrow, documented expected errors in the map.
      if (s.http.length) s.console = s.console.map((m) => /Failed to load resource/.test(m) ? `${m} [${[...new Set(s.http)].join(', ')}]` : m);
      s.expectedConsole = s.console.filter((m) => (step.expectConsole && step.expectConsole.test(m)) || blockedNoise(m));
      s.unexpectedConsole = s.console.filter((m) => !s.expectedConsole.includes(m));
      if (!s.http.length) delete s.http;
      s.status = s.failures.length || s.unexpectedConsole.length ? 'fail' : 'pass';
      delete s.console;
      result.steps.push(s);
    }
    current = null;
  } catch (e) {
    result.error = `setup failed: ${String(e.message).split('\n')[0]}`;
  } finally {
    result.endedAt = new Date().toISOString();
    for (const actor of [...actors.values()].reverse()) {
      try { await actor.scopeHandle?.dispose?.(); } catch { /* already disposed */ }
      try { await (actor.close ? actor.close() : actor.context?.close()); } catch { /* already closed */ }
    }
  }
  return result;
}

// Headless measurement for docs/rail-parity-goal.md: the second rail on the
// Assessment workspace (or another app's /documents with --other) must agree
// with /iq/library's concise stacked rail on width, caption, row type, pitch
// and chrome. With RAIL_PARITY_SUBJECT + RAIL_PARITY_USER it measures the
// chat-rail variant's frame on those pages instead (below). Run from portal/
// (Playwright is installed there).
import { createRequire } from 'node:module';
import { BREADCRUMB_SELECTOR } from './breadcrumb-selector.mjs';
// Playwright is installed in portal/, wherever this script is run from.
const require = createRequire(new URL('../../portal/package.json', import.meta.url));
const { chromium } = require('playwright');

const BASE = process.env.RAIL_PARITY_BASE ?? 'http://localhost:5183';
// The rail half of the rendered contract (docs/journeys.md): with
// RAIL_PARITY_CONTRACT_OUT=<file.jsonl> every measured subject appends
// { key: <its path>, value: { verdict, problems } }, numbers masked so a
// pixel of noise is not a contract change; scripts/journeys/measure.sh hands
// the file to portal/e2e/contracts.ts.
import fs from 'node:fs';
const CONTRACT_OUT = process.env.RAIL_PARITY_CONTRACT_OUT;
function record(key, problems) {
  if (!CONTRACT_OUT) return;
  const value = { verdict: problems.length ? 'DIFFERS' : 'MATCH', problems: problems.map((p) => p.replace(/-?\d+(\.\d+)?/g, '#')).sort() };
  fs.appendFileSync(CONTRACT_OUT, `${JSON.stringify({ key, value })}\n`);
}
const OTHER = process.argv.includes('--other') ? process.env.RAIL_PARITY_OTHER : null;
const TOL = { width: 8, pitch: 2 };

function findRailScript(anyLeft = false) {
  // The rail: the nearest ancestor of the caption (11px caps label) that is
  // 160–340px wide and taller than 300px — the second navigation column
  // (right of the shell rail here; another app may put it at the left edge).
  return (anyLeftArg) => {
    const minLeft = anyLeftArg ? -1 : 100;
    const caps = [...document.querySelectorAll('h2, span, div, p')].filter((e) => {
      if (e.children.length > 3) return false;
      const cs = getComputedStyle(e);
      const fs = parseFloat(cs.fontSize);
      return fs >= 10 && fs <= 12 && cs.textTransform === 'uppercase' && (e.textContent || '').trim().length > 2;
    });
    for (const cap of caps) {
      let el = cap;
      for (let i = 0; i < 8 && el; i++, el = el.parentElement) {
        const r = el.getBoundingClientRect();
        if (r.width >= 160 && r.width <= 340 && r.height >= 300 && r.left > minLeft) {
          const rows = [...el.querySelectorAll('a, button, [role=treeitem], [role=option], li')].filter((n) => {
            const b = n.getBoundingClientRect();
            return b.height >= 24 && b.height <= 44 && b.width > 120 && (n.textContent || '').trim().length > 0;
          });
          if (rows.length < 3) continue;
          // The row's text run, not its container: the drawn size lives on the
          // deepest element holding the label text.
          const textEl = (n) => { const w = document.createTreeWalker(n, NodeFilter.SHOW_TEXT); let t; while ((t = w.nextNode())) { if ((t.textContent || '').trim().length > 1) return t.parentElement; } return n; };
          const rowCs = getComputedStyle(textEl(rows[1]));
          const tops = rows.map((n) => n.getBoundingClientRect().top).sort((a, b) => a - b);
          const gaps = tops.slice(1).map((t, i) => t - tops[i]).filter((g) => g > 8 && g < 80);
          const pitch = gaps.length ? gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : null;
          const capCs = getComputedStyle(cap);
          const bg = getComputedStyle(el).backgroundColor;
          const radius = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
          // Card chrome: a descendant panel at least 60% of the rail's width
          // with rounded corners — the Org rail has none.
          const card = [...el.querySelectorAll('div, section, aside, nav')].find((d) => {
            const b = d.getBoundingClientRect(); const c = getComputedStyle(d);
            return b.width >= r.width * 0.6 && b.height >= 200 && (parseFloat(c.borderTopLeftRadius) || 0) >= 6;
          });
          const cardRadius = card ? parseFloat(getComputedStyle(card).borderTopLeftRadius) : 0;
          // Row icons: the Org rail rows carry none. A disclosure caret and a
          // hover-revealed row menu are not icons — only an svg that leads the
          // label counts (before the row's first text, outside any menu button).
          const iconRows = rows.filter((n) => {
            const w = document.createTreeWalker(n, NodeFilter.SHOW_TEXT); let t;
            while ((t = w.nextNode())) { if ((t.textContent || '').trim().length > 1) break; }
            const firstText = t;
            return [...n.querySelectorAll('svg')].some((svg) => {
              if (svg.closest('button[aria-haspopup], [data-testid*="caret"], [data-testid*="menu"]')) return false;
              return firstText ? (svg.compareDocumentPosition(firstText) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 : true;
            });
          }).length;
          return {
            caption: (cap.textContent || '').trim().slice(0, 24), captionSize: capCs.fontSize, captionWeight: capCs.fontWeight,
            width: Math.round(r.width), left: Math.round(r.left), top: Math.round(r.top), rowFont: rowCs.fontSize, rowWeight: rowCs.fontWeight, pitch, rows: rows.length, bg, radius, cardRadius, iconRows,
          };
        }
      }
    }
    return null;
  };
}

// JOURNEY_MEASURE_CLONES=1 (scripts/journeys/measure.sh): sign in as a dev:mock clone of the persona (same grants,
// own session epoch) so the measurement runs beside an audit using that persona. Default: the persona itself.
async function signIn(page, base, persona, tenant, role) {
  await page.goto(base + '/');
  let userId = persona;
  if (process.env.JOURNEY_MEASURE_CLONES === '1') {
    userId = await page.evaluate(async ({ persona, secret }) => {
      const res = await fetch('/api/__mock/identity/clone', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', ...(secret ? { 'x-mock-control-auth': secret } : {}) }, body: JSON.stringify({ from: persona, label: 'journey-measure' }) });
      if (res.status !== 201) throw new Error(`clone ${persona}: ${res.status}`);
      return (await res.json()).clone.id;
    }, { persona, secret: process.env.MOCK_CONTROL_SECRET ?? '' });
  }
  await page.evaluate(async ({ userId, tenant, role }) => {
    const h = { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include' };
    await fetch('/api/session/login', { ...h, body: JSON.stringify({ userId }) });
    if (tenant) await fetch('/api/session/tenant', { ...h, body: JSON.stringify({ tenant }) });
    if (role) await fetch('/api/session/role', { ...h, body: JSON.stringify({ role }) });
  }, { userId, tenant, role });
}

// ── The chat-rail variant (docs/rail-parity-goal.md, decision 6) ────────────
// RAIL_PARITY_SUBJECT=<path>[,<path>…] RAIL_PARITY_USER=<userId>
// [RAIL_PARITY_TENANT=<tenant>]: the social workspace's pages draw the chat
// app's sidebar (ConversationRail: shelf, Active now, Teams, Rooms, Direct
// messages, Channels — avatars and previews by design), so the StackedRail
// rules (36px rows, 13px text, no icons) do not apply. What does: the FRAME.
// The rail sits flush against the shell rail (left = the content column's
// left = 200 ± 2), starts at the content top (± 2, nothing above it — no page
// header, no shell breadcrumb row), runs the content's full height (± 4), has
// no card ring (radius ≤ 2), and carries the shelf and its section captions.
// One section per route (the user, 2026-10-13): each page carries Active now
// and ONLY its own section caption — /…/channels Channels, /…/dms Direct
// messages, /…/teams Teams, /…/rooms Rooms, /…/calls and /…/recordings none
// (shelf destinations). `missingCaptions` lists the route's expected captions
// that are absent; `forbiddenCaptions` lists any OTHER section caption that is
// present. The Communication plane's home (`/<tenant>/communication`, no
// sub-route) is the one rail that keeps every section.
// RAIL_PARITY_CAPTIONS overrides the captions expected on every route
// (default "Active now").
// ── The list-rail frame (docs/layout-cascade.md rule 5) ─────────────────────
// RAIL_PARITY_LIST=<path>[,<path>…] [RAIL_PARITY_USER=u-vera]
// [RAIL_PARITY_TENANT=orgiq]: a page's list is a flush list rail stacked
// directly beside the section rail — the same ExplorerLayout rail the
// Initiatives list draws (`nav[aria-label="Explorer"]`). Per page: the list
// rail's left is the section rail's right (± 2), it starts at the content top
// (± 2) and runs its full height (± 4), neither it nor any ancestor inside
// <main> carries a radius (no floating box), its width equals the Initiatives
// rail's (± 2), and the breadcrumb trail is the first row of the content
// column after it: 24px (± 2) right of the list rail, ≤ 24px under the top.
const LIST_SUBJECTS = (process.env.RAIL_PARITY_LIST ?? '').split(',').map((v) => v.trim()).filter(Boolean);
if (LIST_SUBJECTS.length) {
  const user = process.env.RAIL_PARITY_USER ?? 'u-vera';
  const tenant = process.env.RAIL_PARITY_TENANT ?? 'orgiq';
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1672, height: 941 } });
  const page = await ctx.newPage();
  await signIn(page, BASE, user, tenant, null);
  const frame = (breadcrumbSelector) => {
    const main = document.querySelector('[data-shell-nav] main') ?? document.querySelector('main');
    if (!main) return null;
    const mr = main.getBoundingClientRect(); const mcs = getComputedStyle(main);
    const content = { left: mr.left + parseFloat(mcs.paddingLeft), top: mr.top + parseFloat(mcs.paddingTop), bottom: mr.bottom - parseFloat(mcs.paddingBottom) };
    const visible = (e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
    const list = [...main.querySelectorAll('nav[aria-label="Explorer"]')].find(visible) ?? null;
    const lr = list?.getBoundingClientRect();
    const section = [...main.querySelectorAll('nav, aside, [role="navigation"]')].filter(visible).filter((e) => e !== list && !(list && e.contains(list)) && !(list && list.contains(e)))
      .map((e) => e.getBoundingClientRect())
      .find((b) => Math.abs(b.left - content.left) <= 2 && b.width >= 120 && b.width <= 340 && b.height >= (content.bottom - content.top) * 0.6) ?? null;
    let radius = 0;
    for (let el = list; el && el !== main; el = el.parentElement) radius = Math.max(radius, parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0);
    const crumbEl = [...main.querySelectorAll(breadcrumbSelector)].filter(visible)
      .find((e) => !lr || e.getBoundingClientRect().left >= lr.right - 2) ?? null;
    const cb = crumbEl?.getBoundingClientRect();
    return {
      contentLeft: Math.round(content.left), contentTop: Math.round(content.top), contentHeight: Math.round(content.bottom - content.top),
      section: section ? { left: Math.round(section.left), right: Math.round(section.right), width: Math.round(section.width) } : null,
      list: lr ? { left: Math.round(lr.left), right: Math.round(lr.right), top: Math.round(lr.top), width: Math.round(lr.width), height: Math.round(lr.height), radius } : null,
      crumb: cb ? { left: Math.round(cb.left), top: Math.round(cb.top), text: (crumbEl.textContent ?? '').slice(0, 60) } : null,
      hScroll: document.documentElement.scrollWidth > innerWidth,
    };
  };
  await page.goto(BASE + '/iq/projects'); await page.waitForTimeout(3000);
  const ref = await page.evaluate(frame, BREADCRUMB_SELECTOR);
  console.log('reference /iq/projects:', JSON.stringify(ref?.list));
  let failed = 0;
  for (const path of LIST_SUBJECTS) {
    await page.goto(BASE + path); await page.waitForTimeout(3000);
    const m = await page.evaluate(frame, BREADCRUMB_SELECTOR);
    console.log(`list ${path}:`, JSON.stringify(m));
    const problems = [];
    if (!m) problems.push('no <main>');
    else if (!m.list) problems.push('no list rail (nav[aria-label="Explorer"]) on the page');
    else {
      if (!m.section) problems.push('no section rail at the content edge');
      else if (m.list.left - m.section.right < -1 || m.list.left - m.section.right > 2) problems.push(`list rail at x=${m.list.left}, ${m.list.left - m.section.right}px from the section rail's right ${m.section.right} — not stacked beside it`);
      if (Math.abs(m.list.top - m.contentTop) > 2) problems.push(`list rail top ${m.list.top} vs content top ${m.contentTop} — something sits above it (a trail, a title)`);
      if (Math.abs(m.list.height - m.contentHeight) > 4) problems.push(`list rail height ${m.list.height} vs content ${m.contentHeight} — not full height`);
      if (m.list.radius > 2) problems.push(`the list rail floats in a rounded box (radius ${m.list.radius}px)`);
      if (ref?.list && Math.abs(m.list.width - ref.list.width) > 2) problems.push(`list rail width ${m.list.width} vs the Initiatives rail ${ref.list.width}`);
      if (!m.crumb) problems.push('no breadcrumb trail right of the list rail');
      else {
        if (Math.abs(m.crumb.left - m.list.right - 24) > 2) problems.push(`trail at x=${m.crumb.left}, ${m.crumb.left - m.list.right}px right of the list rail (want 24)`);
        if (m.crumb.top - m.contentTop > 24) problems.push(`trail ${m.crumb.top - m.contentTop}px under the content top — not the column's first row`);
      }
      if (m.hScroll) problems.push('horizontal page scroll');
    }
    record(path, problems);
    if (problems.length) { failed += 1; console.log(`DIFFERS ${path}:`); for (const p of problems) console.log(' - ' + p); }
    else console.log(`MATCH ${path} — list rail ${m.list.width}px at x=${m.list.left} (section rail ends ${m.section.right}), top ${m.list.top}, height ${m.list.height} of ${m.contentHeight}; trail at x=${m.crumb.left}`);
  }
  await browser.close();
  process.exit(failed ? 1 : 0);
}

const SUBJECTS = (process.env.RAIL_PARITY_SUBJECT ?? '').split(',').map((v) => v.trim()).filter(Boolean);
if (SUBJECTS.length) {
  const user = process.env.RAIL_PARITY_USER;
  if (!user) { console.log('RAIL_PARITY_SUBJECT needs RAIL_PARITY_USER'); process.exit(2); }
  const tenant = process.env.RAIL_PARITY_TENANT ?? 'social';
  const ALWAYS = (process.env.RAIL_PARITY_CAPTIONS ?? 'Active now').split(',').map((v) => v.trim()).filter(Boolean);
  // Mirrors portal/src/pages/social/socialChat.ts ROUTE_RAIL_CAPTION / SOCIAL_SECTION_CAPTIONS /
  // railSectionsFor. Since 6c5c0557 the rooms route is the focused Hangouts list: its own section
  // only — no Active now, no shelf (portal/e2e/social-navigation.spec.ts asserts the same).
  const SECTION_CAPTIONS = ['Teams', 'Hangouts', 'Direct messages', 'Channels'];
  const ROUTE_CAPTION = { channels: 'Channels', dms: 'Direct messages', teams: 'Teams', rooms: 'Hangouts', calls: null, recordings: null };
  const FOCUSED_ROUTES = new Set(['rooms']);
  const captionsFor = (path) => {
    const pathname = new URL(path, 'http://x').pathname.replace(/\/+$/, '');
    const m = pathname.match(/^\/(?:social|[a-z]+\/communication)(?:\/([a-z]+))?/);
    if (!m) return { expected: [...ALWAYS, ...SECTION_CAPTIONS], forbidden: [], shelf: true };
    // The plane's home keeps every section; a route without a sub-route segment under /social is not a chat page.
    if (!m[1]) return { expected: [...ALWAYS, ...SECTION_CAPTIONS], forbidden: [], shelf: true };
    const own = ROUTE_CAPTION[m[1]] ?? null;
    const focused = FOCUSED_ROUTES.has(m[1]);
    return { expected: [...(focused ? [] : ALWAYS), ...(own ? [own] : [])], forbidden: SECTION_CAPTIONS.filter((c) => c !== own), shelf: !focused };
  };
  const SHELF = (process.env.RAIL_PARITY_SHELF ?? 'Activity,Mentions,Calls,Recordings').split(',');
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1672, height: 941 } });
  const page = await ctx.newPage();
  // One sign-in for every subject (the login route is rate-limited, 15/min).
  await signIn(page, BASE, user, tenant, null);
  let failed = 0;
  for (const path of SUBJECTS) {
    await page.goto(BASE + path); await page.waitForTimeout(3500);
    const { expected: CAPTIONS, forbidden: FORBIDDEN, shelf: wantShelf } = captionsFor(path);
    const SHELF_HERE = wantShelf ? SHELF : [];
    const m = await page.evaluate(({ CAPTIONS, FORBIDDEN, SHELF }) => {
      const main = document.querySelector('main');
      const rail = document.querySelector('nav[aria-label="Chat"]') ?? document.querySelector('[data-testid$="chat-rail"]');
      if (!main || !rail) return null;
      const mr = main.getBoundingClientRect(); const mcs = getComputedStyle(main);
      const content = { left: mr.left + parseFloat(mcs.paddingLeft), top: mr.top + parseFloat(mcs.paddingTop), bottom: mr.bottom - parseFloat(mcs.paddingBottom) };
      const r = rail.getBoundingClientRect(); const rcs = getComputedStyle(rail);
      const crumbs = [...document.querySelectorAll('.shell-breadcrumbs')].some((e) => e.getBoundingClientRect().height > 0 && getComputedStyle(e).display !== 'none');
      const text = (rail.textContent ?? '').toLowerCase();
      const heads = [...rail.querySelectorAll('h2, h3, [data-testid="conversation-section"], [role="heading"], button, span')]
        .map((e) => (e.textContent ?? '').trim().toLowerCase());
      // A caption is a heading element whose whole text is the caption (an optional count after it), never a row's preview.
      const isCaption = (c) => { const re = new RegExp(`^${c.toLowerCase()}\\s*\\d*$`); return heads.some((h) => re.test(h)); }; // captions are plain words
      return {
        railLeft: Math.round(r.left), railTop: Math.round(r.top), railWidth: Math.round(r.width), railHeight: Math.round(r.height),
        contentLeft: Math.round(content.left), contentTop: Math.round(content.top), contentHeight: Math.round(content.bottom - content.top),
        radius: parseFloat(rcs.borderTopLeftRadius) || 0, crumbs,
        missingCaptions: CAPTIONS.filter((c) => !isCaption(c)),
        forbiddenCaptions: FORBIDDEN.filter((c) => isCaption(c)),
        missingShelf: SHELF.filter((c) => !text.includes(c.toLowerCase())),
        hScroll: document.documentElement.scrollWidth > innerWidth,
      };
    }, { CAPTIONS, FORBIDDEN, SHELF: SHELF_HERE });
    console.log(`subject ${path} as ${user}:`, JSON.stringify(m));
    const problems = [];
    if (!m) problems.push('no chat rail (nav[aria-label=Chat]) or no <main>');
    else {
      if (Math.abs(m.railLeft - 200) > 2) problems.push(`rail left ${m.railLeft} — not flush against the 200px shell rail`);
      if (Math.abs(m.railLeft - m.contentLeft) > 2) problems.push(`rail left ${m.railLeft} vs content left ${m.contentLeft} — a padded frame is around it`);
      if (Math.abs(m.railTop - m.contentTop) > 2) problems.push(`rail top ${m.railTop} vs content top ${m.contentTop} — something (a page header, the crumbs) sits above it`);
      if (Math.abs(m.railHeight - m.contentHeight) > 4) problems.push(`rail height ${m.railHeight} vs content height ${m.contentHeight} — not full height`);
      if (m.crumbs) problems.push('the shell breadcrumb row is showing (the page root is not data-shell-flush)');
      if (m.radius > 2) problems.push(`the rail has card chrome (radius ${m.radius}px)`);
      if (m.missingCaptions.length) problems.push(`section captions missing: ${m.missingCaptions.join(', ')}`);
      if (m.forbiddenCaptions.length) problems.push(`section captions present but forbidden on this route (one section per route): ${m.forbiddenCaptions.join(', ')}`);
      if (m.missingShelf.length) problems.push(`shelf destinations missing: ${m.missingShelf.join(', ')}`);
      if (m.hScroll) problems.push('horizontal page scroll');
    }
    record(path, problems);
    if (problems.length) { failed += 1; console.log(`DIFFERS ${path}:`); for (const p of problems) console.log(' - ' + p); }
    else console.log(`MATCH ${path} — chat rail ${m.railWidth}px at x=${m.railLeft}, top ${m.railTop}, height ${m.railHeight} of ${m.contentHeight}`);
  }
  await browser.close();
  process.exit(failed ? 1 : 0);
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1672, height: 941 } });
const page = await ctx.newPage();
await signIn(page, BASE, 'u-vera', 'orgiq', 'org-leader');
await page.goto(BASE + '/iq/library'); await page.waitForTimeout(2500);
const reference = await page.evaluate(findRailScript(), false);
let subject;
if (OTHER) {
  const other = await ctx.newPage(); await other.goto(OTHER); await other.waitForTimeout(3500);
  subject = await other.evaluate(findRailScript(), true);
} else {
  await signIn(page, BASE, 'u-farah', 'assessment', null);
  await page.goto(BASE + '/assessment/workspace?doc=page%3A100002'); await page.waitForTimeout(3500);
  subject = await page.evaluate(findRailScript(), false);
}
await browser.close();
console.log('reference /iq/library:', JSON.stringify(reference));
console.log('subject:', JSON.stringify(subject));
const problems = [];
if (!reference) problems.push('no rail found on /iq/library');
if (!subject) problems.push('no rail found on the subject page');
if (reference && subject) {
  if (Math.abs(reference.width - subject.width) > TOL.width) problems.push(`rail width ${subject.width} vs ${reference.width}`);
  // The frame: the second rail sits flush against the shell rail at full
  // height (the page is `data-shell-flush`), so its left and top match.
  if (!OTHER && Math.abs(reference.left - subject.left) > 2) problems.push(`rail left ${subject.left} vs ${reference.left} — a padded frame or a shell breadcrumb row is still around it`);
  if (!OTHER && Math.abs(reference.top - subject.top) > 2) problems.push(`rail top ${subject.top} vs ${reference.top} — a row above the rail (crumbs) or a padded frame`);
  if (reference.captionSize !== subject.captionSize) problems.push(`caption ${subject.captionSize} vs ${reference.captionSize}`);
  if (reference.rowFont !== subject.rowFont || reference.rowWeight !== subject.rowWeight) problems.push(`row type ${subject.rowFont}/${subject.rowWeight} vs ${reference.rowFont}/${reference.rowWeight}`);
  if (reference.pitch && subject.pitch && Math.abs(reference.pitch - subject.pitch) > TOL.pitch) problems.push(`row pitch ${subject.pitch} vs ${reference.pitch}`);
  if (subject.radius > 2 || subject.cardRadius > 2) problems.push(`subject rail has card chrome (radius ${Math.max(subject.radius, subject.cardRadius)}px)`);
  if (subject.iconRows > reference.iconRows) problems.push(`subject rows carry icons (${subject.iconRows} of ${subject.rows}) — the Org rail has ${reference.iconRows}`);
}
if (!OTHER) record('/assessment/workspace', problems);
if (problems.length) { console.log('DIFFERS:'); for (const p of problems) console.log(' - ' + p); process.exit(1); }
console.log('MATCH');

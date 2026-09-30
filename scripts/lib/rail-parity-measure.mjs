// Headless measurement for docs/rail-parity-goal.md: the second rail on the
// Assessment workspace (or another app's /documents with --other) must agree
// with /iq/library's concise stacked rail on width, caption, row type, pitch
// and chrome. Run from portal/ (Playwright is installed there).
import { createRequire } from 'node:module';
// Playwright is installed in portal/, wherever this script is run from.
const require = createRequire(new URL('../../portal/package.json', import.meta.url));
const { chromium } = require('playwright');

const BASE = process.env.RAIL_PARITY_BASE ?? 'http://localhost:5183';
const OTHER = process.argv.includes('--other') ? process.env.RAIL_PARITY_OTHER : null;
const TOL = { width: 8, pitch: 2 };

function findRailScript() {
  // The rail: the nearest ancestor of the caption (11px caps label) that is
  // 160–340px wide and taller than 300px — the second navigation column.
  return () => {
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
        if (r.width >= 160 && r.width <= 340 && r.height >= 300 && r.left > 100) {
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
            width: Math.round(r.width), rowFont: rowCs.fontSize, rowWeight: rowCs.fontWeight, pitch, rows: rows.length, bg, radius, cardRadius, iconRows,
          };
        }
      }
    }
    return null;
  };
}

async function signIn(page, base, userId, tenant, role) {
  await page.goto(base + '/');
  await page.evaluate(async ({ userId, tenant, role }) => {
    const h = { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include' };
    await fetch('/api/session/login', { ...h, body: JSON.stringify({ userId }) });
    if (tenant) await fetch('/api/session/tenant', { ...h, body: JSON.stringify({ tenant }) });
    if (role) await fetch('/api/session/role', { ...h, body: JSON.stringify({ role }) });
  }, { userId, tenant, role });
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1672, height: 941 } });
const page = await ctx.newPage();
await signIn(page, BASE, 'u-vera', 'orgiq', 'org-leader');
await page.goto(BASE + '/iq/library'); await page.waitForTimeout(2500);
const reference = await page.evaluate(findRailScript());
let subject;
if (OTHER) {
  const other = await ctx.newPage(); await other.goto(OTHER); await other.waitForTimeout(3500);
  subject = await other.evaluate(findRailScript());
} else {
  await signIn(page, BASE, 'u-farah', 'assessment', null);
  await page.goto(BASE + '/assessment/workspace?doc=page%3A100002'); await page.waitForTimeout(3500);
  subject = await page.evaluate(findRailScript());
}
await browser.close();
console.log('reference /iq/library:', JSON.stringify(reference));
console.log('subject:', JSON.stringify(subject));
const problems = [];
if (!reference) problems.push('no rail found on /iq/library');
if (!subject) problems.push('no rail found on the subject page');
if (reference && subject) {
  if (Math.abs(reference.width - subject.width) > TOL.width) problems.push(`rail width ${subject.width} vs ${reference.width}`);
  if (reference.captionSize !== subject.captionSize) problems.push(`caption ${subject.captionSize} vs ${reference.captionSize}`);
  if (reference.rowFont !== subject.rowFont || reference.rowWeight !== subject.rowWeight) problems.push(`row type ${subject.rowFont}/${subject.rowWeight} vs ${reference.rowFont}/${reference.rowWeight}`);
  if (reference.pitch && subject.pitch && Math.abs(reference.pitch - subject.pitch) > TOL.pitch) problems.push(`row pitch ${subject.pitch} vs ${reference.pitch}`);
  if (subject.radius > 2 || subject.cardRadius > 2) problems.push(`subject rail has card chrome (radius ${Math.max(subject.radius, subject.cardRadius)}px)`);
  if (subject.iconRows > reference.iconRows) problems.push(`subject rows carry icons (${subject.iconRows} of ${subject.rows}) — the Org rail has ${reference.iconRows}`);
}
if (problems.length) { console.log('DIFFERS:'); for (const p of problems) console.log(' - ' + p); process.exit(1); }
console.log('MATCH');

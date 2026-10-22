// The type scale on every route (the user, 2026-10-07: "walk down the tree on
// all of the pages and see that when you get to the content, note if there's
// oddities on font size oscillating — then there's an issue").
//
// The app has one type scale: page title 20/600, headings 14/600, body
// 14/400, meta 12/400 (`T` / `size="sm"`). Over the layout-cascade route
// inventory (e2e/route-inventory.ts), signed in as its user, this walks every
// visible text node top-down in each region of the page and reads its
// computed font-size/weight, depth and ancestry:
//
//   content  the content column — the shell trail and #main-content, less the
//            in-page rails and the right pane
//   rail     the section rail / list rail inside the page (ConversationRail,
//            ListRailLayout's Explorer rail)
//   pane     the right pane (huddle chat, the page conversation pane, an
//            in-page column hugging the right edge)
//   primary  the shell's primary rail — walked once per tenant
//
// Rules (each offender is `route · rule · region · path · size/weight · text`):
//   scale       every size is 20, 14 or 12 px; 10–11 px only inside a pill or
//               badge (the library count Badge is 10 px; a chip is a filled,
//               rounded box ≤24px tall); 16 px only inside the document editor
//               canvas or the deck editor. Avatar initials (≤3 letters in a
//               filled circle) and an icon drawn as a symbol or emoji ("⋯", "✓", "⬤", "🤖": no
//               letters or digits) are glyphs, not type, and are not walked.
//   title-scale 20 px belongs to the page title alone (the first visible h1 in
//               the content column) — nothing else is that large
//   above-title nothing in the content column is larger than the page title
//   grows       sizes never increase down an ancestor chain of text-bearing
//               elements (a child set larger than the text around it)
//   siblings    sibling headings share one size (no h2 18 beside h3 14)
//   actions     the header action rows (PageHeader actions, the trail band's
//               controls) hold only small buttons — no text above 14 px, no
//               link-styled or md button in the title's action row
//               (role=tab buttons are navigation, not actions, and are not judged)
//
// A burn-down (e2e/type-scale-burndown.tsv: route or App.tsx pattern ·
// rule region size/weight · owner surface · due date): the sweep fails on any
// offender not listed there — a size a page did not have before. A listed
// offender that no longer occurs is reported, and TYPE_SCALE_PRUNE=1 removes
// it; the file may only shrink — TYPE_SCALE_WRITE_BASELINE=1 writes it only
// when it does not exist yet. Every row carries a due date, and
// validate-rail-parity.sh fails once a row outlives it (audit J1: a ratchet
// goes down on a schedule, not merely "never up"). Never add a row to make
// the sweep pass; fix the page.
//
// A complete run also records each route's offender set as the type half of
// its rendered contract (docs/journeys/contracts/type-scale.json,
// docs/journeys.md).
//
// Report: a compact per-route table (route · offenders · worst oscillation)
// on stdout and in $TYPE_SCALE_LOG_DIR (default $RAIL_PARITY_LOG_DIR, /tmp)/
// type-scale-report.txt. TYPE_SCALE_ONLY=<substring> narrows the sweep;
// TYPE_SCALE_TENANTS=orgiq,pipelines narrows the tenants.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { OBSERVED_ROUTES, PARAM_ROUTES, STATE_ROUTES, SWEEP_USER, TENANTS, resolveParam, sourceDigest, staticInventory, type InventoryRoute, type Tenant } from './route-inventory';
import { DEFAULT_DUE, ownerOf, readRows, writeRows, type Row } from './burndown';
import { finishParts, recordPart } from './contracts';
import { signInMeasured } from './realSession';

const BASE = process.env.PARITY_BASE_URL ?? process.env.LAYOUT_CASCADE_BASE ?? 'http://127.0.0.1:5183';
const ONLY = process.env.TYPE_SCALE_ONLY ?? '';
const ONLY_TENANTS = (process.env.TYPE_SCALE_TENANTS ?? '').split(',').filter(Boolean);
const LOG_DIR = process.env.TYPE_SCALE_LOG_DIR ?? process.env.RAIL_PARITY_LOG_DIR ?? '/tmp';
// TYPE_SCALE_USER=u-nora walks as another seeded user (a look, not the judge: the baseline is the inventory user's).
const USER = process.env.TYPE_SCALE_USER ?? SWEEP_USER;
const BURNDOWN_FILE = path.resolve(process.cwd(), 'e2e/type-scale-burndown.tsv');

test.use({ baseURL: BASE, viewport: { width: 1680, height: 940 } });

type Region = 'content' | 'rail' | 'pane' | 'primary';
type Rule = 'scale' | 'title-scale' | 'above-title' | 'grows' | 'siblings' | 'actions';

interface TextEl {
  region: Region; size: number; weight: number; tag: string; path: string; text: string;
  depth: number; parent: number; title: boolean; actions: 'title-row' | 'trail-band' | null;
  pill: boolean; canvas: boolean;
}
interface SiblingGroup { region: Region; path: string; sizes: number[] }
interface ActionButton { region: Region; path: string; text: string; variant: string | null; size: string | null; height: number }
interface Walk { landed: string; els: TextEl[]; siblings: SiblingGroup[]; buttons: ActionButton[] }

/** Walks the page. Runs in the browser; self-contained. */
async function walk(page: Page, withPrimary: boolean): Promise<Walk> {
  return page.evaluate((withPrimary) => {
    const visible = (e: Element) => {
      const b = e.getBoundingClientRect();
      if (b.width <= 1 || b.height <= 1) return false;
      const cs = getComputedStyle(e);
      return cs.visibility !== 'hidden' && cs.clip !== 'rect(0px, 0px, 0px, 0px)' && cs.clipPath !== 'inset(50%)' && cs.opacity !== '0';
    };
    const shell = document.querySelector('[data-shell-nav]');
    const main = shell?.querySelector('main') ?? document.querySelector('main');
    const mc = (document.getElementById('main-content') ?? main) as HTMLElement | null;
    const roots: Array<{ region: Region; el: Element }> = [];
    if (!main || !mc) return { landed: location.pathname + location.search, els: [], siblings: [], buttons: [] };
    const mb = mc.getBoundingClientRect();
    // In-page rails: tall navigation columns at the page top (as the cascade sweep finds them), and the list rail.
    const rails = [...mc.querySelectorAll('aside, nav, [role="navigation"]')].filter(visible).filter((e) => {
      const b = e.getBoundingClientRect();
      return b.width >= 120 && b.width <= 480 && b.height >= mb.height * 0.6 && b.top <= mb.top + 4 && b.left < mb.right - 200;
    });
    for (const r of rails) if (!rails.some((o) => o !== r && o.contains(r))) roots.push({ region: 'rail', el: r });
    // The right pane: the shell's split pane, and an in-page column hugging the right edge.
    const panes = [...main.querySelectorAll('[data-testid="shell-split-stack"], [data-testid="huddle-chat-panel"], [data-testid="huddle-chat-inpage"], [data-testid="page-conversation-pane"]')].filter(visible);
    for (const e of mc.querySelectorAll('aside, [role="complementary"], [data-testid$="-pane"], [data-testid$="-column"]')) {
      if (!visible(e) || rails.some((r) => r.contains(e) || e.contains(r))) continue;
      const b = e.getBoundingClientRect();
      if (b.width >= 220 && b.width <= 600 && b.height >= mb.height * 0.5 && Math.abs(b.right - mb.right) <= 4 && b.left >= mb.left + 400) panes.push(e);
    }
    for (const p of panes) if (!panes.some((o) => o !== p && o.contains(p))) roots.push({ region: 'pane', el: p });
    if (withPrimary) { const primary = shell?.querySelector(':scope > div > aside') ?? shell?.querySelector('aside'); if (primary && !main.contains(primary)) roots.push({ region: 'primary', el: primary }); }
    const regionOf = (e: Element): { region: Region; root: Element } | null => {
      for (const r of roots) if (r.el.contains(e)) return { region: r.region, root: r.el };
      if (main.contains(e)) return { region: 'content', root: main };
      return null;
    };

    // Test ids that carry a record id (a person, a channel, a row) are normalised, so a key names the kind of element, not the data.
    const norm = (id: string) => id
      .replace(/^(rf__node|rf__edge)-.*$/, '$1-*')
      .replace(/-(u|p|wi|d|des|rev|art|team|run|job|deck|asset|page|person|ch|dm)-[\w.:-]+$/i, '-*')
      .replace(/[-_][\w.-]*:[\w:.-]*$/, '-*')
      .replace(/-[\w.-]*\d[\w.-]*$/, '-*');
    const seg = (e: Element) => { const id = e.getAttribute('data-testid'); return id ? `[${norm(id)}]` : null; };
    const pathOf = (e: Element, root: Element) => {
      const marks: string[] = [];
      for (let a: Element | null = e.parentElement; a && a !== root && marks.length < 2; a = a.parentElement) { const s = seg(a); if (s) marks.unshift(s); }
      const role = e.getAttribute('role');
      const own = seg(e) ?? `${e.tagName.toLowerCase()}${role ? `[role=${role}]` : ''}`;
      return [...marks, own].join(' › ');
    };
    const isHeading = (e: Element) => /^H[1-6]$/.test(e.tagName) || e.getAttribute('role') === 'heading';
    const pillOf = (e: Element) => {
      for (let a: Element | null = e, i = 0; a && i < 3; a = a.parentElement, i++) {
        const cls = typeof a.className === 'string' ? a.className : '';
        if (/\brounded-full\b/.test(cls) || a.tagName === 'KBD' || /badge|chip|pill|-count$/i.test(a.getAttribute('data-testid') ?? '')) return true;
        // A chip by its box: filled, rounded, at most 24px tall.
        const cs = getComputedStyle(a), h = a.getBoundingClientRect().height;
        const filled = cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent';
        if (filled && (parseFloat(cs.borderTopLeftRadius) || 0) >= 3 && h > 0 && h <= 24) return true;
      }
      return false;
    };
    // Avatar initials ("RK") are a glyph sized to their circle, not type: a filled circle ≤48px holding ≤3 letters.
    const avatarOf = (e: Element, text: string) => {
      if (text.length > 3) return false;
      for (let a: Element | null = e, i = 0; a && i < 3; a = a.parentElement, i++) {
        const cs = getComputedStyle(a), b = a.getBoundingClientRect();
        const filled = (cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent') || cs.backgroundImage !== 'none';
        if (filled && b.height > 0 && b.height <= 48 && (parseFloat(cs.borderTopLeftRadius) || 0) >= b.height / 2 - 1) return true;
      }
      return false;
    };
    // An icon drawn as a glyph ("⋯", "✓", "⬤", "−", an emoji) is sized to its control, not set as type: symbols only, no letters or digits.
    const glyphOf = (text: string) => /^[\p{S}\p{Extended_Pictographic}\u200d\ufe0f\s]+$/u.test(text);
    // The canvas document editor (sheet, ruler, toolbar, comment gutter) is the library's own surface, like the deck editor.
    const canvasOf = (e: Element) => !!e.closest('.ProseMirror, .tiptap, [contenteditable="true"], [data-testid="deck-editor"], [data-testid^="doc-editor"], [data-testid^="canvas-document"], [data-testid="document-ruler"], [data-testid="document-toolbar"]');

    // The page title: the first visible h1 in the content column.
    const title = [...main.querySelectorAll('h1')].find((h) => visible(h) && regionOf(h)?.region === 'content') ?? null;
    // Header action rows: the title's PageHeader action group, and the trail band's controls.
    const actionRoots: Array<{ el: Element; kind: 'title-row' | 'trail-band' }> = [];
    if (title) {
      const row = title.closest('div.justify-between') ?? title.parentElement?.parentElement ?? null;
      if (row) for (const c of row.children) if (!c.contains(title)) actionRoots.push({ el: c, kind: 'title-row' });
    }
    for (const band of main.querySelectorAll('[data-testid="section-crumbs"]')) {
      for (const c of band.querySelectorAll(':scope > *, :scope > * > *')) {
        if (c.matches('nav') || c.querySelector('nav[aria-label*="readcrumb"]') || c.closest('nav[aria-label*="readcrumb"]')) continue;
        if (!actionRoots.some((r) => r.el.contains(c))) actionRoots.push({ el: c, kind: 'trail-band' });
      }
    }
    const actionsOf = (e: Element) => actionRoots.find((r) => r.el.contains(e))?.kind ?? null;

    const els: TextEl[] = [];
    const index = new Map<Element, number>();
    const scan = [...roots.filter((r) => r.region !== 'content').map((r) => r.el), main];
    const seen = new Set<Element>();
    for (const root of scan) {
      const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let t = tw.nextNode(); t; t = tw.nextNode()) {
        const text = (t.textContent ?? '').replace(/[\s​]+/g, ' ').trim();
        const el = t.parentElement;
        if (!text || !el || seen.has(el)) continue;
        if (el.closest('svg, script, style, noscript, template, option, [data-testid="shell-footer"]')) continue;
        const where = regionOf(el);
        if (!where || (root === main && where.region !== 'content')) continue;
        seen.add(el);
        if (!visible(el) || avatarOf(el, text) || glyphOf(text)) continue;
        const cs = getComputedStyle(el);
        let depth = 0;
        for (let a: Element | null = el; a && a !== where.root; a = a.parentElement) depth++;
        index.set(el, els.length);
        els.push({
          region: where.region, size: Math.round(parseFloat(cs.fontSize) * 10) / 10, weight: Number(cs.fontWeight) || 400,
          tag: el.tagName.toLowerCase(), path: pathOf(el, where.root), text: text.slice(0, 48), depth, parent: -1,
          title: el === title || (!!title && title.contains(el)), actions: actionsOf(el), pill: pillOf(el), canvas: canvasOf(el),
        });
      }
    }
    // The nearest text-bearing ancestor in the same region.
    for (const [el, i] of index) {
      for (let a = el.parentElement; a; a = a.parentElement) {
        const j = index.get(a);
        if (j !== undefined) { if (els[j]!.region === els[i]!.region) els[i]!.parent = j; break; }
        if (a === main) break;
      }
    }
    // Sibling headings: each element's children that are (or open with) a heading.
    const lead = (c: Element): Element | null => {
      let e: Element | null = c;
      for (let i = 0; e && i < 4; i++, e = e.firstElementChild) if (isHeading(e)) return e;
      return null;
    };
    const siblings: SiblingGroup[] = [];
    for (const root of [...roots.map((r) => r.el), main]) {
      for (const p of [root, ...root.querySelectorAll('*')]) {
        if (p.childElementCount < 2 || canvasOf(p)) continue;
        const where = regionOf(p);
        if (!where || (root === main && where.region !== 'content')) continue;
        const hs = [...p.children].map(lead).filter((h): h is Element => !!h && h !== title && visible(h) && regionOf(h)?.region === where.region);
        if (hs.length < 2) continue;
        const sizes = hs.map((h) => Math.round(parseFloat(getComputedStyle(h).fontSize) * 10) / 10);
        if (new Set(sizes).size > 1) siblings.push({ region: where.region, path: pathOf(p, where.root), sizes });
      }
    }
    // Buttons in the title's action row.
    const buttons: ActionButton[] = [];
    for (const r of actionRoots) {
      for (const b of r.el.matches('button, a') ? [r.el] : r.el.querySelectorAll('button, a')) {
        if (!visible(b) || r.kind !== 'title-row' || b.getAttribute('role') === 'tab') continue; // tabs are navigation, not header actions
        const where = regionOf(b) ?? { region: 'content' as Region, root: main };
        buttons.push({ region: where.region, path: pathOf(b, where.root), text: (b.textContent ?? '').trim().slice(0, 40),
          variant: b.getAttribute('data-variant'), size: b.getAttribute('data-size'), height: Math.round(b.getBoundingClientRect().height) });
      }
    }
    return { landed: location.pathname + location.search, els, siblings, buttons };
  }, withPrimary) as Promise<Walk>;
}

interface Offender { rule: Rule; region: Region; path: string; sw: string; text: string }

const PAGE_SCALE = [20, 14, 12];
const near = (a: number, b: number) => Math.abs(a - b) < 0.3;
const onScale = (e: TextEl) => PAGE_SCALE.some((s) => near(e.size, s))
  || (e.pill && (near(e.size, 11) || near(e.size, 10)))
  || (e.canvas && near(e.size, 16));

/** The rules over one walk. Pure. */
export function judge(w: Walk): Offender[] {
  const out: Offender[] = [];
  const sw = (e: { size: number; weight: number }) => `${e.size}/${e.weight}`;
  const add = (rule: Rule, e: TextEl, extra = '') => out.push({ rule, region: e.region, path: e.path, sw: sw(e) + extra, text: e.text });
  const title = w.els.find((e) => e.title) ?? null;
  for (const e of w.els) {
    if (e.canvas) continue;
    if (!onScale(e)) add('scale', e);
    if (!e.title && e.size >= 20 - 0.3) add('title-scale', e);
    if (title && e.region === 'content' && !e.title && e.size > title.size + 0.3) add('above-title', e);
    const p = e.parent >= 0 ? w.els[e.parent]! : null;
    if (p && !e.title && !p.canvas && e.size > p.size + 0.3) add('grows', e, ` in ${sw(p)}`);
    if (e.actions && e.size > 14.3) add('actions', e);
  }
  for (const g of w.siblings) out.push({ rule: 'siblings', region: g.region, path: g.path, sw: g.sizes.join('|'), text: '' });
  for (const b of w.buttons) {
    if (b.variant === 'link') out.push({ rule: 'actions', region: b.region, path: b.path, sw: 'link-styled', text: b.text });
    else if (b.size && b.size !== 'sm') out.push({ rule: 'actions', region: b.region, path: b.path, sw: `size=${b.size}`, text: b.text });
    else if (b.height > 32) out.push({ rule: 'actions', region: b.region, path: b.path, sw: `${b.height}px tall`, text: b.text });
  }
  return out;
}

/** The worst reversal down the content column that leaves the scale ("16→18→16"), or "—". */
export function worstOscillation(w: Walk): string {
  const seq: number[] = [];
  for (const e of w.els) if (e.region === 'content' && !e.canvas && seq[seq.length - 1] !== e.size) seq.push(e.size);
  let best: { off: number; amp: number; s: string } | null = null;
  for (let i = 1; i < seq.length - 1; i++) {
    const [a, b, c] = [seq[i - 1]!, seq[i]!, seq[i + 1]!];
    if (!((b > a && b > c) || (b < a && b < c))) continue;
    const off = [a, b, c].filter((x) => !PAGE_SCALE.some((s) => near(x, s))).length;
    if (!off) continue;
    const amp = Math.min(Math.abs(a - b), Math.abs(c - b));
    if (!best || off > best.off || (off === best.off && amp > best.amp)) best = { off, amp, s: `${a}→${b}→${c}` };
  }
  return best?.s ?? '—';
}

// The ratchet keys on what breaks the scale on a route — rule, region, size/weight — not on the element's
// container: a new row, graph node or table body from new data is not a new offender, a new size is. Paths
// stay in the report and the failure lines so an offender can be found.
/**
 * Offenders that come and go with the shared stack's state rather than the page's code: reported in the table,
 * never judged new. Nothing else may skip the ratchet.
 */
export const VOLATILE: ReadonlyArray<{ match: RegExp; reason: string }> = [
  { match: /active-now|active-grid/, reason: 'presence: ActivePeopleGrid tiles render only while someone is online; their 11/500 names are queued upstream (docs/ui-components-queue.md, "Rail and tile type off the app scale")' },
  { match: /\[loading-state\]/, reason: 'a loading state caught mid-load; its size is judged where it settles, not on a timing' },
];
const volatile = (o: Offender) => VOLATILE.some((v) => v.match.test(o.path));
const keyOf = (o: Offender) => `${o.rule} ${o.region} ${o.sw}`;

// realSession.signInMeasured owns the identity: the seed persona by default, a cached clone of it under
// JOURNEY_MEASURE_CLONES=1 (measure.sh) or TYPE_SCALE_CLONES=1, with the login's own bounded retries.
const enterAs = (page: Page, tenant: Tenant | null, user = USER) => signInMeasured(page, user, tenant ? { tenant } : {});

async function resolveParams(page: Page, tenant: Tenant): Promise<InventoryRoute[]> {
  const out: InventoryRoute[] = [];
  const get = async (url: string) => { const res = await page.request.get(url); return res.ok() ? res.json() : null; };
  for (const r of PARAM_ROUTES.filter((p) => p.tenant === tenant)) out.push({ tenant, path: await resolveParam(r, get), source: 'param', pattern: r.pattern });
  return out;
}

/** A navigation that survives the dev server restarting under another run's edit (connection refused / reset). */
async function goto(page: Page, url: string) {
  for (let attempt = 1; ; attempt++) {
    try { await page.goto(url, { waitUntil: 'domcontentloaded' }); return; } catch (error) {
      if (attempt >= 5 || !/ERR_CONNECTION|ERR_EMPTY_RESPONSE|ERR_NETWORK/.test(String(error))) throw error;
      await page.waitForTimeout(4_000);
    }
  }
}

async function settle(page: Page) {
  await page.getByTestId('shell-footer').first().waitFor({ timeout: 15_000 }).catch(() => {});
  await page.locator('main h1, main nav[aria-label="Breadcrumb"]').first().waitFor({ timeout: 8_000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 4_000 }).catch(() => {});
  // Lazy panes and loading states settle into the page's real content.
  await page.locator('main [aria-busy="true"], main [data-testid$="-loading"]').first().waitFor({ state: 'detached', timeout: 4_000 }).catch(() => {});
  await page.waitForTimeout(400);
}

const inventory = staticInventory();
const BURNDOWN_HEADER = [
  'Type-scale burn-down (portal/e2e/type-scale-sweep.spec.ts; audit 2026-10-07 J1).',
  'Columns: route (inventory key) · offender (rule region size/weight) · count · owner surface · due date.',
  'The sweep tolerates a listed offender; validate-rail-parity.sh fails a row still listed after its due date.',
  'Rows only ever go: TYPE_SCALE_PRUNE=1 drops an offender that no longer occurs. Never add a row to pass; fix the page.',
];
const burndown = readRows(BURNDOWN_FILE);
const baseline: Record<string, string[]> | null = burndown && burndown.reduce<Record<string, string[]>>((acc, r) => { (acc[r.group] ??= []).push(r.item); return acc; }, {});
const observed: Record<string, string[]> = {};
// The type half of each route's rendered contract: its page title and its
// (non-volatile) offender set, and per tenant the primary rail's. Written only after a complete run.
const contract: Record<string, { title: string | null; offenders: string[] }> = {};
// Contracts are recorded only for the inventory user's complete, unfiltered run.
const RECORDS = !ONLY && ONLY_TENANTS.length === 0 && USER === SWEEP_USER;
const startDigest = sourceDigest();

for (const tenant of TENANTS) {
  test(`type scale on every ${tenant} route`, async ({ page }) => {
    test.skip(ONLY_TENANTS.length > 0 && !ONLY_TENANTS.includes(tenant), 'TYPE_SCALE_TENANTS');
    test.setTimeout(40 * 60_000);
    await enterAs(page, tenant);
    const routes = [...inventory.filter((r) => r.tenant === tenant), ...await resolveParams(page, tenant)]
      .filter((r) => !ONLY || r.path.includes(ONLY));
    // Journey-walked routes outside the judged inventory: their contract is recorded, never judged.
    const get = async (url: string) => { const res = await page.request.get(url); return res.ok() ? res.json() : null; };
    const observedRoutes = ONLY ? [] : await Promise.all(OBSERVED_ROUTES.filter((o) => o.tenant === tenant).map(async (o) => ({ path: await resolveParam(o, get), pattern: o.pattern })));
    const rows: string[] = [];
    const failures: string[] = [];
    const stale: string[] = [];
    let first = true;
    for (const r of routes) {
      await goto(page, r.path);
      await settle(page);
      if (/^\/(select|login)/.test(new URL(page.url()).pathname)) {
        await enterAs(page, tenant);
        await goto(page, r.path);
        await settle(page);
      }
      // A client-side redirect or a dev-server reload can destroy the context mid-walk: settle and walk once more.
      const w = await walk(page, first && !ONLY).catch(async (error: unknown) => {
        if (!/Execution context was destroyed|navigation/i.test(String(error))) throw error;
        await settle(page);
        return walk(page, first && !ONLY);
      });
      const offenders = judge(w);
      if (process.env.TYPE_SCALE_DETAIL === '1') {
        try { fs.appendFileSync(path.join(LOG_DIR, 'type-scale-detail.tsv'), offenders.filter((o) => !volatile(o)).map((o) => [r.pattern ?? r.path, o.rule, o.region, o.sw, o.path, o.text].join('\t') + '\n').join('')); } catch { /* detail is a copy */ }
      }
      const titleEl = w.els.find((e) => e.title);
      contract[r.pattern ?? r.path] = { title: titleEl ? `${titleEl.size}/${titleEl.weight}` : null, offenders: [...new Set(offenders.filter((o) => o.region !== 'primary' && !volatile(o)).map(keyOf))].sort() };
      if (first && !ONLY) contract[`${tenant} · primary rail`] = { title: null, offenders: [...new Set(offenders.filter((o) => o.region === 'primary' && !volatile(o)).map(keyOf))].sort() };
      // The primary rail is walked once per tenant and keyed to the tenant.
      const groups = new Map<string, Offender[]>();
      for (const o of offenders) {
        const key = o.region === 'primary' ? `${tenant} · primary rail` : (r.pattern ?? r.path);
        groups.set(key, [...(groups.get(key) ?? []), o]);
      }
      if (!groups.has(r.pattern ?? r.path)) groups.set(r.pattern ?? r.path, []);
      for (const [key, list] of groups) {
        const keys = [...new Set(list.filter((o) => !volatile(o)).map(keyOf))].sort();
        observed[key] = [...new Set([...(observed[key] ?? []), ...keys])].sort();
        const allowed = new Set(baseline?.[key] ?? []);
        const fresh = list.filter((o) => !allowed.has(keyOf(o)) && !volatile(o));
        for (const o of fresh) failures.push(`${key} -> ${w.landed} · ${o.rule} · ${o.region} · ${o.path} · ${o.sw} · "${o.text}"`);
        if (baseline) for (const k of allowed) if (!keys.includes(k)) stale.push(`${key}  ${k}`);
        const known = list.length - fresh.length;
        const by = (region: Region) => new Set(list.filter((o) => o.region === region).map(keyOf)).size;
        const split = key.endsWith('primary rail') ? `primary ${by('primary')}` : `content ${by('content')} · rail ${by('rail')} · pane ${by('pane')}`;
        rows.push(`${key.padEnd(52)} ${String(keys.length).padStart(3)}  ${split.padEnd(30)} ${String(fresh.length).padStart(3)} new/${known} known  ${key.endsWith('primary rail') ? '—' : worstOscillation(w)}`);
      }
      first = false;
    }
    for (const o of observedRoutes) {
      await goto(page, o.path);
      await settle(page);
      const w = await walk(page, false);
      const titleEl = w.els.find((e) => e.title);
      contract[o.pattern] = { title: titleEl ? `${titleEl.size}/${titleEl.weight}` : null, offenders: [...new Set(judge(w).filter((x) => !volatile(x)).map(keyOf))].sort() };
    }
    const table = [`== ${tenant}: ${routes.length} routes ==`, `${'route'.padEnd(52)} all  ${'by region (unique offenders)'.padEnd(30)} ratchet          worst oscillation`, ...rows].join('\n');
    console.log(table);
    try { fs.mkdirSync(LOG_DIR, { recursive: true }); fs.appendFileSync(path.join(LOG_DIR, 'type-scale-report.txt'), `${table}\n`); } catch { /* the report is a copy */ }
    if (stale.length) console.log(`${tenant}: ${stale.length} baselined offenders no longer occur (TYPE_SCALE_PRUNE=1 removes them):\n${stale.join('\n')}`);
    console.log(`${tenant}: swept ${routes.length} routes, ${failures.length} new offenders`);
    if (RECORDS) recordPart('type-scale', tenant, Object.fromEntries(Object.entries(contract).filter(([k]) => k === `${tenant} · primary rail` || routes.some((r) => (r.pattern ?? r.path) === k) || observedRoutes.some((o) => o.pattern === k))), startDigest);
    if (failures.length) console.log(failures.join('\n'));
    if (!baseline) return; // writing the adoption baseline below
    expect(failures, failures.join('\n')).toEqual([]);
  });
}

// The reference page and the plane's other states (the coordinator, 2026-10-07: "use /iq/projects as the
// reference"; "include both the granted landing and the no-grant state"). /iq/projects anchors the scale: its
// title is 20/600 and every step of the allowed set occurs in its content column, so the set is the reference
// page's own. The no-grant state is judged like any route (u-hr in orgiq, u-kofi in pipelines hold no Social
// grant); a granted user's default conversation (u-nora opens #auth-migration) is reported, not judged — its
// offenders are the library chat surface's (docs/ui-components-queue.md) and move with the messages.
const STATES = STATE_ROUTES; // the plane's other states live in the route inventory

test('the reference (/iq/projects) and the Communication plane states', async ({ page }) => {
  test.skip(!!ONLY && !'/iq/projects /communication'.includes(ONLY), 'TYPE_SCALE_ONLY');
  test.skip(ONLY_TENANTS.length > 0 && !ONLY_TENANTS.includes('orgiq'), 'TYPE_SCALE_TENANTS');
  test.setTimeout(5 * 60_000);
  await enterAs(page, 'orgiq');
  await page.goto('/iq/projects', { waitUntil: 'domcontentloaded' });
  await settle(page);
  const ref = await walk(page, false);
  const content = ref.els.filter((e) => e.region === 'content' && !e.pill && !e.canvas);
  const hist = new Map<string, number>();
  for (const e of content) hist.set(`${e.size}/${e.weight}`, (hist.get(`${e.size}/${e.weight}`) ?? 0) + 1);
  const title = ref.els.find((e) => e.title);
  const refLine = `reference /iq/projects: title ${title ? `${title.size}/${title.weight}` : 'none'}; content ${[...hist].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}×${n}`).join(' ')}`;
  console.log(refLine);
  expect(title?.size, 'the reference title is 20px').toBe(20);
  expect(title?.weight, 'the reference title is 600').toBe(600);
  for (const step of PAGE_SCALE.filter((x) => x !== 20)) expect(content.some((e) => near(e.size, step)), `the reference uses ${step}px`).toBe(true);

  const rows: string[] = [refLine];
  const failures: string[] = [];
  for (const st of STATES) {
    await page.context().clearCookies();
    await enterAs(page, null, st.user);
    await goto(page, st.path);
    await settle(page);
    await page.waitForTimeout(st.judged ? 0 : 2_500); // the granted landing opens its default conversation
    await settle(page);
    const w = await walk(page, false);
    const list = judge(w);
    const keys = [...new Set(list.map(keyOf))].sort();
    if (st.judged) {
      observed[st.key] = keys;
      const titleEl = w.els.find((e) => e.title);
      contract[st.key] = { title: titleEl ? `${titleEl.size}/${titleEl.weight}` : null, offenders: [...new Set(list.filter((o) => !volatile(o)).map(keyOf))].sort() };
      const allowed = new Set(baseline?.[st.key] ?? []);
      for (const o of list) if (!allowed.has(keyOf(o)) && !volatile(o)) failures.push(`${st.key} -> ${w.landed} · ${o.rule} · ${o.region} · ${o.path} · ${o.sw} · "${o.text}"`);
    }
    const by = (region: Region) => new Set(list.filter((o) => o.region === region).map(keyOf)).size;
    rows.push(`${st.key.padEnd(52)} ${String(keys.length).padStart(3)}  ${`content ${by('content')} · rail ${by('rail')} · pane ${by('pane')}`.padEnd(30)} ${st.judged ? 'judged' : 'report'} → ${w.landed}  ${worstOscillation(w)}`);
    if (!st.judged) for (const o of list.filter((x) => x.region === 'content')) rows.push(`    ${o.rule} · ${o.path} · ${o.sw} · "${o.text}"`);
  }
  const table = ['== reference and plane states ==', ...rows].join('\n');
  console.log(table);
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); fs.appendFileSync(path.join(LOG_DIR, 'type-scale-report.txt'), `${table}\n`); } catch { /* a copy */ }
  if (failures.length) console.log(failures.join('\n'));
  if (RECORDS) recordPart('type-scale', 'states', Object.fromEntries(STATES.filter((st) => st.judged && contract[st.key]).map((st) => [st.key, contract[st.key]])), startDigest);
  if (!baseline) return;
  expect(failures, failures.join('\n')).toEqual([]);
});

test.afterAll(() => {
  // Written once every part of this run is on disk; a filtered or interrupted run records no contract.
  if (RECORDS) finishParts('type-scale', [...TENANTS, 'states']);
  const write = process.env.TYPE_SCALE_WRITE_BASELINE === '1';
  const prune = process.env.TYPE_SCALE_PRUNE === '1';
  if (write && !burndown) {
    const rows: Row[] = Object.entries(observed).flatMap(([route, keys]) => keys.map((item) => ({ group: route, item, count: 1, owner: ownerOf(route), due: DEFAULT_DUE })));
    writeRows(BURNDOWN_FILE, BURNDOWN_HEADER, rows);
    console.log(`type-scale burn-down written: ${BURNDOWN_FILE}`);
  } else if (prune && burndown && !ONLY && ONLY_TENANTS.length === 0) {
    // Only ever removes: a row stays only if its offender still occurs (owner and due date kept).
    // `observed` is this worker's state. After a tenant fails, Playwright runs afterAll in a FRESH
    // worker whose `observed` is empty, and an unguarded prune would delete every row (it did,
    // on 2026-10-08). So prune only when this worker observed every route the burn-down names.
    const groups = [...new Set(burndown.map((r) => r.group))];
    const unobserved = groups.filter((g) => !(g in observed));
    if (unobserved.length) {
      console.log(`type-scale burn-down NOT pruned: ${unobserved.length} of ${groups.length} burn-down routes were not observed by this worker (a failed or filtered run) — rerun green, then prune`);
    } else {
      writeRows(BURNDOWN_FILE, BURNDOWN_HEADER, burndown.filter((r) => observed[r.group]?.includes(r.item)));
      console.log(`type-scale burn-down pruned: ${BURNDOWN_FILE}`);
    }
  }
});

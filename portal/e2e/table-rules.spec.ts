import fs from 'node:fs';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { loginAs } from './realSession';
import { TABLE_ROUTES, TABLE_USERS } from './route-inventory';

// The table rules (docs/layout-cascade.md "Tables") on every list page of the
// four tenants' list surfaces: one line per row at 44px, every row the same
// height, a cell holds one thing (no stacked second line, no bordered text
// button — an IconButton is the only control a cell may carry), numbers and
// dates right-aligned, the 12/600 caps header, the last column inside the
// table's visible box, the stat strip on the line variant at 14/600 and never
// a lone search input on its own row.
//
// Run against the shared dev stack:
//   PARITY_BASE_URL=http://127.0.0.1:5183 npx playwright test e2e/table-rules.spec.ts --timeout 90000
// TABLE_RULES_ONLY=<substring> narrows the routes; TABLE_RULES_SHOTS=<dir>
// saves a screenshot per route; TABLE_RULES_REPORT=<file>
// writes every route's measurements as JSON (the before/after table).
test.use({ ...(process.env.PARITY_BASE_URL ? { baseURL: process.env.PARITY_BASE_URL } : {}) });

// The list pages and each tenant's own manager live in the route inventory.
type Tenant = keyof typeof TABLE_USERS;
const USER = TABLE_USERS;
const LIST_ROUTES = TABLE_ROUTES;

type TableReport = {
  label: string;
  rows: number;
  heights: number[];
  header: string[];
  borderedButtons: string[];
  stacked: string[];
  notRight: string[];
  clipped: string[];
};
type RouteReport = {
  route: string;
  tables: TableReport[];
  statValues: string[];
  oversized: string[];
  loneSearch: string[];
};

/** One JSON line per route, appended as each route is measured. */
function record(m: RouteReport) {
  const out = process.env.TABLE_RULES_REPORT;
  if (out) fs.appendFileSync(out, `${JSON.stringify(m)}\n`);
}

async function open(browser: Browser, tenant: Tenant, url: string): Promise<Page> {
  const baseURL = test.info().project.use.baseURL;
  const context = await browser.newContext({ viewport: { width: 1680, height: 940 }, baseURL });
  await loginAs(context, USER[tenant], baseURL);
  const page = await context.newPage();
  await page.goto(url);
  return page;
}

/** Every visible table in the content column (not a dialog's, not the shell's). */
async function measure(page: Page, route: string): Promise<RouteReport> {
  const main = page.locator('main').first();
  await expect(main).toBeVisible();
  // Bounded: a polling list never goes network-idle.
  await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
  // A list renders a body row, or its own empty row, once its first read lands.
  await expect(main.locator('table tbody tr').first()).toBeVisible({ timeout: 15_000 }).catch(() => undefined);
  return main.evaluate((root, route) => {
    const visible = (n: Element) => {
      const r = n.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(n).visibility !== 'hidden';
    };
    const text = (n: Element) => (n.textContent ?? '').replace(/\s+/g, ' ').trim();
    // A number, money, a percentage, a duration or a date/time: right-aligned.
    const NUMERIC = /^(?:[~≈<>+\-−]?\s?[$€£]?\d[\d,]*(?:\.\d+)?\s?(?:%|ms|s|m|h|d|w|k|K|M|pts?|tok|tokens)?(?:\s?\/\s?[$€£]?\d[\d,]*(?:\.\d+)?)?|\d+\s?(?:s|m|h|d|w|mo|y)\s+ago|just now|\d{1,2}\/\d{1,2}\/\d{2,4}(?:,?\s[\d:]+(?:\s?[AP]M)?)?|\d{4}-\d{2}-\d{2}(?:[ T][\d:.]+Z?)?|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s\d{1,2}(?:,\s\d{4})?(?:,?\s[\d:]+\s?[AP]M)?)$/;
    const tables: TableReport[] = [];
    [...root.querySelectorAll('table')].filter((t) => visible(t) && !t.closest('[role="dialog"]')).forEach((table, ti) => {
      const heads = [...table.querySelectorAll('thead th')] as HTMLElement[];
      const names = heads.map(text);
      const label = table.getAttribute('aria-label') || names.filter(Boolean).slice(0, 3).join('·') || `table ${ti + 1}`;
      const rows = ([...table.querySelectorAll('tbody tr')] as HTMLElement[])
        .filter((r) => visible(r) && r.querySelectorAll('td').length > 1 && !r.querySelector('td[colspan]'));
      const heights = rows.map((r) => Math.round(r.getBoundingClientRect().height));
      const header = [...new Set(heads.filter((h) => text(h)).map((h) => {
        const cs = getComputedStyle(h);
        return `${cs.fontSize}/${cs.fontWeight}/${cs.textTransform}`;
      }))];
      const borderedButtons: string[] = [];
      const stacked: string[] = [];
      const clipped: string[] = [];
      const columnValues: string[][] = heads.map(() => []);
      const columnAlign: string[][] = heads.map(() => []);
      // The visible box: the nearest ancestor that scrolls or clips.
      let box: Element = table;
      for (let p = table.parentElement; p && p !== root; p = p.parentElement) {
        const ox = getComputedStyle(p).overflowX;
        if (ox !== 'visible') { box = p; break; }
      }
      const boxRight = Math.min(box.getBoundingClientRect().right, document.documentElement.clientWidth);
      rows.forEach((r, ri) => {
        const cells = [...r.querySelectorAll(':scope > td')] as HTMLElement[];
        cells.forEach((c, ci) => {
          const where = `${names[ci] || `col ${ci + 1}`} r${ri + 1}`;
          c.querySelectorAll('button').forEach((b) => {
            if (!visible(b)) return;
            const iconOnly = !text(b) || (!!b.getAttribute('aria-label') && !!b.querySelector('svg') && text(b).length <= 2);
            const cs = getComputedStyle(b);
            const bordered = Number.parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none'
              && !/rgba\(0, 0, 0, 0\)|transparent/.test(cs.borderTopColor);
            if (bordered && !iconOnly) borderedButtons.push(`${where}: "${text(b).slice(0, 40)}"`);
          });
          // One line: no two pieces of text (or replaced elements) in the cell
          // sit one above the other. Text is measured by its own range, not
          // its element — a flex span is as wide as the cell.
          const leaves: DOMRect[] = [];
          const tw = document.createTreeWalker(c, NodeFilter.SHOW_TEXT);
          for (let n = tw.nextNode(); n && leaves.length < 60; n = tw.nextNode()) {
            if (!n.textContent!.trim() || !n.parentElement || !visible(n.parentElement)) continue;
            const range = document.createRange(); range.selectNodeContents(n);
            const rr = range.getBoundingClientRect();
            if (rr.width > 0 && rr.height > 0) leaves.push(rr);
          }
          c.querySelectorAll('svg, img, input').forEach((n) => { if (visible(n) && !n.parentElement?.closest('svg')) leaves.push(n.getBoundingClientRect()); });
          const overlap = (a: DOMRect, b: DOMRect) => a.top < b.bottom - 2 && b.top < a.bottom - 2;
          if (leaves.some((a, i) => leaves.some((b, j) => j > i && !overlap(a, b)))) stacked.push(where);
          if (ci < columnValues.length) {
            const v = text(c);
            if (v && v !== '—' && v !== '-') {
              // Right-aligned means the CONTENT ends at the cell's right
              // padding edge — a block/flex child ignores text-align.
              const cs = getComputedStyle(c);
              const edge = c.getBoundingClientRect().right - Number.parseFloat(cs.paddingRight);
              const contentRight = Math.max(...leaves.map((l) => l.right), -Infinity);
              const flush = Number.isFinite(contentRight) && Math.abs(edge - contentRight) <= 2;
              columnValues[ci]!.push(v);
              columnAlign[ci]!.push(['right', 'end'].includes(cs.textAlign) && flush ? 'right' : `${cs.textAlign}${flush ? '' : ' (content not flush right)'}`);
            }
          }
          if (ci === cells.length - 1) {
            const cr = c.getBoundingClientRect();
            const contentRight = Math.max(cr.left, ...[...c.querySelectorAll('*')].filter(visible).map((n) => n.getBoundingClientRect().right));
            if (cr.right > boxRight + 1) clipped.push(`${where}: cell right ${Math.round(cr.right)} > box ${Math.round(boxRight)}`);
            else if (contentRight > cr.right + 1) clipped.push(`${where}: content overflows its cell by ${Math.round(contentRight - cr.right)}px`);
          }
        });
      });
      const notRight: string[] = [];
      columnValues.forEach((vals, ci) => {
        if (vals.length === 0 || !vals.every((v) => NUMERIC.test(v))) return;
        const off = columnAlign[ci]!.filter((a) => a !== 'right' && a !== 'end').length;
        const th = heads[ci];
        const headOff = th && text(th) && !['right', 'end'].includes(getComputedStyle(th).textAlign);
        if (off || headOff) notRight.push(`${names[ci] || `col ${ci + 1}`}${off ? ` (${off} cells)` : ''}${headOff ? ' (header)' : ''}`);
      });
      tables.push({ label, rows: rows.length, heights, header, borderedButtons, stacked, notRight, clipped });
    });

    const statValues: string[] = [];
    root.querySelectorAll('[data-testid="stat-strip-cluster"]').forEach((c) => {
      const v = c.querySelector(':scope > span > span') ?? c.firstElementChild;
      if (!v || !visible(v)) return;
      const cs = getComputedStyle(v);
      statValues.push(`${cs.fontSize}/${cs.fontWeight}`);
    });
    // The card-variant strip has no cluster id: its 17px/700 figures and 10px
    // caps labels are what a list page must not draw.
    const oversized: string[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const seen = new Set<Element>();
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      const n = t.parentElement;
      if (!n || seen.has(n) || !t.textContent!.trim()) continue;
      seen.add(n);
      if (n.closest('h1, [role="dialog"], [contenteditable="true"]') || !visible(n)) continue;
      const cs = getComputedStyle(n);
      const px = Number.parseFloat(cs.fontSize);
      if (px > 20 || (px >= 15 && Number(cs.fontWeight) >= 600)) oversized.push(`${cs.fontSize}/${cs.fontWeight} ${text(n).slice(0, 40)}`);
    }
    // A search field must share the collection row when other controls exist.
    const loneSearch: string[] = [];
    const controls = [...root.querySelectorAll('button, select, [role="combobox"], [role="tablist"], [data-testid="stat-strip-cluster"], input')]
      .filter(visible);
    [...root.querySelectorAll('input[type="text"], input[type="search"], input:not([type])')]
      .filter((i) => visible(i) && !i.closest('table') && !i.closest('[role="dialog"]') && !i.closest('nav'))
      .forEach((input) => {
        // DataTable's simple searchable mode now draws the canonical
        // CollectionToolbar. A list with no other controls needs no fake
        // companion; multiple toolbar rows still fail the geometric check.
        const collection = input.closest('[data-toolbar-variant="collection"]');
        if (collection && root.querySelectorAll('[role="toolbar"]').length === 1) return;
        const r = input.getBoundingClientRect();
        const wrap = input.parentElement!;
        const beside = controls.some((c) => {
          if (c === input || wrap.contains(c)) return false;
          const b = c.getBoundingClientRect();
          return b.top < r.bottom && r.top < b.bottom;
        });
        if (!beside) loneSearch.push((input as HTMLInputElement).placeholder || input.getAttribute('aria-label') || 'input');
      });
    return { route, tables, statValues, oversized, loneSearch };
  }, route);
}

for (const r of LIST_ROUTES) {
  if (process.env.TABLE_RULES_ONLY && !r.path.includes(process.env.TABLE_RULES_ONLY)) continue;
  test(`table rules: ${r.path}`, async ({ browser }) => {
    const page = await open(browser, r.tenant, r.path);
    const m = await measure(page, r.path);
    record(m);
    const shots = process.env.TABLE_RULES_SHOTS;
    if (shots) await page.screenshot({ path: `${shots}/${r.path.replace(/[^\w]+/g, '_')}.png` });
    expect.soft(m.tables.length, 'the list page draws a table').toBeGreaterThan(0);
    for (const t of m.tables) {
      expect.soft(Math.max(0, ...t.heights), `${t.label}: rows are at most 44px (${t.heights.join(',')})`).toBeLessThanOrEqual(44);
      expect.soft(new Set(t.heights).size, `${t.label}: every row the same height (${t.heights.join(',')})`).toBeLessThanOrEqual(1);
      expect.soft(t.header, `${t.label}: one 12/600 caps header`).toEqual(t.header.length ? ['12px/600/uppercase'] : []);
      expect.soft(t.borderedButtons, `${t.label}: no bordered text button in a cell — IconButtons only`).toEqual([]);
      expect.soft(t.stacked, `${t.label}: one line per cell`).toEqual([]);
      expect.soft(t.notRight, `${t.label}: numbers and dates right-aligned`).toEqual([]);
      expect.soft(t.clipped, `${t.label}: the last column inside the table's box`).toEqual([]);
    }
    if (r.stats) expect.soft(m.statValues.length, 'a line stat strip on the page').toBeGreaterThan(0);
    for (const v of m.statValues) expect.soft(v, 'stat values are 14px semibold').toBe('14px/600');
    expect.soft(m.oversized, 'no card stat strip, nothing above the 20px title').toEqual([]);
    expect.soft(m.loneSearch, 'search shares its row with the strip or the filters').toEqual([]);
    await page.context().close();
  });
}

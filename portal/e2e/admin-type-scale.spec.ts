import { expect, test, type Browser, type Page } from '@playwright/test';
import { loginAs } from './realSession';

// The admin pages are on the app's one type scale (companion to
// app-type-scale.spec.ts): 14/600 stat values on a `StatStrip variant="line"
// size="sm"`, 44px table rows built from the library DataTable, nothing above
// the 20px page title, and every row action an IconButton with a name.
//
// Run against the shared dev stack as the seeded admin:
//   PARITY_BASE_URL=http://127.0.0.1:5183 npx playwright test e2e/admin-type-scale.spec.ts
test.use({ ...(process.env.PARITY_BASE_URL ? { baseURL: process.env.PARITY_BASE_URL } : {}) });

const ADMIN = 'u-operator';

async function open(browser: Browser, url: string): Promise<Page> {
  const baseURL = test.info().project.use.baseURL;
  const context = await browser.newContext({ viewport: { width: 1680, height: 940 }, baseURL });
  await loginAs(context, ADMIN, baseURL);
  const page = await context.newPage();
  await page.goto(url);
  return page;
}

type Scale = {
  statValues: string[];
  rowHeights: number[];
  oversized: string[];
  unnamedRowButtons: number;
};

/** Measures the content column's body (the section layout's `[data-page-body]`), not the shell. */
async function measure(page: Page): Promise<Scale> {
  const root = page.locator('[data-testid="build-section"] [data-page-body]').first();
  await expect(root).toBeVisible();
  await page.waitForLoadState('networkidle').catch(() => undefined);
  return root.evaluate((el) => {
    const statValues: string[] = [];
    el.querySelectorAll('[data-testid="stat-strip-cluster"]').forEach((c) => {
      const v = c.querySelector(':scope > span > span') ?? c.firstElementChild;
      if (!v) return;
      const cs = getComputedStyle(v);
      statValues.push(`${cs.fontSize}/${cs.fontWeight}`);
    });
    const rowHeights = [...el.querySelectorAll('tbody tr')]
      .filter((r) => (r as HTMLElement).offsetParent !== null && r.querySelectorAll('td').length > 1)
      .map((r) => Math.round(r.getBoundingClientRect().height));
    const oversized: string[] = [];
    el.querySelectorAll('*').forEach((n) => {
      if (n.tagName === 'H1' || n.closest('h1')) return;
      if (![...n.childNodes].some((c) => c.nodeType === 3 && c.textContent!.trim())) return;
      const cs = getComputedStyle(n);
      const px = Number.parseFloat(cs.fontSize);
      // Above the title, or a heavy 15px+ figure (a card-variant StatStrip's
      // 17px/700 value) — both read a size up from the 14px app body.
      if (px > 20 || (px >= 15 && Number(cs.fontWeight) >= 600)) oversized.push(`${cs.fontSize}/${cs.fontWeight} ${n.textContent!.trim().slice(0, 40)}`);
    });
    const unnamedRowButtons = [...el.querySelectorAll('tbody button')]
      .filter((b) => !(b.getAttribute('aria-label') || b.textContent?.trim())).length;
    return { statValues, rowHeights, oversized, unnamedRowButtons };
  });
}

function expectScale(s: Scale, { stats = true }: { stats?: boolean } = {}) {
  if (stats) expect(s.statValues.length, 'a line stat strip on the page').toBeGreaterThan(0);
  for (const v of s.statValues) expect(v, 'stat values are 14px semibold').toBe('14px/600');
  for (const h of s.rowHeights) expect(h, 'table rows are at most 44px').toBeLessThanOrEqual(44);
  expect(s.oversized, 'nothing above the 20px page title, no 15px+ semibold figures').toEqual([]);
  expect(s.unnamedRowButtons, 'every row button has an accessible name').toBe(0);
}

test('Budgets › Initiatives: one-line 44px rows, line strip, aligned numeric columns', async ({ browser }) => {
  const page = await open(browser, '/admin/budgets');
  const table = page.getByTestId('budgets-initiatives-table');
  await expect(table.locator('tbody tr').first()).toBeVisible();
  const s = await measure(page);
  expectScale(s);
  expect(s.rowHeights.length).toBeGreaterThan(0);
  expect(new Set(s.rowHeights).size, `every row the same height: ${s.rowHeights.join(',')}`).toBe(1);

  const geometry = await table.evaluate((t) => {
    const heads = [...t.querySelectorAll('thead th')] as HTMLElement[];
    const rows = [...t.querySelectorAll('tbody tr')] as HTMLElement[];
    const names = heads.map((h) => h.textContent?.trim() ?? '');
    const numeric = ['Allocated', 'Spent', 'Remaining', 'Runs'].map((n) => names.indexOf(n));
    const misaligned: string[] = [];
    const notRight: string[] = [];
    const header = heads.map((h) => getComputedStyle(h).fontSize + '/' + getComputedStyle(h).fontWeight);
    for (const r of rows) {
      const cells = [...r.querySelectorAll('td')] as HTMLElement[];
      cells.forEach((c, i) => {
        const h = heads[i]!.getBoundingClientRect(), b = c.getBoundingClientRect();
        if (Math.abs(h.left - b.left) > 1 || Math.abs(h.width - b.width) > 1) misaligned.push(`${names[i]}`);
      });
      for (const i of numeric) {
        if (i < 0) { notRight.push('missing column'); continue; }
        if (getComputedStyle(cells[i]!).textAlign !== 'right') notRight.push(names[i]!);
        if (getComputedStyle(heads[i]!).textAlign !== 'right') notRight.push(`${names[i]} header`);
      }
      const wrapped = cells.some((c) => c.getBoundingClientRect().height > 44);
      if (wrapped) misaligned.push('wrapped cell');
    }
    return { names, misaligned, notRight, header: [...new Set(header)] };
  });
  expect(geometry.names.slice(0, 7)).toEqual(['Initiative', 'Allocated', 'Spent', 'Remaining', 'Runs', 'Last activity', 'Updated by']);
  expect(geometry.misaligned, 'header and body cells share column x').toEqual([]);
  expect(geometry.notRight, 'numeric columns right-aligned').toEqual([]);
  expect(geometry.header.length, 'one header style').toBe(1);

  const remove = table.getByRole('button', { name: /^Remove allocation for / });
  if (await remove.count()) await expect(remove.first()).toHaveAccessibleName(/Remove allocation for .+/);
  // The section rail: one line per item, the count on the same line.
  const rail = page.getByRole('navigation', { name: 'Budgets navigation' });
  for (const name of ['Initiatives', 'Sprints']) {
    const item = rail.getByRole('link', { name: new RegExp(`^${name}`) });
    const h = await item.evaluate((n) => n.getBoundingClientRect().height);
    expect(h, `${name} rail item is one line`).toBeLessThanOrEqual(36);
  }
  await page.context().close();
});

test('Budgets › Sprints: same scale', async ({ browser }) => {
  const page = await open(browser, '/admin/budgets?report=sprints');
  await expect(page.getByTestId('budgets-sprints-table').locator('tbody tr').first()).toBeVisible();
  expectScale(await measure(page));
  await page.context().close();
});

for (const [name, url, stats] of [
  ['Identity › Users', '/admin/identity/users', true],
  ['Knowledge', '/admin/knowledge', true],
  ['Observability › Cost', '/admin/observability/cost', true],
  ['Observability › Traffic', '/admin/observability/traffic', true],
] as const) {
  test(`${name}: admin type scale`, async ({ browser }) => {
    const page = await open(browser, url);
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    expectScale(await measure(page), { stats });
    await page.context().close();
  });
}

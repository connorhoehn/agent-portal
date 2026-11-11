// A budget notification's selected row must be in the visible scroll region,
// including the table's card form. Uses only the mock's existing allocations.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(path.join(root, 'portal/package.json'));
const playwright = await import(pathToFileURL(require.resolve('playwright')).href);
const chromium = playwright.chromium ?? playwright.default.chromium;
const portal = process.env.PORTAL_URL;
assert.ok(portal, 'run through run-demo-moments.mjs --journey budgets-selection');
const outAt = process.argv.indexOf('--out');
const out = process.argv[outAt + 1];
assert.ok(outAt >= 0 && out, '--out is required');
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const results = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  assert.equal((await context.request.post(`${portal}/api/session/login`, { data: { userId: 'u-vera' } })).status(), 200);
  assert.equal((await context.request.post(`${portal}/api/session/role`, { data: { tenant: 'orgiq', role: 'org-leader' } })).status(), 200);
  const page = await context.newPage();
  const table = page.getByTestId('budgets-initiatives-table');
  await page.goto(`${portal}/admin/budgets`, { waitUntil: 'domcontentloaded' });
  await table.locator('[data-allocation-trigger]').last().waitFor();
  const key = await table.locator('[data-allocation-trigger]').last().getAttribute('data-allocation-trigger');
  assert.ok(key);

  const measure = () => table.locator('tr[data-selected]').evaluate((row) => {
    const box = row.getBoundingClientRect();
    let top = 0, bottom = innerHeight;
    for (let p = row.parentElement; p; p = p.parentElement) {
      if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(p).overflowY)) {
        const rect = p.getBoundingClientRect();
        top = Math.max(top, rect.top + p.clientTop);
        bottom = Math.min(bottom, rect.top + p.clientTop + p.clientHeight);
      }
    }
    const visible = Math.max(0, Math.min(box.bottom, bottom) - Math.max(box.top, top));
    return { top: box.top, bottom: box.bottom, height: box.height, clipTop: top, clipBottom: bottom,
      visible, required: Math.min(box.height, bottom - top), card: getComputedStyle(row).display === 'block',
      reveal: !!row.closest('[data-reveal-selection]') };
  });

  for (const { width, reload } of [
    ...[1440, 1280].map((width) => ({ width, reload: true })),
    ...[1440, 1280].map((width) => ({ width, reload: false })),
  ]) {
    await page.setViewportSize({ width, height: 900 });
    if (reload) await page.goto(`${portal}/admin/budgets?row=${encodeURIComponent(key)}`, { waitUntil: 'domcontentloaded' });
    await table.locator('tr[data-selected]').waitFor();
    const end = Date.now() + 5000;
    let geometry;
    do {
      await page.waitForTimeout(100);
      geometry = await measure();
    } while (geometry.visible < geometry.required - 1 && Date.now() < end);
    const ok = geometry.visible >= geometry.required - 1 && geometry.reveal;
    const state = reload ? 'load' : 'resize';
    results.push({ width, state, key, ok, geometry });
    console.log(`${ok ? 'PASS' : 'FAIL'} budget selection @${width} ${state}: ${JSON.stringify(geometry)}`);
    await page.screenshot({ path: path.join(out, `budget-selection-${width}-${state}.png`) });
  }
} finally {
  await browser.close();
  fs.writeFileSync(path.join(out, 'budget-selection.json'), JSON.stringify(results, null, 2));
}
process.exitCode = results.every((r) => r.ok) ? 0 : 1;

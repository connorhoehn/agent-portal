// Shared helpers for the interviews walk (scripts/journeys/interviews.mjs and its pieces in this folder).
// createContext() launches the browser and returns what every piece receives.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(path.join(root, 'portal/package.json'));
const playwright = await import(pathToFileURL(require.resolve('playwright')).href);
const chromium = playwright.chromium ?? playwright.default.chromium;

export async function createContext() {
  const portal = process.env.PORTAL_URL;
  assert.ok(portal, 'run through run-demo-moments.mjs --journey interviews');
  const middleware = process.env.MIDDLEWARE_URL;
  const outAt = process.argv.indexOf('--out');
  const out = process.argv[outAt + 1];
  assert.ok(outAt >= 0 && out, '--out is required');
  fs.mkdirSync(out, { recursive: true });

  const results = [];
  function record(step, ok, detail) {
    results.push({ step, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'} ${step}: ${detail}`);
  }

  const browser = await chromium.launch();

/** A fresh browser context signed in as `userId` (the picker login the mock offers). */
async function signIn(userId, width = 1440) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const res = await context.request.post(`${portal}/api/session/login`, { data: { userId } });
  assert.equal(res.status(), 200, `sign in as ${userId}: ${res.status()}`);
  return context;
}

/** The names in a table's candidate cells, once the rows have loaded. */
async function namesIn(page, tableId, cellId, expectOne) {
  const table = page.getByTestId(tableId);
  await table.getByText(expectOne, { exact: true }).first().waitFor({ timeout: 30_000 });
  // A person cell is the avatar (initials until a portrait lands) above the name: keep the name.
  return (await table.getByTestId(cellId).allInnerTexts()).map((s) => s.trim().split('\n').pop().trim());
}

/** The geometry a dense home must keep: a table row above the fold and no sideways scroll. */
async function geometry(page, tableId) {
  return page.evaluate((id) => {
    const table = document.querySelector(`[data-testid="${id}"]`);
    const row = table?.querySelector('tbody tr');
    return {
      firstRowTop: row ? Math.round(row.getBoundingClientRect().top) : null,
      viewport: innerHeight,
      horizontalScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    };
  }, tableId);
}

async function shoot(page, name, tableId) {
  const shots = [];
  for (const width of [1440, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(300);
    const g = await geometry(page, tableId);
    const file = path.join(out, `interviews-${name}-${width}.png`);
    await page.screenshot({ path: file });
    shots.push({ width, ...g, ok: g.firstRowTop !== null && g.firstRowTop < g.viewport && !g.horizontalScroll });
  }
  return shots;
}


  /**
   * Put the mock world back to its seeds (POST /api/__mock/reset on the walk's own middleware, the route the
   * other journeys use). A piece that writes calls this first so it starts from the seeds whatever ran before.
   */
  async function resetMock() {
    assert.ok(middleware, 'MIDDLEWARE_URL is not set');
    const r = await fetch(`${middleware}/api/__mock/reset`, { method: 'POST' });
    assert.equal(r.status, 200, `POST /api/__mock/reset answered ${r.status}`);
  }

  // Each piece may leave screenshots' geometry here for a later piece to judge (the homes the first piece shot).
  const homes = [];
  return { assert, fs, path, portal, middleware, out, browser, results, record, signIn, namesIn, geometry, shoot, resetMock, homes };
}

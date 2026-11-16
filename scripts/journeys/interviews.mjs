// journey:interviews — the interviews tenant's walk (docs/interviews-tenant-plan.md, ledger: it starts with
// I1.1 and gains a step with each row that names one). Headless, on the mock world, through
// run-demo-moments.mjs (its own middleware and portal):
//
//   cd portal && JOURNEY_MIDDLEWARE_PORT=<mw> JOURNEY_PORTAL_PORT=<portal> npm run journey:interviews [-- --out <dir>]
//
// Steps (one PASS or FAIL line each, named by the ledger row they judge):
//   I0.5a  the recruiter signs in and lands on Candidates: all twelve applications, every opening
//   I0.5b  an interviewer lands on My interviews: their own desk, none of the other interviewer's alone
//   I0.5c  the second interviewer's desk shows the scorecard that is due, and none of the first's alone
//   I0.5d  an interviewer cannot open another interviewer's interview by its address, and opens their own
//   I0.5e  an interviewer at the recruiter's front door goes on to their own desk; a hiring manager's page refuses them
//   I0.5f  the hiring manager lands on My openings: the candidates on her two openings, none of the third's
//   I0.5g  a Work-only persona at an interviews address gets the other-workspace page, the address kept
//   I1.1   the three homes at 1440 and 1280 px: a table above the fold, no horizontal scroll
// Screenshots of each home at both widths go to --out.
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
assert.ok(portal, 'run through run-demo-moments.mjs --journey interviews');
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

const homes = [];
try {
  // ── I0.5a: the recruiter ────────────────────────────────────────────────
  {
    const context = await signIn('u-greta');
    const page = await context.newPage();
    await page.goto(`${portal}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForURL(/\/interviews\/candidates$/, { timeout: 30_000 });
    const names = await namesIn(page, 'interviews-candidates-table', 'interviews-candidate-name', 'Mateo Álvarez');
    const want = ['Mateo Álvarez', 'Ingrid Solberg', 'Aiko Tanaka', 'Ravi Menon', 'Nadia Petrova', 'Jonah Whitaker', 'Chloé Martin', 'Elif Demir'];
    const text = await page.getByTestId('interviews-candidates-table').innerText();
    const ok = names.length === 12 && want.every((n) => names.includes(n)) && /System design · Tomorrow \d\d:\d\d/.test(text) && /Yes · Coding/.test(text)
      && !/\b(cand|app|iv|op|sc)-[a-z]/.test(text);
    record('I0.5a', ok, `recruiter lands on ${new URL(page.url()).pathname}; ${names.length} candidate rows; next interview and last result shown; no ids in the table`);
    homes.push({ name: 'recruiter-candidates', shots: await shoot(page, 'recruiter-candidates', 'interviews-candidates-table') });
    await context.close();
  }

  // ── I0.5b, I0.5d, I0.5e: Hugo, an interviewer ───────────────────────────
  {
    const context = await signIn('u-hugo');
    const page = await context.newPage();
    await page.goto(`${portal}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForURL(/\/interviews\/my-interviews$/, { timeout: 30_000 });
    const names = await namesIn(page, 'interviews-my-interviews-table', 'interviews-desk-candidate', 'Kwame Asante');
    const states = (await page.getByTestId('interviews-my-interviews-table').getByTestId('interviews-desk-state').allInnerTexts()).map((s) => s.trim());
    const others = ['Aiko Tanaka', 'Ravi Menon', 'Jonah Whitaker'];
    const ok = names.length === 4 && ['Kwame Asante', 'Mateo Álvarez', 'Nadia Petrova'].every((n) => names.includes(n)) && others.every((n) => !names.includes(n))
      && states[0] === 'Accept or decline';
    record('I0.5b', ok, `interviewer lands on ${new URL(page.url()).pathname}; desk rows ${JSON.stringify(names)}; first waits for "${states[0]}"; none of ${others.join(', ')}`);
    homes.push({ name: 'interviewer-my-interviews', shots: await shoot(page, 'interviewer-my-interviews', 'interviews-my-interviews-table') });

    const theirs = await context.request.get(`${portal}/api/interviews/interviews/iv-aiko-coding`);
    const mine = await context.request.get(`${portal}/api/interviews/interviews/iv-mateo-design`);
    const theirCandidate = await context.request.get(`${portal}/api/interviews/candidates/cand-aiko`);
    record('I0.5d', theirs.status() === 404 && theirCandidate.status() === 404 && mine.status() === 200,
      `another interviewer's interview by address: ${theirs.status()}, its candidate: ${theirCandidate.status()}; their own: ${mine.status()}`);

    await page.goto(`${portal}/interviews/candidates`, { waitUntil: 'domcontentloaded' });
    await page.waitForURL(/\/interviews\/my-interviews$/, { timeout: 15_000 }).catch(() => {});
    const frontDoor = new URL(page.url()).pathname;
    await page.goto(`${portal}/interviews/my-openings`, { waitUntil: 'domcontentloaded' });
    const refused = await page.getByTestId('no-access').first().waitFor({ timeout: 15_000 }).then(() => true, () => false);
    record('I0.5e', frontDoor === '/interviews/my-interviews' && refused && new URL(page.url()).pathname === '/interviews/my-openings',
      `the front door sends the interviewer to ${frontDoor}; the hiring manager's page shows the no-access page with its address kept`);
    await context.close();
  }

  // ── I0.5c: Wen, the second interviewer ──────────────────────────────────
  {
    const context = await signIn('u-wen');
    const page = await context.newPage();
    await page.goto(`${portal}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForURL(/\/interviews\/my-interviews$/, { timeout: 30_000 });
    const names = await namesIn(page, 'interviews-my-interviews-table', 'interviews-desk-candidate', 'Jonah Whitaker');
    const text = await page.getByTestId('interviews-my-interviews-table').innerText();
    const ok = names.includes('Jonah Whitaker') && /Scorecard due/.test(text) && !names.includes('Kwame Asante') && !names.includes('Mateo Álvarez');
    record('I0.5c', ok, `second interviewer's desk ${JSON.stringify(names)}; a scorecard due; none of Hugo's alone`);
    await context.close();
  }

  // ── I0.5f: Amara, the hiring manager ────────────────────────────────────
  {
    const context = await signIn('u-amara');
    const page = await context.newPage();
    await page.goto(`${portal}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForURL(/\/interviews\/my-openings$/, { timeout: 30_000 });
    const names = await namesIn(page, 'interviews-my-openings-table', 'interviews-pipeline-candidate', 'Ingrid Solberg');
    const body = await page.getByTestId('interviews-my-openings').innerText();
    const iosCandidates = ['Aiko Tanaka', 'Ravi Menon', 'Chloé Martin', 'Samuel Adeyemi'];
    const openings = await (await context.request.get(`${portal}/api/interviews/openings`)).json();
    const titles = (openings.items ?? []).map((o) => o.title).sort();
    const ios = await context.request.get(`${portal}/api/interviews/openings/op-ios`);
    const ok = names.length === 8 && iosCandidates.every((n) => !names.includes(n)) && !/iOS Engineer/.test(body) && names[0] === 'Ingrid Solberg'
      && /8 candidates on 2 openings/.test(body) && /Scorecard due/.test(body)
      && JSON.stringify(titles) === JSON.stringify(['Engineering Manager', 'Senior Backend Engineer']) && ios.status() === 404;
    record('I0.5f', ok, `hiring manager lands on ${new URL(page.url()).pathname}; ${names.length} candidates on her openings ${JSON.stringify(titles)}, debrief first (${names[0]}), a scorecard due shown; the iOS opening by address: ${ios.status()}`);
    homes.push({ name: 'hiring-manager-my-openings', shots: await shoot(page, 'hiring-manager-my-openings', 'interviews-my-openings-table') });
    await context.close();
  }

  // ── I0.5g: a Work-only persona ───────────────────────────────────────────
  {
    const context = await signIn('u-theo');
    const page = await context.newPage();
    await page.goto(`${portal}/interviews/candidates`, { waitUntil: 'domcontentloaded' });
    const shown = await page.getByTestId('other-workspace').first().waitFor({ timeout: 30_000 }).then(() => true, () => false);
    const api = await context.request.get(`${portal}/api/interviews/candidates`);
    record('I0.5g', shown && new URL(page.url()).pathname === '/interviews/candidates' && api.status() === 403,
      `Work-only persona: other-workspace page ${shown ? 'shown' : 'missing'} at ${new URL(page.url()).pathname}; the API answers ${api.status()}`);
    await context.close();
  }

  // ── I1.1: density at both widths ─────────────────────────────────────────
  const shots = homes.flatMap((h) => h.shots.map((s) => ({ home: h.name, ...s })));
  record('I1.1', shots.length === 6 && shots.every((s) => s.ok),
    shots.map((s) => `${s.home}@${s.width}: first row at ${s.firstRowTop}px${s.horizontalScroll ? ', scrolls sideways' : ''}`).join('; '));
} catch (err) {
  record('journey', false, `stopped: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  await browser.close();
  fs.writeFileSync(path.join(out, 'interviews.json'), JSON.stringify(results, null, 2));
}
const passed = results.filter((r) => r.ok).length;
console.log(`journey:interviews ${passed} passed; ${results.length - passed} failed (screenshots in ${out})`);
process.exitCode = results.length > 0 && results.every((r) => r.ok) ? 0 : 1;

#!/usr/bin/env node
// Executable journey maps (docs/journeys.md "Journey maps"): walk each map
// headlessly, measure every step with the ui-dom-audit, write the family's
// journey log in its PROTOCOL's format with an honest verdict, and seal a
// walked log through scripts/journeys/seal.sh only when that map passed.
//
//   node scripts/journeys/run-maps.mjs check [--family access]            # validate maps, no browser
//   node scripts/journeys/run-maps.mjs walk  [--family access] [--only requester/] [--no-seal] [--wait 30]
//   node scripts/journeys/run-maps.mjs write [--family access] [--only …]  # recompose logs from the last walk's results
//   node scripts/journeys/run-maps.mjs coverage [--check]                  # docs/journeys/coverage.md
//
// Needs the dev stack (JOURNEY_BASE_URL or Vite :5183, middleware :3001) for `walk`. Identity
// rules: a run refuses (or waits, --wait <minutes>) while a ui-dom-audit run
// (`pgrep -f audit.mjs`) holds the browser, unless lane M's identity clones are
// available (portal/e2e/realSession.ts `openAsClone`); two runs never walk as
// one identity (a lock per persona under $TMPDIR). A map that writes runs only
// under a mock scope (realSession `withMockScope`); until those land it is
// skipped and its log is left as it is.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ROOT, mapFiles, loadMaps, composeLog, familyDir, coverageModel, coverageMarkdown, rel } from './maps.mjs';
import { resolveUiAuditSkill } from '../lib/ui-audit-skill.cjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORTAL = path.join(ROOT, 'portal');
const SKILL = resolveUiAuditSkill({ root: ROOT });
const BASE = process.env.JOURNEY_BASE_URL ?? process.env.UI_AUDIT_BASE_URL ?? 'http://127.0.0.1:5183';

function args(argv) {
  const o = { cmd: argv[0] };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-seal') o.noSeal = true;
    else if (a === '--check') o.check = true;
    else if (a === '--allow-persona') o.allowPersona = true;
    else if (a === '--role') o.role = argv[++i];
    else if (!a.startsWith('--') && !o.family) o.family = a; // `check runbooks`, `walk runbooks --role author`
    else if (['--family', '--only', '--out', '--wait', '--video'].includes(a)) o[a.slice(2)] = argv[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  o.out = path.resolve(ROOT, o.out ?? '.scratch/journeys');
  // --video <dir>: record each walk as a watchable video, slowed down; writes no logs and seals nothing.
  if (o.video) { o.video = path.resolve(ROOT, o.video); o.noSeal = true; }
  return o;
}

async function selected(o) {
  const { maps, problems } = await loadMaps(mapFiles(o.family));
  let only = o.only ? maps.filter(({ map, file }) => `${map.family}/${map.log}`.includes(o.only) || file.includes(o.only)) : maps;
  // --role author|reviewer|consumer|box: the maps whose log lives in that role's directory.
  if (o.role) only = only.filter(({ map }) => map.log.startsWith(`${o.role}/`));
  return { maps: only, problems };
}

/** realSession's lane-M exports, when they exist (read from source: importing it needs the Playwright runner). */
function laneM() {
  const src = fs.readFileSync(path.join(PORTAL, 'e2e/realSession.ts'), 'utf8');
  return { clones: /export (async )?function openAsClone\b/.test(src), scopes: /export (async )?function withMockScope\b/.test(src) };
}

const auditRunning = () => { try { return execFileSync('pgrep', ['-f', 'audit\.mjs'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).filter((p) => Number(p) !== process.pid); } catch { return []; } };

/** Maps that sign in as the seed persona itself (no clones yet, or the map needs the persona's own records). */
const needsPersona = (m, map) => map.identity !== 'demo' && (!m.clones || map.identity === 'persona' || Object.values(map.peers ?? {}).some((p) => p.identity === 'persona'));
/** The seed users a map signs in as itself (its persona, and any persona peers). */
const personaUsers = (m, map) => [...(!m.clones || map.identity === 'persona' ? [map.persona.user] : []), ...Object.values(map.peers ?? {}).filter((p) => p.identity === 'persona').map((p) => p.user)];

async function waitForBrowserIdentity(o) {
  const deadline = Date.now() + Number(o.wait ?? 0) * 60_000;
  for (;;) {
    const pids = auditRunning();
    if (!pids.length) return true;
    if (Date.now() >= deadline) { console.error(`deferring the maps that walk as a seed persona: a ui-dom-audit run holds the seed identities (pids ${pids.join(', ')}) — rerun with --wait <minutes>`); return false; }
    console.error(`waiting: ui-dom-audit running (pids ${pids.join(', ')}) …`);
    await new Promise((r) => setTimeout(r, 30_000));
  }
}

/** One lock per persona: never two of these runs as one identity. */
function lockIdentities(users) {
  const held = [];
  for (const u of users) {
    const f = path.join(os.tmpdir(), `run-maps-${u}.lock`);
    try { fs.writeFileSync(f, String(process.pid), { flag: 'wx' }); held.push(f); continue; } catch { /* exists */ }
    const pid = Number(fs.readFileSync(f, 'utf8'));
    let alive = false; try { process.kill(pid, 0); alive = true; } catch { /* stale */ }
    if (alive) { held.forEach((h) => fs.rmSync(h, { force: true })); throw new Error(`identity ${u} is in use by run-maps pid ${pid}`); }
    fs.writeFileSync(f, String(process.pid)); held.push(f);
  }
  return () => held.forEach((h) => fs.rmSync(h, { force: true }));
}

const outDirOf = (o, map) => path.join(o.out, map.family, map.log);

async function writeSpec(dir, o, maps, m) {
  const req = createRequire(path.join(PORTAL, 'package.json'));
  const testModule = req.resolve('@playwright/test');
  const { loadEnv } = await import(pathToFileURL(req.resolve('vite')).href);
  const gatewayFallback = loadEnv('development', PORTAL).VITE_GATEWAY_URL;
  const imp = (p) => JSON.stringify(pathToFileURL(p).href);
  const entries = maps.map(({ file, map }) => ({ file: path.join(ROOT, file), rel: file, out: outDirOf(o, map), title: `${map.family}/${map.log}` }));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  fs.writeFileSync(path.join(dir, 'journeys.spec.ts'), `import playwright from ${JSON.stringify(testModule)};
import fs from 'node:fs';
import path from 'node:path';
import * as rs from ${JSON.stringify(path.join(PORTAL, 'e2e/realSession.ts'))};
import adapter from ${JSON.stringify(path.join(PORTAL, 'e2e/ui-dom-audit.adapter.ts'))};
import { fakeMeetingMedia } from ${JSON.stringify(path.join(PORTAL, 'e2e/meetingMedia.ts'))};
import * as inv from ${JSON.stringify(path.join(PORTAL, 'e2e/route-inventory.ts'))};
import { probes } from ${imp(path.join(SKILL, 'scripts/probes.mjs'))};
import { measureCase, validateContract } from ${imp(path.join(SKILL, 'scripts/run.mjs'))};
import { walkMap } from ${imp(path.join(HERE, 'walk.mjs'))};
import { gatewayRefusal as probeGatewayRefusal } from ${imp(path.join(HERE, 'gateway-refusal.mjs'))};
import { sendCloneDm as probeCloneDm } from ${imp(path.join(HERE, 'clone-dm.mjs'))};
const sendCloneDm = (page, channel, sender, message) => probeCloneDm(page, channel, sender, message, ${JSON.stringify(gatewayFallback ?? null)});
const gatewayRefusal = (page, channel) => probeGatewayRefusal(page, channel, 8000, ${JSON.stringify(gatewayFallback ?? null)});
const { test } = playwright;
const ENTRIES = ${JSON.stringify(entries)};
const LANE_M = ${JSON.stringify(m)};
const contractFile = adapter.contract ?? ${JSON.stringify(path.join(SKILL, 'references/work-ui.contract.json'))};
const contract = JSON.parse(fs.readFileSync(contractFile, 'utf8')); validateContract(contract);
const contractName = contract.name + ' ' + (await import('node:crypto')).createHash('sha256').update(JSON.stringify(contract)).digest('hex').slice(0, 16);
const routes = [...inv.staticInventory(), ...inv.paramInventory()];
const routeFor = (p) => { const key = inv.routeKey(p); return key ? routes.find((r) => (r.pattern ?? r.path) === key || r.path === key) : undefined; };
const SHELL = ['$header', '$footer', '$shellColumns'];
// docs/journeys/audit-burndown.tsv: route-key, rule, owner, reason — findings recorded in the log but not failing the walk.
const BURNDOWN = new Set((() => { try { return fs.readFileSync(${JSON.stringify(path.join(ROOT, 'docs/journeys/audit-burndown.tsv'))}, 'utf8').split('\\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split('\\t').slice(0, 2).join('\\t')); } catch { return []; } })());
// Use the shared two-frame measurement, including precise evidence of any movement.
async function measure(page, step) {
  const u = new URL(page.url()); const p = u.pathname + u.search;
  // The contract is the app frame of inventoried routes; /select and /workspaces sit outside it.
  if (!inv.routeKey(p)) return { skipped: 'outside the route inventory (no app frame for the audit contract to judge)' };
  const r = routeFor(p);
  const shell = (await page.locator(adapter.selectors.header).count()) > 0;
  const spec = r ? { ...r, path: p } : { tenant: inv.tenantOf(u.pathname), path: p, kind: 'page', source: 'static' };
  const composerExpectation = shell ? await adapter.composerExpectation?.(page, spec) : undefined;
  const required = [...(shell ? SHELL : []), ...(step.required ?? [])];
  const measured = await measureCase(page, { contract, selectors: adapter.selectors, required, composerExpectation });
  const issues = [...measured.issues];
  const key = inv.routeKey(p) ?? u.pathname;
  const owed = issues.filter((i) => BURNDOWN.has(key + '\\t' + i.rule));
  const gating = issues.filter((i) => !owed.includes(i));
  const count = (list) => { const o = {}; for (const i of list) o[i.rule] = (o[i.rule] ?? 0) + 1; return o; };
  const brief = (i) => ({ rule: i.rule, selector: i.selector, property: i.property, expected: i.expected, actual: i.actual, ...(i.moved ? { moved: i.moved } : {}) });
  return { routeKey: key, findings: gating.length, rules: count(gating), recorded: owed.length, recordedRules: count(owed), issues: gating.slice(0, 12).map(brief), recordedIssues: owed.slice(0, 6).map(brief), unclassified: measured.coverage.filter((c) => c.status === 'unclassified').length };
}
const VIDEO = (map, size) => (${JSON.stringify(o.video ?? null)} ? { recordVideo: { dir: path.join(${JSON.stringify(o.video ?? '')}, map.family, map.log), size } } : {});
async function open(browser, map, { viewport }) {
  const persona = map.persona;
  const opts = { ...(persona.switchTenant ? { tenant: persona.tenant } : { expectTenant: persona.tenant }), ...(persona.switchRole ? { role: persona.role } : { expectRole: persona.role }) };
  const scope = typeof map.scenario === 'object' ? map.scenario.scope : null;
  if (map.identity === 'demo') {
    // The cookie-less demo identity: no sign-in, no switch (a switch would bump demo-user's shared epoch); /me says where it landed.
    const context = await browser.newContext({ baseURL: ${JSON.stringify(BASE)}, viewport, reducedMotion: 'reduce', ...VIDEO(map, viewport) });
    try {
      const me = await context.request.get('/api/session/me');
      const principal = await me.json();
      if (principal.sub !== 'demo-user') throw new Error('the cookie-less identity is ' + principal.sub + ', not demo-user');
      return { context, principal, close: () => context.close() };
    } catch (e) { await context.close(); throw e; }
  }
  if (LANE_M.clones && (map.identity ?? 'clone') === 'clone') {
    // Lane M: a clone of the persona (same grants and person link, its own id and epoch), in the map's scope when it has one.
    const person = await rs.openAsClone(browser, persona.user, { ...opts, viewport, baseURL: ${JSON.stringify(BASE)}, landing: null, label: 'run-maps ' + map.family + '/' + map.log, contextOptions: { reducedMotion: 'reduce', ...VIDEO(map, viewport) }, ...(scope ? { scope } : {}), ...(map.media === 'meeting-fixture' ? { preJoin: 'remembered', prepare: context => fakeMeetingMedia(context, persona.user) } : {}) });
    return { context: person.context, principal: person.principal, clone: person.cloneId, close: async () => {
      try {
        if (map.media === 'meeting-fixture') for (const page of person.context.pages()) {
          const leave = page.getByTestId(/^(shell-)?call-dock-leave$/).first();
          if (await leave.isVisible()) await leave.click();
        }
      } finally { await person.close(); }
    } };
  }
  const context = await browser.newContext({ baseURL: ${JSON.stringify(BASE)}, viewport, reducedMotion: 'reduce', ...VIDEO(map, viewport) });
  let handle = null;
  try {
    if (scope) handle = await rs.withMockScope(context, scope);
    const principal = await rs.signIn(context, persona.user, opts);
    return { context, principal, close: async () => { await handle?.dispose(); await context.close(); } };
  } catch (e) { await handle?.dispose(); await context.close(); throw e; }
}
test.describe.configure({ mode: 'serial' });
for (const e of ENTRIES) test(e.title, async ({ browser }) => {
  const map = (await import(e.file)).default;
  // 10 minutes, or 20 s a step for a map with many (the work family's refusals maps walk ~70 refused deep links).
  test.setTimeout(Math.max(10 * 60_000, map.steps.length * 20_000));
  const ctx = { baseURL: ${JSON.stringify(BASE)}, outDir: e.out, gatewayRefusal, sendCloneDm, fixtureOrigins: map.media === 'meeting-fixture' ? ['http://meeting-media.test'] : [], open, measure, focusWalk: probes.focusWalk, scoped: (LANE_M.scopes && !!map.scenario?.scope) || (LANE_M.clones && ['meeting', 'clone-dm'].includes(map.scenario?.realtime)), setScope: LANE_M.scopes ? (context, scope) => rs.withMockScope(context, scope) : undefined };
  let result = await walkMap(browser, map, ctx);
  // A BFF reload (Tilt restarts it on any middleware edit) drops in-memory clones and scopes: re-mint and walk once more.
  if (result.authLost || /^setup failed/.test(result.error ?? '')) {
    const lost = result.authLost ?? result.error;
    // Wait (bounded, 2 min) for the BFF to answer again before re-minting.
    for (let i = 0; i < 24; i++) { const ok = await fetch(${JSON.stringify(BASE)} + '/api/health').then((r) => r.ok, () => false); if (ok) break; await new Promise((r) => setTimeout(r, 5000)); }
    await new Promise((r) => setTimeout(r, 3000));
    result = await walkMap(browser, map, ctx);
    result.retried = 'the first attempt lost its clone, scope or BFF (' + lost + '), probably a BFF reload; this is the second walk';
  }
  result.mapFile = e.rel; result.contract = contractName; result.outDir = path.relative(${JSON.stringify(ROOT)}, e.out);
  // RegExps do not survive JSON: keep the map's strings for the log, drop expectations.
  result.map = { family: map.family, log: map.log, kind: map.kind, persona: map.persona, goal: map.goal, scenario: map.scenario, writes: !!map.writes, identity: map.identity, identityReason: map.identityReason, fields: map.fields, claims: map.claims };
  fs.writeFileSync(path.join(e.out, 'result.json'), JSON.stringify(result, null, 1));
});
`);
  fs.writeFileSync(path.join(dir, 'playwright.config.cjs'), `module.exports = { testDir: ${JSON.stringify(dir)}, testMatch: 'journeys.spec.ts', timeout: 600000, workers: 1, retries: 0, reporter: 'line', outputDir: ${JSON.stringify(path.join(o.out, 'playwright'))}, use: { browserName: 'chromium', headless: true${o.video ? ", launchOptions: { slowMo: 350 }" : ''} } };\n`);
  return path.join(path.dirname(testModule), 'cli.js');
}

function stackLine() {
  try { const v = JSON.parse(fs.readFileSync(path.join(PORTAL, 'node_modules/@connorhoehn/ui-components/package.json'), 'utf8')).version; return `middleware dev:mock :3001, Vite ${BASE}, ui-components ${v}`; } catch { return `middleware dev:mock :3001, Vite ${BASE}`; }
}

/** Compose and write each walked map's log (and its screenshot) into the family directory. */
function writeLogs(o, maps) {
  const written = []; const skipped = [];
  for (const { map } of maps) {
    const dir = outDirOf(o, map);
    const f = path.join(dir, 'result.json');
    if (!fs.existsSync(f)) { skipped.push(`${map.family}/${map.log}: no result (not walked)`); continue; }
    const result = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (result.skipped) { skipped.push(`${map.family}/${map.log}: skipped — ${result.error}`); continue; }
    if (result.error && !result.steps?.length) { skipped.push(`${map.family}/${map.log}: no walk happened (${result.error}) — the log is left as it was`); continue; }
    result.scenario = result.map.scenario?.realtime === 'clone-dm' ? 'scenario: local gateway, two fresh Social clones, clone-only DM delivery and receipts; other HTTP business writes blocked; clone deletion removes DM and memory inbox state' : result.map.scenario?.realtime === 'meeting' ? 'scenario: shared meeting gateway, clone identities, signalling media fixture; HTTP business writes blocked' : result.map.scenario === 'shared' ? 'scenario: the shared mock, read-only (every non-GET the page sent was blocked)' : `scenario: scope ${result.map.scenario.scope}`;
    result.stack = stackLine();
    const target = path.join(ROOT, familyDir(map.family), `${map.log}.md`);
    const shotName = `${path.basename(map.log)}.jpg`;
    const shotStep = result.steps.find((s) => s.index === result.screenshotStep);
    if (shotStep?.screenshot && fs.existsSync(path.join(dir, shotStep.screenshot))) { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(path.join(dir, shotStep.screenshot), path.join(path.dirname(target), shotName)); result.screenshot = shotName; }
    const { text, verdict } = composeLog(result);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
    written.push({ log: rel(target), verdict, map, failed: result.steps.filter((s) => s.status !== 'pass').map((s) => `step ${s.index}: ${s.failures?.[0] ?? s.unexpectedConsole?.[0]}`) });
  }
  return { written, skipped };
}

/** Seal only the logs this run walked; preserve every unrelated seal. */
function sealDirs(written) {
  return written.map(w => {
    if (w.verdict !== 'pass') return `${w.log}: not sealed — walk failed`;
    const r = spawnSync('bash', [path.join(ROOT, 'scripts/journeys/seal.sh'), w.log], { cwd: ROOT, encoding: 'utf8' });
    return `${w.log}: ${(r.stdout + r.stderr).trim()}`;
  });
}

async function main() {
  const o = args(process.argv.slice(2));
  if (o.cmd === 'check') {
    const { maps, problems } = await selected(o);
    problems.forEach((p) => console.log(`  ✗ ${p}`));
    console.log(`${maps.length} map(s) valid, ${problems.length} problem(s)`);
    process.exit(problems.length ? 1 : 0);
  }
  if (o.cmd === 'coverage') {
    const inv = await import(pathToFileURL(path.join(PORTAL, 'e2e/route-inventory.ts')).href);
    const { maps, problems } = await loadMaps(mapFiles());
    if (problems.length) { problems.forEach((p) => console.error(`  ✗ ${p}`)); process.exit(1); }
    const seen = new Set(); const inventory = [];
    for (const r of [...inv.staticInventory(), ...inv.paramInventory()]) { const key = r.pattern ?? inv.routeKey(r.path) ?? r.path; if (seen.has(key)) continue; seen.add(key); inventory.push({ key, tenant: r.tenant, kind: r.kind ?? 'page' }); }
    // DE-29 moved registration out of session.ts: consume the generated
    // manifest data, without importing the session runtime or parsing its source.
    const { ROLES_BY_TENANT, CROSS_TENANT_ROLES } = await import(pathToFileURL(path.join(ROOT, 'middleware/src/lib/tenants.generated.ts')).href);
    const rolesByTenant = Object.fromEntries(Object.entries(ROLES_BY_TENANT).map(([tenant, roles]) => [tenant, [...roles, ...CROSS_TENANT_ROLES]]));
    // A map that writes counts only once lane M's scopes let it run.
    const m = laneM();
    const runnable = maps.filter(({ map }) => !map.hold && (!map.writes || m.scopes));
    const pending = maps.filter((x) => !runnable.includes(x)).map(({ file, map }) => ({ file, log: `${map.family}/${map.log}`, goal: map.goal, why: map.hold ?? 'it writes, and no mock scope is available' }));
    const model = coverageModel(runnable, { inventory, rolesByTenant, routeKey: inv.routeKey });
    const md = coverageMarkdown(model, { families: [...new Set(maps.map((x) => x.map.family))].sort(), pending });
    const target = path.join(ROOT, 'docs/journeys/coverage.md');
    if (o.check) { const cur = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : ''; if (cur !== md) { console.error('docs/journeys/coverage.md is out of date — run node scripts/journeys/run-maps.mjs coverage'); process.exit(1); } console.log('coverage.md is current'); return; }
    fs.writeFileSync(target, md);
    const t = model.totals;
    console.log(`docs/journeys/coverage.md: ${t.maps} maps; ${t.visited}/${t.routes} routes; ${t.rolesWalked}/${t.roles} roles; ${t.stateCells} route×role×state cells`);
    return;
  }
  if (o.cmd === 'burndown') {
    // Print (never write) the route × rule pairs the last walk found that the burn-down does not own yet.
    // Owning one is a decision: paste the row into docs/journeys/audit-burndown.tsv with its owner and reason.
    const { maps } = await selected(o);
    const ledger = path.join(ROOT, 'docs/journeys/audit-burndown.tsv');
    const have = new Set(fs.existsSync(ledger) ? fs.readFileSync(ledger, 'utf8').split('\n').map((l) => l.split('\t').slice(0, 2).join('\t')) : []);
    const rows = new Map();
    for (const { map } of maps) {
      const f = path.join(outDirOf(o, map), 'result.json');
      if (!fs.existsSync(f)) continue;
      for (const st of JSON.parse(fs.readFileSync(f, 'utf8')).steps ?? []) for (const r of Object.keys(st.audit?.rules ?? {})) { const k = `${st.audit.routeKey}\t${r}`; if (!have.has(k)) rows.set(k, (rows.get(k) ?? 0) + st.audit.rules[r]); }
    }
    for (const [k, n] of [...rows].sort()) console.log(`${k}\t<owner>\t<reason> (${n} finding(s) in the last walk)`);
    return;
  }
  if (o.cmd !== 'walk' && o.cmd !== 'write') { console.error('usage: run-maps.mjs check|walk|write|coverage [family|--family f] [--role r] [--only s] [--no-seal] [--wait min] [--out dir]'); process.exit(2); }
  const { maps, problems } = await selected(o);
  if (problems.length) { problems.forEach((p) => console.error(`  ✗ ${p}`)); process.exit(1); }
  if (!maps.length) { console.error('no maps selected'); process.exit(1); }
  let deferred = [];
  const held = maps.filter(({ map }) => map.hold);
  maps.splice(0, maps.length, ...maps.filter((x) => !held.includes(x)));
  for (const { map } of held) console.log(`  · ${map.family}/${map.log}: held — ${map.hold}`);
  if (!maps.length) { console.error('every selected map is held'); process.exit(3); }
  if (o.cmd === 'walk') {
    const m = laneM();
    // Clones are the rule (lane M); a map that needs the seed persona runs only with --allow-persona.
    if (!o.allowPersona) {
      const persona = maps.filter(({ map }) => needsPersona(m, map));
      for (const { map } of persona) console.log(`  · ${map.family}/${map.log}: not walked — it needs the seed persona ${personaUsers(m, map).join(', ')} (${m.clones ? map.identityReason : 'no clones in realSession.ts'}); rerun with --allow-persona`);
      maps.splice(0, maps.length, ...maps.filter((x) => !persona.includes(x)));
      if (!maps.length) process.exit(3);
    }
    // Never walk as a seed persona while an audit holds the seed identities; clones walk regardless.
    if (maps.some(({ map }) => needsPersona(m, map)) && !(await waitForBrowserIdentity(o))) {
      deferred = maps.filter(({ map }) => needsPersona(m, map));
      maps.splice(0, maps.length, ...maps.filter((x) => !deferred.includes(x)));
      if (!maps.length) { console.error(`${deferred.length} map(s) deferred; nothing to walk`); process.exit(3); }
    }
    const release = lockIdentities([...new Set(maps.filter(({ map }) => needsPersona(m, map)).flatMap(({ map }) => personaUsers(m, map)))]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-maps-'));
    try {
      for (const { map } of maps) fs.rmSync(outDirOf(o, map), { recursive: true, force: true });
      const cli = await writeSpec(dir, o, maps, m);
      console.log(`walking ${maps.length} map(s)${m.clones ? ' as clones' : ''} …`);
      const r = spawnSync(process.execPath, [cli, 'test', '--config', path.join(dir, 'playwright.config.cjs')], { stdio: 'inherit', cwd: PORTAL });
      if (r.status !== 0) console.error(`the Playwright run exited ${r.status} — logs are written for every map that produced a result`);
    } finally { release(); fs.rmSync(dir, { recursive: true, force: true }); }
  }
  if (o.video) { console.log(`videos under ${path.relative(ROOT, o.video)} (no logs written, nothing sealed)`); process.exit(0); }
  const { written, skipped } = writeLogs(o, maps);
  for (const w of written) console.log(`  ${w.verdict === 'pass' ? '✓' : '✗'} ${w.log}${w.failed.length ? ` — ${w.failed.slice(0, 2).join('; ')}` : ''}`);
  for (const s of skipped) console.log(`  · ${s}`);
  for (const { map } of deferred) console.log(`  · ${map.family}/${map.log}: deferred — walks as seed persona ${map.persona.user} while an audit runs`);
  const passed = written.filter((w) => w.verdict === 'pass').length;
  console.log(`${passed}/${written.length} walks passed${skipped.length ? `; ${skipped.length} not written` : ''}`);
  if (!o.noSeal && o.cmd === 'walk') for (const line of sealDirs(written)) console.log(`  seal ${line}`);
  // A write map waiting for lane M is reported, not failed; a map that produced no walk is a failure.
  process.exit(passed === written.length && !deferred.length && !skipped.some((x) => !/: skipped — /.test(x)) ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(e.stack ?? e.message); process.exit(2); });

export { sealDirs, writeLogs, lockIdentities };

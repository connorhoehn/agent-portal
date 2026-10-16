#!/usr/bin/env node
// The Work tenant's journey checks (docs/work-journeys-goal.md), the static
// half of scripts/validate-work-journeys.sh. Prints one `ok|fail|note<TAB>text`
// line per finding so the judge can relay them.
//
//   node scripts/journeys/work-journeys.mjs catalog     # the catalog, MATRIX.txt and the maps agree
//   node scripts/journeys/work-journeys.mjs depth       # every map meets the depth rules
//   node scripts/journeys/work-journeys.mjs refusals    # every role × gated route it cannot reach is refused by a map
//   node scripts/journeys/work-journeys.mjs floors [--write]   # route × role × state floors (scripts/work-journeys-floors.tsv), ratchet up only
//   node scripts/journeys/work-journeys.mjs logs        # every map's log exists, passes, carries its kind's fields
//   node scripts/journeys/work-journeys.mjs burndown    # every burn-down row on a Work route names an owner and a reason
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { ROOT, mapFiles, loadMaps, stepRoutes, PROFILES, BUILTIN } from './maps.mjs';

export const GOAL = 'docs/work-journeys-goal.md';
export const MATRIX = 'docs/work-journeys/MATRIX.txt';
export const FLOORS = 'scripts/work-journeys-floors.tsv';
export const LOGS = 'docs/work-journeys';
export const ROLES = ['member', 'sme', 'program-owner', 'org-leader', 'hr-admin'];
/** Every check the catalog's `checks` column may name, and what the map must then contain. */
export const CHECKS = ['numbers', 'dialog', 'composer', 'palette', 'write', 'tabs', 'reload'];
export const WIDTHS = [1440, 900];
export const THEMES = ['light', 'dark'];

const out = (kind, text) => process.stdout.write(`${kind}\t${text}\n`);
const asList = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/**
 * The catalog: the table under "## The catalog" in the goal doc. One row per journey:
 * | `role/surface` | kind | route(s) | states | tabs | checks | what the person does |
 */
export function readCatalog(text = read(GOAL)) {
  const sec = text.split(/^## The catalog\s*$/m)[1]?.split(/^## (?!#)/m)[0] ?? '';
  const rows = [];
  for (const line of sec.split('\n')) {
    const m = line.match(/^\|\s*`([\w-]+\/[\w-]+)`\s*\|/);
    if (!m) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    const list = (c) => (c && c !== '—' && c !== '-' ? c.split(/,\s*/).map((x) => x.replace(/`/g, '').trim()).filter(Boolean) : []);
    rows.push({ id: m[1], role: m[1].split('/')[0], surface: m[1].split('/')[1], kind: cells[1], routes: list(cells[2]), states: list(cells[3]), tabs: list(cells[4]), checks: list(cells[5]), intent: cells[6] ?? '' });
  }
  return rows;
}

/** MATRIX.txt: surface | url | L or - | roles — the cells validate-orgiq-audit.sh judges. */
export function readMatrix(text = read(MATRIX)) {
  return text.split('\n').filter((l) => l.trim() && !l.startsWith('#')).map((l) => { const [surface, url, list, roles] = l.split('|').map((x) => x.trim()); return { surface, url, list: list === 'L', roles: roles.split(',').map((r) => r.trim()) }; });
}

async function workMaps() {
  const { maps, problems } = await loadMaps(mapFiles('work'));
  return { maps, problems };
}

/** Every UI state a map shows (step states, refused deep links, scope switches). */
export function statesOf(map) {
  const s = new Set();
  for (const st of map.steps) {
    if (st.state) s.add(st.state);
    if (st.do === 'navigate' && !st.state) s.add('default');
    if (st.expect?.urlNot) s.add('refused');
  }
  return s;
}

// ── catalog ↔ MATRIX ↔ maps ───────────────────────────────────────────────
async function catalog() {
  const rows = readCatalog();
  const { maps, problems } = await workMaps();
  if (problems.length) out('fail', `${problems.length} work map(s) do not load or validate (run-maps.mjs check --family work)`);
  if (!rows.length) { out('fail', `${GOAL} has no catalog rows under "## The catalog"`); return; }
  const ids = new Set(rows.map((r) => r.id));
  const dup = rows.map((r) => r.id).filter((id, i, a) => a.indexOf(id) !== i);
  if (dup.length) out('fail', `catalog lists a journey twice: ${[...new Set(dup)].join(', ')}`);
  const bad = rows.filter((r) => !ROLES.includes(r.role) || !PROFILES.work[r.kind] || !r.routes.length || !r.intent || r.checks.some((c) => !CHECKS.includes(c)));
  if (bad.length) out('fail', `catalog rows with an unknown role, kind or check, or no route or intent: ${bad.map((r) => r.id).join(', ')}`); else out('ok', `catalog: ${rows.length} journeys, every row has a role, a kind, a route and an intent`);
  for (const role of ROLES) {
    const mine = rows.filter((r) => r.role === role);
    const kinds = new Set(mine.map((r) => r.kind));
    const need = ['surface', 'refusals', 'frames'].filter((k) => !kinds.has(k));
    if (need.length) out('fail', `${role}: the catalog has no ${need.join(' or ')} journey`);
    else out('ok', `${role}: ${mine.length} journeys (${mine.filter((r) => r.kind === 'surface').length} surfaces, a refusals walk, a frames walk)`);
  }
  const byLog = new Map(maps.map(({ map, file }) => [map.log, { map, file }]));
  const noMap = rows.filter((r) => !byLog.has(r.id)).map((r) => r.id);
  const noRow = [...byLog.keys()].filter((l) => !ids.has(l));
  if (noMap.length) out('fail', `${noMap.length} catalog journey(s) have no map under docs/journeys/maps/work: ${noMap.slice(0, 12).join(", ")}${noMap.length > 12 ? " …" : ""}`); else out('ok', `every catalog journey has a map (${rows.length})`);
  if (noRow.length) out('fail', `${noRow.length} map(s) are not in the catalog: ${noRow.join(', ')}`); else out('ok', 'every work map is a catalog journey');
  const mismatch = rows.filter((r) => byLog.has(r.id) && (byLog.get(r.id).map.kind !== r.kind || byLog.get(r.id).map.persona.role !== r.role || byLog.get(r.id).map.persona.tenant !== 'orgiq'));
  if (mismatch.length) out('fail', `maps whose kind, tenant or role differ from the catalog: ${mismatch.map((r) => r.id).join(', ')}`);
  // MATRIX: every cell is a catalog surface journey of that role, walking that URL.
  const cells = readMatrix();
  const missing = [];
  for (const c of cells) for (const r of c.roles) {
    const row = rows.find((x) => x.id === `${r}/${c.surface}`);
    if (!row || row.kind !== 'surface') missing.push(`${r}/${c.surface}`);
  }
  if (missing.length) out('fail', `${missing.length} MATRIX.txt cell(s) have no catalog surface journey: ${missing.slice(0, 12).join(', ')}`); else out('ok', `every MATRIX.txt cell (${cells.reduce((n, c) => n + c.roles.length, 0)}) is a catalog surface journey`);
}

// ── depth ─────────────────────────────────────────────────────────────────
const isTab = (t) => t && t.role === 'tab';
const tabName = (t) => (t.name instanceof RegExp ? t.name.source : String(t.name ?? ''));
const hasAssertion = (e) => e && Object.keys(e).some((k) => k !== 'noHscroll');

/** Problems with one map against its catalog row (sentences). */
export function depthProblems(map, row) {
  const p = [];
  const steps = map.steps;
  if (map.hold) return p; // a held map is listed as pending by coverage and the judge
  if (map.viewport?.width !== 1440) p.push('walks at 1440 wide (viewport { width: 1440, height: 900 })');
  const unmeasured = steps.filter((s) => s.audit === false);
  if (unmeasured.length) p.push(`the DOM audit runs at every step: step(s) ${unmeasured.map((s) => steps.indexOf(s) + 1).join(', ')} say audit: false`);
  const blind = steps.filter((s) => ['click', 'press', 'fill', 'reload', 'back'].includes(s.do) || (s.do === 'scope' && s.url)).filter((s) => !hasAssertion(s.expect));
  if (blind.length) p.push(`every step that changes the UI asserts the result: step(s) ${blind.map((s) => steps.indexOf(s) + 1).join(', ')} expect nothing`);
  const navs = steps.filter((s) => s.do === 'navigate' && !hasAssertion(s.expect));
  if (navs.length) p.push(`every navigate asserts what it shows: step(s) ${navs.map((s) => steps.indexOf(s) + 1).join(', ')}`);
  if (map.kind === 'surface') {
    if (!steps.some((s) => s.do === 'tab-walk')) p.push('no tab-walk (keyboard reach)');
    if (!steps.some((s) => s.do === 'press')) p.push('no key press (Enter, Escape, the palette or the composer keys)');
    const facts = steps.filter((s) => asList(s.proves).includes('story-facts'));
    if (!facts.length || !facts.some((s) => s.expect?.noText?.length)) p.push('story-facts: no step asserts the content with a noText leak list (names, not ids)');
  }
  if (!row) return p;
  const states = statesOf(map);
  const missing = row.states.filter((s) => !states.has(s));
  if (missing.length) p.push(`shows none of the catalog's states ${missing.join(', ')}`);
  const tabsClicked = steps.filter((s) => s.do === 'click' && isTab(s.target));
  for (const t of row.tabs) {
    const hit = tabsClicked.find((s) => new RegExp(`^(?:${tabName(s.target)})$`, 'i').test(t) || tabName(s.target).toLowerCase() === t.toLowerCase());
    if (!hit) p.push(`never clicks the "${t}" tab`);
    else if (!hit.stable?.length) p.push(`the "${t}" tab click has no stable: [...] (header, tab strip and pane must not move)`);
  }
  const want = new Set(row.checks);
  if (row.tabs.length) want.add('tabs');
  const exp = steps.flatMap((s) => [s.expect ?? {}]);
  if (want.has('numbers') && !exp.some((e) => asList(e.numbers).length)) p.push('checks numbers: no step has expect.numbers (a count that agrees with its rows)');
  if (want.has('dialog') && !(states.has('dialog-open') && steps.some((s) => s.do === 'press' && s.key === 'Escape'))) p.push('checks a dialog: needs a dialog-open state and an Escape that closes it');
  if (want.has('composer') && !(steps.some((s) => s.do === 'press' && /^[1-5]$/.test(s.key)) && steps.some((s) => s.do === 'press' && s.key === 'Enter'))) p.push('checks the composer: needs a 1-5 key and an Enter press');
  if (want.has('palette') && !steps.some((s) => s.do === 'press' && /^(Meta|Control|ControlOrMeta)\+k$/i.test(s.key))) p.push('checks the palette: needs a ControlOrMeta+k press');
  if (want.has('write')) {
    if (!map.writes || typeof map.scenario !== 'object') p.push('checks a write: the map must declare writes: true under a scope');
    const lastWrite = steps.map((s, i) => (s.writes ? i : -1)).filter((i) => i >= 0).pop();
    if (lastWrite == null) p.push('checks a write: no step writes');
    else if (!steps.slice(lastWrite + 1).some((s) => (s.do === 'reload' || s.do === 'navigate') && hasAssertion(s.expect))) p.push('checks a write: nothing reads it back after a reload');
  }
  if (want.has('reload') && !steps.some((s) => s.do === 'reload' && hasAssertion(s.expect))) p.push('checks a reload: no reload step asserts the state survived');
  if (map.kind === 'frames') {
    // Every frames route at both widths and both themes.
    let w = map.viewport?.width ?? 1680; let th = 'light'; const seen = new Set();
    for (const s of steps) {
      if (s.do === 'viewport') w = s.width;
      if (s.do === 'theme') th = s.value;
      if (s.do === 'navigate') seen.add(`${s.url.split('?')[0]}|${w}|${th}`);
    }
    for (const r of row.routes) for (const ww of WIDTHS) for (const tt of THEMES) if (!seen.has(`${r.split('?')[0]}|${ww}|${tt}`)) p.push(`frames: ${r} never walked at ${ww} ${tt}`);
  }
  return p;
}

async function depth() {
  const rows = new Map(readCatalog().map((r) => [r.id, r]));
  const { maps } = await workMaps();
  let bad = 0;
  for (const { map, file } of maps) {
    const p = depthProblems(map, rows.get(map.log));
    if (p.length) { bad++; out('fail', `${map.log}: ${p.slice(0, 4).join('; ')}${p.length > 4 ? ` (+${p.length - 4} more)` : ''}`); }
  }
  if (!bad) out('ok', `all ${maps.length} work maps meet the depth rules (audit at every step, every UI change asserted, the catalog's states, tabs and checks)`);
  const steps = maps.reduce((n, { map }) => n + map.steps.length, 0);
  out('note', `${maps.length} maps, ${steps} steps, ${maps.filter(({ map }) => map.writes).length} writing maps, ${maps.reduce((n, { map }) => n + map.steps.filter((s) => s.stable).length, 0)} tab-stability checks`);
}

// ── refusals ──────────────────────────────────────────────────────────────
/** App.tsx routes a role cannot reach: gated, under /iq or /admin, not a wildcard. */
export async function gatedRoutes() {
  const inv = await import(pathToFileURL(path.join(ROOT, 'portal/e2e/route-inventory.ts')).href);
  return inv.appRoutes().filter((r) => r.roles && /^\/(iq|admin)(\/|$)/.test(r.path) && !r.path.includes('*'));
}
const patternRe = (p) => new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/:[A-Za-z]+/g, '[^/?]+')}(?:\\?.*)?$`);

async function refusals() {
  const gated = await gatedRoutes();
  const { maps } = await workMaps();
  for (const role of ROLES) {
    const owed = gated.filter((r) => !r.roles.includes(role));
    const refused = maps.filter(({ map }) => map.persona.role === role).flatMap(({ map }) => map.steps.filter((s) => s.do === 'navigate' && s.expect?.urlNot).map((s) => s.url));
    const uncovered = owed.filter((r) => !refused.some((u) => patternRe(r.path).test(u)));
    if (!owed.length) out('ok', `${role}: reaches every gated route (nothing to refuse)`);
    else if (uncovered.length) out('fail', `${role}: ${uncovered.length} of ${owed.length} gated routes it cannot reach have no refused deep link in a map: ${uncovered.slice(0, 8).map((r) => r.path).join(', ')}${uncovered.length > 8 ? ' …' : ''}`);
    else out('ok', `${role}: all ${owed.length} gated routes it cannot reach are refused by a walked deep link`);
    const apis = maps.filter(({ map }) => map.persona.role === role).flatMap(({ map }) => map.steps.filter((s) => s.do === 'api' && asList(s.expect?.status).some((x) => x === 403)));
    if (owed.length && !apis.length) out('fail', `${role}: no API refusal (a 403) is probed`);
  }
}

// ── floors ────────────────────────────────────────────────────────────────
async function floorCells() {
  const inv = await import(pathToFileURL(path.join(ROOT, 'portal/e2e/route-inventory.ts')).href);
  const { maps } = await workMaps();
  const cells = new Map();
  for (const { map } of maps) {
    if (map.hold) continue;
    for (const { key, state } of stepRoutes(map, inv.routeKey)) {
      const k = `${key}\t${map.persona.role}`;
      if (!cells.has(k)) cells.set(k, new Set());
      cells.get(k).add(state);
    }
  }
  return cells;
}
const parseFloors = (t) => new Map(t.split('\n').filter((l) => l && !l.startsWith('#') && !l.startsWith('route\t')).map((l) => { const [route, role, states] = l.split('\t'); return [`${route}\t${role}`, new Set((states ?? '').split(',').filter(Boolean))]; }));

async function floors(write) {
  const cells = await floorCells();
  const file = path.join(ROOT, FLOORS);
  const now = fs.existsSync(file) ? parseFloors(fs.readFileSync(file, 'utf8')) : new Map();
  if (write) {
    // Ratchet up only: keep every row and state already there, add what the maps now show.
    const merged = new Map(now);
    for (const [k, s] of cells) merged.set(k, new Set([...(merged.get(k) ?? []), ...s]));
    const lines = [...merged].sort(([a], [b]) => a.localeCompare(b)).map(([k, s]) => `${k}\t${[...s].sort().join(',')}`);
    const head = ['# Work tenant journey floors (docs/work-journeys-goal.md): route key, role, the UI states the maps show it in.',
      '# Ratchet up only: a row or a state never leaves (scripts/validate-work-journeys.sh compares with HEAD); add with',
      '# node scripts/journeys/work-journeys.mjs floors --write after the maps that show more have walked and passed.',
      'route\trole\tstates'];
    fs.writeFileSync(file, `${head.join('\n')}\n${lines.join('\n')}\n`);
    out('note', `${FLOORS}: ${merged.size} route × role cells, ${[...merged.values()].reduce((n, s) => n + s.size, 0)} states`);
    return;
  }
  if (!now.size) { out('fail', `${FLOORS} missing or empty (write it with floors --write)`); return; }
  const short = [];
  for (const [k, s] of now) { const have = cells.get(k) ?? new Set(); const lost = [...s].filter((x) => !have.has(x)); if (lost.length) short.push(`${k.replace('\t', ' as ')}: ${lost.join(', ')}`); }
  if (short.length) out('fail', `${short.length} floor cell(s) no longer shown by a map: ${short.slice(0, 6).join('; ')}`);
  else out('ok', `the maps meet every floor: ${now.size} route × role cells, ${[...now.values()].reduce((n, s) => n + s.size, 0)} route × role × state cells`);
  const above = [...cells].filter(([k, s]) => !now.has(k) || [...s].some((x) => !now.get(k).has(x))).length;
  if (above) out('note', `${above} cell(s) show more than their floor — raise it with floors --write`);
  let was = null;
  try { was = parseFloors(execFileSync('git', ['show', `HEAD:${FLOORS}`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })); } catch { /* not committed yet */ }
  if (!was) { out('note', 'no committed floors yet: the ratchet is judged from the next commit on'); return; }
  const down = [];
  for (const [k, s] of was) { const n = now.get(k); if (!n) { down.push(`${k.replace('\t', ' as ')} removed`); continue; } const lost = [...s].filter((x) => !n.has(x)); if (lost.length) down.push(`${k.replace('\t', ' as ')} lost ${lost.join(', ')}`); }
  if (down.length) out('fail', `floors moved down against HEAD: ${down.slice(0, 6).join('; ')}`); else out('ok', `floors only ratcheted up against HEAD (${was.size} → ${now.size} cells)`);
}

// ── logs ──────────────────────────────────────────────────────────────────
async function logs() {
  const { maps } = await workMaps();
  const walked = []; let bad = 0; let held = 0;
  for (const { map } of maps) {
    if (map.hold) { held++; out('note', `held ${map.log}: ${map.hold}`); continue; }
    const f = `${LOGS}/${map.log}.md`;
    if (!fs.existsSync(path.join(ROOT, f))) { bad++; out('fail', `${map.log}: never walked (${f} missing)`); continue; }
    const t = read(f);
    const why = [];
    if (!/^verdict: *pass/m.test(t)) why.push((t.match(/^verdict: *(.*)$/m)?.[1] ?? 'no verdict').slice(0, 140));
    if (!/^console errors: *0\b/m.test(t)) why.push('console errors');
    if (!/^layout: *pass/m.test(t)) why.push('layout');
    if (!/^dom-audit: *0 failing/m.test(t)) why.push('dom-audit has failing findings');
    for (const field of PROFILES.work[map.kind].filter((x) => !BUILTIN.has(x))) {
      const v = t.match(new RegExp(`^${field}: *(.*)$`, 'm'))?.[1];
      if (!v) why.push(`no ${field}:`); else if (/^fail/.test(v)) why.push(`${field}: ${v.slice(0, 100)}`);
    }
    const shot = t.match(/^screenshot: *(\S+)/m)?.[1];
    if (!shot || !fs.existsSync(path.join(ROOT, path.dirname(f), shot))) why.push('screenshot missing');
    if (why.length) { bad++; out('fail', `${map.log}: ${why.slice(0, 3).join('; ')}`); }
    walked.push(f);
  }
  if (!bad) out('ok', `all ${walked.length} walked logs pass with every field of their kind${held ? ` (${held} held)` : ''}`);
  // The caller judges freshness of exactly these logs.
  fs.writeFileSync(path.join(ROOT, '.scratch/work-journeys-logs.txt'), `${walked.join('\n')}\n`);
}

// ── burn-down ownership ───────────────────────────────────────────────────
function burndown() {
  const rows = read('docs/journeys/audit-burndown.tsv').split('\n').filter((l) => l && !l.startsWith('#'));
  const work = rows.filter((l) => /^\/(iq|admin|settings)(\/|\t|$)/.test(l));
  const unowned = work.filter((l) => { const [, , owner, reason] = l.split('\t'); return !owner || !reason || /<owner>|<reason>|TODO|unverified|placeholder/i.test(owner + reason); });
  if (unowned.length) out('fail', `${unowned.length} burn-down row(s) on Work routes lack an owner or a reason: ${unowned.slice(0, 4).map((l) => l.split('\t').slice(0, 2).join(' ')).join('; ')}`);
  else out('ok', `${work.length} burn-down row(s) on Work routes, each with an owner and a reason`);
}

const cmd = process.argv[2];
const run = { catalog, depth, refusals, floors: () => floors(process.argv.includes('--write')), logs, burndown }[cmd];
if (!run) { console.error('usage: work-journeys.mjs catalog|depth|refusals|floors [--write]|logs|burndown'); process.exit(2); }
fs.mkdirSync(path.join(ROOT, '.scratch'), { recursive: true });
await run();

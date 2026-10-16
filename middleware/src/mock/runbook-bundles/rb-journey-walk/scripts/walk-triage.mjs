#!/usr/bin/env node
// runtime: node >=20
// deps: none (node built-ins only)
// Triage a journey walk: read the runner's result.json files (scripts/journeys/run-maps.mjs writes one
// per map under .scratch/journeys/<family>/<log>/), sort every failed step into the cause that
// usually explains it, and say per directory whether the walk can seal or what to fix first.
//
//   node scripts/walk-triage.mjs --out ~/Projects/aws-agentcore/.scratch/journeys/work [--only member/]
//   node scripts/walk-triage.mjs --results data/sample-results.json      # offline: an array of result objects
//
// Exit: 0 every map passed, 1 something failed (the report says what to do), 2 bad arguments.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

// [cause, test on one failure line, what to do]. First match wins; order matters (specific before general).
export const CAUSES = [
  ['audit', /ui-dom-audit finding\(s\)/, 'a page defect the DOM audit measured: fix the page (or the library, then move the pin); only a person may own it in docs/journeys/audit-burndown.tsv (candidates: run-maps.mjs burndown <family>)'],
  ['tab-moved', /^stable: .* moved/, 'a tab click moved the header, tab strip or pane: keep one header density for every tab; never drop the stable target to pass'],
  ['blocked-write', /tried to write \(blocked\)/, 'a read-only map (scenario: shared) clicked something that writes: run it under scenario: { scope: "default" } with writes: true, or the target is the wrong control'],
  ['gateway-down', /WebSocket connection to .*\/ws/, 'the BFF socket dropped: usually a Tilt reload after a middleware edit mid-walk; stop editing middleware during walks and re-walk the map'],
  ['stack-down', /ERR_CONNECTION_REFUSED|DOM audit could not measure/, 'the stack went away (Vite :5183 or the BFF :3001): bring it back and re-walk; nothing to fix in the map'],
  ['http-error', /Failed to load resource/, 'an API answered 4xx/5xx: if the step means it (a refusal probe, a not-found), add expectConsole: /403|404/ to that step; otherwise the page called something it may not'],
  ['target-missing', /^(click|press|fill|wait) failed: .*Timeout/, 'the target never became actionable: wrong role/name, covered by a popover, or not rendered for this role; open the step screenshot and prefer role+name targets'],
  ['landed-elsewhere', /^(expected url|still on) /, 'navigation went somewhere else: a gate refused, a redirect changed, or a row opened a different record; compare with the route gate in App.tsx'],
  ['numbers', /^number in /, 'two numbers on the page disagree (a badge vs its rows, a header vs the table): a story-facts defect in the page or the fixture, never in the map'],
  ['layout', /horizontal scroll|first-row-top/, 'a layout rule failed (sideways scroll at this width, or the first data row below the fold): fix the page'],
  ['status', /^status \d+ \(expected/, 'an API probe answered a different status: the gate changed, or the probe body is not the refusal it claims'],
  ['content', /^(not visible|text not visible|count of visible|present \(expected absent|visible \(expected hidden|text present)/, 'the page shows different content than the map expects: a seed change, a clone that owns no user-keyed records (identity: persona), or a real regression'],
];

export function classify(line) {
  for (const [cause, re] of CAUSES) if (re.test(line)) return cause;
  return 'other';
}

/** One map's result → { name, dir, pass, problems: [{ step, cause, line }], notes } */
export function triageOne(r) {
  const name = `${r.map?.family ?? '?'}/${r.map?.log ?? '?'}`;
  const dir = (r.map?.log ?? '').includes('/') ? r.map.log.split('/')[0] : '.';
  const problems = []; const notes = [];
  if (r.skipped) notes.push(`skipped: ${r.error}`);
  else if (r.error && !(r.steps ?? []).length) problems.push({ step: 0, cause: /^setup failed/.test(r.error) ? 'setup' : 'other', line: r.error });
  if (r.retried) notes.push('the runner re-minted the clone and walked twice (a BFF reload mid-walk); the second walk is the record');
  for (const s of r.steps ?? []) {
    if (s.status === 'pass') continue;
    for (const f of s.failures ?? []) problems.push({ step: s.index, cause: classify(f), line: f });
    for (const m of s.unexpectedConsole ?? []) problems.push({ step: s.index, cause: classify(m), line: `console: ${m}` });
  }
  return { name, dir, pass: !r.skipped && !problems.length, problems, notes };
}

export function report(results) {
  const maps = results.map(triageOne).sort((a, b) => a.name.localeCompare(b.name));
  const out = [];
  const tally = new Map();
  for (const m of maps) {
    out.push(`${m.pass ? 'PASS' : 'FAIL'} ${m.name}${m.problems.length ? ` — ${m.problems.length} problem(s)` : ''}`);
    for (const n of m.notes) out.push(`     note: ${n}`);
    for (const p of m.problems) {
      out.push(`     step ${p.step} [${p.cause}] ${p.line.length > 110 ? `${p.line.slice(0, 107)}...` : p.line}`);
      tally.set(p.cause, (tally.get(p.cause) ?? 0) + 1);
    }
  }
  if (tally.size) {
    out.push('', 'causes, most frequent first:');
    const advice = new Map(CAUSES.map(([c, , a]) => [c, a]));
    advice.set('setup', 'the clone or scope could not be minted: is the BFF on dev:mock, and did a reset run mid-walk?');
    advice.set('other', 'read the step screenshot under the map out dir and the failure line');
    for (const [c, n] of [...tally].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) out.push(`  ${n} × ${c}: ${advice.get(c)}`);
  }
  // One audit rule failing in most maps is one defect in a shared frame (rail, header, table), not N page bugs.
  const ruleMaps = new Map();
  for (const m of maps) {
    const rules = new Set(m.problems.filter((p) => p.cause === 'audit').flatMap((p) => [...p.line.matchAll(/([a-z]+\.[a-z-]+) ×/g)].map((x) => x[1])));
    for (const r of rules) ruleMaps.set(r, (ruleMaps.get(r) ?? 0) + 1);
  }
  const shared = [...ruleMaps].filter(([, n]) => n >= 3 && n * 2 >= maps.length).sort((a, b) => b[1] - a[1]);
  if (shared.length) {
    out.push('', 'shared defects (fix once in the shared frame or the library, then re-walk everything):');
    for (const [r, n] of shared) out.push(`  ${r} fails in ${n} of ${maps.length} maps`);
  }
  out.push('', 'seal readiness (a directory seals only when every log in it passed in one run):');
  const dirs = new Map();
  for (const m of maps) { if (!dirs.has(m.dir)) dirs.set(m.dir, []); dirs.get(m.dir).push(m); }
  for (const [d, ms] of [...dirs].sort(([a], [b]) => a.localeCompare(b))) {
    const bad = ms.filter((m) => !m.pass);
    out.push(bad.length
      ? `  ${d}: NOT ready — fix ${bad.length} map(s), iterate with --only <log> --no-seal, then walk the whole directory once more`
      : `  ${d}: ready — ${ms.length} map(s) passed`);
  }
  return { text: out.join('\n'), ok: maps.every((m) => m.pass) };
}

function readResults(dir, only) {
  const found = [];
  const walk = (d) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      if (n === 'playwright') continue;
      if (statSync(p).isDirectory()) walk(p);
      else if (n === 'result.json') found.push(p);
    }
  };
  walk(dir);
  return found.filter((f) => !only || f.includes(only)).map((f) => JSON.parse(readFileSync(f, 'utf8')));
}

function main() {
  let values;
  try {
    ({ values } = parseArgs({ options: { out: { type: 'string' }, results: { type: 'string' }, only: { type: 'string' } } }));
  } catch (e) { console.error(e.message); process.exit(2); }
  if (!values.out === !values.results) { console.error('usage: walk-triage.mjs (--out <.scratch/journeys/family> | --results <file.json>) [--only <substring>]'); process.exit(2); }
  if (values.out && !existsSync(values.out)) { console.error(`no walk results at ${values.out}`); process.exit(2); }
  const results = values.results ? JSON.parse(readFileSync(values.results, 'utf8')) : readResults(values.out, values.only);
  if (!results.length) { console.error('no result.json found'); process.exit(2); }
  const { text, ok } = report(results);
  console.log(text);
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();

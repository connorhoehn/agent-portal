#!/usr/bin/env node
// A production bundle must not carry Node-only code. realtime-modules 0.147.0
// shipped ./proxy-client with a top-level require of @connorhoehn/service-runtime
// (async_hooks AsyncLocalStorage); the portal imports that subpath at boot, so
// every page threw "AsyncLocalStorage is not a constructor" and rendered blank.
//
// Build first (`npm run build`), then:
//   node scripts/check-bundle-node-free.mjs [--dist dist] [--graph .module-graph.json]
// Scans every dist/**/*.js (not source maps) and fails when one contains a
// forbidden marker. A substring scan can be fooled (a stubbed builtin whose
// name is minified away, a renamed package), so it also reads the module-graph
// report the build writes (scripts/node-free-graph.mjs, next to dist): it fails
// when the report is missing, empty or names a Node-only module.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { GRAPH_REPORT, nodeOnlyModules } from './node-free-graph.mjs';

export const FORBIDDEN = ['async_hooks', '@connorhoehn/service-runtime'];

function arg(name) { const i = process.argv.indexOf(name); return i < 0 ? null : process.argv[i + 1]; }
function scripts(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) scripts(p, out); else if (n.endsWith('.js') || n.endsWith('.mjs')) out.push(p);
  }
  return out;
}

/** `[{ file, marker }]` for every forbidden marker found in the given `{ file, text }` list. */
export function scan(files) {
  const hits = [];
  for (const { file, text } of files) for (const marker of FORBIDDEN) if (text.includes(marker)) hits.push({ file, marker });
  return hits;
}

/** Problems with the build's module-graph report (`{ checked, offenders }`), or [] when it is clean. */
export function graphProblems(reportText) {
  let report;
  try { report = JSON.parse(reportText); } catch { return ['the module-graph report is not JSON']; }
  if (!report || typeof report.checked !== 'number' || report.checked < 1) return ['the module-graph report checked no modules'];
  const listed = Array.isArray(report.offenders) ? report.offenders : [];
  // Re-derive from the ids as well, so a report cannot under-state its own offenders.
  const ids = listed.map((o) => o && o.id).filter(Boolean);
  const offenders = [...new Set([...listed.map((o) => `${o.id}: ${o.reason}`), ...nodeOnlyModules(ids).map((o) => `${o.id}: ${o.reason}`)])];
  return offenders.map((o) => `module graph reaches ${o}`);
}

function main() {
  const dist = resolve(arg('--dist') ?? 'dist');
  if (!existsSync(dist)) { console.error(`${dist} does not exist; run npm run build first`); process.exit(2); }
  const files = scripts(dist);
  if (!files.length) { console.error(`no *.js under ${dist}`); process.exit(2); }
  const hits = scan(files.map((file) => ({ file: file.slice(dist.length + 1), text: readFileSync(file, 'utf8') })));
  console.log(`bundle node-free: ${files.length} scripts, ${hits.length} forbidden marker(s)`);
  for (const h of hits) console.log(`  FAIL ${h.file} contains ${h.marker}`);
  const graph = resolve(arg('--graph') ?? join(dirname(dist), GRAPH_REPORT));
  const problems = existsSync(graph)
    ? graphProblems(readFileSync(graph, 'utf8'))
    : [`no module-graph report at ${graph}; build with the portal's vite config (npm run build)`];
  console.log(`module graph: ${problems.length} problem(s)`);
  for (const p of problems) console.log(`  FAIL ${p}`);
  process.exit(hits.length || problems.length ? 1 : 0);
}
if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) main();

#!/usr/bin/env node
// A production bundle must not carry Node-only code. realtime-modules 0.147.0
// shipped ./proxy-client with a top-level require of @connorhoehn/service-runtime
// (async_hooks AsyncLocalStorage); the portal imports that subpath at boot, so
// every page threw "AsyncLocalStorage is not a constructor" and rendered blank.
//
// Build first (`npm run build`), then:
//   node scripts/check-bundle-node-free.mjs [--dist dist]
// Scans every dist/**/*.js (not source maps) and fails when one contains a
// forbidden marker.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

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

function main() {
  const dist = resolve(arg('--dist') ?? 'dist');
  if (!existsSync(dist)) { console.error(`${dist} does not exist; run npm run build first`); process.exit(2); }
  const files = scripts(dist);
  if (!files.length) { console.error(`no *.js under ${dist}`); process.exit(2); }
  const hits = scan(files.map((file) => ({ file: file.slice(dist.length + 1), text: readFileSync(file, 'utf8') })));
  console.log(`bundle node-free: ${files.length} scripts, ${hits.length} forbidden marker(s)`);
  for (const h of hits) console.log(`  FAIL ${h.file} contains ${h.marker}`);
  process.exit(hits.length ? 1 : 0);
}
if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) main();

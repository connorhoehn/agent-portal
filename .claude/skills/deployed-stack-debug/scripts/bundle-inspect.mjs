#!/usr/bin/env node
// Rebuild the portal with source maps into .scratch/portal-sourcemap and
// (a) map minified stack frames from the deployed bundle back to source,
// (b) report every CommonJS module the bundle carries, and every package that
// appears as more than one file (a second module instance: the 'localsInner'
// canvas crash was two prosemirror-view copies, index.js + index.cjs).
//
//   node bundle-inspect.mjs [--skip-build] [--frames 275:26432,272:17154,...]
//
// The rebuild matches the published bundle line:column for line:column when it
// is built from the same commit and lockfile (check one frame's code first).
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const portal = resolve(root, 'portal');
const out = resolve(root, '.scratch/portal-sourcemap');
const flag = (n) => process.argv.indexOf(`--${n}`);
if (flag('skip-build') < 0 || !existsSync(out)) {
  execFileSync('npx', ['vite', 'build', '--sourcemap', '--outDir', out], { cwd: portal, stdio: ['ignore', 'ignore', 'inherit'] });
}
const assets = resolve(out, 'assets');
const maps = readdirSync(assets).filter(f => f.endsWith('.js.map'));
const pkgOf = (s) => { const m = /node_modules\/((?:@[^/]+\/)?[^/]+)\/(.*)$/.exec(s); return m ? { pkg: m[1], file: m[2] } : null; };

const cjs = new Map();
for (const map of maps) {
  for (const source of JSON.parse(readFileSync(resolve(assets, map), 'utf8')).sources) {
    const p = pkgOf(source); if (!p) continue;
    if (/\.cjs$|\/cjs\//.test(p.file)) (cjs.get(p.pkg) ?? cjs.set(p.pkg, new Set()).get(p.pkg)).add(map);
  }
}
console.log(`CommonJS modules bundled (${cjs.size}):`);
for (const [pkg, inMaps] of [...cjs].sort()) console.log(`  ${pkg}  (${[...inMaps].join(', ')})`);
console.log('\nPackages whose entry appears as both ESM and CJS (two instances):');
for (const map of maps) {
  const sources = JSON.parse(readFileSync(resolve(assets, map), 'utf8')).sources.map(pkgOf).filter(Boolean);
  const byPkg = new Map();
  for (const { pkg, file } of sources) if (/(^|\/)index\.(c|m)?js$|\.cjs$/.test(file)) (byPkg.get(pkg) ?? byPkg.set(pkg, new Set()).get(pkg)).add(file);
  for (const [pkg, set] of byPkg) if ([...set].some(f => f.endsWith('.cjs')) && [...set].some(f => !f.endsWith('.cjs'))) console.log(`  ${pkg} in ${map}: ${[...set].join(' + ')}`);
}

const framesArg = flag('frames') >= 0 ? process.argv[flag('frames') + 1] : '';
if (framesArg) {
  const require = createRequire(resolve(portal, 'package.json'));
  const { SourceMapConsumer } = require('source-map-js');
  const main = maps.find(m => m.startsWith('index-'));
  const consumer = new SourceMapConsumer(JSON.parse(readFileSync(resolve(assets, main), 'utf8')));
  console.log(`\nFrames mapped through ${main}:`);
  for (const frame of framesArg.split(',')) {
    const [line, col] = frame.split(':').map(Number);
    const p = consumer.originalPositionFor({ line, column: col - 1 });
    console.log(`  ${frame} → ${(p.source ?? '?').replace(/.*node_modules\//, '')}:${p.line}${p.name ? ` (${p.name})` : ''}`);
  }
}

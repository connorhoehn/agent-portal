#!/usr/bin/env node
// A production bundle must hold exactly one ESM instance of each singleton
// package. realtime-modules ships CommonJS, so without the editorStackAsEsm
// plugin (vite.config.ts) the build pulled y-tiptap.cjs, @tiptap/core's
// index.cjs and prosemirror-view's index.cjs beside the ESM copies ui-components
// imports, and every collaborative canvas crashed on mount (DE-28 check 4,
// docs/aws-deploy-open-items-2026-10-27.md item 2).
//
// Build with sourcemaps first (`vite build --sourcemap`), then:
//   node scripts/check-bundle-singletons.mjs [--dist dist] [--json]
// Reads every dist/**/*.js.map `sources`, maps each to node_modules/<pkg>, and
// fails when a singleton comes from a .cjs file, a /cjs/ directory, or two
// different install paths.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const SINGLETONS = /^(?:react|react-dom|yjs|y-protocols|lib0|prosemirror-[\w-]+|@tiptap\/[\w-]+)$/;
/** React ships only CommonJS (react/cjs/*.production.js); one instance is what matters, and the install-path rule still covers it. */
const CJS_ONLY = new Set(['react', 'react-dom']);
/** `package` or `package:reason-pattern` -> why it is allowed. Empty: nothing is exempt today. */
const EXEMPT = {};

function arg(name) { const i = process.argv.indexOf(name); return i < 0 ? null : process.argv[i + 1]; }
function maps(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) maps(p, out); else if (n.endsWith('.js.map')) out.push(p);
  }
  return out;
}

/** `[installPath, pkg, rest]` for a source path, or null when it is not under node_modules. */
export function packageOf(source) {
  const norm = source.replace(/^\0/, '').replace(/\\/g, '/').split('?')[0];
  const at = norm.lastIndexOf('node_modules/');
  if (at < 0) return null;
  const rest = norm.slice(at + 'node_modules/'.length).split('/');
  const pkg = rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0];
  const inner = rest.slice(pkg.split('/').length).join('/');
  // The install path is everything up to and including the package folder, minus the leading ../ run.
  const installPath = norm.slice(0, at + 'node_modules/'.length + pkg.length).replace(/^(\.\.\/)+/, '');
  return { installPath, pkg, inner };
}

export function analyse(sourceLists) {
  const installs = new Map(); // pkg -> Set(installPath)
  const failures = [];
  for (const { file, sources } of sourceLists) {
    for (const s of sources) {
      const p = packageOf(s);
      if (!p || !SINGLETONS.test(p.pkg)) continue;
      if (!installs.has(p.pkg)) installs.set(p.pkg, new Set());
      installs.get(p.pkg).add(p.installPath);
      if (!CJS_ONLY.has(p.pkg) && (/\.cjs$/.test(p.inner) || /(^|\/)cjs\//.test(p.inner))) {
        if (!EXEMPT[p.pkg]) failures.push(`${p.pkg}: CommonJS source ${p.pkg}/${p.inner} (in ${file})`);
      }
    }
  }
  for (const [pkg, paths] of installs) if (paths.size > 1 && !EXEMPT[pkg]) failures.push(`${pkg}: ${paths.size} install paths: ${[...paths].join(', ')}`);
  return { packages: [...installs].map(([pkg, paths]) => ({ pkg, installs: [...paths] })), failures: [...new Set(failures)] };
}

function main() {
  const dist = resolve(arg('--dist') ?? 'dist');
  if (!existsSync(dist)) { console.error(`${dist} does not exist; run vite build --sourcemap first`); process.exit(2); }
  const files = maps(dist);
  if (!files.length) { console.error(`no *.js.map under ${dist}; build with --sourcemap`); process.exit(2); }
  const result = analyse(files.map((file) => ({ file: file.slice(dist.length + 1), sources: JSON.parse(readFileSync(file, 'utf8')).sources ?? [] })));
  if (process.argv.includes('--json')) console.log(JSON.stringify({ maps: files.length, ...result }, null, 1));
  else {
    console.log(`bundle singletons: ${files.length} maps, ${result.packages.length} singleton packages, ${result.failures.length} failing`);
    for (const f of result.failures) console.log(`  FAIL ${f}`);
  }
  process.exit(result.failures.length ? 1 : 0);
}
if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) main();

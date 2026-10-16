#!/usr/bin/env node
// runtime: node >=20 (the import check spawns `node` from the consumer folder)
// deps: none (node built-ins only)
// Prove a consumer really got a library release: judge the INSTALLED copy, never the library's source
// or CHANGELOG (a release once documented and tested a prop its dist never shipped). Checks the
// installed version, the lockfile entry, that each named export imports under Node from the consumer,
// that each named declaration is in the shipped .d.ts, and that Vite's prebundle cache is not older
// than the install (a running dev server serves the old dist until .vite is cleared and it restarts).
//
//   node scripts/verify-installed.mjs --consumer "$REPO/portal" --package "$PKG" --version 2.463.0 \
//        [--export MeetingToolbar] [--export useConsentDismissal@video] [--dts popoverLabel]
//   node scripts/verify-installed.mjs --fixture data/sample-install.json --package @acme/ui --version 1.4.0 ...   # offline
//
// Exit: 0 every check OK, 1 a check FAILED, 2 bad arguments.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

function dtsFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const n of readdirSync(d).sort()) {
      if (n === 'node_modules') continue;
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.d\.(ts|mts|cts)$/.test(n)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

export function verify({ consumer, pkg, version, exports = [], dts = [] }) {
  const lines = []; let ok = true;
  const OK = (s) => lines.push(`OK   ${s}`);
  const FAIL = (s) => { lines.push(`FAIL ${s}`); ok = false; };
  const home = join(consumer, 'node_modules', ...pkg.split('/'));
  const mf = join(home, 'package.json');
  if (!existsSync(mf)) { FAIL(`${pkg} is not installed under ${relative(consumer, home) || '.'} (run npm install in the consumer)`); return { lines, ok }; }
  const installed = JSON.parse(readFileSync(mf, 'utf8'));
  if (installed.version === version) OK(`installed ${pkg} is ${version}`);
  else FAIL(`installed ${pkg} is ${installed.version}, expected ${version} (npm kept the old copy: is the file: path new?)`);

  const lockFile = join(consumer, 'package-lock.json');
  if (existsSync(lockFile)) {
    const entry = JSON.parse(readFileSync(lockFile, 'utf8')).packages?.[`node_modules/${pkg}`];
    if (!entry) FAIL(`package-lock.json has no node_modules/${pkg} entry`);
    else if (entry.version === version && (!entry.resolved || entry.resolved.includes(version))) OK(`package-lock.json resolves ${entry.resolved ?? entry.version}`);
    else FAIL(`package-lock.json still says ${entry.version} (${entry.resolved ?? 'no resolved'}); rerun npm install --prefer-offline in the consumer`);
  } else lines.push('SKIP no package-lock.json beside the consumer');

  for (const spec of exports) {
    const [name, sub] = spec.split('@');
    const target = sub ? `${pkg}/${sub}` : pkg;
    try {
      const out = execFileSync('node', ['--input-type=module', '-e', `const m = await import(${JSON.stringify(target)}); console.log(typeof m[${JSON.stringify(name)}]);`], { cwd: consumer, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }).trim();
      if (out === 'undefined') FAIL(`${target} imports but exports no ${name}`);
      else OK(`${target} exports ${name} (${out})`);
    } catch (e) {
      FAIL(`${target} does not import under Node: ${String(e.stderr || e.message).split('\n').find((l) => /Error/.test(l)) ?? 'error'}`);
    }
  }

  if (dts.length) {
    const files = dtsFiles(home).map((f) => [f, readFileSync(f, 'utf8')]);
    for (const word of dts) {
      const re = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
      const hits = files.filter(([, t]) => re.test(t)).map(([f]) => relative(home, f));
      if (hits.length) OK(`${word} is declared in ${hits.slice(0, 3).join(', ')}${hits.length > 3 ? ` and ${hits.length - 3} more` : ''}`);
      else FAIL(`${word} is in no shipped .d.ts: the release does not carry it, whatever its CHANGELOG says`);
    }
  }

  const vite = join(consumer, 'node_modules', '.vite');
  if (existsSync(vite) && statSync(vite).mtimeMs < statSync(mf).mtimeMs) FAIL('node_modules/.vite predates the install: rm -rf it and restart the dev server');
  else OK(existsSync(vite) ? 'node_modules/.vite is newer than the install' : 'no node_modules/.vite (the dev server rebuilds it on start)');
  return { lines, ok };
}

function fromFixture(file) {
  const fx = JSON.parse(readFileSync(file, 'utf8'));
  const root = mkdtempSync(join(tmpdir(), 'verify-installed-'));
  for (const [p, content] of Object.entries(fx.files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  // An install is newer than everything else in the fixture, unless the fixture says Vite's cache is older.
  for (const [p, ageMs] of Object.entries(fx.ages ?? {})) {
    const t = new Date(Date.now() - ageMs);
    utimesSync(join(root, p), t, t);
  }
  return root;
}

function main() {
  let v;
  try {
    ({ values: v } = parseArgs({ options: {
      consumer: { type: 'string' }, fixture: { type: 'string' }, package: { type: 'string' }, version: { type: 'string' },
      export: { type: 'string', multiple: true }, dts: { type: 'string', multiple: true },
    } }));
  } catch (e) { console.error(e.message); process.exit(2); }
  if ((!v.consumer && !v.fixture) || !v.package || !v.version) {
    console.error('usage: verify-installed.mjs (--consumer <dir> | --fixture <file>) --package <name> --version <x.y.z> [--export Name[@subpath]]… [--dts word]…');
    process.exit(2);
  }
  const consumer = v.fixture ? fromFixture(v.fixture) : v.consumer;
  try {
    const { lines, ok } = verify({ consumer, pkg: v.package, version: v.version, exports: v.export ?? [], dts: v.dts ?? [] });
    console.log(lines.join('\n'));
    process.exitCode = ok ? 0 : 1;
  } finally { if (v.fixture) rmSync(consumer, { recursive: true, force: true }); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();

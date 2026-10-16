#!/usr/bin/env node
// runtime: node >=20
// deps: none (node built-ins only)
// Move a consumer's pin on a packed library tarball (`file:` dependency) in one go: check the tarball
// really holds the package and version you think, rewrite every package.json under the consumer that
// pins the package by `file:`, update the version on the pins line of a doc (CLAUDE.md), and print the
// install commands that make each lockfile follow. Never touches node_modules or a lockfile itself.
//
//   eval "$(node scripts/pin-tarball.mjs --env data/projects.json --project aws-agentcore --lib ui-components)"
//   node scripts/pin-tarball.mjs --consumer "$REPO" --package "$PKG" --tarball "$VENDOR/$TGZ" [--doc CLAUDE.md] [--dry-run]
//   node scripts/pin-tarball.mjs --fixture data/sample-consumer.json        # offline: build the fixture tree in a temp dir, pin it
//
// Exit: 0 pinned (or nothing to change), 1 a check failed, 2 bad arguments.
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const DEP_KEYS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

/** package/package.json out of an npm-pack tarball (ustar, gzip), or null. */
export function tarballManifest(buf) {
  const tar = gunzipSync(buf);
  for (let off = 0; off + 512 <= tar.length;) {
    const name = tar.subarray(off, off + 100).toString('utf8').replace(/\0.*$/s, '');
    if (!name) break;
    const size = parseInt(tar.subarray(off + 124, off + 136).toString('utf8').replace(/\0.*$/s, '').trim() || '0', 8);
    if (name === 'package/package.json') return JSON.parse(tar.subarray(off + 512, off + 512 + size).toString('utf8'));
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return null;
}

/** A minimal npm-pack-shaped tarball holding only package/package.json (fixtures). */
export function makeTarball(manifest) {
  const body = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  const h = Buffer.alloc(512);
  const put = (s, o, n) => h.write(s, o, n, 'utf8');
  put('package/package.json', 0, 100); put('0000644\0', 100, 8); put('0000000\0', 108, 8); put('0000000\0', 116, 8);
  put(body.length.toString(8).padStart(11, '0') + '\0', 124, 12); put('00000000000\0', 136, 12);
  put('        ', 148, 8); put('0', 156, 1); put('ustar\0', 257, 6); put('00', 263, 2);
  let sum = 0; for (const b of h) sum += b;
  put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  const pad = Buffer.alloc((512 - (body.length % 512)) % 512);
  return gzipSync(Buffer.concat([h, body, pad, Buffer.alloc(1024)]), { mtime: 0 });
}

/** package.json files under root (depth ≤ 2), skipping node_modules and vendor folders. */
export function manifests(root) {
  const out = [];
  const visit = (d, depth) => {
    const f = join(d, 'package.json');
    if (existsSync(f)) out.push(f);
    if (depth === 2) return;
    for (const n of readdirSync(d).sort()) {
      if (n === 'node_modules' || n === 'vendor' || n.startsWith('.')) continue;
      const p = join(d, n);
      if (statSync(p).isDirectory()) visit(p, depth + 1);
    }
  };
  visit(root, 0);
  return out;
}

/** Rewrite every `file:` pin of pkg under root to the tarball. Returns [{ file, from, to }]. */
export function pin(root, pkg, tarball, { dryRun = false } = {}) {
  const changes = [];
  for (const f of manifests(root)) {
    const text = readFileSync(f, 'utf8');
    const json = JSON.parse(text);
    let changed = false;
    for (const k of DEP_KEYS) {
      const spec = json[k]?.[pkg];
      if (typeof spec !== 'string' || !spec.startsWith('file:')) continue;
      const to = `file:${relative(dirname(f), tarball)}`;
      if (spec === to) continue;
      changes.push({ file: relative(root, f), key: k, from: spec, to });
      json[k][pkg] = to; changed = true;
    }
    if (changed && !dryRun) writeFileSync(f, JSON.stringify(json, null, text.match(/^\{\n( +)/)?.[1].length ?? 2) + (text.endsWith('\n') ? '\n' : ''));
  }
  return changes;
}

/** Update the version written in bold after the package's short name on a doc's pins line. */
export function pinDoc(text, pkg, version) {
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // The full name first; the short name (after the scope) only when the doc never writes the full one.
  for (const name of [pkg, pkg.split('/').pop()]) {
    const re = new RegExp(`(${esc(name)}\`?[\\s\\w\`@/.-]{0,40}?\\*\\*)(\\d+\\.\\d+\\.\\d+[\\w.-]*)(\\*\\*)`, 'g');
    let n = 0; let from = null;
    const out = text.replace(re, (_, a, v, b) => { n += 1; from = v; return `${a}${version}${b}`; });
    if (n) return { text: out, count: n, from };
  }
  return { text, count: 0, from: null };
}

function run({ consumer, pkg, tarball, doc, dryRun }) {
  const lines = []; let ok = true;
  if (!existsSync(tarball)) { console.error(`no tarball at ${tarball} (npm pack --pack-destination first)`); process.exit(1); }
  const m = tarballManifest(readFileSync(tarball));
  if (!m) { lines.push(`FAIL ${relative(consumer, tarball)} holds no package/package.json`); return { lines, ok: false }; }
  lines.push(`tarball: ${m.name}@${m.version} (${relative(consumer, tarball)})`);
  // npm folders a file: dependency under its KEY, whatever the tarball calls itself: an alias installs and
  // passes a version check, but imports must use the key. Say so rather than fail.
  if (m.name !== pkg) lines.push(`NOTE the tarball calls itself ${m.name}; npm installs it as ${pkg} (the dependency key), so imports use ${pkg}`);
  const changes = pin(consumer, pkg, tarball, { dryRun });
  if (!changes.length) lines.push(`no manifest under ${consumer === process.cwd() ? '.' : 'the consumer'} pins ${pkg} by file: to another tarball (already pinned, or pinned another way)`);
  for (const c of changes) lines.push(`${dryRun ? 'would pin' : 'pinned'} ${c.file} ${c.key}: ${c.from} -> ${c.to}`);
  if (doc) {
    const f = resolve(consumer, doc);
    const d = pinDoc(readFileSync(f, 'utf8'), pkg, m.version);
    if (!d.count) { lines.push(`WARN ${doc}: no pins line names ${pkg} with a **version**; update it by hand`); ok = false; }
    else { if (!dryRun) writeFileSync(f, d.text); lines.push(`${doc}: ${dryRun ? 'would update ' : ''}${d.count} pin line(s) ${d.from} -> ${m.version}`); }
  }
  for (const c of changes) lines.push(`next: (cd ${dirname(c.file) || '.'} && npm install --prefer-offline --no-audit --no-fund)`);
  return { lines, ok };
}

function env(file, project, lib) {
  const p = JSON.parse(readFileSync(file, 'utf8'))[project];
  const l = p?.libraries?.[lib];
  if (!l) { console.error(`no ${project}/${lib} in ${file}`); process.exit(2); }
  const home = (s) => s.replace(/^~(?=\/|$)/, homedir());
  const repo = home(p.repo);
  const vars = { REPO: repo, LIB: home(l.repo), PKG: l.package, VENDOR: join(repo, l.vendor), CONSUMERS: l.consumers.join(' '), PINS_DOC: l.doc ?? '', DEV_RESTART: l.devRestart ?? '' };
  return Object.entries(vars).map(([k, v]) => `export ${k}='${String(v).replace(/'/g, `'\\''`)}'`).join('\n');
}

function main() {
  let v;
  try {
    ({ values: v } = parseArgs({ options: {
      consumer: { type: 'string' }, package: { type: 'string' }, tarball: { type: 'string' }, doc: { type: 'string' },
      'dry-run': { type: 'boolean' }, fixture: { type: 'string' }, env: { type: 'string' }, project: { type: 'string' }, lib: { type: 'string' },
    } }));
  } catch (e) { console.error(e.message); process.exit(2); }
  if (v.env) { if (!v.project || !v.lib) { console.error('--env needs --project and --lib'); process.exit(2); } console.log(env(v.env, v.project, v.lib)); return; }
  if (v.fixture) {
    const fx = JSON.parse(readFileSync(v.fixture, 'utf8'));
    const root = mkdtempSync(join(tmpdir(), 'pin-tarball-'));
    try {
      for (const [p, content] of Object.entries(fx.files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), content); }
      const tgz = join(root, fx.tarball.path);
      mkdirSync(dirname(tgz), { recursive: true });
      writeFileSync(tgz, makeTarball(fx.tarball.manifest));
      const { lines, ok } = run({ consumer: root, pkg: fx.package, tarball: tgz, doc: fx.doc });
      for (const p of Object.keys(fx.files)) lines.push(`--- ${p}`, ...readFileSync(join(root, p), 'utf8').trimEnd().split('\n').filter((l) => l.includes(fx.package) || /\*\*\d/.test(l)));
      console.log(lines.join('\n'));
      process.exit(ok ? 0 : 1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
  if (!v.consumer || !v.package || !v.tarball) { console.error('usage: pin-tarball.mjs --consumer <repo> --package <name> --tarball <file.tgz> [--doc CLAUDE.md] [--dry-run] | --fixture <file> | --env <projects.json> --project <p> --lib <l>'); process.exit(2); }
  const consumer = resolve(v.consumer);
  const { lines, ok } = run({ consumer, pkg: v.package, tarball: resolve(consumer, v.tarball), doc: v.doc, dryRun: v['dry-run'] });
  console.log(lines.join('\n'));
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();

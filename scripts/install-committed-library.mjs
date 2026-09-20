#!/usr/bin/env node
// Install tracked release artifacts without recursively preparing unchanged
// Git dependency graphs. A dependency/peer change must use npm install first.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';

const [consumerArg, repositoryArg, name, commit] = process.argv.slice(2);
if (!consumerArg || !repositoryArg || !/^(@[a-z0-9_-]+\/)?[a-z0-9_-]+$/.test(name ?? '') || !/^[a-f0-9]{40}$/.test(commit ?? '')) {
  throw new Error('Usage: install-committed-library.mjs <consumer> <repository> <dependency-name> <full-commit>');
}
const consumer = resolve(consumerArg), repository = resolve(repositoryArg);
const packageFile = resolve(consumer, 'package.json'), lockFile = resolve(consumer, 'package-lock.json');
const manifest = JSON.parse(readFileSync(packageFile)), lock = JSON.parse(readFileSync(lockFile));
const section = ['dependencies', 'devDependencies'].find(key => manifest[key]?.[name]);
const priorSpec = section && manifest[section][name];
if (!/^github:[^#]+#[a-f0-9]{7,40}$/.test(priorSpec ?? '')) throw new Error('Existing dependency must be a Git commit pin');
const key = `node_modules/${name}`, entry = lock.packages[key];
if (!entry?.resolved?.startsWith('git+')) throw new Error('Existing lock entry must resolve to Git');
if (!entry.resolved.split('#')[1]?.startsWith(priorSpec.split('#')[1])) throw new Error('Manifest and lock commits disagree');
const target = resolve(consumer, key), installed = JSON.parse(readFileSync(resolve(target, 'package.json')));
const temp = mkdtempSync(resolve(tmpdir(), 'committed-library-'));
const stable = value => JSON.stringify(Object.fromEntries(Object.entries(value ?? {}).sort(([a], [b]) => a.localeCompare(b))));
try {
  const archive = execFileSync('git', ['-C', repository, 'archive', '--format=tar', commit], { maxBuffer: 256 * 1024 * 1024 });
  execFileSync('tar', ['-xf', '-', '-C', temp], { input: archive });
  const release = JSON.parse(readFileSync(resolve(temp, 'package.json')));
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta']) {
    if (stable(installed[field]) !== stable(release[field])) throw new Error(`${field} changed; use npm install to resolve the new graph`);
  }
  const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json'], { cwd: temp, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
  const unpacked = resolve(temp, 'unpacked'); mkdirSync(unpacked);
  execFileSync('tar', ['-xf', resolve(temp, packed[0].filename), '-C', unpacked]);
  const next = resolve(unpacked, 'package');
  const backup = resolve(temp, 'previous-package');
  // Keep nested dependency resolution intact: the graph was proved unchanged.
  if (existsSync(resolve(target, 'node_modules'))) renameSync(resolve(target, 'node_modules'), resolve(next, 'node_modules'));
  mkdirSync(dirname(target), { recursive: true });
  renameSync(target, backup);
  try { renameSync(next, target); } catch (error) { renameSync(backup, target); throw error; }
  const spec = priorSpec.replace(/#[a-f0-9]{7,40}$/, `#${commit}`);
  manifest[section][name] = spec;
  lock.packages[''][section][name] = spec;
  entry.version = release.version;
  entry.resolved = entry.resolved.replace(/#[a-f0-9]{40}$/, `#${commit}`);
  delete entry.integrity; // Git object identity is the lockfile's content pin.
  writeFileSync(packageFile, JSON.stringify(manifest, null, 2) + '\n');
  writeFileSync(lockFile, JSON.stringify(lock, null, 2) + '\n');
  console.log(`${name}@${release.version}: installed committed package ${commit} in ${consumer}`);
} finally { rmSync(temp, { recursive: true, force: true }); }

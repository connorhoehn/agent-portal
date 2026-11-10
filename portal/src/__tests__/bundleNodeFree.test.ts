// Run with:  cd portal && node --test 'src/__tests__/bundleNodeFree.test.ts'
// scripts/check-bundle-node-free.mjs over fixture dist folders, and over the
// real portal/dist when a build is present (CI builds before it tests).
// realtime-modules 0.147.0 put async_hooks in the bundle and blanked every page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(import.meta.dirname, '../../scripts/check-bundle-node-free.mjs');
const PORTAL_DIST = resolve(import.meta.dirname, '../../dist');

function run(dist: string) {
  return spawnSync('node', [SCRIPT, '--dist', dist], { encoding: 'utf8' });
}
function check(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'node-free-'));
  try {
    mkdirSync(join(dir, 'assets'));
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, 'assets', name), text);
    return run(dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('a bundle without Node-only markers passes', () => {
  const r = check({ 'index.js': 'export const a = 1;', 'index.js.map': '{"sources":["async_hooks"]}' });
  assert.equal(r.status, 0, r.stdout);
});

test('async_hooks in a script fails and is named', () => {
  const r = check({ 'index.js': 'import "__vite-browser-external:async_hooks";' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /index\.js contains async_hooks/);
});

test('@connorhoehn/service-runtime in a script fails', () => {
  assert.equal(check({ 'vendor.js': 'require("@connorhoehn/service-runtime")' }).status, 1);
});

test('the built portal bundle carries no Node-only code', { skip: !existsSync(PORTAL_DIST) && 'no portal/dist; run npm run build first' }, () => {
  const r = run(PORTAL_DIST);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

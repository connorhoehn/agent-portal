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

const CLEAN_GRAPH = JSON.stringify({ checked: 1200, offenders: [] });

function run(dist: string, graph?: string) {
  return spawnSync('node', [SCRIPT, '--dist', dist, ...(graph ? ['--graph', graph] : [])], { encoding: 'utf8' });
}
function check(files: Record<string, string>, graph: string | null = CLEAN_GRAPH) {
  const dir = mkdtempSync(join(tmpdir(), 'node-free-'));
  try {
    mkdirSync(join(dir, 'dist', 'assets'), { recursive: true });
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, 'dist', 'assets', name), text);
    if (graph !== null) writeFileSync(join(dir, '.module-graph.json'), graph);
    return run(join(dir, 'dist'));
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

test('a build without its module-graph report fails', () => {
  const r = check({ 'index.js': 'export const a = 1;' }, null);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /no module-graph report/);
});

test('a module graph that reaches a stubbed builtin fails even when the assets look clean', () => {
  // Minified, the stub's name is gone from the asset; the graph still has it.
  const graph = JSON.stringify({ checked: 900, offenders: [{ id: '__vite-browser-external:async_hooks', reason: 'stub' }] });
  const r = check({ 'index.js': 'var a=function(){};export{a};' }, graph);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /module graph reaches __vite-browser-external:async_hooks/);
});

test('an empty or malformed module-graph report fails', () => {
  assert.equal(check({ 'index.js': 'export {};' }, JSON.stringify({ checked: 0, offenders: [] })).status, 1);
  assert.equal(check({ 'index.js': 'export {};' }, 'not json').status, 1);
});

test('the graph rule names builtins, stubs and Node-only packages, and nothing else', async () => {
  const { nodeOnlyModules } = await import('../../scripts/node-free-graph.mjs');
  const ids = [
    '\0__vite-browser-external:async_hooks', 'node:crypto', 'fs', 'fs/promises',
    '/repo/node_modules/@connorhoehn/service-runtime/dist/index.js', '@connorhoehn/service-runtime/tracing',
    '/repo/node_modules/react/index.js', '/repo/node_modules/buffer/index.js', '/repo/src/main.tsx',
  ];
  const flagged = nodeOnlyModules(ids).map((o: { id: string }) => o.id);
  assert.deepEqual(flagged, ids.slice(0, 6));
});

test('the built portal bundle carries no Node-only code', { skip: !existsSync(PORTAL_DIST) && 'no portal/dist; run npm run build first' }, () => {
  const r = run(PORTAL_DIST);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

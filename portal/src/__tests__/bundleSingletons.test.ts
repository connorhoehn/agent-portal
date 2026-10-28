// Run with:  cd portal && node --test 'src/__tests__/bundleSingletons.test.ts'
// scripts/check-bundle-singletons.mjs over fixture dist folders (DE-28 check 4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(import.meta.dirname, '../../scripts/check-bundle-singletons.mjs');

function distWith(sources: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'singletons-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'assets/index.js.map'), JSON.stringify({ version: 3, sources }));
  return dir;
}
function check(sources: string[]) {
  const dir = distWith(sources);
  try {
    const res = spawnSync('node', [SCRIPT, '--dist', dir, '--json'], { encoding: 'utf8' });
    return { status: res.status, out: JSON.parse(res.stdout || '{}') as { failures: string[] } };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('one ESM instance of each singleton passes', () => {
  const r = check([
    '../../node_modules/prosemirror-view/dist/index.js', '../../node_modules/@tiptap/core/dist/index.js',
    '../../node_modules/react/index.js', '../../src/App.tsx', '../../node_modules/left-pad/index.cjs',
  ]);
  assert.equal(r.status, 0);
  assert.deepEqual(r.out.failures, []);
});

test('prosemirror-view from a .cjs file fails and is named (editorStackAsEsm removed)', () => {
  const r = check(['../../node_modules/prosemirror-view/dist/index.js', '../../node_modules/prosemirror-view/dist/index.cjs']);
  assert.equal(r.status, 1);
  assert.ok(r.out.failures.some((f) => f.startsWith('prosemirror-view: CommonJS source')), r.out.failures.join('\n'));
});

test('a /cjs/ directory fails, except React, which ships only CommonJS', () => {
  assert.equal(check(['../../node_modules/lib0/cjs/observable.js']).status, 1);
  assert.equal(check(['../../node_modules/react-dom/cjs/react-dom.production.js']).status, 0);
});

test('two install paths for one singleton fail', () => {
  const r = check(['../../node_modules/yjs/dist/yjs.mjs', '../../node_modules/@connorhoehn/realtime-modules/node_modules/yjs/dist/yjs.mjs']);
  assert.equal(r.status, 1);
  assert.ok(r.out.failures.some((f) => f.startsWith('yjs: 2 install paths')));
});

// Run with:  cd portal && node --test 'src/pages/work/__tests__/*.test.ts'

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toToolCallStripItems } from '../toolCallFormat.ts';

test('toToolCallStripItems: undefined and empty both render nothing', () => {
  assert.deepEqual(toToolCallStripItems(undefined), []);
  assert.deepEqual(toToolCallStripItems([]), []);
});

test('toToolCallStripItems: carries name and done through, mints a positional id', () => {
  const items = toToolCallStripItems([
    { name: 'Bash', done: true },
    { name: 'Edit', done: false },
  ]);
  assert.deepEqual(items, [
    { id: '0-Bash', name: 'Bash', done: true },
    { id: '1-Edit', name: 'Edit', done: false },
  ]);
});

test('toToolCallStripItems: two calls to the same tool get distinct ids', () => {
  const items = toToolCallStripItems([
    { name: 'Read', done: true },
    { name: 'Read', done: true },
  ]);
  const ids = items.map((i) => i.id);
  assert.equal(new Set(ids).size, 2);
});

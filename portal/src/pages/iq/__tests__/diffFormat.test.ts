// Run with:  cd portal && node --test 'src/pages/iq/__tests__/*.test.ts'

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { diffStats, lineDiff } from '../diffFormat.ts';

test('lineDiff reports identical texts as entirely unchanged', () => {
  const lines = lineDiff('a\nb\nc', 'a\nb\nc');
  assert.deepEqual(lines, [
    { kind: 'same', text: 'a' },
    { kind: 'same', text: 'b' },
    { kind: 'same', text: 'c' },
  ]);
  assert.deepEqual(diffStats(lines), { added: 0, removed: 0, unchanged: 3 });
});

// `''.split('\n')` is `['']`, not `[]` — an "empty" side still carries one
// blank line through the LCS pass, so it shows up as one extra add/remove
// alongside the real lines. That is the existing DiffPage/PromptHistoryPage
// behavior this file was extracted from, not something introduced here.
test('lineDiff treats an empty base as one blank line plus the real additions', () => {
  const lines = lineDiff('', 'x\ny');
  assert.deepEqual(diffStats(lines), { added: 2, removed: 1, unchanged: 0 });
});

test('lineDiff treats an empty target as one blank line plus the real removals', () => {
  const lines = lineDiff('x\ny', '');
  assert.deepEqual(diffStats(lines), { added: 1, removed: 2, unchanged: 0 });
});

test('lineDiff finds the common subsequence around a changed middle line', () => {
  const lines = lineDiff('one\ntwo\nthree', 'one\nTWO\nthree');
  assert.deepEqual(diffStats(lines), { added: 1, removed: 1, unchanged: 2 });
  assert.equal(lines[0]!.kind, 'same');
  assert.equal(lines[lines.length - 1]!.kind, 'same');
});

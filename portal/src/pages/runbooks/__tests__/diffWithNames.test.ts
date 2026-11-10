// A proposal diff reads account ids as names (UX leftovers, 10 November).
// Run with:  cd portal && node --test src/pages/runbooks/__tests__/diffWithNames.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildNames, diffWithNames } from '../runbookNames.ts';

const DIFF = [
  'diff --git a/data/expected-output.txt b/data/expected-output.txt',
  '--- a/data/expected-output.txt',
  '+++ b/data/expected-output.txt',
  '@@ -1,3 +1,3 @@',
  ' - Nora DaSilva (u-nora) online',
  '-- Omar Haddad (u-omar) online',
  '+- Omar Haddad (u-omar) busy',
  'diff --git a/data/presence-snapshot.json b/data/presence-snapshot.json',
  '@@ -7,3 +7,3 @@',
  '       "u-vera":  { "n": "Vera Green",   "st": "on" },',
  '-      "u-rhea":  { "n": "Rhea Kapoor",  "st": "idle" },',
  '+      "u-zed":   { "st": "idle" },',
].join('\n');

const names = buildNames({ users: [{ id: 'u-nora', name: 'Nora DaSilva' }, { id: 'u-vera', name: 'Vera Green' }, { id: 'u-ghost', name: 'u-ghost' }] });

test('a directory name, or the name the diff pairs with the id, replaces the id; "Name (u-id)" reads once', () => {
  const { text, replaced } = diffWithNames(DIFF, (id) => names.user(id));
  assert.match(text, /^ - Nora DaSilva online$/m);
  assert.match(text, /^\+- Omar Haddad busy$/m, 'Omar is not in this directory; the diff names him');
  assert.match(text, /"Vera Green":  \{ "n": "Vera Green"/);
  assert.match(text, /"Rhea Kapoor":  \{ "n": "Rhea Kapoor"/);
  assert.ok(replaced >= 5);
});

test('an id nothing names stays as written, and the diff headers are untouched', () => {
  const { text } = diffWithNames(DIFF, (id) => names.user(id));
  assert.match(text, /"u-zed":/);
  assert.match(text, /^diff --git a\/data\/expected-output\.txt b\/data\/expected-output\.txt$/m);
  assert.equal(text.split('\n').length, DIFF.split('\n').length, 'line for line, so hunks still count');
});

test('a diff with no account ids is returned unchanged with nothing replaced', () => {
  const plain = 'diff --git a/x b/x\n@@ -1 +1 @@\n-old\n+new';
  assert.deepEqual(diffWithNames(plain, () => 'Someone'), { text: plain, replaced: 0 });
});

test('the directory lookup has no fallback: an unknown or self-named account is null', () => {
  assert.equal(names.user('u-nora'), 'Nora DaSilva');
  assert.equal(names.user('u-omar'), null);
  assert.equal(names.user('u-ghost'), null, 'a "name" that is the id is no name');
  assert.equal(names.user(null), null);
});

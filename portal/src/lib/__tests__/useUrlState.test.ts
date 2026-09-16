// Run with:  cd portal && node --test 'src/lib/__tests__/*.test.ts'
//
// `useUrlState` itself needs a DOM/router to exercise end-to-end; what's
// worth unit-testing without either is `nextSearch`, the pure merge the hook
// is built on. These are the properties that matter for a page composing
// several `useUrlState` calls (or one `useUrlState` plus a hand-rolled facet
// setter, like `LibraryPage.tsx`) on the same URL: a write to one key must
// never touch another key, order must be stable, and deleting the only key
// must not leave a stray `?`.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { nextSearch } from '../useUrlState.ts';

test('sets a key that was absent', () => {
  const current = new URLSearchParams('');
  const next = nextSearch(current, 'window', '24h');
  assert.equal(next.toString(), 'window=24h');
  // `current` itself is untouched — callers pass `prev` from a
  // `setSearchParams` updater and must be free to read it again after.
  assert.equal(current.toString(), '');
});

test('overwrites an existing value for the same key', () => {
  const current = new URLSearchParams('window=1h');
  const next = nextSearch(current, 'window', '7d');
  assert.equal(next.toString(), 'window=7d');
});

test('deletes the key when value is null', () => {
  const current = new URLSearchParams('window=24h&tab=overview');
  const next = nextSearch(current, 'window', null);
  assert.equal(next.toString(), 'tab=overview');
});

test('deleting the only key leaves an empty (not "?") result', () => {
  const current = new URLSearchParams('window=24h');
  const next = nextSearch(current, 'window', null);
  assert.equal(next.toString(), '');
});

test('deleting an absent key is a no-op', () => {
  const current = new URLSearchParams('tab=overview');
  const next = nextSearch(current, 'window', null);
  assert.equal(next.toString(), 'tab=overview');
});

test('never touches sibling params — one call, one key', () => {
  const current = new URLSearchParams('kind=skill&tier=core&q=auth');
  const next = nextSearch(current, 'tier', 'edge');
  assert.equal(next.get('kind'), 'skill');
  assert.equal(next.get('tier'), 'edge');
  assert.equal(next.get('q'), 'auth');
});

test('composes across sequential calls the way two useUrlState hooks on one page would', () => {
  let params = new URLSearchParams('');
  params = nextSearch(params, 'open', 'asset-1');
  params = nextSearch(params, 'kind', 'skill');
  params = nextSearch(params, 'open', null); // drawer closed
  assert.equal(params.get('open'), null);
  assert.equal(params.get('kind'), 'skill');
});

test('setting an empty string is a real value, distinct from deletion', () => {
  const current = new URLSearchParams('');
  const next = nextSearch(current, 'q', '');
  assert.equal(next.has('q'), true);
  assert.equal(next.get('q'), '');
});

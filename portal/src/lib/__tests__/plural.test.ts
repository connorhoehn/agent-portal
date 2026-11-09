// Run with:  cd portal && node --test src/lib/__tests__/plural.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ofTotal, plural, pluralWord } from '../plural.ts';

test('one takes the singular, everything else the plural', () => {
  assert.equal(plural(1, 'error'), '1 error');
  assert.equal(plural(0, 'error'), '0 errors');
  assert.equal(plural(2, 'error'), '2 errors');
  assert.equal(plural(2, 'person', 'people'), '2 people');
  assert.equal(plural(1200, 'run'), '1,200 runs');
  assert.equal(pluralWord(1, 'entry', 'entries'), 'entry');
  assert.equal(pluralWord(3, 'entry', 'entries'), 'entries');
});

test('a shown-of-total count agrees with the total', () => {
  assert.equal(ofTotal(1, 1, 'request'), '1 of 1 request');
  assert.equal(ofTotal(0, 1, 'request'), '0 of 1 request');
  assert.equal(ofTotal(3, 12, 'request'), '3 of 12 requests');
});

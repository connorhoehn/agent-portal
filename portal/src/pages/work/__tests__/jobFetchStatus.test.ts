// Run with:  cd portal && node --test 'src/pages/work/__tests__/*.test.ts'

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isNotFoundFetchError } from '../jobFetchStatus.ts';

test('isNotFoundFetchError recognizes the useFetch 404 shape', () => {
  assert.equal(isNotFoundFetchError('404 Not Found'), true);
  assert.equal(isNotFoundFetchError('404'), true);
});

test('isNotFoundFetchError rejects other statuses and null', () => {
  assert.equal(isNotFoundFetchError('500 Internal Server Error'), false);
  assert.equal(isNotFoundFetchError('403 Forbidden'), false);
  assert.equal(isNotFoundFetchError(null), false);
});

test('isNotFoundFetchError does not substring-match a message that merely mentions 404', () => {
  assert.equal(isNotFoundFetchError('job failed: retried 404 times'), false);
});

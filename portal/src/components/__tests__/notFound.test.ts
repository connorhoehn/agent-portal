// Run with:  cd portal && node --test 'src/components/__tests__/notFound.test.ts'

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isNotFoundError } from '../notFound.ts';

test('isNotFoundError: a 404 status line is a not-found answer', () => {
  assert.equal(isNotFoundError('404 Not Found — design review not found'), true);
  assert.equal(isNotFoundError(' 404 Not Found'), true);
});

test('isNotFoundError: every other failure stays an outage', () => {
  assert.equal(isNotFoundError('500 Internal Server Error — Internal server error'), false);
  // A reason that merely mentions "not found" under a 5xx is still an outage.
  assert.equal(isNotFoundError('503 Service Unavailable — upstream not found'), false);
  assert.equal(isNotFoundError('Failed to fetch'), false);
  assert.equal(isNotFoundError('4040 things'), false);
  assert.equal(isNotFoundError(null), false);
  assert.equal(isNotFoundError(undefined), false);
});

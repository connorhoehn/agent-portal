// Run with:  cd portal && node --test 'src/pages/capabilities/prompts/__tests__/*.test.ts'

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { friendlyLibraryError } from '../libraryError.ts';

test('extracts detail from the canary-library 503 shape', () => {
  const raw = JSON.stringify({
    error: 'Bedrock unavailable',
    detail: 'The security token included in the request is invalid.',
  });
  assert.equal(
    friendlyLibraryError(raw),
    'The security token included in the request is invalid.',
  );
});

test('falls back to error when detail is absent', () => {
  const raw = JSON.stringify({ error: 'Bedrock unavailable' });
  assert.equal(friendlyLibraryError(raw), 'Bedrock unavailable');
});

test('returns the raw string when it is not the known JSON shape', () => {
  assert.equal(friendlyLibraryError('Failed to fetch'), 'Failed to fetch');
});

test('returns the raw string for JSON that is not an object', () => {
  assert.equal(friendlyLibraryError('"just a string"'), '"just a string"');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readableRecordingError } from '../useRecordingRead.ts';

test('readableRecordingError: a transport failure reads as plain copy, never "Failed to fetch"', () => {
  assert.equal(readableRecordingError(new TypeError('Failed to fetch')), 'The recording service is not reachable right now.');
  assert.equal(readableRecordingError(new Error('NetworkError when attempting to fetch resource.')), 'The recording service is not reachable right now.');
  assert.equal(readableRecordingError(new Error('Load failed')), 'The recording service is not reachable right now.');
});

test('readableRecordingError: a service message passes through; anything else gets a fallback', () => {
  assert.equal(readableRecordingError(new Error('The recording could not be associated with this exact call.')), 'The recording could not be associated with this exact call.');
  assert.equal(readableRecordingError('boom'), 'The recording could not be read.');
});

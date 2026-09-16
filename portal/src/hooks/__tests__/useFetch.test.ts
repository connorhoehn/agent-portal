// Run with:  cd portal && node --test --experimental-strip-types 'src/hooks/__tests__/*.test.ts'
//
// useFetch itself needs React + a DOM to exercise end to end, and this repo's
// test setup is plain node:test with no React renderer or jsdom (see
// tenantCaches.test.ts) — so this pins the PURE scheduling helpers the hook's
// visibility-pause and failure-backoff behavior is built from
// (src/hooks/pollSchedule.ts), rather than trying to mount the hook.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { nextPollDelay, isDocumentHidden } from '../pollSchedule.ts';

test('nextPollDelay holds the base interval with no failures', () => {
  assert.equal(nextPollDelay(0, 5_000), 5_000);
  assert.equal(nextPollDelay(-1, 5_000), 5_000);
});

test('nextPollDelay doubles per consecutive failure', () => {
  assert.equal(nextPollDelay(1, 1_000), 2_000);
  assert.equal(nextPollDelay(2, 1_000), 4_000);
});

test('nextPollDelay caps at 5x the base interval', () => {
  assert.equal(nextPollDelay(3, 1_000), 5_000); // 2^3 = 8, capped to 5
  assert.equal(nextPollDelay(4, 1_000), 5_000);
  assert.equal(nextPollDelay(10, 1_000), 5_000);
});

test('nextPollDelay resets to the base interval once failures clears (caller resets on success)', () => {
  assert.equal(nextPollDelay(5, 1_000), 5_000);
  assert.equal(nextPollDelay(0, 1_000), 1_000);
});

test('nextPollDelay is a no-op for a non-polling interval', () => {
  assert.equal(nextPollDelay(3, 0), 0);
  assert.equal(nextPollDelay(3, -1), -1);
});

test('isDocumentHidden reads document.visibilityState when document exists', () => {
  const original = (globalThis as { document?: unknown }).document;
  try {
    (globalThis as { document?: unknown }).document = { visibilityState: 'hidden' };
    assert.equal(isDocumentHidden(), true);
    (globalThis as { document?: unknown }).document = { visibilityState: 'visible' };
    assert.equal(isDocumentHidden(), false);
  } finally {
    (globalThis as { document?: unknown }).document = original;
  }
});

test('isDocumentHidden is false with no document (SSR/node)', () => {
  const original = (globalThis as { document?: unknown }).document;
  try {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete (globalThis as { document?: unknown }).document;
    assert.equal(isDocumentHidden(), false);
  } finally {
    (globalThis as { document?: unknown }).document = original;
  }
});

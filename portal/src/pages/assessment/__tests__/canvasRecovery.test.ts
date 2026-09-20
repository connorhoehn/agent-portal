import assert from 'node:assert/strict';
import test from 'node:test';
import { canvasRecoveryKey, encodeCanvasRecovery, decodeCanvasRecovery } from '../knowledge/canvasRecovery.ts';

test('recovery bytes survive encoding without sharing identity or document keys', () => {
  const bytes = Uint8Array.from({ length: 20_000 }, (_, index) => index % 256);
  assert.deepEqual(decodeCanvasRecovery(encodeCanvasRecovery(bytes)), bytes);
  const key = canvasRecoveryKey('tenant-a', 'alice', 'doc-1');
  assert.notEqual(key, canvasRecoveryKey('tenant-b', 'alice', 'doc-1'));
  assert.notEqual(key, canvasRecoveryKey('tenant-a', 'bob', 'doc-1'));
  assert.notEqual(key, canvasRecoveryKey('tenant-a', 'alice', 'doc-2'));
});
test('unknown or damaged recovery records are not offered', () => {
  for (const value of [null, {}, { version: 2, savedAt: '', snapshot: 'AAAA' }, { version: 1, savedAt: '', snapshot: '!invalid' }]) {
    assert.equal(decodeCanvasRecovery(value), null);
  }
});

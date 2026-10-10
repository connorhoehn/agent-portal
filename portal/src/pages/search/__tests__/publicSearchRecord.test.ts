import assert from 'node:assert/strict';
import { test } from 'node:test';
import { publicSearchRecord } from '../publicSearchRecord.ts';
test('ordinary search uses self-disclosed skills; HR retains the source evidence', () => {
  const nora = { type: 'person' as const, id: 'p-004', title: 'Nora DaSilva', href: '/iq/search', description: 'Private inferred specialties' };
  assert.match(publicSearchRecord(nora, false).description, /OpenTelemetry/);
  assert.doesNotMatch(publicSearchRecord(nora, false).description, /inferred/);
  assert.equal(publicSearchRecord(nora, true), nora);
  assert.match(publicSearchRecord({ ...nora, id: 'unknown' }, false).description, /No self-disclosed/);
});

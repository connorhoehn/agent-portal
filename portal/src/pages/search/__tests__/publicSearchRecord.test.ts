import assert from 'node:assert/strict';
import { test } from 'node:test';
import { publicSearchRecord, publicSearchResult } from '../publicSearchRecord.ts';
test('ordinary search uses self-disclosed skills; HR retains the source evidence', () => {
  const nora = { type: 'person' as const, id: 'p-004', title: 'Nora DaSilva', href: '/iq/search', description: 'Private inferred specialties' };
  assert.match(publicSearchRecord(nora, false).description, /OpenTelemetry/);
  assert.doesNotMatch(publicSearchRecord(nora, false).description, /inferred/);
  assert.equal(publicSearchRecord(nora, true), nora);
  assert.match(publicSearchRecord({ ...nora, id: 'unknown' }, false).description, /No self-disclosed/);
});
test('result rows omit repeated empty prose after privacy filtering, preserving shared skills and portraits', () => {
  const unshared = { type: 'person' as const, id: 'unknown', title: 'A Person', href: '/iq/search', description: 'Private inferred specialty', avatarUrl: '/portrait.jpg', subtitle: 'Engineer · Online' };
  const result = publicSearchResult(unshared, false);
  assert.equal(result.description, undefined);
  assert.equal(result.avatarUrl, unshared.avatarUrl);
  assert.equal(result.subtitle, unshared.subtitle);
  assert.match(publicSearchRecord(unshared, false).description, /No self-disclosed/);
  assert.equal(publicSearchResult(unshared, true), unshared);
  assert.match(publicSearchResult({ ...unshared, id: 'p-004' }, false).description, /OpenTelemetry/);
});

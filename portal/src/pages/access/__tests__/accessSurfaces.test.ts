import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ACCESS_SURFACES, ACCESS_SURFACE_IDS } from '../accessSurfaces.ts';

test('every surface sits under /access in one of the four rail groups', () => {
  for (const id of ACCESS_SURFACE_IDS) {
    const s = ACCESS_SURFACES[id];
    assert.equal(s.id, id);
    assert.match(s.path, /^\/access\//);
    assert.ok(['Request', 'Approve', 'Govern', 'System'].includes(s.group), id);
    assert.ok(s.title && s.description, id);
  }
});

test('composer policy: lists and the record require it; only the form, configuration and placeholder are exempt (decision A9)', () => {
  const exempt = ACCESS_SURFACE_IDS.filter(id => ACCESS_SURFACES[id].composer === 'exempt').sort();
  assert.deepEqual(exempt, ['configuration', 'new-request', 'settings']);
  for (const id of ['catalog', 'requests', 'request', 'approvals', 'policies', 'reviews', 'review', 'audit'] as const) {
    assert.equal(ACCESS_SURFACES[id].composer, 'required', id);
  }
});

test('no surface is a placeholder any more; settings holds delegation (lane A3, 2026-10-14)', () => {
  for (const s of Object.values(ACCESS_SURFACES)) assert.equal(s.next, undefined, s.id);
  assert.equal(ACCESS_SURFACES.settings.phase, 'A3');
  assert.match(ACCESS_SURFACES.settings.description, /Delegate your approval decisions/);
  // Lane A2 brought the campaigns: Reviews has data now, and says what an empty list means instead of naming a lane.
  assert.equal(ACCESS_SURFACES.reviews.phase, 'A2');
  assert.equal(ACCESS_SURFACES.reviews.next, undefined);
  assert.ok(ACCESS_SURFACES.reviews.emptyTitle && ACCESS_SURFACES.reviews.emptyBody);
});

test('the request record carries its discussion (lane A1: the gateway admits access:req:<id>)', () => {
  assert.equal(ACCESS_SURFACES.request.composer, 'required');
  assert.match(ACCESS_SURFACES.request.description, /discussion/);
});

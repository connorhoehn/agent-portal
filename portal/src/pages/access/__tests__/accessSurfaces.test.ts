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
  for (const id of ['catalog', 'requests', 'request', 'approvals', 'policies', 'reviews', 'audit'] as const) {
    assert.equal(ACCESS_SURFACES[id].composer, 'required', id);
  }
});

test('a surface whose data is not here yet names the lane that brings it', () => {
  for (const id of ['reviews', 'settings'] as const) {
    const s = ACCESS_SURFACES[id];
    assert.ok(s.emptyTitle && s.emptyBody && s.next, id);
    assert.match(s.next!, new RegExp(`Lane ${s.phase}`));
  }
  assert.equal(ACCESS_SURFACES.reviews.phase, 'A2');
});

test('the request record carries its discussion (lane A1: the gateway admits access:req:<id>)', () => {
  assert.equal(ACCESS_SURFACES.request.composer, 'required');
  assert.match(ACCESS_SURFACES.request.description, /discussion/);
});

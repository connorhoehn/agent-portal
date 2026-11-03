import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listRailPlacementProblems as check } from './list-rail-profile.mjs';

test('combined catalog occupies the content edge without a redundant rail', () => {
  const valid = { combined: true, contentLeft: 240, section: null, list: { left: 240 } };
  assert.deepEqual(check(valid), []);
  assert.equal(check({ ...valid, list: { left: 264 } }).length, 1);
  assert.equal(check({ ...valid, section: { right: 240 } }).length, 1);
});
test('ordinary list rails still require their section rail and adjacency', () => {
  const valid = { combined: false, contentLeft: 240, section: { right: 504 }, list: { left: 504 } };
  assert.deepEqual(check(valid), []);
  assert.equal(check({ ...valid, section: null }).length, 1);
  assert.equal(check({ ...valid, list: { left: 528 } }).length, 1);
});

import { listRailWidthProblems } from './list-rail-profile.mjs';
test('default rail widths distinguish ordinary, combined and explicitly folded layouts', () => {
  for (const profile of [{ width: 264 }, { combined: true, width: 320 }, { collapsed: true, width: 36 }, { combined: true, collapsed: true, width: 36 }]) {
    assert.deepEqual(listRailWidthProblems(profile), []);
    assert.equal(listRailWidthProblems({ ...profile, width: profile.width + 8 }).length, 1);
  }
  assert.equal(listRailWidthProblems({ width: 320 }).length, 1);
  assert.equal(listRailWidthProblems({ width: 36 }).length, 1);
  assert.equal(listRailWidthProblems({ combined: true, width: 264 }).length, 1);
});

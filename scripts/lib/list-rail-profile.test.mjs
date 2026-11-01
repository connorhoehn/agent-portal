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

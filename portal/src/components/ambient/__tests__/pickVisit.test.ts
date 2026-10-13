import assert from 'node:assert/strict';
import { test } from 'node:test';

import { pickVisit as pick, VISIT_INTERVAL_MS } from '../pickVisit.ts';

test('visits are a minute apart', () => assert.equal(VISIT_INTERVAL_MS, 60_000));

test('a visit lands on any surface, stops inside the surface and can walk either way', () => {
  const seq = (...v: number[]) => { let i = 0; return () => v[i++ % v.length]!; };
  assert.equal(pick(4, seq(0, 0, 0)).index, 0);
  assert.equal(pick(4, seq(0.99, 0, 0)).index, 3);
  const lo = pick(3, seq(0, 0, 0.9)), hi = pick(3, seq(0, 0.999, 0.1));
  assert.ok(lo.stopAt >= 0.15 && hi.stopAt <= 0.85);
  assert.equal(lo.reverse, false); assert.equal(hi.reverse, true);
});

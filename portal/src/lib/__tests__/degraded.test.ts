// Run with:  cd portal && node --test 'src/lib/__tests__/*.test.ts'
//
// `readDegraded` is the portal half of the wire convention routes/cost.ts set:
// a read that failed answers 200 with an ordinary-looking empty collection
// PLUS `degraded: true` and the first line of the error. The whole value of
// that marker is one distinction — "we could not look" vs "there is nothing
// here" — so these tests are mostly about the second half of it. A guard that
// fires on an honest empty answer is worse than no guard: it turns every quiet
// hour into an alarm and trains the reader to ignore the banner.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readDegraded, firstDegraded } from '../degraded.ts';

test('a healthy answer is never marked, whatever its shape', () => {
  // The object family: an empty list with no marker is an honest empty.
  assert.equal(readDegraded({ errors: [] }), null);
  assert.equal(readDegraded({ byAgent: [], windowHours: 24 }), null);
  assert.equal(readDegraded({ points: [], bucketMin: 30, windowHours: 6 }), null);
  // Nothing at all.
  assert.equal(readDegraded(null), null);
  assert.equal(readDegraded(undefined), null);
  assert.equal(readDegraded('a string'), null);
  assert.equal(readDegraded(42), null);
});

test('the marker is read off shape, not presence', () => {
  // `degraded` present but false, or truthy-but-not-true, is not the marker.
  assert.equal(readDegraded({ errors: [], degraded: false }), null);
  assert.equal(readDegraded({ errors: [], degraded: 'true' }), null);
  assert.equal(readDegraded({ errors: [], degraded: 1 }), null);
  assert.equal(
    readDegraded({ errors: [], degraded: true, error: 'relation "tool_calls" does not exist' }),
    'relation "tool_calls" does not exist',
  );
});

test('a marker with no usable message still renders as a failure', () => {
  // The server promises `error`, but a banner that says nothing is worse than
  // one that admits it does not know why.
  assert.equal(readDegraded({ errors: [], degraded: true }), 'the server did not say why');
  assert.equal(readDegraded({ errors: [], degraded: true, error: '   ' }), 'the server did not say why');
  assert.equal(readDegraded({ errors: [], degraded: true, error: 42 }), 'the server did not say why');
});

test('drift/summary: an ARRAY is always a real reading', () => {
  // GET /api/observability/drift/summary answers a bare array when healthy —
  // an array has nowhere to put a marker — and the object form ONLY on
  // failure. Consumers write `Array.isArray(x) ? x : []`, which is exactly how
  // the failure used to vanish. Both halves must be handled here.
  assert.equal(readDegraded([]), null);
  assert.equal(
    readDegraded([{ agentId: 'orgiq-supervisor', count: 12, schemaConformance: 1 }]),
    null,
  );
  // An array cannot be claimed degraded even if someone bolts the property on.
  const weird = Object.assign([], { degraded: true, error: 'boom' });
  assert.equal(readDegraded(weird), null);

  // The failure branch of that same endpoint.
  assert.equal(
    readDegraded({ agents: [], degraded: true, error: 'type "vector" does not exist' }),
    'type "vector" does not exist',
  );
});

test('firstDegraded reports one sentence for a fan-out of reads', () => {
  const healthy = { points: [] };
  const broken = { byAgent: [], degraded: true, error: 'AccessDeniedException' };
  assert.equal(firstDegraded(healthy, healthy, healthy), null);
  assert.equal(firstDegraded(healthy, broken, healthy), 'AccessDeniedException');
  // Order is the caller's: the first failure wins, the rest are the same story.
  assert.equal(
    firstDegraded(broken, { x: [], degraded: true, error: 'second' }),
    'AccessDeniedException',
  );
  // Loading (null) reads as healthy — a spinner is not a failure.
  assert.equal(firstDegraded(null, null), null);
});

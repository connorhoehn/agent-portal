// Run with:  cd portal && node --test 'src/pages/project-detail/__tests__/*.test.ts'
//
// Plain node:test. personCardState is pure TypeScript (no DOM, no timers —
// those live in the component), so Node's type-stripping loader runs it
// directly.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  initialPersonCardState,
  isPersonCardVisible,
  personCardReducer,
  type PersonCardState,
} from '../personCardState.ts';

test('starts closed', () => {
  assert.deepEqual(initialPersonCardState, { hoverOpen: false, pinned: false });
  assert.equal(isPersonCardVisible(initialPersonCardState), false);
});

test('hover-open then hover-close is a plain round trip, not a pin', () => {
  let s = personCardReducer(initialPersonCardState, { type: 'hover-open' });
  assert.equal(isPersonCardVisible(s), true);
  assert.equal(s.pinned, false);
  s = personCardReducer(s, { type: 'hover-close' });
  assert.equal(isPersonCardVisible(s), false);
});

test('toggle-pin opens and closes independently of hover', () => {
  let s = personCardReducer(initialPersonCardState, { type: 'toggle-pin' });
  assert.equal(s.pinned, true);
  assert.equal(isPersonCardVisible(s), true);
  s = personCardReducer(s, { type: 'toggle-pin' });
  assert.equal(s.pinned, false);
  assert.equal(isPersonCardVisible(s), false);
});

test('hover-close does not un-pin — mouse leaving a pinned card must not hide it', () => {
  const pinned: PersonCardState = { hoverOpen: true, pinned: true };
  const s = personCardReducer(pinned, { type: 'hover-close' });
  assert.equal(s.pinned, true);
  assert.equal(isPersonCardVisible(s), true);
});

test('dismiss (Escape) clears both hover and pin regardless of how it opened', () => {
  const hoverOnly = personCardReducer(initialPersonCardState, { type: 'dismiss' });
  assert.deepEqual(hoverOnly, initialPersonCardState); // no-op when already closed

  const opened = personCardReducer(initialPersonCardState, { type: 'hover-open' });
  assert.deepEqual(personCardReducer(opened, { type: 'dismiss' }), { hoverOpen: false, pinned: false });

  const pinned = personCardReducer(initialPersonCardState, { type: 'toggle-pin' });
  assert.deepEqual(personCardReducer(pinned, { type: 'dismiss' }), { hoverOpen: false, pinned: false });

  const both = personCardReducer(opened, { type: 'toggle-pin' });
  assert.deepEqual(personCardReducer(both, { type: 'dismiss' }), { hoverOpen: false, pinned: false });
});

test('reducer returns the same reference when an action is a no-op', () => {
  // Not load-bearing for correctness, but a reducer that always allocates
  // defeats a memoized consumer for no reason.
  assert.equal(personCardReducer(initialPersonCardState, { type: 'hover-close' }), initialPersonCardState);
  assert.equal(personCardReducer(initialPersonCardState, { type: 'dismiss' }), initialPersonCardState);
});

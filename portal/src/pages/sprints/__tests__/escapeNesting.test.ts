// Run with:  cd portal && node --test 'src/pages/sprints/__tests__/*.test.ts'

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  escapeNestReducer, shouldHostHandleEscape, topEscapeLayer,
  INITIAL_ESCAPE_NEST_STATE, type EscapeNestState,
} from '../escapeNesting.ts';

test('an empty stack tells the host to handle Escape itself', () => {
  assert.equal(shouldHostHandleEscape(INITIAL_ESCAPE_NEST_STATE), true);
  assert.equal(topEscapeLayer(INITIAL_ESCAPE_NEST_STATE), null);
});

test('opening a layer takes Escape away from the host', () => {
  const s = escapeNestReducer(INITIAL_ESCAPE_NEST_STATE, { type: 'open', id: 'add' });
  assert.equal(shouldHostHandleEscape(s), false);
  assert.equal(topEscapeLayer(s), 'add');
});

test('escape pops exactly one layer, innermost first', () => {
  let s: EscapeNestState = INITIAL_ESCAPE_NEST_STATE;
  s = escapeNestReducer(s, { type: 'open', id: 'add' });
  s = escapeNestReducer(s, { type: 'open', id: 'confirm' });
  assert.deepEqual(s.stack, ['add', 'confirm']);

  s = escapeNestReducer(s, { type: 'escape' });
  assert.equal(topEscapeLayer(s), 'add');
  assert.equal(shouldHostHandleEscape(s), false);

  s = escapeNestReducer(s, { type: 'escape' });
  assert.equal(topEscapeLayer(s), null);
  assert.equal(shouldHostHandleEscape(s), true);

  // A third Escape has nothing left to pop — the host takes the next one,
  // which is exactly the drawer-closes-and-returns-focus behavior.
  s = escapeNestReducer(s, { type: 'escape' });
  assert.deepEqual(s.stack, []);
});

test('close removes a specific layer, e.g. a Cancel button rather than Escape', () => {
  let s: EscapeNestState = INITIAL_ESCAPE_NEST_STATE;
  s = escapeNestReducer(s, { type: 'open', id: 'edit:g-1' });
  s = escapeNestReducer(s, { type: 'close', id: 'edit:g-1' });
  assert.deepEqual(s.stack, []);
  assert.equal(shouldHostHandleEscape(s), true);
});

test('closing an id that is not open is a no-op, not an error', () => {
  const s = escapeNestReducer(INITIAL_ESCAPE_NEST_STATE, { type: 'close', id: 'nope' });
  assert.equal(s, INITIAL_ESCAPE_NEST_STATE);
});

test('opening the same id twice does not duplicate it on the stack', () => {
  let s: EscapeNestState = INITIAL_ESCAPE_NEST_STATE;
  s = escapeNestReducer(s, { type: 'open', id: 'add' });
  s = escapeNestReducer(s, { type: 'open', id: 'add' });
  assert.deepEqual(s.stack, ['add']);
});

test('escape on an empty stack is a no-op (returns the same reference)', () => {
  const s = escapeNestReducer(INITIAL_ESCAPE_NEST_STATE, { type: 'escape' });
  assert.equal(s, INITIAL_ESCAPE_NEST_STATE);
});

// GrantsPanel/SprintBoard never dispatch the generic `{ type: 'escape' }`
// action directly — Escape and the Cancel button both resolve the layer's id
// first (`topEscapeLayer`) and close it by that id, because closing by id is
// what also carries the focus-restore side effect (see GrantsPanel's
// `closeAdd`/`closeEdit`). This test pins the invariant that makes that safe:
// for a single open layer, popping it by its own id produces the exact same
// stack a bare `escape` pop would. If a future edit swaps the Escape path to
// `dispatchNest({ type: 'escape' })` for convenience, it would silently skip
// whatever close helper carries the focus-restore — this test does not catch
// that mistake directly (it is a DOM effect, not reducer state) but documents
// why the id-targeted form is required, not incidental.
test('closing the top layer by id matches a generic escape pop, for one open layer', () => {
  const opened = escapeNestReducer(INITIAL_ESCAPE_NEST_STATE, { type: 'open', id: 'add' });
  const byId = escapeNestReducer(opened, { type: 'close', id: topEscapeLayer(opened)! });
  const byEscape = escapeNestReducer(opened, { type: 'escape' });
  assert.deepEqual(byId, byEscape);
});

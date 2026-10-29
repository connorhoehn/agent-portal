// Run with:  cd portal && node --test 'src/pages/admin/__tests__/changesFormat.test.ts'
//
// DE-42 split ManageDevbox into per-route actions; these pin which button on
// the Changes queue and the review page asks which one, and the one
// per-instance refusal the page can know in advance (the author's own change).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CHANGE_ACTION_CAPABILITY, SELF_APPROVAL_REASON, changeActionGate, type ChangeCapability,
} from '../changesFormat.ts';

const viewer = (held: ChangeCapability[], sub = 'u-reviewer') => ({
  ready: true,
  sub,
  can: (a: ChangeCapability) => held.includes(a),
});

test('each control asks the action its route checks (middleware/src/routes/sdlc.ts)', () => {
  assert.deepEqual(CHANGE_ACTION_CAPABILITY, {
    decide: 'DecideAgentChange',     // POST /changes/:id/decide
    deliver: 'DeliverAgentChange',   // POST /changes/:id/deliver
    address: 'RunDevboxTask',        // POST /changes/:id/address
    rereview: 'RunDevboxTask',       // POST /changes/:id/rereview
  });
});

test('a role with only the decision right sees decide, not deliver or dispatch', () => {
  const v = viewer(['DecideAgentChange']);
  const change = { requestedBy: 'u-author' };
  assert.equal(changeActionGate('decide', change, v).show, true);
  assert.equal(changeActionGate('deliver', change, v).show, false);
  assert.equal(changeActionGate('address', change, v).show, false);
  assert.equal(changeActionGate('rereview', change, v).show, false);
});

test('the author sees Approve/Reject disabled with the server\'s own 409 reason', () => {
  const v = viewer(['DecideAgentChange', 'DeliverAgentChange', 'RunDevboxTask'], 'u-author');
  const own = changeActionGate('decide', { requestedBy: 'u-author' }, v);
  assert.equal(own.show, true);
  assert.equal(own.disabled, true);
  assert.equal(own.reason, SELF_APPROVAL_REASON);
  // The author rule is a DECIDE rule only (DE-43): delivering their own
  // approved change is the server's business, not refused here.
  assert.equal(changeActionGate('deliver', { requestedBy: 'u-author' }, v).disabled, false);
});

test('an unattributed change (no requestedBy) is decidable by any holder', () => {
  const v = viewer(['DecideAgentChange'], 'u-author');
  const g = changeActionGate('decide', { requestedBy: null }, v);
  assert.equal(g.show, true);
  assert.equal(g.disabled, false);
  assert.equal(g.reason, null);
});

test('nothing renders before the capability probe settles', () => {
  const v = { ...viewer(['DecideAgentChange']), ready: false };
  assert.equal(changeActionGate('decide', { requestedBy: null }, v).show, false);
});

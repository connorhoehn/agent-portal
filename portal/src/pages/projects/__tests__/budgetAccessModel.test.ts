import { test } from 'node:test';
import assert from 'node:assert/strict';
import { budgetLock, openStatusText, quickRequestProblem, quickRequestState, requestHref, waitingOn } from '../budgetAccessModel.ts';
import type { AccessRequest } from '../../../lib/accessRequests.ts';
import type { ProjectSummary } from '../types.ts';

const LOCK = { visible: false as const, reason: 'tier', requestItemId: 'capability:orgiq:budgets-read' };
const req = (over: Partial<AccessRequest>): AccessRequest => ({
  id: 'req-0007', kind: 'grant', reviewId: null,
  requester: { id: 'u-theo', displayName: 'Theo Chang' }, beneficiary: { id: 'u-theo', displayName: 'Theo Chang' },
  item: { id: LOCK.requestItemId } as AccessRequest['item'], justification: 'x', duration: '30d', status: 'submitted',
  steps: [{ step: 1, kind: 'steward', status: 'current', eligible: [{ id: 'u-priya', displayName: 'Priya Venkataraman' }], escalated: 'Escalated' }],
  submittedAt: '2026-10-13T10:00:00.000Z', sod: { verdict: 'clear', conflicts: [] },
  can: { decide: false, withdraw: true, viewAudit: true }, thread: 'access:req:req-0007', ...over,
} as AccessRequest);

test('budgetLock reads the server lock off the rows, and nothing when the figures shipped', () => {
  assert.deepEqual(budgetLock([{ id: 'p', name: 'P', budgetAccess: LOCK } as ProjectSummary]), LOCK);
  assert.equal(budgetLock([{ id: 'p', name: 'P', agentSpendUsd: 2 } as ProjectSummary]), null);
  assert.equal(budgetLock(null), null);
});

test('the newest request decides the header: open, approved, granted, or ask again after a closed one', () => {
  assert.deepEqual(quickRequestState([]), { kind: 'none' });
  const open = quickRequestState([req({})]);
  assert.equal(open.kind, 'open');
  assert.equal(open.kind === 'open' && openStatusText(open), 'Requested — waiting on Priya Venkataraman');
  assert.equal(quickRequestState([req({ status: 'active' })]).kind, 'granted');
  assert.equal(quickRequestState([req({ status: 'approved' })]).kind, 'approved');
  assert.equal(quickRequestState([req({ status: 'rejected' })]).kind, 'none');
  assert.equal(quickRequestState([req({ status: 'rejected', submittedAt: '2026-10-12T00:00:00.000Z' }), req({ id: 'req-0008' })]).kind, 'open');
});

test('waitingOn names the live eligible deciders, briefly', () => {
  assert.equal(waitingOn(req({ steps: [{ step: 1, kind: 'manager', status: 'current', eligible: [] }] })), 'your manager');
  const three = [{ id: 'a', displayName: 'A' }, { id: 'b', displayName: 'B' }, { id: 'c', displayName: 'C' }];
  assert.equal(waitingOn(req({ steps: [{ step: 1, kind: 'steward', status: 'current', eligible: three }] })), 'A or 2 others');
});

test('the record link only for someone who can open Access', () => {
  assert.equal(requestHref('req-0007', { orgiq: ['member'] }), null);
  assert.equal(requestHref('req-0007', { orgiq: ['member'], access: ['requester'] }), '/access/requests/req-0007');
});

test('the form needs 20 characters of justification and an offered duration', () => {
  assert.match(quickRequestProblem('too short', '30d')!, /at least 20/);
  assert.match(quickRequestProblem('I run the weekly delivery review.', '')!, /how long/);
  assert.equal(quickRequestProblem('I run the weekly delivery review.', '30d'), null);
});

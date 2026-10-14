// Escalation timers and delegation in the portal (2026-10-14): the step lines
// the request record and the inbox show, and the delegation form's rules
// (/access/settings) before anything is sent.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DELEGATION_WINDOWS, EMPTY_DELEGATION, EVENT_LABELS, decidedByLabel, delegationBody, delegationProblem, delegationWindowLabel, eligibleLabel,
  escalationLabel, eventHref, type RequestStep,
} from '../../../lib/accessRequests.ts';

const omar = { id: 'u-omar', displayName: 'Omar Haddad' };
const priya = { id: 'u-priya', displayName: 'Priya Venkataraman' };
const step = (over: Partial<RequestStep> = {}): RequestStep => ({ step: 1, kind: 'manager', status: 'current', eligible: [omar], escalated: null, escalationLevel: 0, ...over });
const NOW = Date.parse('2026-10-14T09:00:00.000Z');
const at = (h: number) => new Date(NOW + h * 3_600_000).toISOString();

test('a delegate is shown deciding for their delegator, before and after the decision', () => {
  assert.equal(eligibleLabel(step({ eligible: [omar, { ...priya, onBehalfOf: omar }] }), 'submitted'), 'Omar Haddad, Priya Venkataraman (for Omar Haddad)');
  assert.equal(decidedByLabel({ decidedBy: priya, decidedOnBehalfOf: omar }), 'Priya Venkataraman, on behalf of Omar Haddad');
  assert.equal(eligibleLabel(step({ status: 'approved', decidedBy: priya, decidedOnBehalfOf: omar }), 'pending'), 'Priya Venkataraman, on behalf of Omar Haddad');
  assert.equal(decidedByLabel({ decidedBy: omar, decidedOnBehalfOf: null }), 'Omar Haddad');
  assert.equal(decidedByLabel({ decidedBy: null }), null);
});

test('the escalation line says where a waiting step stands and when it moves next', () => {
  assert.equal(escalationLabel(step({ escalatesAt: at(45) }), NOW), 'Escalates to the access admins in 45 h if undecided.');
  assert.equal(escalationLabel(step({ escalationLevel: 1, escalatesAt: at(72) }), NOW), 'Escalated to the access admins. Escalates to the platform admins in 3 days if undecided.');
  assert.equal(escalationLabel(step({ escalationLevel: 2, escalatesAt: null }), NOW), 'Escalated to the platform admins.');
  assert.equal(escalationLabel(step({ escalatesAt: at(-1) }), NOW), 'Escalates to the access admins at the next sweep if undecided.');
  // A step waiting on the requester (information asked) or never escalated and not current says nothing.
  assert.equal(escalationLabel(step({ status: 'info-requested', escalatesAt: null }), NOW), null);
  assert.equal(escalationLabel(step({ status: 'waiting', escalatesAt: null }), NOW), null);
});

test('the delegation form refuses what the server would, before sending', () => {
  assert.equal(delegationProblem(EMPTY_DELEGATION), 'Choose who decides for you.');
  assert.equal(delegationProblem({ ...EMPTY_DELEGATION, delegateId: 'u-priya' }), 'Say why in at least 10 characters.');
  assert.equal(delegationProblem({ delegateId: 'u-priya', window: '90d', reason: 'Out of office all week.' }), 'Choose how long.');
  assert.equal(delegationProblem({ delegateId: 'u-priya', window: '7d', reason: 'Out of office all week.' }), null);
  // Every offered window fits the server's 30-day cap.
  assert.ok(DELEGATION_WINDOWS.every((w) => w.hours <= 30 * 24));
});

test('the body starts now and ends after the chosen window', () => {
  assert.deepEqual(delegationBody({ delegateId: 'u-priya', window: '3d', reason: '  Summit travel.  ' }, NOW),
    { delegateId: 'u-priya', startsAt: at(0), endsAt: at(72), reason: 'Summit travel.' });
});

test('delegation events and windows read as people expect', () => {
  assert.equal(EVENT_LABELS.escalated, 'Escalated');
  assert.equal(EVENT_LABELS.delegated, 'Delegated');
  assert.equal(EVENT_LABELS['delegation-ended'], 'Delegation ended');
  assert.equal(eventHref({ requestId: null, policyId: null, delegationId: 'dlg-0001' }), '/access/settings');
  assert.equal(delegationWindowLabel({ startsAt: '2026-10-14T12:00:00Z', endsAt: '2026-10-17T12:00:00Z', endedAt: null }, 'en-US'), 'Oct 14 – Oct 17');
  assert.equal(delegationWindowLabel({ startsAt: '2026-10-14T12:00:00Z', endsAt: '2026-10-17T12:00:00Z', endedAt: '2026-10-15T12:00:00Z' }, 'en-US'), 'Oct 14 – Oct 15 (ended early)');
});

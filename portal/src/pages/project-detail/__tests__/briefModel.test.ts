// Run with:  cd portal && node --test 'src/pages/project-detail/__tests__/*.test.ts'
//
// The Brief tab: three rows derived from reads, each read's pending/failed
// state kept distinct from "nothing written".

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { briefFacts, buildBrief, itemFlags, nextStepCallout, priorityTag } from '../briefModel.ts';
import { workRows } from '../workListModel.ts';
import type { Criterion, ThreadComment } from '../useWorkItemThread.ts';
import type { ProjectDecision } from '../types.ts';
import { OBS_TREE } from './obsFixture.ts';

const b4 = workRows(OBS_TREE, 'priority', '').find((r) => r.id === 'wi-obs-e2-b4')!;
const crit = (id: string, done = false) => ({ id, done } as Criterion);
const comment = (id: string, isSystem = false) => ({ id, isSystem } as ThreadComment);
const decision = (id: string, workItemId: string | null) => ({ id, workItemId } as ProjectDecision);

test('an empty brief reads the mockup rows, with member writes disabled and drafting open', () => {
  const m = buildBrief({
    itemId: b4.id, canEdit: false,
    criteria: { data: [] }, decisions: { data: [decision('d1', 'other')] }, comments: { data: [comment('c1', true)] },
  });
  assert.deepEqual(m.rows.map((r) => [r.label, r.value, r.action?.label, r.action?.disabledReason]), [
    ['Acceptance criteria', 'Not defined yet', 'Draft with agent', null],
    ['Dependencies and decisions', 'No links added', 'Add context', 'Your role cannot edit work items'],
    ['Planning notes', 'No notes added', 'Add a note', 'Your role cannot edit work items'],
  ]);
  assert.ok(m.rows.every((r) => r.muted && !r.filled));
  assert.equal(m.showTable, true);
});

test('filled rows count from rows; all three filled hides the table', () => {
  const m = buildBrief({
    itemId: b4.id, canEdit: true,
    criteria: { data: [crit('a', true), crit('b'), crit('c')] },
    decisions: { data: [decision('d1', b4.id), decision('d2', b4.id), decision('d3', null)] },
    comments: { data: [comment('c1'), comment('c2', true)] },
  });
  assert.deepEqual(m.rows.map((r) => [r.value, r.action?.label, r.action?.disabledReason]), [
    ['3 defined · 1 met', 'Edit', null],
    ['2 linked', 'Add context', null],
    ['1 note', 'Add a note', null],
  ]);
  assert.equal(m.showTable, false);
});

test('a pending or failed read is its own state, never "Not defined yet"', () => {
  const m = buildBrief({
    itemId: b4.id, canEdit: true,
    criteria: { data: null }, decisions: { data: [], error: 'HTTP 503' }, comments: { data: undefined },
  });
  assert.deepEqual(m.rows.map((r) => [r.state, r.value, r.action]), [
    ['loading', 'Loading…', null],
    ['error', "Couldn't load decisions", null],
    ['loading', 'Loading…', null],
  ]);
});

test('meta flags and priority tag: Blocked while to do; "High priority"', () => {
  assert.deepEqual(itemFlags(b4), [{ label: 'Blocked', tone: 'danger' }]);
  assert.deepEqual(itemFlags({ ...b4, status: 'done' }), []);
  assert.equal(priorityTag('high').label, 'High priority');
});

test('the next-step callout comes from the row, and hides without one', () => {
  assert.deepEqual(nextStepCallout(b4), {
    title: 'Next step',
    step: 'Confirm the dependency map with Eli Garcia.',
    detail: 'The team needs this before choosing how to group duplicate alerts.',
    actionLabel: 'Open discussion',
  });
  assert.equal(nextStepCallout({ nextStep: '  ', nextStepDetail: 'x' }), null);
});

test('a decision the item waits on is live state: open, then decided, then the next unmet criterion (second regression walk)', () => {
  const decision = { id: 'd-cut', topic: 'Cutover order for legacy SSO tenants', summary: null, status: 'escalated', requiredRole: 'org-leader', escalatedAt: null, workItemId: 'wi-s2', workItemTitle: null };
  const reason = 'Blocked on "Cutover order for legacy SSO tenants", escalated to Sienna Garcia. She decides once the second internal rehearsal passes.';
  const story = { id: 'wi-s2', labels: ['runbook', 'blocked'], blockedReason: reason, blockedByDecisionId: 'd-cut', nextStep: null, nextStepDetail: null };
  const criteria = [
    { text: 'Record the decided tenant order and the reason for it', done: false, position: 2 },
    { text: 'Rehearse the cutover on both internal tenants with zero forced logouts', done: true, position: 0 },
    { text: 'Pre-flight: the tenant origin is in the Cognito app client CallbackURLs before the flip', done: false, position: 1 },
  ];
  // Waiting: the decision comes first; the block's reason says who and when.
  assert.deepEqual(nextStepCallout(story, { decisions: [decision], criteria }), {
    title: 'Next step', step: 'The escalated decision "Cutover order for legacy SSO tenants" comes first.', detail: reason, actionLabel: 'Open discussion',
  });
  // Decided: the settle drops the label and the reason and keeps the link; nobody "decides" any more.
  const settled = { ...story, labels: ['runbook'], blockedReason: null };
  const decided = nextStepCallout(settled, { decisions: [{ ...decision, status: 'resolved' }], criteria });
  assert.deepEqual(decided, {
    title: 'Next step', step: 'Pre-flight: the tenant origin is in the Cognito app client CallbackURLs before the flip.',
    detail: '"Cutover order for legacy SSO tenants" is decided.', actionLabel: 'Open discussion',
  });
  assert.doesNotMatch(JSON.stringify(decided), /decides|waits|escalated/);
  // Rejected: still blocked, replanned.
  const rejected = nextStepCallout({ ...story, blockedReason: 'Decision rejected: Cutover order for legacy SSO tenants' }, { decisions: [{ ...decision, status: 'rejected' }], criteria });
  assert.equal(rejected?.step, 'Replan this item: the decision "Cutover order for legacy SSO tenants" was rejected.');
  // The decisions read not loaded yet: the row's own step, or nothing.
  assert.equal(nextStepCallout(story), null);
  // An open decision the item is NOT blocked on leaves the row's own step.
  const own = { id: 'wi-llm', labels: [], blockedReason: null, blockedByDecisionId: null, nextStep: 'Nina Rivera decides the judge model.', nextStepDetail: null };
  assert.equal(nextStepCallout(own, { decisions: [{ ...decision, status: 'open', workItemId: 'wi-llm' }] })?.step, 'Nina Rivera decides the judge model.');
});

test('brief facts: unknown criteria stay unknown', () => {
  assert.deepEqual(briefFacts(b4, { data: [] }), { criteriaCount: 0, blocked: true, assigneeFirstName: 'Eli' });
  assert.equal(briefFacts(b4, { data: [], error: 'x' }).criteriaCount, null);
});

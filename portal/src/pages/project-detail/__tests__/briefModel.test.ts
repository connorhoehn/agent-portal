// Run with:  cd portal && node --test 'src/pages/project-detail/__tests__/*.test.ts'
//
// The Brief tab: three rows derived from reads, each read's pending/failed
// state kept distinct from "nothing written", and the Run setup hint.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { briefFacts, buildBrief, itemFlags, nextStepCallout, priorityTag, runSetupHint } from '../briefModel.ts';
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

test('run setup hint: no dispatch, sme without grant, then the run facts', () => {
  assert.equal(runSetupHint({ canDispatch: false, isSme: false, hasGrant: null }), 'SME or release manager required to dispatch');
  assert.equal(runSetupHint({ canDispatch: true, isSme: true, hasGrant: false }), 'Needs an active sprint grant on this initiative');
  assert.equal(runSetupHint({ canDispatch: true, isSme: true, hasGrant: null, model: 'Haiku 4.5', repo: 'org/obs', capUsd: 5 }), 'Haiku 4.5 · org/obs · cap $5.00');
  assert.equal(runSetupHint({ canDispatch: true, isSme: false, hasGrant: null }), 'Ready to dispatch');
});

test('brief facts: unknown criteria stay unknown', () => {
  assert.deepEqual(briefFacts(b4, { data: [] }), { criteriaCount: 0, blocked: true, assigneeFirstName: 'Eli' });
  assert.equal(briefFacts(b4, { data: [], error: 'x' }).criteriaCount, null);
});

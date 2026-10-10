import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCORECARD_TABS, dimensionRailGroup, dimensionRailGroups, dimensionRailTitle, filterRailDimensions, levelTrackSteps, scorecardFacts, scorecardTabFromParam,
} from '../scorecardHeaderModel.ts';

test('Discussion is not a tab: ?tab=discussion lands on Certification with the pane revealed', () => {
  assert.ok(!SCORECARD_TABS.some((t) => (t.id as string) === 'discussion'));
  assert.deepEqual(scorecardTabFromParam('discussion'), { tab: 'scorecard', revealDiscussion: true });
  assert.deepEqual(scorecardTabFromParam('activity'), { tab: 'activity', revealDiscussion: false });
  assert.deepEqual(scorecardTabFromParam(null), { tab: 'scorecard', revealDiscussion: false });
  assert.deepEqual(scorecardTabFromParam('bogus'), { tab: 'scorecard', revealDiscussion: false });
});

const cert = { target_level: 3, at_or_above_target: 0, below_target: 5, above_target: 0, assessed: 5, applicable: 17, highest_verified_level: 1 };
const team = { certification: cert, dimensions_assessed: 5, dimensions_total: 17, followups_open: 0, workflow_step_label: 'Intake' };

test('the four facts read value then the rest of the sentence; the level carries its progress to the target', () => {
  const facts = scorecardFacts(team, 'Classify');
  assert.deepEqual(facts.map((f) => [f.value, f.label]), [['L1', 'verified · target L3'], ['5/17', 'assessed'], [0, 'open follow-ups'], ['Classify', 'workflow step']]);
  assert.deepEqual(facts[0]!.progress, { value: 1, max: 3 });
  assert.equal(facts[0]!.tone, 'accent');
  assert.equal(facts[2]!.tone, 'default');
  assert.match(facts[0]!.title, /working toward Level 3/);
});

test('no verification is "None" with no bar; open follow-ups are danger; the step falls back to the team row', () => {
  const facts = scorecardFacts({ ...team, certification: { ...cert, highest_verified_level: null }, followups_open: 1 });
  assert.equal(facts[0]!.value, 'None');
  assert.equal(facts[0]!.progress, null);
  assert.equal(facts[2]!.label, 'open follow-up');
  assert.equal(facts[2]!.tone, 'danger');
  assert.equal(facts[3]!.value, 'Intake');
  // A level past the target fills the bar, never overflows it.
  assert.deepEqual(scorecardFacts({ ...team, certification: { ...cert, highest_verified_level: 5 } })[0]!.progress, { value: 3, max: 3 });
  // No certification block: no target, no bar.
  assert.equal(scorecardFacts({ ...team, certification: null })[0]!.progress, null);
});

const dims = [
  { id: '1', is_na: false, current_level: 1, certification: { claimed_level: 2, verified_level: 1 } },
  { id: '2', is_na: false, current_level: 2, certification: { claimed_level: 2, verified_level: 2 } },
  { id: '3', is_na: false, current_level: null },
  { id: '4', is_na: true, current_level: null },
] as unknown as Parameters<typeof dimensionRailGroup>[0][];

test('the rail groups by where each dimension stands, open claims first, empty groups dropped', () => {
  assert.deepEqual(dims.map(dimensionRailGroup), ['claims', 'verified', 'unassessed', 'na']);
  assert.deepEqual(dimensionRailGroups(dims).map((g) => [g.id, g.count]), [['claims', 1], ['verified', 1], ['unassessed', 1], ['na', 1]]);
  assert.deepEqual(dimensionRailGroups([dims[1]!]).map((g) => g.id), ['verified']);
  assert.deepEqual(filterRailDimensions(dims, true).map((d) => d.id), ['1']);
  assert.equal(filterRailDimensions(dims, false).length, 4);
  assert.equal(dimensionRailTitle(0, 'Continuous Integration (CI)'), '01 Continuous Integration (CI)');
});

test('the level track: levels up to the verified one done, the next active, the rest ahead; nothing without progress', () => {
  assert.deepEqual(levelTrackSteps({ value: 1, max: 3 }), [
    { step: 1, label: 'L1', done: true, active: false },
    { step: 2, label: 'L2', done: false, active: true },
    { step: 3, label: 'L3', done: false, active: false },
  ]);
  assert.deepEqual(levelTrackSteps({ value: 3, max: 3 }).map((s) => [s.done, s.active]), [[true, false], [true, false], [true, false]]);
  assert.deepEqual(levelTrackSteps(null), []);
  assert.deepEqual(levelTrackSteps({ value: 1, max: 0 }), []);
});

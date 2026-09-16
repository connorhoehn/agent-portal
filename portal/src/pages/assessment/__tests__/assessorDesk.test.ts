import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contributorAvatars, deskSummary, nextActionFor } from '../assessmentFormat.ts';
import type { TeamSummary } from '../types.ts';

function team(over: Partial<TeamSummary> = {}): TeamSummary {
  return {
    id: 'TEAM-001', name: 'Northstar', cohort: 'white_glove', cohort_label: 'White Glove', status: 'IN_PROGRESS',
    assessment_lead: 'Jordan Lee', workflow_step: 3, workflow_step_label: 'Score',
    dimensions_assessed: 10, dimensions_total: 17, followups_open: 0, updated_at: '2026-09-15T00:00:00Z',
    certification: { target_level: 3, at_or_above_target: 6, below_target: 4, above_target: 0, assessed: 10, applicable: 17, claims_open: 0 },
    ...over,
  };
}

test('a team with nothing assessed starts with intake', () => {
  assert.deepEqual(nextActionFor(team({ dimensions_assessed: 0, certification: undefined })), { kind: 'intake', label: 'Start intake' });
});

test('open claims come first — the evidence ask is the cheapest step', () => {
  const t = team({ followups_open: 4, certification: { ...team().certification!, claims_open: 3 } });
  assert.deepEqual(nextActionFor(t), { kind: 'close_claims', label: 'Close 3 claims' });
});

test('then open questions, then the dimensions left', () => {
  assert.deepEqual(nextActionFor(team({ followups_open: 1 })), { kind: 'answer', label: 'Answer 1 question' });
  assert.deepEqual(nextActionFor(team()), { kind: 'assess', label: 'Assess 7 more' });
});

test('a fully assessed team moves along the ladder', () => {
  const full = { ...team().certification!, assessed: 17, at_or_above_target: 17 };
  assert.deepEqual(nextActionFor(team({ dimensions_assessed: 17, certification: full, workflow_step: 4 })), { kind: 'publish', label: 'Review and publish' });
  assert.deepEqual(nextActionFor(team({ dimensions_assessed: 17, certification: full, workflow_step: 5 })), { kind: 'publish', label: 'Publish' });
  assert.deepEqual(nextActionFor(team({ dimensions_assessed: 17, certification: full, workflow_step: 6 })), { kind: 'follow_up', label: 'Follow up' });
});

test('the desk strip sums claims and questions over the rows it shows', () => {
  const s = deskSummary([team({ followups_open: 2, certification: { ...team().certification!, claims_open: 1 } }), team({ id: 'TEAM-002', followups_open: 3 })]);
  assert.equal(s.teams, 2);
  assert.equal(s.claimsOpen, 1);
  assert.equal(s.questionsOpen, 5);
  assert.equal(s.targetLevel, 3);
});

// ─── contributorAvatars ───────────────────────────────────────────────────────

test('contributorAvatars maps {initials,name} rows onto id+name pairs', () => {
  const avatars = contributorAvatars([{ initials: 'JL', name: 'Jordan Lee' }, { initials: 'AS', name: 'Asha Nair' }]);
  assert.deepEqual(avatars, [{ id: 'Jordan Lee-0', name: 'Jordan Lee' }, { id: 'Asha Nair-1', name: 'Asha Nair' }]);
});

test('contributorAvatars is empty for undefined or empty contributors', () => {
  assert.deepEqual(contributorAvatars(undefined), []);
  assert.deepEqual(contributorAvatars([]), []);
});

test('contributorAvatars keeps two same-named contributors distinct by index', () => {
  const avatars = contributorAvatars([{ initials: 'JL', name: 'Jordan Lee' }, { initials: 'JL', name: 'Jordan Lee' }]);
  assert.equal(new Set(avatars.map((a) => a.id)).size, 2);
});

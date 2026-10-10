// Run with:  cd portal && node --test 'src/pages/promotions/__tests__/*.test.ts'

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { supportLine, readyToPromote, nextStep, filterPromotions, allowedActions, isTerminalStatus } from '../promotionFormat.ts';
import type { PromotionCandidate } from '../types.ts';

function candidate(over: Partial<PromotionCandidate> = {}): PromotionCandidate {
  return {
    id: 'promo-1', proposedKind: 'runbook', title: 'T', rationale: 'R',
    supportCount: 3, sessionCount: 2, observations: [],
    status: 'candidate', dryRunPassed: null,
    ...over,
  };
}

test('supportLine: pluralizes observations and sessions independently', () => {
  assert.equal(supportLine(candidate({ supportCount: 11, sessionCount: 6 })), '11 observations across 6 sessions');
  assert.equal(supportLine(candidate({ supportCount: 1, sessionCount: 2 })), '1 observation across 2 sessions');
  assert.equal(supportLine(candidate({ supportCount: 3, sessionCount: 1 })), '3 observations across 1 session');
});

test('readyToPromote: insight and runbook are ready as soon as they are not terminal', () => {
  assert.equal(readyToPromote(candidate({ proposedKind: 'insight', status: 'candidate' })), true);
  assert.equal(readyToPromote(candidate({ proposedKind: 'runbook', status: 'approved' })), true);
});

test('readyToPromote: a skill is ready only once its dry run has passed', () => {
  assert.equal(readyToPromote(candidate({ proposedKind: 'skill', status: 'approved', dryRunPassed: null })), false);
  assert.equal(readyToPromote(candidate({ proposedKind: 'skill', status: 'approved', dryRunPassed: false })), false);
  assert.equal(readyToPromote(candidate({ proposedKind: 'skill', status: 'approved', dryRunPassed: true })), true);
});

test('readyToPromote: terminal statuses are never ready, regardless of kind', () => {
  assert.equal(readyToPromote(candidate({ status: 'promoted', proposedKind: 'insight' })), false);
  assert.equal(readyToPromote(candidate({ status: 'dismissed', proposedKind: 'runbook' })), false);
});

test('filterPromotions: "all" keeps everything, any other value narrows by exact status', () => {
  const candidates = [
    candidate({ id: 'a', status: 'candidate' }),
    candidate({ id: 'b', status: 'promoted' }),
    candidate({ id: 'c', status: 'dismissed' }),
  ];
  assert.deepEqual(filterPromotions(candidates, 'all').map((c) => c.id), ['a', 'b', 'c']);
  assert.deepEqual(filterPromotions(candidates, 'promoted').map((c) => c.id), ['b']);
  assert.deepEqual(filterPromotions(candidates, 'approved'), []);
});

test('nextStep: names the dry-run gate for a skill by its actual state', () => {
  assert.match(nextStep(candidate({ proposedKind: 'skill', status: 'candidate', dryRunPassed: null })), /Record approval — a skill also needs a completed dry-run/);
  assert.match(nextStep(candidate({ proposedKind: 'skill', status: 'approved', dryRunPassed: null })), /waits for a completed dry-run/);
  assert.match(nextStep(candidate({ proposedKind: 'skill', status: 'approved', dryRunPassed: false })), /Dry run failed/);
  assert.match(nextStep(candidate({ proposedKind: 'skill', status: 'approved', dryRunPassed: true })), /Dry run passed/);
});

test('nextStep: a drifted candidate names the drift before the normal approval prompt', () => {
  assert.match(
    nextStep(candidate({ proposedKind: 'runbook', status: 'candidate', driftedFrom: 'skl-x' })),
    /Sent back from a skill by drift detection/,
  );
});

test('nextStep: terminal states read as done, not as a call to action', () => {
  assert.match(nextStep(candidate({ status: 'dismissed' })), /not going forward/);
  assert.match(nextStep(candidate({ status: 'promoted', proposedKind: 'skill' })), /before enabling execution/);
  assert.match(nextStep(candidate({ status: 'promoted', proposedKind: 'insight' })), /Agent library as an insight/);
});

// ─── isTerminalStatus / allowedActions ───────────────────────────────────────

test('isTerminalStatus: only promoted and dismissed are terminal', () => {
  assert.equal(isTerminalStatus('candidate'), false);
  assert.equal(isTerminalStatus('approved'), false);
  assert.equal(isTerminalStatus('promoted'), true);
  assert.equal(isTerminalStatus('dismissed'), true);
});

test('allowedActions: a terminal candidate hides every action (DEFECTS.md #1 — no stale-drawer retry)', () => {
  assert.deepEqual(allowedActions(candidate({ status: 'promoted', proposedKind: 'insight' })), { primary: null, canDismiss: false });
  assert.deepEqual(allowedActions(candidate({ status: 'dismissed', proposedKind: 'skill', dryRunPassed: true })), { primary: null, canDismiss: false });
});

test('allowedActions: an unapproved skill with no completed dry run offers "Record approval", never a dry-run claim', () => {
  // sme DEFECTS #19: "Approve + record a passing dry run" recorded only the
  // approval — a client cannot assert a run. The label now says what lands.
  for (const dryRunPassed of [null, false] as const) {
    const { primary, canDismiss } = allowedActions({ status: 'candidate', proposedKind: 'skill', dryRunPassed });
    assert.equal(primary?.intent, 'approve');
    assert.equal(primary?.label, 'Record approval');
    assert.match(primary?.hint ?? '', /completed dry-run/);
    assert.doesNotMatch(primary?.hint ?? '', /pipelines/);
    assert.equal(canDismiss, true);
  }
});

test('allowedActions: an approved skill still waiting on its run offers Promote, which re-asks the gate', () => {
  for (const dryRunPassed of [null, false] as const) {
    const { primary } = allowedActions({ status: 'approved', proposedKind: 'skill', dryRunPassed });
    assert.equal(primary?.intent, 'promote');
    assert.match(primary?.hint ?? '', /only if a completed dry-run/);
  }
});

test('allowedActions: a skill with a completed dry run, and every insight/runbook, get a plain Promote', () => {
  for (const c of [
    { status: 'candidate', proposedKind: 'skill', dryRunPassed: true },
    { status: 'candidate', proposedKind: 'insight', dryRunPassed: null },
    { status: 'approved', proposedKind: 'runbook', dryRunPassed: null },
  ] as const) {
    assert.deepEqual(allowedActions(c), { primary: { intent: 'promote', label: 'Promote' }, canDismiss: true });
  }
});

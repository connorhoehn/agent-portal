// Run with:  cd portal && node --test 'src/pages/designs/__tests__/*.test.ts'

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { reviewStateLine, latestSignoffs, filterDesigns, designParticipantPortrait } from '../designFormat.ts';
import type { DesignReview } from '../types.ts';

test('design portraits retain an external signer and do not borrow a namesake photo', () => {
  const thread = { posts: [], signoffs: [{ personName: 'Alex', avatarUrl: '/external.jpg' as string | null }] };
  const contributors = [{ name: 'Alex', avatarUrl: '/other.jpg' }];
  assert.equal(designParticipantPortrait('Alex', thread, contributors), '/external.jpg');
  thread.signoffs[0]!.avatarUrl = null;
  assert.equal(designParticipantPortrait('Alex', thread, contributors), undefined);
  thread.signoffs.push({ personName: 'Alex', avatarUrl: '/external.jpg' });
  assert.equal(designParticipantPortrait('Alex', thread, contributors), undefined);
});

test('legacy design portraits resolve only one matching initiative contributor', () => {
  const thread = { posts: [{ authorKind: 'human' as const, authorName: 'Alex' }], signoffs: [] };
  const contributors = [{ name: 'Alex', avatarUrl: '/one.jpg' }];
  assert.equal(designParticipantPortrait('Alex', thread, contributors), '/one.jpg');
  assert.equal(designParticipantPortrait('Unknown', thread, contributors), undefined);
  contributors.push({ name: 'Alex', avatarUrl: '/two.jpg' });
  assert.equal(designParticipantPortrait('Alex', thread, contributors), undefined);
});

function review(over: Partial<DesignReview> = {}): DesignReview {
  return {
    id: 'd1', orgProjectId: 'p-x', orgProjectName: 'X', title: 'T',
    summary: '', affected: [],
    status: 'ideating', dependsOn: [], kbSynced: false, openQuestions: 0,
    signoffs: [], postCount: 3, createdAt: '2026-01-01', updatedAt: '2026-01-02',
    ...over,
  };
}

test('reviewStateLine: open questions outrank everything but approval', () => {
  assert.match(reviewStateLine(review({ status: 'awaiting_input', openQuestions: 2 })), /2 questions waiting on a human/);
  assert.match(reviewStateLine(review({ status: 'proposed', signoffs: [
    { personName: 'a', role: 'sme', decision: 'approve', at: '1' },
  ] })), /1\/2 sign-offs/);
  assert.match(reviewStateLine(review({ status: 'approved', kbSynced: true, signoffs: [
    { personName: 'a', role: 'sme', decision: 'approve', at: '1' },
    { personName: 'b', role: 'owner', decision: 'approve', at: '2' },
  ] })), /2 sign-offs · in the knowledge base/);
  assert.match(reviewStateLine(review()), /3 posts/);
});

test('latestSignoffs: one standing decision per person', () => {
  const out = latestSignoffs([
    { personName: 'a', role: 'sme', decision: 'reject', at: '1' },
    { personName: 'a', role: 'sme', decision: 'approve', at: '2' },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.decision, 'approve');
});

import { nextStep } from '../designFormat.ts';

test('filterDesigns: "all" keeps everything, any other value narrows by exact status', () => {
  const reviews = [
    review({ id: 'a', status: 'ideating' }),
    review({ id: 'b', status: 'approved' }),
    review({ id: 'c', status: 'awaiting_input' }),
  ];
  assert.deepEqual(filterDesigns(reviews, 'all').map((r) => r.id), ['a', 'b', 'c']);
  assert.deepEqual(filterDesigns(reviews, 'approved').map((r) => r.id), ['b']);
  assert.deepEqual(filterDesigns(reviews, 'rejected'), []);
});

test('nextStep names the human action per status', () => {
  assert.match(nextStep(review({ status: 'awaiting_input', openQuestions: 1 })), /Answer the open question/);
  assert.match(nextStep(review({ status: 'proposed' })), /2 more sign-offs/);
  assert.match(nextStep(review({ status: 'proposed', signoffs: [{ personName: 'a', role: 'sme', decision: 'approve', at: '1' }] })), /1 more sign-off/);
  assert.match(nextStep(review({ status: 'approved' })), /binds the designs/);
  assert.match(nextStep(review({ status: 'ideating' })), /nothing needs you yet/);
});

// DEFECTS.md #12: a viewer with no DispatchAgentRun capability has no answer
// control mounted, so the summary band must stop telling them to use one.
test('nextStep: awaiting_input defers to the capability that can answer, per viewer', () => {
  assert.match(
    nextStep(review({ status: 'awaiting_input', openQuestions: 1 }), 2, true),
    /Answer the open question below/,
  );
  assert.match(
    nextStep(review({ status: 'awaiting_input', openQuestions: 3 }), 2, false),
    /An owner or SME will answer the 3 open questions below/,
  );
  // Every other status is a shared state, not a per-viewer control — canAnswer
  // must not change their wording.
  assert.equal(
    nextStep(review({ status: 'proposed' }), 2, true),
    nextStep(review({ status: 'proposed' }), 2, false),
  );
});

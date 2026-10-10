// Run with:  cd portal && node --test 'src/pages/work/__tests__/*.test.ts'
//
// The Findings page warns an SME before "Put a worker on it" when the promote
// route's grant check would refuse it. These pin the two halves of that: the
// initiative is read from the evidence exactly the way the route reads it, and
// the warning appears only when the page can actually tell.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { findingInitiativeId, promoteGrantBlock, type ScopedSprintLike } from '../findingsFilter.ts';

test('findingInitiativeId reads the evidence keys in the route\'s order', () => {
  assert.equal(findingInitiativeId({ evidence: { initiativeId: 'p-a', initiative: 'p-b' } }), 'p-a');
  assert.equal(findingInitiativeId({ evidence: { initiative: 'p-cost-opt', ownerActive: false } }), 'p-cost-opt');
  assert.equal(findingInitiativeId({ evidence: { candidateInitiative: 'p-auth-migration' } }), 'p-auth-migration');
  assert.equal(findingInitiativeId({ evidence: { initiatives: ['p-observability', 'p-x'] } }), 'p-observability');
  assert.equal(findingInitiativeId({ evidence: { holders: 1 } }), null);
  assert.equal(findingInitiativeId({ evidence: null }), null);
  assert.equal(findingInitiativeId({ evidence: { initiative: '' } }), null);
});

const SPRINTS: ScopedSprintLike[] = [
  { orgProjectId: 'p-observability', orgProjectName: 'Observability Platform', status: 'active', isGrantee: false },
  { orgProjectId: 'p-auth-migration', orgProjectName: 'Auth Migration', status: 'active', isGrantee: true },
  { orgProjectId: 'p-soc2', orgProjectName: 'SOC2', status: 'done', isGrantee: true },
];

test('an sme with an active grant on the finding\'s initiative is not blocked', () => {
  assert.equal(promoteGrantBlock({ evidence: { candidateInitiative: 'p-auth-migration' } }, true, SPRINTS), null);
});

test('an sme without one is blocked, named when the sprints carry the name', () => {
  assert.deepEqual(
    promoteGrantBlock({ evidence: { initiatives: ['p-observability'] } }, true, SPRINTS),
    { initiativeId: 'p-observability', initiativeName: 'Observability Platform' },
  );
  assert.deepEqual(
    promoteGrantBlock({ evidence: { initiative: 'p-cost-opt' } }, true, SPRINTS),
    { initiativeId: 'p-cost-opt', initiativeName: null },
  );
});

test('a grant on a finished sprint is not an active grant', () => {
  assert.deepEqual(
    promoteGrantBlock({ evidence: { initiative: 'p-soc2' } }, true, SPRINTS),
    { initiativeId: 'p-soc2', initiativeName: 'SOC2' },
  );
});

test('says nothing when it cannot tell, or when the role is not grant-scoped', () => {
  assert.equal(promoteGrantBlock({ evidence: { initiative: 'p-cost-opt' } }, true, null), null);
  assert.equal(promoteGrantBlock({ evidence: { initiative: 'p-cost-opt' } }, false, SPRINTS), null);
  assert.equal(promoteGrantBlock({ evidence: { holders: 2 } }, true, SPRINTS), null);
});

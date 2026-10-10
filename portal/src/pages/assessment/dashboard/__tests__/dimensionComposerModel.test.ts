import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  composerAccess, dimensionPageReference, dimensionReference, parseDimensionReference, routeAgentText, teamDiscussionChannel,
} from '../dimensionComposerModel.ts';

test('the reference carries kind and ID only, and round-trips', () => {
  const ref = dimensionReference('TEAM-001', '7');
  assert.deepEqual(ref, { kind: 'assessment-dimension', id: 'TEAM-001:7' });
  assert.deepEqual(parseDimensionReference(ref), { teamId: 'TEAM-001', dimensionId: '7' });
  for (const bad of [null, {}, { kind: 'initiative', id: 'TEAM-001:7' }, { kind: 'assessment-dimension', id: 'team-1:7' }, { kind: 'assessment-dimension', id: 'TEAM-001:../x' }])
    assert.equal(parseDimensionReference(bad), null);
});

test('the chip names team and dimension; the page descriptor has no title', () => {
  const r = dimensionPageReference({ id: 'TEAM-001', name: 'Payments' }, { id: '7', title: 'Testing' });
  assert.equal(r.label, 'Assessment › Teams › Payments › 7. Testing');
  assert.deepEqual(Object.keys(r.page).sort(), ['id', 'kind']);
});

test('chat goes to the team discussion family', () => {
  assert.equal(teamDiscussionChannel('TEAM-005'), 'assessment:team:TEAM-005');
});

test('agent text routes commands and refuses free text', () => {
  assert.equal(routeAgentText('/summarize').action, 'summary');
  assert.equal(routeAgentText('/followups please').action, 'followups');
  assert.equal(routeAgentText('/deck').action, 'deck');
  assert.equal(routeAgentText('/agent /summarize').action, 'summary');
  assert.equal(routeAgentText('/agent what now').action, null);
  assert.equal(routeAgentText('what is next?').action, null);
  assert.equal(routeAgentText('/unknown').action, null);
});

test('readers get a read-only composer with the reason', () => {
  const reader = composerAccess({ mayRead: true, canScore: false, canRunAgent: false });
  assert.equal(reader.canChat, false);
  assert.match(reader.readOnlyReason ?? '', /read-only/);
  const scorer = composerAccess({ mayRead: true, canScore: true, canRunAgent: false });
  assert.deepEqual([scorer.canChat, scorer.canAgent, scorer.readOnlyReason], [true, false, null]);
  assert.equal(composerAccess({ mayRead: true, canScore: true, canRunAgent: true }).canAgent, true);
});

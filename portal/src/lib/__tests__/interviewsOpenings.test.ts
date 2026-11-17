import assert from 'node:assert/strict';
import { test } from 'node:test';
import { candidateHref } from '../interviews.ts';
import { openingRail, pipelineNameHref, stageFilterOf, stageTabs } from '../interviewsOpenings.ts';

test('a name opens the profile whether or not the debrief is ready', () => {
  assert.equal(pipelineNameHref({ candidate: { id: 'cand-ingrid' }, debriefReady: true } as never), candidateHref('cand-ingrid'));
  assert.equal(pipelineNameHref({ candidate: { id: 'cand-ingrid' }, debriefReady: false } as never), '/interviews/candidates/cand-ingrid');
});

test('stage tabs count in decision order and leave out empty stages', () => {
  const t = stageTabs([{ stage: 'interviewing' }, { stage: 'debrief' }, { stage: 'interviewing' }, { stage: 'applied' }]);
  assert.equal(t.all, 4);
  assert.deepEqual(t.stages, [{ stage: 'debrief', count: 1 }, { stage: 'interviewing', count: 2 }, { stage: 'applied', count: 1 }]);
});

test('a typed filter picks a stage or clears', () => {
  assert.equal(stageFilterOf('offer'), 'offer');
  assert.equal(stageFilterOf('nonsense'), '');
  assert.equal(stageFilterOf(''), '');
});

test('the openings rail groups by state, sublines the team and finds by title or team', () => {
  const rows = [
    { id: 'a', title: 'Senior Backend Engineer', team: 'Platform', state: 'open' as const },
    { id: 'b', title: 'Designer', team: 'Product', state: 'paused' as const },
  ];
  const all = openingRail(rows, '');
  assert.deepEqual(all.groups.map((g) => [g.id, g.count]), [['open', 1], ['paused', 1], ['closed', 0]]);
  assert.deepEqual(all.rows[0], { id: 'a', groupId: 'open', title: 'Senior Backend Engineer', subline: 'Platform' });
  assert.deepEqual(openingRail(rows, ' product ').rows.map((r) => r.id), ['b']);
});

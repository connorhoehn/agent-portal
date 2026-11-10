// Run with:  cd portal && node --test src/lib/__tests__/marketplaceRunNames.test.ts
//
// A marketplace dispatch that never got a project run, whose work item's name
// cannot be found, read "marketplace work wi-…" (UX leftovers, 10 November).
// The projection now titles it "Marketplace work · Coding agent"; the run page
// names the agent as its definition and the work item by name, its id behind a
// copy control.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { definitionLabel, workItemName, type PipelineRun } from '../pipelineRuns.ts';

const ctx = (over: Partial<PipelineRun['context']>): Pick<PipelineRun, 'context'> => ({
  context: { tenant: 'orgiq', kind: 'agent', table: 'bot_runs', id: 'br-1', sourceStatus: 'running', sources: [], title: '', ...over },
});

test('a marketplace dispatch is run by the coding agent, not "Not recorded"', () => {
  assert.equal(definitionLabel('marketplace'), 'Coding agent');
});

test('the work item reads by name: the dispatched item, a governed run\'s own title, or "Name not found"', () => {
  assert.equal(workItemName(ctx({ title: 'Dispatched: Span-metrics connector feeding RED dashboards', workItemId: 'wi-obs-e1-s3' })), 'Span-metrics connector feeding RED dashboards');
  assert.equal(workItemName(ctx({ title: 'Marketplace work · Coding agent', workItemId: 'wi-gone' })), 'Name not found');
  assert.equal(workItemName(ctx({ table: 'agent_project_runs', title: 'Logout leaves the shim cookie alive', workItemId: 'wi-1' })), 'Logout leaves the shim cookie alive');
  assert.equal(workItemName(ctx({ title: 'Supervisor run' })), null, 'no work item, no row');
});

test('no name it gives is an id', () => {
  for (const title of ['Dispatched: A thing', 'Marketplace work · Coding agent']) {
    assert.doesNotMatch(workItemName(ctx({ title, workItemId: 'wi-obs-e1-s3' })) ?? '', /wi-/);
  }
});

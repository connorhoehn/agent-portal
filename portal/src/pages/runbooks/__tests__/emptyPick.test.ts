// UX walk, 9 November 2026, defect 22: the Proposals and Briefs panes with
// nothing open say what fills them and offer the one action that does.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { briefsEmpty, proposalsEmpty } from '../emptyPick.ts';

const href = (id: string) => `/x/${id}`;

test('proposals: the first open one, else the latest decided one, else the library', () => {
  assert.deepEqual(proposalsEmpty([{ id: 'd1', groupId: 'decided' }, { id: 'o1', groupId: 'open' }], href, '/lib').action, { label: 'Open the first open proposal', href: '/x/o1' });
  const decided = proposalsEmpty([{ id: 'd1', groupId: 'decided' }], href, '/lib');
  assert.equal(decided.title, 'Nothing to review');
  assert.deepEqual(decided.action, { label: 'Open the latest proposal', href: '/x/d1' });
  const none = proposalsEmpty([], href, '/lib');
  assert.equal(none.title, 'No proposals yet');
  assert.match(none.description, /suggests an edit from the runbook's page/);
  assert.deepEqual(none.action, { label: 'Open the runbook library', href: '/lib' });
});

test('briefs: the newest brief, else the runs that write them', () => {
  assert.deepEqual(briefsEmpty([{ id: 'run-2' }, { id: 'run-1' }], href, '/runs').action, { label: 'Open the newest brief', href: '/x/run-2' });
  const none = briefsEmpty([], href, '/runs');
  assert.equal(none.title, 'No briefs yet');
  assert.deepEqual(none.action, { label: 'See the runs', href: '/runs' });
});

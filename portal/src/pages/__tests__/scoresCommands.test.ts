import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectionCommandAdapter, resolveCollectionTarget } from '../../components/collections/collectionCommands.ts';
import { scoreTargets, scoresGrammar } from '../scoresCommands.ts';

const entries = [
  { personId: 'p-001', name: 'Ada Lovelace', department: 'Engineering' },
  { personId: 'p-002', name: 'Grace Hopper', department: 'Platform' },
];

test('scores: skill search, department phrases, reset; no score or weighting verbs', async () => {
  const state = { skill: '', dept: '', refreshes: 0, selected: '' };
  const shown = () => entries.filter((e) => !state.dept || e.department === state.dept);
  const adapter = collectionCommandAdapter(scoresGrammar(['Engineering', 'Platform']), {
    setQuery: (v) => { state.skill = v; }, setFilter: (v) => { state.dept = v; }, refresh: () => { state.refreshes++; }, scopeNote: 'x',
    open: (target) => { const row = resolveCollectionTarget(target, scoreTargets(shown())); state.selected = row.id; return 'ok'; },
  });
  for (const example of adapter.examples.filter((e) => !e.startsWith('open <'))) await adapter.execute(example);
  await adapter.execute('show engineering people'); assert.equal(state.dept, 'Engineering');
  await adapter.execute('search people for Kubernetes'); assert.equal(state.skill, 'Kubernetes'); assert.equal(state.dept, 'Engineering');
  for (const bad of ['set weighting to 80%', 'rescore everyone', 'compare p-001 and p-002', 'show sales people', 'open all']) {
    await assert.rejects(() => Promise.resolve(adapter.execute(bad)), bad);
  }
  assert.equal(state.dept, 'Engineering'); assert.equal(state.skill, 'Kubernetes'); assert.equal(state.selected, '');
  await adapter.execute('open ada lovelace'); assert.equal(state.selected, 'p-001');
  await assert.rejects(() => Promise.resolve(adapter.execute('open p-002')), /No matching/);
  await adapter.execute('reset filters'); assert.equal(state.dept, ''); assert.equal(state.skill, '');
  await adapter.execute('open p-002'); assert.equal(state.selected, 'p-002');
});

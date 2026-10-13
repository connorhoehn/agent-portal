import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectionCommandAdapter, resolveCollectionTarget } from '../../../components/collections/collectionCommands.ts';
import { DESIGN_GRAMMAR, matchesDesign } from '../designCommands.ts';
import type { DesignReview } from '../types';

const review = (id: string, title: string, orgProjectName = 'Auth migration') => ({ id, title, orgProjectName } as DesignReview);
const reviews = [review('des-auth-rotation', 'Key rotation'), review('des-rag', 'Hybrid retrieval', 'RAG search')];

test('designs: Status phrases, search, reset; no sign-off or answer verbs', async () => {
  const state = { query: '', status: 'all', refreshes: 0 };
  const adapter = collectionCommandAdapter(DESIGN_GRAMMAR, {
    setQuery: (v) => { state.query = v; }, setFilter: (v) => { state.status = v || 'all'; }, refresh: () => { state.refreshes++; }, scopeNote: 'x',
  });
  for (const example of adapter.examples) await adapter.execute(example);
  await adapter.execute('show needs input designs'); assert.equal(state.status, 'awaiting_input');
  await adapter.execute('show awaiting sign-off designs'); assert.equal(state.status, 'proposed');
  await adapter.execute('search designs for rag'); assert.equal(state.query, 'rag');
  for (const bad of ['approve des-rag', 'sign off all designs', 'answer the open questions', 'show rejected designs']) {
    await assert.rejects(() => Promise.resolve(adapter.execute(bad)), bad);
  }
  assert.equal(state.status, 'proposed'); assert.equal(state.query, 'rag');
  await adapter.execute('reset filters'); assert.equal(state.status, 'all'); assert.equal(state.query, '');
});

test('designs: search matches id, title and initiative; open is exact on the shown rows', () => {
  assert.deepEqual(reviews.filter((r) => matchesDesign(r, 'RAG')).map((r) => r.id), ['des-rag']);
  assert.deepEqual(reviews.filter((r) => matchesDesign(r, 'auth')).map((r) => r.id), ['des-auth-rotation']);
  assert.equal(resolveCollectionTarget('key rotation', reviews).id, 'des-auth-rotation');
  assert.throws(() => resolveCollectionTarget('Key', reviews), /No matching/);
  const shown = reviews.filter((r) => matchesDesign(r, 'rag'));
  assert.throws(() => resolveCollectionTarget('des-auth-rotation', shown), /No matching/);
});

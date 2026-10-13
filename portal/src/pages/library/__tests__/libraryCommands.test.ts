import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectionCommandAdapter, resolveCollectionTarget } from '../../../components/collections/collectionCommands.ts';
import { LIBRARY_GRAMMAR, libraryTargets } from '../libraryCommands.ts';
import type { LibraryAsset } from '../types';

const asset = (id: string, name: string) => ({ id, name } as LibraryAsset);
const assets = [asset('skill-pr-review', 'PR review'), asset('prompt-triage', 'Triage'), asset('eval-triage', 'Triage')];

test('library: Kind phrases, search, reset and refresh drive the URL-backed state', async () => {
  const state = { q: 'x', kind: 'all', refreshes: 0, opened: '' };
  const adapter = collectionCommandAdapter(LIBRARY_GRAMMAR, {
    setQuery: (v) => { state.q = v; }, setFilter: (v) => { state.kind = v || 'all'; }, refresh: () => { state.refreshes++; }, scopeNote: 'x',
    open: (target) => { const row = resolveCollectionTarget(target, libraryTargets(assets)); state.opened = row.id; return 'ok'; },
  });
  for (const example of adapter.examples.filter((e) => !e.startsWith('open <'))) await adapter.execute(example);
  await adapter.execute('show system prompt assets'); assert.equal(state.kind, 'system');
  await adapter.execute('filter skill'); assert.equal(state.kind, 'skill');
  await adapter.execute('search assets for review'); assert.equal(state.q, 'review'); assert.equal(state.kind, 'skill');
  for (const bad of ['delete PR review', 'promote all assets', 'show endpoint assets', 'retire skill-pr-review', 'open all']) {
    await assert.rejects(() => Promise.resolve(adapter.execute(bad)), bad);
  }
  assert.equal(state.kind, 'skill'); assert.equal(state.q, 'review'); assert.equal(state.opened, '');
  await adapter.execute('open pr review'); assert.equal(state.opened, 'skill-pr-review');
  await assert.rejects(() => Promise.resolve(adapter.execute('open Triage')), /multiple/);
  await adapter.execute('open eval-triage'); assert.equal(state.opened, 'eval-triage');
  await adapter.execute('clear filters'); assert.equal(state.kind, 'all'); assert.equal(state.q, '');
});

test('library: open only sees the rows the table currently shows', () => {
  assert.throws(() => resolveCollectionTarget('prompt-triage', libraryTargets(assets.slice(0, 1))), /No matching/);
});

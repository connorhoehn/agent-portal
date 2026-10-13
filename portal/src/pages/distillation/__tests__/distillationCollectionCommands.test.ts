// Run with:  cd portal && node --test 'src/pages/distillation/__tests__/distillationCollectionCommands.test.ts'
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  activityRunsCommandAdapter, knowledgeCommandAdapter, promotionsCommandAdapter, runMatches,
} from '../distillationCollectionCommands.ts';

function knowledge(view: 'guides' | 'notes', rows = [{ id: 'art-001', title: 'Rotate keys' }, { id: 'obs-7', title: 'Flaky test' }]) {
  const calls: string[] = [];
  const adapter = knowledgeCommandAdapter(view, view === 'guides' ? 'guides & findings' : 'run notes', rows, {
    setQuery: (v) => calls.push(`query:${v}`), setFilter: (v) => calls.push(`filter:${v}`),
    refresh: () => calls.push('refresh'), openItem: (id) => calls.push(`open:${id}`),
  });
  return { adapter, calls };
}

test('knowledge (notes): search, reset, refresh and exact open drive the rail', async () => {
  const { adapter, calls } = knowledge('notes');
  await adapter.execute('search run notes for "aurora"');
  await adapter.execute('reset filters');
  await adapter.execute('refresh run notes');
  await adapter.execute('open obs-7');
  await adapter.execute('open rotate keys');
  assert.deepEqual(calls, ['query:aurora', 'query:', 'filter:', 'refresh', 'open:obs-7', 'open:art-001']);
  // Lifecycle belongs to the guides view only.
  await assert.rejects(async () => adapter.execute('show published run notes'), /No changes/);
  assert.ok(!adapter.examples.some((e) => e.includes('published')));
});

test('knowledge (guides): lifecycle phrases come from the rail filter', async () => {
  const { adapter, calls } = knowledge('guides');
  await adapter.execute('show draft guides & findings');
  await adapter.execute('filter retired');
  assert.deepEqual(calls, ['filter:draft', 'filter:retired']);
  for (const text of ['publish art-001', 'retire all guides', 'explain art-001', 'open Rotate', 'open everything']) {
    await assert.rejects(async () => adapter.execute(text));
  }
  assert.equal(calls.length, 2);
});

test('knowledge: open never reaches a row outside the current list', async () => {
  const { adapter, calls } = knowledge('notes', [{ id: 'obs-7', title: 'Flaky test' }]);
  await assert.rejects(async () => adapter.execute('open art-001'), /No matching/);
  assert.deepEqual(calls, []);
});

test('activity runs: status phrases, search and exact-ID open; titles repeat', async () => {
  const calls: string[] = [];
  const rows = [{ id: 'job-1', title: 'Run notes → Patterns' }, { id: 'job-2', title: 'Run notes → Patterns' }];
  const adapter = activityRunsCommandAdapter(rows, {
    setQuery: (v) => calls.push(`query:${v}`), setStatus: (v) => calls.push(`status:${v}`),
    refresh: () => calls.push('refresh'), openRun: (id) => calls.push(`open:${id}`),
  });
  await adapter.execute('show failed runs');
  await adapter.execute('show completed runs');
  await adapter.execute('find aurora');
  await adapter.execute('clear filters');
  await adapter.execute('open job-2');
  assert.deepEqual(calls, ['status:failed', 'status:succeeded', 'query:aurora', 'query:', 'status:null', 'open:job-2']);
  await assert.rejects(async () => adapter.execute('open run notes → patterns'), /multiple/);
  for (const text of ['compact L0 to L1', 'cancel job-1', 'start a compaction', 'show L2 runs']) {
    await assert.rejects(async () => adapter.execute(text));
  }
  assert.equal(calls.length, 6);
});

test('runMatches searches id, title, meta and subline with every term', () => {
  const row = { id: 'job-9', title: 'Patterns → Guides', meta: '4 patterns → 1 guide', subline: 'started 3h ago' };
  assert.ok(runMatches(row, ''));
  assert.ok(runMatches(row, 'guides 3h'));
  assert.ok(runMatches(row, 'JOB-9'));
  assert.ok(!runMatches(row, 'guides failed'));
});

test('promotions: status filter, reset to all, exact open; no decisions', async () => {
  const calls: string[] = [];
  const rows = [{ id: 'promo-1', title: 'Retry flaky builds' }];
  const adapter = promotionsCommandAdapter(rows, {
    setQuery: (v) => calls.push(`query:${v}`), setStatus: (v) => calls.push(`status:${v}`),
    refresh: () => calls.push('refresh'), openCandidate: (id) => calls.push(`open:${id}`),
  });
  await adapter.execute('show approved candidates');
  await adapter.execute('show all candidates');
  await adapter.execute('open Retry flaky builds');
  assert.deepEqual(calls, ['status:approved', 'query:', 'status:all', 'open:promo-1']);
  for (const text of ['approve promo-1', 'promote promo-1', 'dismiss all', 'open promo']) {
    await assert.rejects(async () => adapter.execute(text));
  }
  assert.equal(calls.length, 4);
});

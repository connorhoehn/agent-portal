import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectionCommandAdapter, resolveCollectionTarget } from '../../../components/collections/collectionCommands.ts';
import {
  FINDINGS_GRAMMAR, GRAPH_UPDATES_GRAMMAR, INBOX_RUNS_GRAMMAR, QUEUE_GRAMMAR,
  findingStatusValue, graphUpdatesFilterValue, matchesJob, queueFilterValue, recentFinishedRuns,
} from '../workCollectionCommands.ts';
import type { Job } from '../workShared';

const job = (id: string, title: string, extra: Partial<Job> = {}): Job => ({
  id, kind: 'freeform', title, status: 'done', priority: 0, boxId: null, attempts: 1, maxAttempts: 3, result: null,
  error: null, createdAt: '2026-10-01T00:00:00Z', finishedAt: null, botId: null, botName: null, botTrigger: null, ...extra,
});

/** A controlled table: the state the toolbar and the composer share. */
function harness(grammar: Parameters<typeof collectionCommandAdapter>[0], filterOf: (value: string) => string, rows: Job[]) {
  const state = { query: '', filter: filterOf(''), refreshes: 0, opened: '' };
  const visible = () => rows.filter((row) => matchesJob(row, state.query));
  const adapter = collectionCommandAdapter(grammar, {
    setQuery: (value) => { state.query = value; },
    ...(grammar.filters ? { setFilter: (value: string) => { state.filter = filterOf(value); } } : {}),
    refresh: () => { state.refreshes++; }, scopeNote: 'Loaded rows only.',
    open: (target) => { const row = resolveCollectionTarget(target, visible()); state.opened = row.id; return `Opening ${row.title}.`; },
  });
  return { state, adapter };
}

const rows = [job('job-1', 'Rotate the auth keys', { botName: 'key-rotator' }), job('job-2', 'Document Cedar policies'), job('job-3', 'Rotate the auth keys')];

test('queue: advertised examples drive the State chips, search and refresh', async () => {
  const { state, adapter } = harness(QUEUE_GRAMMAR, queueFilterValue, rows);
  for (const example of adapter.examples.filter((e) => !e.startsWith('open <'))) await adapter.execute(example);
  await adapter.execute('show awaiting review runs'); assert.equal(state.filter, 'awaiting_review');
  await adapter.execute('filter failed'); assert.equal(state.filter, 'failed');
  await adapter.execute('search runs for Cedar'); assert.equal(state.query, 'Cedar'); assert.equal(state.filter, 'failed');
  await adapter.execute('reset filters'); assert.equal(state.query, ''); assert.equal(state.filter, 'all');
  await adapter.execute('refresh runs'); assert.ok(state.refreshes >= 2);
});

test('queue: mutations and unsupported prose change nothing', async () => {
  const { state, adapter } = harness(QUEUE_GRAMMAR, queueFilterValue, rows);
  await adapter.execute('filter queued'); await adapter.execute('search Cedar');
  const before = { ...state };
  for (const phrase of ['requeue job-1', 'cancel all runs', 'run the queue', 'show stuck runs', 'open all', 'assign job-2 to me']) {
    await assert.rejects(() => Promise.resolve(adapter.execute(phrase)), phrase);
  }
  assert.deepEqual(state, before);
});

test('open resolves an exact id or a unique title on the current rows only', async () => {
  const { state, adapter } = harness(INBOX_RUNS_GRAMMAR, (v) => v, rows);
  await adapter.execute('open job-2'); assert.equal(state.opened, 'job-2');
  await adapter.execute('open "document cedar policies"'); assert.equal(state.opened, 'job-2');
  await assert.rejects(() => Promise.resolve(adapter.execute('open Rotate the auth keys')), /multiple/);
  await assert.rejects(() => Promise.resolve(adapter.execute('open JOB-2')), /No matching/);
  await assert.rejects(() => Promise.resolve(adapter.execute('open Document')), /No matching/);
  await adapter.execute('search runs for rotator');
  await assert.rejects(() => Promise.resolve(adapter.execute('open job-2')), /No matching/);
  await adapter.execute('open Rotate the auth keys'); assert.equal(state.opened, 'job-1');
  // The inbox section has no filter, so filter phrases are refused.
  await assert.rejects(() => Promise.resolve(adapter.execute('show failed runs')));
});

test('inbox recent runs: newest finished matches, capped at four', () => {
  const finished = Array.from({ length: 6 }, (_, i) => job(`r-${i}`, i % 2 ? 'Odd run' : 'Even run', { finishedAt: `2026-10-0${i + 1}T00:00:00Z` }));
  const all = [...finished, job('live', 'Even run')];
  assert.deepEqual(recentFinishedRuns(all, '').map((r) => r.id), ['r-5', 'r-4', 'r-3', 'r-2']);
  assert.deepEqual(recentFinishedRuns(all, 'even').map((r) => r.id), ['r-4', 'r-2', 'r-0']);
});

test('findings and graph updates: status phrases, defaults on reset, no write verbs', async () => {
  for (const [grammar, reset, phrase, value] of [
    [FINDINGS_GRAMMAR, findingStatusValue, 'show dismissed findings', 'dismissed'],
    [GRAPH_UPDATES_GRAMMAR, graphUpdatesFilterValue, 'show failed graph updates', 'failed'],
  ] as const) {
    let query = ''; let filter = reset(''); let refreshes = 0;
    const adapter = collectionCommandAdapter(grammar, {
      setQuery: (v) => { query = v; }, setFilter: (v) => { filter = reset(v); }, refresh: () => { refreshes++; }, scopeNote: 'x',
    });
    for (const example of adapter.examples) await adapter.execute(example);
    await adapter.execute(phrase); assert.equal(filter, value);
    await adapter.execute(`search ${grammar.noun} for "bus factor"`); assert.equal(query, 'bus factor');
    for (const bad of ['promote all', 'dismiss everything', 'approve all', 'retry failed', 'run sweeps now', 'open f-1']) {
      await assert.rejects(() => Promise.resolve(adapter.execute(bad)), bad);
    }
    assert.equal(filter, value); assert.equal(query, 'bus factor');
    await adapter.execute('reset'); assert.equal(filter, reset('')); assert.equal(query, ''); assert.ok(refreshes >= 1);
    assert.ok(!adapter.examples.some((e) => e.startsWith('open ')));
  }
});

// Run with:  cd portal && node --test 'src/pages/distillation/__tests__/*.test.ts'

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  durationMs, edgeDetail, filterRuns, inputRefs, ioLabel, logLines, producedRefs, replicationLine, runFacts,
  runRows, runStatus, transformationLabel, whatChanged,
} from '../activityModel.ts';
import type { CompactionRun } from '../types.ts';

const NOW = Date.parse('2026-09-24T12:00:00Z');

function job(over: Partial<CompactionRun> = {}): CompactionRun {
  return {
    id: 'comp-101', level: 'L1', startedAt: '2026-09-24T09:00:00Z', finishedAt: '2026-09-24T09:02:00Z',
    status: 'succeeded', inputItems: 13, outputItems: 4, dedupedItems: 9, bytesReclaimed: 0, costUsd: 0.0039,
    ...over,
  };
}

test('a run reads as its transformation and its own input → output counts', () => {
  assert.equal(transformationLabel('L1'), 'Run notes → Patterns');
  assert.equal(transformationLabel('L2'), 'Patterns → Guides & findings');
  assert.equal(ioLabel(job()), '13 run notes → 4 patterns');
  assert.equal(ioLabel(job({ level: 'L2', inputItems: 1, outputItems: 1 })), '1 pattern → 1 guide');
  assert.equal(ioLabel(job({ status: 'queued', outputItems: 0 })), '13 run notes → …');
  assert.equal(ioLabel(job({ input_ids: ['a', 'b'], output_ids: ['c'] })), '2 run notes → 1 pattern', 'the id lists win over the counts');
  assert.deepEqual(runStatus('succeeded'), { label: 'Completed', tone: 'success' });
  assert.deepEqual(runStatus('queued'), { label: 'Queued', tone: 'pending' });
});

test('inspector facts: duration from the server, else the timestamps; cost at 4dp', () => {
  assert.equal(durationMs(job()), 120_000);
  assert.equal(durationMs(job({ duration_ms: 5 })), 5);
  assert.equal(durationMs(job({ finishedAt: null, status: 'running' })), null);
  assert.deepEqual(runFacts(job()), [
    { label: 'Input', value: '13 run notes' },
    { label: 'Output', value: '4 patterns' },
    { label: 'Duration', value: '2 min' },
    { label: 'Cost', value: '$0.0039' },
  ]);
  assert.equal(runFacts(job({ status: 'running', finishedAt: null })).find((f) => f.label === 'Duration')?.value, 'Running');
});

test('produced rows are the job\'s own output ids, in the tier they land in', () => {
  assert.deepEqual(producedRefs(job({ output_ids: ['cl-1'] })), [{ id: 'cl-1', level: 'L1' }]);
  assert.deepEqual(producedRefs(job({ produced: { cluster_ids: [], artifact_ids: ['art-1'] } })), [{ id: 'art-1', level: 'L2' }]);
  assert.deepEqual(producedRefs(job()), []);
  assert.deepEqual(inputRefs(job({ level: 'L2', input_ids: ['cl-9'] })), [{ id: 'cl-9', level: 'L1' }]);
});

test('what changed and the log are the server\'s words', () => {
  assert.equal(whatChanged(job({ what_changed: 'Merged.' })), 'Merged.');
  assert.equal(whatChanged(job({ status: 'failed', error: 'boom' })), 'boom');
  assert.deepEqual(logLines(job({ log: [{ at: 't', level: 'warn', message: 'm' }] })), [
    { id: 'comp-101-0', timestamp: 't', level: 'warn', message: 'm' },
  ]);
});

test('run rows: newest first, active jobs grouped first, scope filters keep repo-less jobs', () => {
  const jobs = [
    job({ id: 'a', startedAt: '2026-09-20T09:00:00Z' }),
    job({ id: 'b', status: 'running', startedAt: '2026-09-24T11:00:00Z', finishedAt: null }),
    job({ id: 'c', level: 'L2', startedAt: '2026-09-24T10:00:00Z', repo: 'org/x' }),
  ];
  const rows = runRows(jobs, NOW);
  assert.deepEqual(rows.map((r) => [r.id, r.groupId]), [['b', 'active'], ['c', 'recent'], ['a', 'earlier']]);
  assert.match(rows[1].subline, /started 2h ago$/);
  assert.deepEqual(filterRuns(jobs, { level: 'L2', status: null, repo: null }).map((j) => j.id), ['c']);
  assert.deepEqual(filterRuns(jobs, { level: null, status: null, repo: 'org/y' }).map((j) => j.id), ['a', 'b']);
});

test('edge captions come from the latest finished job on that edge', () => {
  const jobs = [job({ id: 'old', finishedAt: '2026-09-23T09:00:00Z' }), job({ id: 'new', finishedAt: '2026-09-24T09:00:00Z' })];
  assert.equal(edgeDetail(jobs, 'L1', NOW), '13 → 4 · 3h ago');
  assert.equal(edgeDetail(jobs, 'L2', NOW), null);
});

test('replication: in sync, drift, or unknown — never assumed healthy', () => {
  assert.deepEqual(
    replicationLine({ primary: { id: 'p', digest: 'x' }, replicas: [{ id: 'r', digest: 'x', lagMs: 0 }], inSync: true }),
    { text: 'Replica in sync', tone: 'success' },
  );
  assert.deepEqual(
    replicationLine({ primary: { id: 'p', digest: 'x' }, replicas: [{ id: 'r', digest: 'y', lagMs: 3000 }, { id: 's', digest: 'x', lagMs: 0 }], inSync: false }),
    { text: '1 of 2 replicas drifting · 3 s behind', tone: 'warning' },
  );
  assert.equal(replicationLine(null), null);
  assert.equal(replicationLine({ replicas: [] }), null);
});

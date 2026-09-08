// Run with:  cd portal && node --test 'src/pages/distillation/__tests__/*.test.ts'

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { filterCompactionJobs } from '../compactionsFilter.ts';
import type { CompactionJob } from '../types.ts';

function job(over: Partial<CompactionJob>): CompactionJob {
  return {
    id: 'comp-1', level: 'L1', startedAt: '2026-09-06T00:00:00Z', finishedAt: null,
    status: 'succeeded', inputItems: 10, outputItems: 5, dedupedItems: 5, bytesReclaimed: 0, costUsd: 0,
    ...over,
  };
}

test('filterCompactionJobs with both facets at "all" returns every job', () => {
  const jobs = [job({ id: 'a', level: 'L1' }), job({ id: 'b', level: 'L2', status: 'failed' })];
  assert.deepEqual(filterCompactionJobs(jobs, 'all', 'all'), jobs);
});

test('filterCompactionJobs narrows by level', () => {
  const jobs = [job({ id: 'a', level: 'L1' }), job({ id: 'b', level: 'L2' })];
  assert.deepEqual(filterCompactionJobs(jobs, 'L2', 'all').map((j) => j.id), ['b']);
});

test('filterCompactionJobs narrows by status', () => {
  const jobs = [job({ id: 'a', status: 'succeeded' }), job({ id: 'b', status: 'failed' })];
  assert.deepEqual(filterCompactionJobs(jobs, 'all', 'failed').map((j) => j.id), ['b']);
});

test('filterCompactionJobs combines both facets', () => {
  const jobs = [
    job({ id: 'a', level: 'L1', status: 'failed' }),
    job({ id: 'b', level: 'L1', status: 'succeeded' }),
    job({ id: 'c', level: 'L2', status: 'failed' }),
  ];
  assert.deepEqual(filterCompactionJobs(jobs, 'L1', 'failed').map((j) => j.id), ['a']);
});

test('filterCompactionJobs never mutates the input array', () => {
  const jobs = [job({ id: 'a' })];
  const out = filterCompactionJobs(jobs, 'L2', 'all');
  assert.notEqual(out, jobs);
  assert.equal(jobs.length, 1);
});

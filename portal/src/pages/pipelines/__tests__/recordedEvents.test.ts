import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeActivity, recordedRunActivity } from '../recordedEvents.ts';
import type { PipelineRun, PipelineStep } from '../../../lib/pipelineRuns.ts';

const run = { id: 'r-1', status: 'completed', startedAt: '2026-10-06T10:00:00Z', finishedAt: '2026-10-06T10:05:00Z', context: { error: null } } as unknown as PipelineRun;
const steps = [
  { runId: 'r-1', stepId: 'a', label: 'Claim', status: 'completed', startedAt: '2026-10-06T10:00:01Z', finishedAt: '2026-10-06T10:01:00Z' },
  { runId: 'r-1', stepId: 'b', label: 'Later', status: 'pending', startedAt: null, finishedAt: null },
] as unknown as PipelineStep[];

test('a finished seeded run yields its recorded history, pending steps skipped', () => {
  const ev = recordedRunActivity(run, steps);
  assert.deepEqual(ev.map(e => e.eventType), ['run.started', 'step.started', 'step.completed', 'run.completed']);
  assert.equal(ev[3]!.timestamp, '2026-10-06T10:05:00.000Z');
});

test('a running run has no terminal row', () => {
  const ev = recordedRunActivity({ ...run, status: 'running', finishedAt: null } as PipelineRun, steps);
  assert.equal(ev.at(-1)!.eventType, 'step.completed');
});

test('merge: a live row replaces its recorded twin and order is oldest first', () => {
  const rec = recordedRunActivity(run, steps);
  const live = [{ eventType: 'run.completed', detail: { runId: 'r-1', status: 'completed' }, timestamp: '2026-10-06T10:06:00.000Z', userId: null, displayName: 'System' }];
  const merged = mergeActivity(rec, live);
  assert.equal(merged.filter(e => e.eventType === 'run.completed').length, 1);
  assert.equal(merged.at(-1)!.timestamp, '2026-10-06T10:06:00.000Z');
  assert.equal(merged[0]!.eventType, 'run.started');
});

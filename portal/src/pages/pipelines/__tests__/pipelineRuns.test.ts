// Run with:  cd portal && node --test 'src/pages/pipelines/__tests__/*.test.ts'
//
// The run model every run surface shares (lib/pipelineRuns.ts): the nine
// statuses each have a tone and a words-not-underscores label, the lossy
// crosswalk is disclosed when the source said something else, and the
// WorkflowStepper gets exactly one active step — the one a reader should look
// at, which is the one that carries aria-current="step".

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PIPELINE_RUN_STATUSES, STATUS_FILTER_OPTIONS, runStatusChip, runsQuery, sourceStatusNote,
  stepperSteps, stepStatusChip, runHref, attemptItems, unlinkedNote, KIND_FILTER_OPTIONS, sourceLabel, type PipelineStep,
} from '../../../lib/pipelineRuns.ts';

test('every one of the nine run statuses has a tone and a readable label', () => {
  assert.equal(PIPELINE_RUN_STATUSES.length, 9);
  for (const s of PIPELINE_RUN_STATUSES) {
    const c = runStatusChip(s);
    assert.ok(c.tone, `${s} has no tone`);
    assert.doesNotMatch(c.label, /_/, `${s} label shows an underscore`);
  }
  assert.equal(runStatusChip('failed').tone, 'danger');
  assert.equal(runStatusChip('awaiting_approval').label, 'awaiting approval');
  assert.deepEqual(runStatusChip('mystery_state'), { tone: 'neutral', label: 'mystery state' });
  assert.equal(stepStatusChip('skipped').tone, 'neutral');
});

test('the status filter offers "any" plus the nine, in pipeline-runtime order', () => {
  assert.equal(STATUS_FILTER_OPTIONS[0]!.value, '');
  assert.deepEqual(STATUS_FILTER_OPTIONS.slice(1).map((o) => o.value), [...PIPELINE_RUN_STATUSES]);
});

test('the crosswalk is disclosed only where it changes what the source meant', () => {
  assert.equal(sourceStatusNote({ status: 'cancelled', context: { sourceStatus: 'skipped' } } as never), 'source status: skipped');
  assert.equal(sourceStatusNote({ status: 'rejected', context: { sourceStatus: 'blocked' } } as never), 'source status: blocked');
  assert.equal(sourceStatusNote({ status: 'awaiting_approval', context: { sourceStatus: 'awaiting_review' } } as never), 'source status: awaiting review');
  // A rename is not a disclosure: done → completed, queued → pending.
  assert.equal(sourceStatusNote({ status: 'completed', context: { sourceStatus: 'done' } } as never), null);
  assert.equal(sourceStatusNote({ status: 'pending', context: { sourceStatus: 'queued' } } as never), null);
  assert.equal(sourceStatusNote({ status: 'failed', context: { sourceStatus: 'failed' } } as never), null);
});

test('the stepper marks the first unfinished step active, and none when all are done', () => {
  const step = (stepId: string, status: PipelineStep['status']): PipelineStep =>
    ({ runId: 'r', stepId, label: stepId, status, startedAt: null, finishedAt: null, attempts: [] });
  const mid = stepperSteps([step('trigger', 'completed'), step('claim', 'skipped'), step('execute', 'running'), step('review', 'pending')]);
  assert.deepEqual(mid.map((s) => s.active), [false, false, true, false]);
  assert.deepEqual(mid.map((s) => s.done), [true, true, false, false]);
  const done = stepperSteps([step('a', 'completed'), step('b', 'completed')]);
  assert.equal(done.filter((s) => s.active).length, 0);
});

test('run ids (table-prefixed) are URL-encoded, and empty filters are omitted', () => {
  assert.equal(runHref('/api/runs', 'job:job-obs-maint-1'), '/api/runs/job%3Ajob-obs-maint-1');
  assert.equal(runsQuery({}), '');
  assert.equal(runsQuery({ status: 'failed', kind: '', contextTenant: 'orgiq', limit: 200 }), '?status=failed&contextTenant=orgiq&limit=200');
});

// P1 — agent runs: a step's attempts are its tool calls, named.
test('an agent step lists its tool calls as attempts; any other step shows its retry count', () => {
  const agent = { attempts: [
    { attempt: 1, status: 'completed' as const, label: 'search_organization', toolCallId: 'tc1' },
    { attempt: 2, status: 'failed' as const, label: 'get_expertise_scores', toolCallId: 'tc2' },
  ] };
  assert.deepEqual(attemptItems(agent), [
    { key: 'tc1', label: 'search_organization', status: 'completed' },
    { key: 'tc2', label: 'get_expertise_scores', status: 'failed' },
  ]);
  assert.deepEqual(attemptItems({ attempts: [{ attempt: 3, status: 'completed' }] }), [{ key: 'n3', label: 'attempt 3', status: 'completed' }]);
  assert.deepEqual(attemptItems({ attempts: [] }), []);
});

test('agent runs are filterable and named; unlinked traces are counted, not hidden', () => {
  assert.ok(KIND_FILTER_OPTIONS.some((o) => o.value === 'agent'));
  assert.equal(sourceLabel('invocation_traces'), 'agent trace');
  assert.equal(unlinkedNote(undefined), null);
  assert.equal(unlinkedNote({ invocation_traces: 0 }), null);
  assert.match(unlinkedNote({ invocation_traces: 3 }) ?? '', /^3 agent traces carry no run id/);
  assert.match(unlinkedNote({ invocation_traces: 1 }) ?? '', /^1 agent trace carries no run id/);
});

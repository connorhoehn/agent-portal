// Run with:  cd portal && node --test 'src/pages/distillation/__tests__/*.test.ts'

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  orderedSteps, latestRun, chosenRun, stepMarkers, latestRunCallout, runHistoryRows, STEP_MARKER,
} from '../procedureRunsModel.ts';
import type { ProcedureRun } from '../types.ts';

const STEPS = [
  { id: 's3', title: 'Deploy', ordinal: 3 },
  { id: 's1', title: 'Build', ordinal: 1, body: 'npm run build' },
  { id: 's2', title: 'Migrate', ordinal: 2 },
];

const RUNS: ProcedureRun[] = [
  { id: 'r-old', at: '2026-09-20T10:00:00Z', actor: 'sess-a', note: null,
    steps: [{ step_id: 's1', status: 'done' }, { step_id: 's2', status: 'done' }, { step_id: 's3', status: 'done' }] },
  { id: 'r-new', at: '2026-09-24T10:00:00Z', actor: 'sess-b', note: 'migration lock held',
    steps: [{ step_id: 's1', status: 'done' }, { step_id: 's2', status: 'skipped' }, { step_id: 's3', status: 'failed' }] },
];

test('steps order by ordinal', () => {
  assert.deepEqual(orderedSteps(STEPS).map((s) => s.id), ['s1', 's2', 's3']);
  assert.deepEqual(orderedSteps([{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }]).map((s) => s.id), ['a', 'b']);
});

test('latest run is the newest by time, not wire order', () => {
  assert.equal(latestRun(RUNS)?.id, 'r-new');
  assert.equal(latestRun([]), null);
});

test('never run: steps with no markers and no callout', () => {
  const m = stepMarkers(STEPS, []);
  assert.deepEqual(m.map((s) => s.status), [undefined, undefined, undefined]);
  assert.equal(m[0].body, 'npm run build');
  assert.equal(latestRunCallout(STEPS, []), null);
});

test('markers from the latest run, note under the failed step', () => {
  const m = stepMarkers(STEPS, RUNS);
  assert.deepEqual(m.map((s) => [s.id, s.status, s.note]), [
    ['s1', 'done', undefined], ['s2', 'skipped', undefined], ['s3', 'failed', 'migration lock held'],
  ]);
  assert.deepEqual(m.map((s) => STEP_MARKER[s.status!]), ['✓', '–', '!']);
});

test('callout: stopped at step N with the note', () => {
  const c = latestRunCallout(STEPS, RUNS);
  assert.equal(c?.text, 'Latest run stopped at step 3 — migration lock held');
  assert.equal(c?.tone, 'danger');
  assert.equal(c?.failedAtStep, 3);
  assert.equal(c?.actor, 'sess-b');
});

test('callout: completed, partial (unmentioned steps are pending), no outcomes', () => {
  assert.equal(latestRunCallout(STEPS, [RUNS[0]])?.text, 'Latest run completed all 3 steps');
  const partial: ProcedureRun = { at: '2026-09-24T11:00:00Z', actor: null, note: null, steps: [{ step_id: 's1', status: 'done' }] };
  assert.equal(latestRunCallout(STEPS, [partial])?.text, 'Latest run reached 1 of 3 steps');
  assert.equal(stepMarkers(STEPS, [partial])[2].status, 'pending');
  const empty: ProcedureRun = { at: '2026-09-24T11:00:00Z', actor: null, note: 'aborted', steps: [] };
  assert.equal(latestRunCallout(STEPS, [empty])?.text, 'Latest run recorded no step outcomes — aborted');
});

test('history rows newest first with outcome and summary', () => {
  const rows = runHistoryRows(STEPS, RUNS);
  assert.deepEqual(rows.map((r) => [r.id, r.outcome, r.summary, r.failedAtStep]), [
    ['r-new', 'failed', '1 of 3 steps done', 3],
    ['r-old', 'succeeded', '3 of 3 steps done', null],
  ]);
  const anon = runHistoryRows(STEPS, [{ at: 'x', actor: null, note: null, steps: [] }]);
  assert.equal(anon[0].id, 'x#0', 'a run without an id still gets a stable key');
});

test('stepMarkers shows a chosen run; an unknown or absent id falls back to the latest', () => {
  const old = stepMarkers(STEPS, RUNS, 'r-old');
  assert.deepEqual(old.map((m) => m.status), ['done', 'done', 'done']);
  assert.equal(old.some((m) => m.note), false);
  const latest = stepMarkers(STEPS, RUNS).map((m) => m.status);
  assert.deepEqual(stepMarkers(STEPS, RUNS, 'r-gone').map((m) => m.status), latest);
  assert.deepEqual(stepMarkers(STEPS, RUNS, null).map((m) => m.status), latest);
  assert.equal(chosenRun(RUNS, 'r-old')?.id, 'r-old');
  assert.equal(chosenRun(RUNS)?.id, 'r-new');
  assert.equal(chosenRun([], 'r-old'), null);
});

test('chosenRun matches an id-less run by the history row key', () => {
  const idless: ProcedureRun[] = [{ at: '2026-09-21T10:00:00Z', actor: null, note: null, steps: [{ step_id: 's1', status: 'failed' }] }];
  const key = runHistoryRows(STEPS, [...RUNS, ...idless]).find((r) => r.at === '2026-09-21T10:00:00Z')!.id;
  assert.equal(chosenRun([...RUNS, ...idless], key)?.at, '2026-09-21T10:00:00Z');
});

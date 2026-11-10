// Run with:  cd portal && node --test 'src/pages/library/__tests__/*.test.ts'

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  formatPassRate, assertionSummary, latestRun, caseResultFor, progressColor, runEvalsDisabledReason,
  type EvalRun,
} from '../evalFormat.ts';

function run(over: Partial<EvalRun> = {}): EvalRun {
  return {
    id: 'run-1', assetId: 'lib-csrf-check', version: '5', ranAt: '2026-01-01T00:00:00Z',
    ranBy: 'tester', passRate: 1, total: 3, passed: 3,
    results: [{ caseId: 'ev-1', passed: true, failures: [] }],
    ...over,
  };
}

test('formatPassRate: "no runs yet" for null, otherwise a rounded percentage', () => {
  assert.equal(formatPassRate(null), 'no runs yet');
  assert.equal(formatPassRate(0.833), '83%');
  assert.equal(formatPassRate(1), '100%');
});

test('assertionSummary: singular vs plural', () => {
  assert.equal(assertionSummary(1), '1 assertion');
  assert.equal(assertionSummary(3), '3 assertions');
  assert.equal(assertionSummary(0), '0 assertions');
});

test('latestRun: picks the most recent ranAt regardless of input order', () => {
  const older = run({ id: 'run-old', ranAt: '2026-01-01T00:00:00Z' });
  const newer = run({ id: 'run-new', ranAt: '2026-02-01T00:00:00Z' });
  assert.equal(latestRun([older, newer])?.id, 'run-new');
  assert.equal(latestRun([newer, older])?.id, 'run-new');
  assert.equal(latestRun([]), null);
});

test('caseResultFor: finds the result for a case in the given run, null when absent or no run', () => {
  const r = run({ results: [{ caseId: 'ev-1', passed: false, failures: ['x'] }] });
  assert.equal(caseResultFor(r, 'ev-1')?.passed, false);
  assert.equal(caseResultFor(r, 'ev-missing'), null);
  assert.equal(caseResultFor(null, 'ev-1'), null);
});

test('progressColor: red only below the 80% gate floor', () => {
  assert.equal(progressColor(0.79), 'var(--color-danger)');
  assert.equal(progressColor(0.8), undefined);
  assert.equal(progressColor(null), undefined);
});

test('runEvalsDisabledReason: no cases or a run in progress say why; a runnable suite says nothing', () => {
  assert.equal(runEvalsDisabledReason({ busy: false, caseCount: 3 }), null);
  assert.match(runEvalsDisabledReason({ busy: false, caseCount: 0 })!, /no eval cases/);
  assert.match(runEvalsDisabledReason({ busy: true, caseCount: 3 })!, /in progress/);
});

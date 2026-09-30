// Run with:  cd portal && node --test 'src/components/chat/__tests__/*.test.ts'
//
// Plain node:test (see answerSources.test.ts for the established pattern) —
// pure module, no JSX, no DOM.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildFeedbackBody, buildRunFeedbackBody } from '../feedbackBody.ts';

const ID = '11111111-2222-3333-4444-555555555555';

test('builds the minimal body with no note', () => {
  assert.deepEqual(buildFeedbackBody(ID, 'good'), { invocationId: ID, label: 'good' });
});

test('includes a trimmed note when provided', () => {
  assert.deepEqual(buildFeedbackBody(ID, 'bad', '  wrong person  '), {
    invocationId: ID,
    label: 'bad',
    note: 'wrong person',
  });
});

test('drops a blank/whitespace-only note rather than sending empty string', () => {
  assert.deepEqual(buildFeedbackBody(ID, 'good', '   '), { invocationId: ID, label: 'good' });
});

test('omits note when undefined', () => {
  assert.deepEqual(buildFeedbackBody(ID, 'bad', undefined), { invocationId: ID, label: 'bad' });
});

test('by run: the AG-UI run id instead of a trace uuid, same note rules', () => {
  assert.deepEqual(buildRunFeedbackBody('run-1', 'good'), { runId: 'run-1', label: 'good' });
  assert.deepEqual(buildRunFeedbackBody('run-1', 'bad', '  off  '), { runId: 'run-1', label: 'bad', note: 'off' });
  assert.deepEqual(buildRunFeedbackBody('run-1', 'bad', '  '), { runId: 'run-1', label: 'bad' });
});

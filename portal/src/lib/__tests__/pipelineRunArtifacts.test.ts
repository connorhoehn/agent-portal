// Run with:  cd portal && node --test src/lib/__tests__/pipelineRunArtifacts.test.ts
//
// A run's artifacts name their step and their place in words; the ids (a step
// id like "route-2", an invocation id like "mock-inv-0" or a uuid) stay in the
// hover title (walk, 9 November).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { artifactPlace, artifactStepLabel } from '../pipelineRuns.ts';

test('a trace says where it is read, with the invocation id only in the title', () => {
  assert.deepEqual(artifactPlace({ kind: 'trace', uri: 'mock-inv-0' }), { label: 'Observability · invocation trace', title: 'mock-inv-0' });
  assert.deepEqual(artifactPlace({ kind: 'document', uri: 's3://halyard-docs/auth/cutover.md' }), { label: 's3://halyard-docs/auth/cutover.md' });
});

test('an artifact names the step it came from', () => {
  const steps = [{ stepId: 'search-1', label: 'search' }, { stepId: 'synthesize-2', label: 'synthesize' }];
  assert.equal(artifactStepLabel({ stepId: 'synthesize-2' }, steps), 'synthesize');
  assert.equal(artifactStepLabel({ stepId: 'gone-9' }, steps), 'gone-9');
  assert.equal(artifactStepLabel({ stepId: null }, steps), '—');
});

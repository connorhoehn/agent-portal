// Run with:  cd portal && node --test src/lib/__tests__/pipelineRunArtifacts.test.ts
//
// A run's artifacts name their step and their place in words; the ids (a step
// id like "route-2", an invocation id like "mock-inv-0" or a uuid) stay in the
// hover title (walk, 9 November).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { artifactPlace, artifactStepLabel, definitionLabel } from '../pipelineRuns.ts';

test('a trace says where it is read, with the invocation id only in the title', () => {
  assert.deepEqual(artifactPlace({ kind: 'trace', uri: 'mock-inv-0' }), { label: 'Observability · invocation trace', title: 'mock-inv-0' });
  assert.deepEqual(artifactPlace({ kind: 'document', uri: 's3://halyard-docs/auth/cutover.md' }), { label: 's3://halyard-docs/auth/cutover.md' });
});

test('a store key or a commit hash is named in words, the key or hash in the title (UX leftovers, 10 November)', () => {
  assert.deepEqual(artifactPlace({ kind: 'transcript', uri: 'agent_jobs/job-inf-maint-1#result' }), { label: "Work queue · the job's result", title: 'agent_jobs/job-inf-maint-1#result' });
  assert.deepEqual(artifactPlace({ kind: 'change', uri: 'agent_change_requests/cr-9' }), { label: 'Changes · change request', title: 'agent_change_requests/cr-9' });
  const sha = 'a'.repeat(7) + 'b'.repeat(33);
  assert.deepEqual(artifactPlace({ kind: 'change', uri: sha }), { label: 'Commit aaaaaaa', title: sha });
});

test('an artifact names the step it came from', () => {
  const steps = [{ stepId: 'search-1', label: 'search' }, { stepId: 'synthesize-2', label: 'synthesize' }];
  assert.equal(artifactStepLabel({ stepId: 'synthesize-2' }, steps), 'synthesize');
  assert.equal(artifactStepLabel({ stepId: 'gone-9' }, steps), 'gone-9');
  assert.equal(artifactStepLabel({ stepId: null }, steps), '—');
});

test('a run names what ran: the name the caller knows, an agent by its role, else its kind', () => {
  assert.equal(definitionLabel('bot:32970d0a-e28e-5100-8fb0-a5cbb87dac99', 'obs-nightly-maintenance'), 'obs-nightly-maintenance');
  assert.equal(definitionLabel('bot:32970d0a-e28e-5100-8fb0-a5cbb87dac99'), 'A bot');
  assert.equal(definitionLabel('agent:orgiq-supervisor'), 'Supervisor agent');
  assert.equal(definitionLabel('agent:graph-builder'), 'Graph builder agent');
  assert.equal(definitionLabel('mystery'), 'Not recorded');
  assert.equal(definitionLabel(null), 'Not recorded');
});

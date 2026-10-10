import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jobAgentRequest, type JobQuestionContext } from '../jobAgentRequest.ts';

const job: JobQuestionContext = { id: 'job-1', title: 'Check the dependency map', status: 'done',
  payload: { prompt: 'Review the checklist.', initiativeId: 'p-observability', workItemId: 'wi-obs-e2-b4',
    credentials: 'never-include-arbitrary-payload', unrelated: 'not relevant' },
  result: { summary: 'Validation still needs a dependency map.' }, error: null };

test('removing the run reference removes its snapshot and authoritative selection', () => {
  const request = jobAgentRequest('/agent Explain the options', job, false)!;
  assert.deepEqual(request, { prompt: 'Explain the options', question: 'Explain the options', contextLabel: null, records: [] });
});

test('a submitted snapshot stays on its original job when polling updates the page', () => {
  const current = structuredClone(job);
  const request = jobAgentRequest('What should we validate next?', current, true)!;
  current.status = 'running'; current.result!.summary = 'A later attempt'; current.payload.workItemId = 'wi-other';
  assert.match(request.prompt, /"status":"done"/);
  assert.match(request.prompt, /Validation still needs a dependency map/);
  assert.doesNotMatch(request.prompt, /never-include|unrelated|A later attempt/);
  assert.deepEqual(request.records, [{ type: 'initiative', id: 'p-observability' }, { type: 'work', id: 'wi-obs-e2-b4' }]);
  assert.match(request.prompt, /does not authorize running/);
});

test('unlinked jobs do not invent project context or a job search record type', () => {
  const request = jobAgentRequest('What happened?', { ...job, payload: {}, result: null, error: 'Computer unavailable' }, true)!;
  assert.deepEqual(request.records, []);
  assert.match(request.prompt, /Computer unavailable/);
  assert.equal(jobAgentRequest('  ', job, true), null);
});

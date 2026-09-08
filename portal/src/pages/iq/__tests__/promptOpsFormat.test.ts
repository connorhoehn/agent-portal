// Run with:  cd portal && node --test 'src/pages/iq/__tests__/*.test.ts'

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseArn, runtimeForSystemPrompt, subjectLabel, systemPromptForRuntime,
} from '../promptOpsFormat.ts';

test('parseArn splits the trailing id:version and treats a missing version as DRAFT', () => {
  assert.deepEqual(parseArn('arn:aws:bedrock:us-east-1:123:prompt/ABC123:1'), { id: 'ABC123', version: '1' });
  assert.deepEqual(parseArn('arn:aws:bedrock:us-east-1:123:prompt/ABC123'), { id: 'ABC123', version: '' });
  assert.deepEqual(parseArn(undefined), { id: '', version: '' });
});

test('subjectLabel names the prompt from the library map and falls back to the raw id', () => {
  const names = new Map([['ABC123', 'orgiq-search-system-prompt']]);
  assert.equal(subjectLabel('arn:.../prompt/ABC123:3', names), 'orgiq-search-system-prompt · v3');
  assert.equal(subjectLabel('arn:.../prompt/ABC123', names), 'orgiq-search-system-prompt · DRAFT');
  assert.equal(subjectLabel('arn:.../prompt/UNKNOWN:1', names), 'UNKNOWN · v1');
  assert.equal(subjectLabel(undefined, names), '—');
});

test('runtimeForSystemPrompt matches only system-prompt library entries', () => {
  assert.equal(runtimeForSystemPrompt('orgiq-search-system-prompt'), 'orgiq_search');
  assert.equal(runtimeForSystemPrompt('orgiq-graph-builder-system-prompt'), 'orgiq_graph_builder');
  assert.equal(runtimeForSystemPrompt('some-other-prompt'), null);
});

test('systemPromptForRuntime is the inverse of runtimeForSystemPrompt', () => {
  assert.equal(systemPromptForRuntime('orgiq_search'), 'orgiq-search-system-prompt');
  assert.equal(systemPromptForRuntime('orgiq_graph_builder'), 'orgiq-graph-builder-system-prompt');
  // The third name has two underscores in its suffix, which is the case the
  // round-trip can get wrong; keep a live runtime here so a deleted agent's
  // name never lingers in a fixture.
  for (const name of ['orgiq_search', 'orgiq_graph_builder', 'orgiq_assessment_scorer']) {
    assert.equal(runtimeForSystemPrompt(systemPromptForRuntime(name)), name);
  }
});

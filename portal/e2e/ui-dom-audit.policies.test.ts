import assert from 'node:assert/strict';
import test from 'node:test';
import { pipelineComposerPolicy } from './ui-dom-audit.policies.ts';

test('all inspected collections require input even when empty', () => {
  for (const path of ['', '/runs', '/runs/abc', '/definitions', '/queues', '/runbooks', '/artifacts', '/approvals', '/agents', '/bots', '/commands']) {
    assert.deepEqual(pipelineComposerPolicy(`/pipelines${path}`), { mode: 'required' });
  }
});
test('contextual exceptions require positive evidence and cannot exempt another route', () => {
  const views = [
    ['/activity', { graph: true }], ['/communication', { communicationOverview: true }],
    ['/communication', { socialAccessRequired: true }], ['/configuration', { configurationForm: true }],
    ['/settings', { settingsPlaceholder: true }],
  ] as const;
  for (const [path, evidence] of views) {
    assert.equal(pipelineComposerPolicy(`/pipelines${path}`), undefined);
    assert.equal(pipelineComposerPolicy(`/pipelines${path}`, evidence)?.mode, 'exempt');
    assert.equal(pipelineComposerPolicy('/pipelines/unknown', evidence), undefined);
    assert.equal(pipelineComposerPolicy('/pipelines/runs', evidence)?.mode, 'required');
  }
});
test('loaded reports require composers; verified unavailable records are distinct', () => {
  assert.equal(pipelineComposerPolicy('/pipelines/decks/report')?.mode, 'required');
  assert.equal(pipelineComposerPolicy('/pipelines/decks/report', { missingDeck: true })?.mode, 'exempt');
});
test('unknown tenant routes never inherit a blanket exemption', () => {
  assert.equal(pipelineComposerPolicy('/iq/settings', { settingsPlaceholder: true }), undefined);
  assert.equal(pipelineComposerPolicy('/pipelines/new-page'), undefined);
});

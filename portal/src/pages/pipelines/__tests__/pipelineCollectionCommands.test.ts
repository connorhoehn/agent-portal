import assert from 'node:assert/strict';
import { test } from 'node:test';
import { filterArtifacts, filterQueues, filterRunbooks, parsePipelineCollectionCommand, pipelineCollectionAdapter, type PipelineCollection } from '../pipelineCollectionCommands.ts';
import type { RunbookRow } from '../../../lib/pipelineDefinitions.ts';
import type { PipelineArtifact } from '../../../lib/pipelineRuns.ts';
import type { PipelineQueue } from '../../../lib/pipelineQueues.ts';

for (const collection of ['definitions', 'runbooks', 'queues', 'artifacts'] as PipelineCollection[]) {
  test(`${collection}: quoted search preserves punctuation and case; reset/refresh/help are bounded`, () => {
    assert.deepEqual(parsePipelineCollectionCommand(`search ${collection} for "DEP-5.1"`, collection), { kind: 'search', query: 'DEP-5.1' });
    assert.deepEqual(parsePipelineCollectionCommand(`Please refresh ${collection}!`, collection), { kind: 'refresh' });
    assert.deepEqual(parsePipelineCollectionCommand(`show all ${collection}`, collection), { kind: 'reset' });
    assert.deepEqual(parsePipelineCollectionCommand('help', collection), { kind: 'help' });
    for (const phrase of ['', 'reset filters and delete all', 'refresh every second', 'search for ""', 'purge queues', 'run all', 'x'.repeat(501)]) {
      assert.throws(() => parsePipelineCollectionCommand(phrase, collection), Error, phrase);
    }
  });
  test(`${collection}: advertised examples execute, unsupported commands cannot mutate filters`, () => {
    let query = 'current'; let filter = 'current'; let refreshes = 0;
    const adapter = pipelineCollectionAdapter(collection, {
      setQuery: value => { query = value; }, setFilter: value => { filter = value; }, refresh: () => { refreshes++; }, scopeNote: 'Loaded rows only.',
    });
    assert.throws(() => adapter.execute('delete everything'));
    assert.equal(query, 'current'); assert.equal(filter, 'current'); assert.equal(refreshes, 0);
    adapter.execute('search for "literal and punctuation!"');
    assert.equal(query, 'literal and punctuation!'); assert.equal(filter, 'current');
    adapter.execute('help'); assert.equal(query, 'literal and punctuation!');
    adapter.execute('refresh'); assert.equal(refreshes, 1); assert.equal(query, 'literal and punctuation!');
    adapter.execute('reset filters'); assert.equal(query, ''); assert.equal(filter, '');
    for (const example of adapter.examples) assert.doesNotThrow(() => adapter.execute(example), example);
  });
}
test('filter phrases select only supported values and reject qualifiers that would silently broaden scope', () => {
  assert.deepEqual(parsePipelineCollectionCommand('show assessment command definitions', 'definitions'), { kind: 'filter', value: 'assessment-command' });
  assert.deepEqual(parsePipelineCollectionCommand('show needs dry-run runbooks', 'runbooks'), { kind: 'filter', value: 'needs-dry-run' });
  assert.deepEqual(parsePipelineCollectionCommand('show dead-letter queues', 'queues'), { kind: 'filter', value: 'dead-letter' });
  assert.deepEqual(parsePipelineCollectionCommand('show trace artifacts', 'artifacts'), { kind: 'filter', value: 'trace' });
  assert.throws(() => parsePipelineCollectionCommand('show dead-letter queues from yesterday', 'queues'));
  assert.throws(() => parsePipelineCollectionCommand('show passed artifacts', 'artifacts'));
});
test('runbook search and promotion filters intersect and keep promoted distinct from dry-run requirements', () => {
  const rows = [
    { id: '1', title: 'Nightly audit', owner: 'Nora', description: null, runbook: { candidateStatus: 'candidate', promotionToSkill: { ok: true, runId: 'r1' } } },
    { id: '2', title: 'Nightly deploy', owner: null, description: 'Staging', runbook: { candidateStatus: 'candidate', promotionToSkill: { ok: false, reason: 'Never run' } } },
    { id: '3', title: 'Nightly monitor', owner: null, description: null, runbook: { candidateStatus: 'promoted', promotionToSkill: { ok: false, reason: 'No history' } } },
  ] as RunbookRow[];
  assert.deepEqual(filterRunbooks(rows, 'NIGHTLY', 'passed').map(row => row.id), ['1']);
  assert.deepEqual(filterRunbooks(rows, 'Staging', 'needs-dry-run').map(row => row.id), ['2']);
  assert.deepEqual(filterRunbooks(rows, '', 'promoted').map(row => row.id), ['3']);
  assert.equal(filterRunbooks(rows, 'deploy', 'passed').length, 0);
  assert.equal(filterRunbooks(rows, '', 'unknown').length, 0);
  assert.equal(rows.length, 3);
});
test('queue filtering preserves unknown metadata and distinguishes dead-letter classification from availability', () => {
  const rows = [
    { name: 'work', purpose: 'Ingest', deadLetter: false, state: 'available', snapshot: null },
    { name: 'work-dlq', purpose: 'Failed ingest', deadLetter: true, state: 'unavailable', snapshot: null },
    { name: 'batch', purpose: 'Backfill', deadLetter: false, state: 'missing', snapshot: null },
  ] as PipelineQueue[];
  assert.deepEqual(filterQueues(rows, 'INGEST', 'dead-letter').map(row => row.name), ['work-dlq']);
  assert.deepEqual(filterQueues(rows, '', 'work').map(row => row.name), ['work', 'batch']);
  assert.deepEqual(filterQueues(rows, '', 'missing').map(row => row.name), ['batch']);
  assert.equal(filterQueues(rows, 'dlq', 'available').length, 0);
  assert.equal(filterQueues(rows, '  Ingest  ', '').length, 2);
  assert.equal(rows[1].snapshot, null);
});
test('artifact search uses identifiers, title and workspace without requiring a linked run', () => {
  const rows = [
    { id: 'artifact-A', title: 'Contract', runId: null, contextTenant: 'orgiq' },
    { id: 'artifact-B', title: 'Scores', runId: 'assessment:123', contextTenant: null },
  ] as PipelineArtifact[];
  assert.deepEqual(filterArtifacts(rows, ' ARTIFACT-a ').map(row => row.id), ['artifact-A']);
  assert.deepEqual(filterArtifacts(rows, 'ASSESSMENT:123').map(row => row.id), ['artifact-B']);
  assert.equal(filterArtifacts(rows, 'orgiq').length, 1);
  assert.equal(filterArtifacts(rows, '').length, 2);
});

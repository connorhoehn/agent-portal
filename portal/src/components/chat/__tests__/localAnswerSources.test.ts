import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveSources, provenanceNote } from '../answerSources.ts';
import { friendlyToolName, summarizeToolCalls } from '../toolCallSummary.ts';

// A local answer (middleware lib/local-answers) streams a `local_answer` call
// (the rows its figures came from) and a `search_context` call (its cited
// records). It is not a retrieval, so it must never read as "knowledge base
// searched — no documents matched".
const local = [
  { name: 'local_answer', args: '{"intent":"budget"}', result: '{"intent":"budget","rows":[]}' },
  { name: 'search_context', args: '{"records":[]}', result: '{"records":[],"edges":[]}' },
];

test('a local answer chips its data source and claims no search', () => {
  const out = deriveSources({ content: 'No initiative is over its October allocation.', toolCalls: local });
  assert.deepEqual(out.sources.map(s => s.label), ['program data']);
  assert.equal(provenanceNote(out.sources, out.provenance), null);
});

test('the tool strip names data, not tool ids', () => {
  assert.equal(friendlyToolName('local_answer'), 'read program data');
  assert.equal(summarizeToolCalls(local), 'read program data · read cited records');
});

test('an answer that ran no tool says nothing about provenance', () => {
  const out = deriveSources({ content: "I can't answer that here.", toolCalls: [] });
  assert.equal(provenanceNote(out.sources, out.provenance), null);
});

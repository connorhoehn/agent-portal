import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deckQuestionRequest } from '../deckQuestionRequest.ts';
import type { DeckSpec } from '../deckApi.ts';

const spec: DeckSpec = { title: 'Review', slides: [
  { id: 'summary', title: 'Summary', layout: 'bullets', bullets: ['Original figures'], notes: 'Saved speaker note', sources: [{ documentId: 'initiative:p-observability', title: 'Observability' }] },
  { id: 'next', title: 'Next step', layout: 'bullets', bullets: ['Replay the outage'], sources: [] },
] };
test('question captures visible slide and version without adding edit authority', () => {
  const records = [{ type: 'initiative' as const, id: 'p-observability' }];
  const request = deckQuestionRequest({ deckId: 'd1', title: 'Review', revisionId: 'v7', spec, question: '/agent Explain this slide', slideId: 'summary', records })!;
  records[0].id = 'another';
  assert.equal(request.question, 'Explain this slide');
  assert.equal(request.contextLabel, 'Review › Summary');
  assert.match(request.prompt, /read-only question/);
  assert.match(request.prompt, /Visible saved version: v7/);
  assert.match(request.prompt, /Saved speaker note/);
  assert.doesNotMatch(request.prompt, /Replay the outage/);
  assert.deepEqual(request.records, [{ type: 'initiative', id: 'p-observability' }]);
});
test('removing the reference removes all captured deck and source context', () => {
  const request = deckQuestionRequest({ deckId: 'private', title: 'Private deck', revisionId: 'v7', spec, question: 'General question', withReference: false })!;
  assert.deepEqual(request, { prompt: 'General question', question: 'General question', contextLabel: null, records: [] });
});
test('generated Sources and unsaved drafts keep truthful provenance', () => {
  const request = deckQuestionRequest({ deckId: 'd1', title: 'Review', revisionId: 'v7', spec, question: 'Where did this come from?', generatedTitle: 'Sources', dirty: true })!;
  assert.equal(request.contextLabel, 'Review › Sources');
  assert.match(request.prompt, /generated Sources slide/);
  assert.match(request.prompt, /Visible draft based on: v7/);
  assert.match(request.prompt, /initiative:p-observability/);
});

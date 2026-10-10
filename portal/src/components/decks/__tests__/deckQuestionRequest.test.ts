import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deckQuestionRequest } from '../deckQuestionRequest.ts';
import type { DeckSpec } from '../deckApi.ts';
import { initiativeAgentBody, presentationReadReceipt } from '../../../pages/projects/initiativeAgentRequest.ts';

const spec: DeckSpec = { title: 'Review', slides: [
  { id: 'summary', title: 'Summary', layout: 'bullets', bullets: ['Original figures'], notes: 'Saved speaker note', sources: [{ documentId: 'initiative:p-observability', title: 'Observability' }] },
  { id: 'next', title: 'Next step', layout: 'bullets', bullets: ['Replay the outage'], sources: [] },
] };
test('question captures visible slide and version without adding edit authority', () => {
  const records = [{ type: 'initiative' as const, id: 'p-observability' }];
  const request = deckQuestionRequest({ deckId: 'd1', title: 'Review', revisionId: 'v7', spec, question: '/agent Explain this slide', slideId: 'summary', records })!;
  records[0].id = 'another';
  assert.equal(request.question, 'Explain this slide');
  assert.equal(request.contextLabel, 'Review › Summary · v7');
  assert.match(request.prompt, /read-only question/);
  assert.match(request.prompt, /Visible saved version: v7/);
  assert.match(request.prompt, /Saved speaker note/);
  assert.doesNotMatch(request.prompt, /Replay the outage/);
  assert.deepEqual(request.records, []);
  assert.deepEqual(request.presentationContext, { kind: 'initiative-deck', deckId: 'd1', revisionId: 'v7', scope: 'slide', slideId: 'summary' });
  assert.deepEqual(initiativeAgentBody(request.prompt, request, 'session'), { message: 'Explain this slide', sessionId: 'session', presentationContext: request.presentationContext });
});
test('removing the reference removes all captured deck and source context', () => {
  const request = deckQuestionRequest({ deckId: 'private', title: 'Private deck', revisionId: 'v7', spec, question: 'General question', withReference: false })!;
  assert.deepEqual(request, { prompt: 'General question', question: 'General question', contextLabel: null, records: [] });
});
test('generated Sources and unsaved drafts keep truthful provenance', () => {
  const request = deckQuestionRequest({ deckId: 'd1', title: 'Review', revisionId: 'v7', spec, question: 'Where did this come from?', generatedTitle: 'Sources', dirty: true })!;
  assert.equal(request.contextLabel, 'Review › Sources · v7 draft');
  assert.match(request.prompt, /generated Sources slide/);
  assert.match(request.prompt, /Visible draft based on: v7/);
  assert.match(request.prompt, /initiative:p-observability/);
  assert.equal(request.presentationContext?.scope, 'sources');
  assert.equal(request.presentationContext?.draftSpec?.slides[0].notes, 'Saved speaker note');
  spec.slides[0].notes = 'Changed after send';
  assert.equal(request.presentationContext?.draftSpec?.slides[0].notes, 'Saved speaker note');
});
test('a missing saved version or deleted selected slide does not become an initiative or whole-deck question', () => {
  assert.throws(() => deckQuestionRequest({ deckId: 'd1', title: 'Review', revisionId: null, spec, question: 'Summarize', slideId: 'summary' }), /version is still loading/);
  assert.throws(() => deckQuestionRequest({ deckId: 'd1', title: 'Review', revisionId: 'v7', spec, question: 'Summarize', slideId: 'deleted' }), /no longer available/);
});
test('ordinary Work agent requests keep their server-resolved initiative selection', () => {
  const request = { prompt: 'About Auth: Who owns this?', question: 'Who owns this?', contextLabel: 'Auth', records: [{ type: 'initiative' as const, id: 'auth' }] };
  assert.deepEqual(initiativeAgentBody(request.prompt, request), { message: request.prompt, selection: { records: request.records } });
});
test('repeating one question across slides retains distinct captured transcript keys and version/slide scope', () => {
  const first = deckQuestionRequest({ deckId: 'd1', title: 'Review', revisionId: 'v7', spec, question: 'Summarize this slide', slideId: 'summary' })!;
  const second = deckQuestionRequest({ deckId: 'd1', title: 'Review', revisionId: 'v7', spec, question: 'Summarize this slide', slideId: 'next' })!;
  const transcriptRequests = new Map([[first.prompt, first], [second.prompt, second]]);
  assert.notEqual(first.prompt, second.prompt);
  assert.equal(transcriptRequests.get(first.prompt)?.contextLabel, 'Review › Summary · v7');
  assert.equal(transcriptRequests.get(second.prompt)?.contextLabel, 'Review › Next step · v7');
  assert.equal(initiativeAgentBody(first.prompt, first).message, 'Summarize this slide');
  assert.equal(initiativeAgentBody(second.prompt, second).presentationContext?.slideId, 'next');
});
test('presentation provenance displays only an actual completed context receipt with exact version and scope', () => {
  assert.equal(presentationReadReceipt([{ name: 'search_context', result: '{"title":"Unrelated initiative"}' }]), null);
  assert.equal(presentationReadReceipt([{ name: 'presentation_context' }]), null);
  const receipt = { kind: 'initiative-deck', deckId: 'd1', revisionId: 'v7', title: 'Review', scope: 'slide', provenance: 'saved-revision', slideTitles: ['Summary'] };
  const { kind: _kind, ...expected } = receipt;
  assert.deepEqual(presentationReadReceipt([{ name: 'presentation_context', result: JSON.stringify(receipt) }]), expected);
});

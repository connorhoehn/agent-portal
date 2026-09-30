import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DOCUMENT_EDIT_MODE,
  DOCUMENT_TEXT_LIMIT,
  buildDocumentEditRequest,
  documentEditInvokeUrl,
  documentEditMessage,
  insertContentFor,
  parseDocumentEditReply,
  pendingProposal,
  readyProposal,
  resolveApplyTarget,
  type DocumentEditContext,
} from '../knowledge/documentAgentEditModel.ts';

const PAGE = 'Scope\nThe assessment covers practices.\nNext steps';
const AT_CURSOR: DocumentEditContext = { docId: 'page:100002', title: 'SDLC Assessment Program', text: PAGE, selection: null, cursor: 7 };
const SELECTED: DocumentEditContext = { ...AT_CURSOR, selection: { from: 8, to: 41, text: 'The assessment covers practices.' } };

test('the drafter is reached through the existing invoke route', () => {
  assert.equal(documentEditInvokeUrl(), '/api/agents/orgiq-assessment-drafter/invoke');
});

test('a request carries the drafter document-command payload: mode, instruction, id, title, text and the selection with its range', () => {
  const request = buildDocumentEditRequest('  Make it one sentence  ', SELECTED)!;
  assert.equal(request.mode, DOCUMENT_EDIT_MODE);
  assert.match(request.instruction, /^Make it one sentence\n/);
  assert.match(request.instruction, /selected passage/);
  assert.deepEqual(request.document, {
    id: 'page:100002', title: 'SDLC Assessment Program', text: PAGE, truncated: false,
    selection: { from: 8, to: 41, text: 'The assessment covers practices.' },
  });
  assert.deepEqual(JSON.parse(documentEditMessage(request)), request);
});

test('without a selection the request asks for text at the cursor', () => {
  const request = buildDocumentEditRequest('Add a next step', AT_CURSOR)!;
  assert.equal(request.document.selection, null);
  assert.match(request.instruction, /insert at the cursor/);
});

test('an empty or whitespace selection counts as the cursor, and an empty instruction sends nothing', () => {
  assert.equal(buildDocumentEditRequest('x', { ...AT_CURSOR, selection: { from: 5, to: 5, text: '' } })!.document.selection, null);
  assert.equal(buildDocumentEditRequest('x', { ...AT_CURSOR, selection: { from: 5, to: 7, text: '  ' } })!.document.selection, null);
  assert.equal(buildDocumentEditRequest('   ', AT_CURSOR), null);
});

test('a long page is cut at the limit and says so', () => {
  const request = buildDocumentEditRequest('x', { ...AT_CURSOR, text: 'a'.repeat(DOCUMENT_TEXT_LIMIT + 10) })!;
  assert.equal(request.document.text.length, DOCUMENT_TEXT_LIMIT);
  assert.equal(request.document.truncated, true);
});

test('the reply is read from the drafter envelope, fenced or not', () => {
  const envelope = JSON.stringify({ summary: 'Tightens scope', content: 'Five practices.', format: 'markdown', source_spans: ['Scope'], draft: true, published: false });
  assert.deepEqual(parseDocumentEditReply(envelope), { ok: true, content: 'Five practices.', summary: 'Tightens scope' });
  assert.deepEqual(parseDocumentEditReply('```json\n' + envelope + '\n```'), { ok: true, content: 'Five practices.', summary: 'Tightens scope' });
});

test('a prose reply is the content; empty, content-less and error replies are refusals', () => {
  assert.deepEqual(parseDocumentEditReply('Just this.'), { ok: true, content: 'Just this.' });
  assert.equal(parseDocumentEditReply('  ').ok, false);
  assert.equal(parseDocumentEditReply('{"summary":"x","content":""}').ok, false);
  assert.deepEqual(parseDocumentEditReply('{"agent":"assessment-drafter","error":"mode must be story"}'), { ok: false, error: 'mode must be story' });
});

test('a send opens a streaming proposal anchored to the selection, and the reply makes it ready', () => {
  const pending = pendingProposal('p1', ' Tighten ', SELECTED);
  assert.deepEqual(pending, {
    id: 'p1', kind: 'replace', anchor: { from: 8, to: 41 }, content: { text: '' }, status: 'streaming',
    originalText: 'The assessment covers practices.', cursor: 7, instruction: 'Tighten',
  });
  const ready = readyProposal(pending, { ok: true, content: 'Five practices.', summary: 'Tightens scope' });
  assert.equal(ready.status, 'ready');
  assert.deepEqual(ready.content, { text: 'Five practices.' });
  assert.equal(ready.summary, 'Tightens scope');
  assert.equal(pendingProposal('p2', 'x', AT_CURSOR).anchor, 'cursor');
});

test('Apply replaces only while the same text is still at the range', () => {
  const pending = pendingProposal('p1', 'x', SELECTED);
  const page = (text: string) => ({ size: 60, textBetween: (from: number, to: number) => (from === 8 && to === 41 ? text : '') });
  assert.deepEqual(resolveApplyTarget(pending, page('The assessment covers practices.')), { ok: true, from: 8, to: 41 });
  assert.equal(resolveApplyTarget(pending, page('The assessment covers some practices')).ok, false);
  assert.equal(resolveApplyTarget(pending, { size: 20, textBetween: () => '' }).ok, false);
});

test('Apply inserts at the asked caret, clamped into the page', () => {
  const at = (cursor: number, size: number) => resolveApplyTarget({ ...pendingProposal('p', 'x', { ...AT_CURSOR, cursor }) }, { size, textBetween: () => '' });
  assert.deepEqual(at(7, 60), { ok: true, from: 7, to: 7 });
  assert.deepEqual(at(90, 60), { ok: true, from: 59, to: 59 });
  assert.deepEqual(at(0, 60), { ok: true, from: 1, to: 1 });
});

test('markdown becomes editor content: one paragraph inline, several as blocks, # as headings', () => {
  assert.equal(insertContentFor('One line\nwrapped.'), 'One line wrapped.');
  assert.deepEqual(insertContentFor('## Next steps\n\nConfirm owners.'), [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Next steps' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Confirm owners.' }] },
  ]);
  assert.equal(insertContentFor('\n\n'), '');
});

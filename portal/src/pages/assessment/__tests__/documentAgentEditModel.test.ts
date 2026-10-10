import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DOCUMENT_EDIT_MODE,
  DOCUMENT_EDIT_INPUT_LIMIT,
  DOCUMENT_REVISION_FEEDBACK_LIMIT,
  DOCUMENT_TEXT_LIMIT,
  buildDocumentEditRequest,
  buildDocumentRevisionRequest,
  documentEditInvokeUrl,
  documentEditMessage,
  insertContentFor,
  parseDocumentEditReply,
  pendingProposal,
  readyProposal,
  resolveApplyTarget,
  type DocumentEditContext,
  mergeRefreshedProposals,
} from '../knowledge/documentAgentEditModel.ts';

const PAGE = 'Scope\nThe assessment covers practices.\nNext steps';
const AT_CURSOR: DocumentEditContext = { docId: 'page:100002', title: 'SDLC Assessment Program', text: PAGE, selection: null, cursor: 7 };
const SELECTED: DocumentEditContext = { ...AT_CURSOR, selection: { from: 8, to: 41, text: 'The assessment covers practices.' } };
const PRIOR_DRAFT = {
  ...readyProposal(pendingProposal('proposal-original', 'Tighten the scope', SELECTED), { ok: true, content: 'Five practices are assessed.' }),
  version: 3,
};

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

test('revision retains the original replacement target and prior draft after the user changes selection and caret', () => {
  const context = { ...AT_CURSOR, selection: { from: 42, to: 52, text: 'Next steps' }, cursor: 52 };
  const request = buildDocumentRevisionRequest('  Mention ownership  ', context, PRIOR_DRAFT)!;
  assert.equal(request.mode, DOCUMENT_EDIT_MODE);
  assert.equal(request.instruction.split('\n')[0], 'Mention ownership');
  assert.deepEqual(request.document.selection, SELECTED.selection);
  assert.equal(request.document.cursor, PRIOR_DRAFT.cursor);
  assert.deepEqual(request.revision, {
    id: 'proposal-original', version: 3, instruction: 'Tighten the scope',
    content: { text: 'Five practices are assessed.' },
  });
  assert.equal(request.document.text, PAGE);
  assert.equal(request.document.truncated, false);
  assert.equal(request.document.text.includes(request.revision.content.text), false);
  assert.deepEqual(JSON.parse(documentEditMessage(request)), request);
  assert.deepEqual(PRIOR_DRAFT.anchor, { from: 8, to: 41 });
  assert.equal(PRIOR_DRAFT.status, 'ready');
});

test('revision of an insertion retains its original caret even when the user now has a selection', () => {
  const proposal = { ...readyProposal(pendingProposal('insert-original', 'Add a next step', AT_CURSOR), { ok: true, content: 'Confirm owners.' }), version: 7 };
  const request = buildDocumentRevisionRequest('Make it a question', { ...SELECTED, cursor: 90 }, proposal)!;
  assert.equal(request.document.selection, null);
  assert.equal(request.document.cursor, 7);
  assert.equal(request.revision.id, 'insert-original');
  assert.equal(request.revision.version, 7);
  assert.equal(request.revision.content.text, 'Confirm owners.');
});

test('revision preserves original whitespace selection text rather than treating it as a new insertion', () => {
  const proposal = { ...PRIOR_DRAFT, anchor: { from: 8, to: 10 }, originalText: '  ' };
  const request = buildDocumentRevisionRequest('Add a sentence', AT_CURSOR, proposal)!;
  assert.deepEqual(request.document.selection, { from: 8, to: 10, text: '  ' });
});

test('blank revision feedback sends nothing and feedback over the limit is a visible refusal', () => {
  assert.equal(buildDocumentRevisionRequest(' \n\t ', AT_CURSOR, PRIOR_DRAFT), null);
  const accepted = buildDocumentRevisionRequest(`  ${'x'.repeat(DOCUMENT_REVISION_FEEDBACK_LIMIT)}  `, AT_CURSOR, PRIOR_DRAFT)!;
  assert.equal(accepted.instruction.split('\n')[0].length, DOCUMENT_REVISION_FEEDBACK_LIMIT);
  assert.throws(() => buildDocumentRevisionRequest('x'.repeat(DOCUMENT_REVISION_FEEDBACK_LIMIT + 1), AT_CURSOR, PRIOR_DRAFT), /2,000 characters/);
});

test('revision bounds page context at the normal limit without truncating the pending draft', () => {
  const request = buildDocumentRevisionRequest('Tighten it', { ...AT_CURSOR, text: 'a'.repeat(DOCUMENT_TEXT_LIMIT + 10) }, PRIOR_DRAFT)!;
  assert.equal(request.document.text.length, DOCUMENT_TEXT_LIMIT);
  assert.equal(request.document.truncated, true);
  assert.deepEqual(request.revision.content, PRIOR_DRAFT.content);
});

test('revision rejects empty or whitespace-only canonical documents despite nonempty prior draft and selection', () => {
  for (const text of ['', ' \n\t\u00a0 ']) {
    assert.throws(() => buildDocumentRevisionRequest('Make it concise', { ...AT_CURSOR, text }, PRIOR_DRAFT), /document text as source context/);
  }
  assert.equal(buildDocumentRevisionRequest('   ', { ...AT_CURSOR, text: '' }, PRIOR_DRAFT), null);
});

test('revision rejects context whose meaningful document text falls beyond the page limit', () => {
  const text = ' '.repeat(DOCUMENT_TEXT_LIMIT) + 'Canonical source text.';
  assert.throws(() => buildDocumentRevisionRequest('Make it concise', { ...AT_CURSOR, text }, PRIOR_DRAFT), /document text as source context/);
});

test('revision refuses when the JSON budget leaves only empty or whitespace canonical context', () => {
  const feedback = 'Make it concise';
  const context = { ...AT_CURSOR, text: '   Canonical source text.' };
  const emptyDraft = { ...PRIOR_DRAFT, content: { text: '' } };
  const baseline = buildDocumentRevisionRequest(feedback, context, emptyDraft)!;
  const essential = { ...baseline, document: { ...baseline.document, text: '', truncated: true } };
  for (const availableContextLength of [0, 3]) {
    const draftLength = DOCUMENT_EDIT_INPUT_LIMIT - JSON.stringify(essential).length - availableContextLength;
    const proposal = { ...PRIOR_DRAFT, content: { text: 'x'.repeat(draftLength) } };
    const boundary = {
      ...essential,
      document: { ...essential.document, text: context.text.slice(0, availableContextLength) },
      revision: { ...essential.revision, content: proposal.content },
    };
    assert.equal(JSON.stringify(boundary).length, DOCUMENT_EDIT_INPUT_LIMIT);
    assert.throws(() => buildDocumentRevisionRequest(feedback, context, proposal), /leaves no document text as source context/);
    assert.equal(proposal.content.text.length, draftLength);
  }
});

test('revision budgets serialized JSON including escapes, cutting page context while preserving draft and target', () => {
  const proposal = { ...PRIOR_DRAFT, content: { text: 'Prior pending draft. '.repeat(1_600) } };
  const context = { ...AT_CURSOR, text: '\u0000'.repeat(DOCUMENT_TEXT_LIMIT) };
  const request = buildDocumentRevisionRequest('Keep the owners', context, proposal)!;
  assert.ok(JSON.stringify(request).length <= DOCUMENT_EDIT_INPUT_LIMIT);
  assert.ok(request.document.text.length > 0);
  assert.ok(request.document.text.length < DOCUMENT_TEXT_LIMIT);
  assert.equal(request.document.truncated, true);
  assert.equal(request.document.text, context.text.slice(0, request.document.text.length));
  assert.deepEqual(request.revision.content, proposal.content);
  assert.deepEqual(request.document.selection, SELECTED.selection);
  assert.equal(request.document.cursor, proposal.cursor);
});

test('revision context truncation preserves complete Unicode characters', () => {
  const text = 'a'.repeat(DOCUMENT_TEXT_LIMIT - 1) + '😀';
  const request = buildDocumentRevisionRequest('Keep the meaning', { ...AT_CURSOR, text }, PRIOR_DRAFT)!;
  assert.equal(request.document.text, 'a'.repeat(DOCUMENT_TEXT_LIMIT - 1));
  assert.equal(request.document.truncated, true);
});

test('revision refuses when the prior draft or original selection alone cannot fit instead of dropping them', () => {
  for (const proposal of [
    { ...PRIOR_DRAFT, content: { text: 'x'.repeat(DOCUMENT_EDIT_INPUT_LIMIT) } },
    { ...PRIOR_DRAFT, originalText: '\u0000'.repeat(12_000) },
  ]) {
    assert.throws(() => buildDocumentRevisionRequest('Make it concise', AT_CURSOR, proposal), /too large to revise/);
  }
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

test('a refresh keeps a just-applied row and local streaming/unsaved rows, drops other stale locals', () => {
  const row = (id: string, status: string) => ({ id, status });
  const merged = mergeRefreshedProposals(
    [row('a', 'applied'), row('s', 'streaming'), row('u', 'ready'), row('old', 'ready')],
    [row('r1', 'ready'), row('t', 'ready')],
    { requestedId: 't', unsaved: id => id === 'u' },
  );
  assert.deepEqual(merged.map(p => p.id), ['t', 'a', 's', 'u', 'r1']);
});

test('a single-paragraph insert after sentence text keeps a space; blocks and empty lines are untouched', () => {
  assert.equal(insertContentFor('Next step.', '.'), ' Next step.');
  assert.equal(insertContentFor('Next step.', ' '), 'Next step.');
  assert.equal(insertContentFor('Next step.', ''), 'Next step.');
  assert.equal(insertContentFor('Next step.', '\n'), 'Next step.');
  assert.equal(insertContentFor('A\n\nB', '.').length, 2);
});

test('Apply stays one undoable ySync-origin transaction', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../knowledge/CanvasDocumentPane.tsx', import.meta.url), 'utf8');
  assert.match(src, /\}, ySyncPluginKey\)/);
  const hook = readFileSync(new URL('../knowledge/useDocumentAgentEdit.tsx', import.meta.url), 'utf8');
  assert.match(hook, /insertContentFor\(row\.content\.text, target\.from > 1/);
});

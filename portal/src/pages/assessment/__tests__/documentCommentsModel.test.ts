import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  awarenessPeople, commentGroups, commentImportNotice, commentThreads, documentCallChannel, documentCallLobby,
  hrefFromCallChannel, openThreadCount, type PlatformComment,
} from '../knowledge/documentCommentsModel.ts';

const base = { documentId: 'd', color: 'rgb(74 144 217)' };
const anchor = { v: 1, key: 'body', start: 'AAE=', end: 'AAI=', quote: 'Partially met' };
const rows: PlatformComment[] = [
  { ...base, commentId: 'kc-rubric-02', text: 'Reply', userId: 'u-farah', displayName: 'Farah Osei', timestamp: '2026-09-24T10:00:00.000Z', parentCommentId: 'kc-rubric-01', importedFrom: 'assessment_knowledge_comments' },
  { ...base, commentId: 'kc-rubric-01', text: 'Root', userId: 'u-jonas', displayName: 'Jonas Lindqvist', timestamp: '2026-09-23T10:00:00.000Z', scope: 'document', importedFrom: 'assessment_knowledge_comments' },
  { ...base, commentId: '01K', text: 'Pinned', userId: 'u-farah', displayName: 'Farah Osei', timestamp: '2026-09-29T10:00:00.000Z', anchor, resolved: true, resolvedBy: 'u-jonas' },
  { ...base, commentId: '01L', text: 'Lost parent', userId: 'u-x', displayName: '', timestamp: '2026-09-29T11:00:00.000Z', parentCommentId: 'gone' },
];

test('threads nest replies under their root, oldest first, and keep an orphaned reply visible as a root', () => {
  const threads = commentThreads(rows);
  assert.deepEqual(threads.map(t => [t.id, t.replies.map(r => r.id)]), [['kc-rubric-01', ['kc-rubric-02']], ['01K', []], ['01L', []]]);
  assert.equal(threads[0]!.imported, true);
  assert.equal(threads[0]!.parentCommentId, null);
  assert.equal(threads[2]!.displayName, 'u-x');
  assert.equal(openThreadCount(threads), 2);
  assert.equal(threads[1]!.resolvedBy, 'Jonas Lindqvist', 'the resolver is named from the authors on the page');
  const unknown = commentThreads(rows.map(r => r.commentId === '01K' ? { ...r, resolvedBy: 'u-zed' } : r));
  assert.equal(unknown[1]!.resolvedBy, 'u-zed', 'no name known for the resolver — the id stands');
});

test('the Comments tab groups pinned threads apart from document-wide ones, with open counts', () => {
  const groups = commentGroups(commentThreads(rows));
  assert.deepEqual(groups.map(g => [g.key, g.title, g.threads.map(t => t.id), g.open]), [
    ['page', 'On the page', ['01K'], 0],
    ['document', 'Whole document', ['kc-rubric-01', '01L'], 2],
  ]);
  assert.deepEqual(commentGroups([]), []);
});

test('the import notice speaks only when earlier comments have not moved', () => {
  assert.equal(commentImportNotice({ state: 'imported', imported: 2, legacy: 2 }), null);
  assert.equal(commentImportNotice({ state: 'unconfigured', imported: 0, legacy: 0 }), null);
  assert.match(commentImportNotice({ state: 'unconfigured', imported: 0, legacy: 2 })!.text, /^2 earlier comments are still/);
  assert.equal(commentImportNotice({ state: 'failed', imported: 0, legacy: 1, reason: 'boom' })!.text, 'boom');
});

test('the byline is everyone else on the canvas, one entry per person across tabs', () => {
  const people = awarenessPeople([
    [1, { user: { id: 'u-farah', name: 'Farah Osei', color: 'teal' } }],
    [2, { user: { id: 'u-jonas', name: 'Jonas Lindqvist', color: 'rgb(37 99 235)' } }],
    [3, { user: { id: 'u-jonas', name: 'Jonas Lindqvist' } }],
    [4, { cursor: null }],
  ], 'u-farah');
  assert.deepEqual(people, [{ id: 'u-jonas', name: 'Jonas Lindqvist', color: 'rgb(37 99 235)', clientIds: [2, 3] }]);
});

test('the call lobby is tenant-prefixed, one per document; the invite carries only an in-app document URL', () => {
  assert.equal(documentCallLobby('assessment:', 'assessment:doc:page:100002'), 'assessment:doc:page:100002');
  assert.equal(documentCallLobby('assessment:', 'assessment:doc:h:1x2y'), 'assessment:doc:h:1x2y');
  const channel = documentCallChannel('/assessment/workspace?doc=page%3A100002');
  assert.equal(hrefFromCallChannel(channel), '/assessment/workspace?doc=page%3A100002');
  assert.equal(hrefFromCallChannel('assessment-document:https://evil.example/?doc=x'), null);
  assert.equal(hrefFromCallChannel('initiative:p-soc2'), null);
});

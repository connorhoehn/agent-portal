import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyCommentUpdates, commentQuote, commentsForDoc, retainCommentUpdates, withStoredComments, type KnowledgeCommentItem } from '../knowledge/knowledgeFormat.ts';
import type { AssessmentSSEEvent } from '../knowledge/types.ts';

const parent: KnowledgeCommentItem = {
  id: 'c1', clientId: 'u-asha', userId: 'u-asha', displayName: 'Asha',
  content: 'Original evidence', timestamp: '2026-09-19T12:00:00Z',
};
const replyEvent: AssessmentSSEEvent = {
  type: 'knowledge.comment.created', id: 'c2', doc_id: 'doc-1', by: 'u-jonas',
  body: 'Follow-up', parent_id: 'c1', ts: '2026-09-19T12:01:00Z',
};
const edit = (body: string, ts: string): AssessmentSSEEvent => ({
  type: 'knowledge.comment.edited', id: 'c1', doc_id: 'doc-1', by: 'u-asha', body, ts,
});
const deletion: AssessmentSSEEvent = {
  type: 'knowledge.comment.deleted', id: 'c1', doc_id: 'doc-1', by: 'u-asha', ts: '2026-09-19T12:03:00Z',
};

test('reply parent survives SSE and durable/live deduplication', () => {
  const live = commentsForDoc([replyEvent], 'doc-1');
  assert.equal(live[0]?.parentId, parent.id);
  const storedReply = { ...live[0]! };
  const merged = withStoredComments([parent, storedReply], live);
  assert.equal(merged.length, 2);
  assert.deepEqual(commentQuote(merged, merged[1]!.parentId!), {
    messageId: 'c1', author: 'Asha', timestamp: parent.timestamp, text: 'Original evidence',
  });
  assert.deepEqual(commentsForDoc([replyEvent], 'other-doc'), []);
});

test('quote reflects a live parent edit without mutating the fetched rows', () => {
  const comments = applyCommentUpdates([parent], [edit('Corrected evidence', '2026-09-19T12:02:00Z')], 'doc-1');
  assert.equal(commentQuote(comments, parent.id).text, 'Corrected evidence');
  assert.equal(parent.content, 'Original evidence');
});

test('older replay cannot overwrite a newer stored edit', () => {
  const latest = { ...parent, content: 'Latest', editedAt: '2026-09-19T12:04:00Z' };
  const comments = applyCommentUpdates([latest], [edit('Old', '2026-09-19T12:02:00Z')], 'doc-1');
  assert.equal(commentQuote(comments, parent.id).text, 'Latest');
});

test('out-of-order edits converge to the newest edit', () => {
  const comments = applyCommentUpdates([parent], [edit('New', '2026-09-19T12:02:00Z'), edit('Old', '2026-09-19T12:01:00Z')], 'doc-1');
  assert.equal(commentQuote(comments, parent.id).text, 'New');
});

test('deletion preserves replies and never exposes original text in a quote', () => {
  const reply = commentsForDoc([replyEvent], 'doc-1')[0]!;
  const comments = applyCommentUpdates([parent, reply], [deletion, edit('Do not resurrect', '2026-09-19T12:04:00Z')], 'doc-1');
  assert.equal(comments.length, 2);
  assert.equal(comments[1]?.parentId, parent.id);
  assert.equal(commentQuote(comments, parent.id).text, 'This comment was deleted.');
  assert.equal(commentQuote([{ ...parent, deletedAt: deletion.ts }], parent.id).text, 'This comment was deleted.');
});

test('updates for another document cannot edit or delete this quote', () => {
  const events = [edit('Wrong document', '2026-09-19T12:02:00Z'), deletion];
  assert.deepEqual(applyCommentUpdates([parent], events, 'other-doc'), [parent]);
});

test('missing parent is rendered as unavailable, without inventing quoted text', () => {
  assert.deepEqual(commentQuote([], parent.id), {
    messageId: parent.id, author: 'Comment', text: 'Original comment unavailable.',
  });
});

test('event buffer rollover and stale fetches cannot resurrect deleted text or drop replies', () => {
  const reply = commentsForDoc([replyEvent], 'doc-1')[0]!;
  const observed = applyCommentUpdates([parent, reply], [deletion], 'doc-1');
  const afterRollover = applyCommentUpdates(retainCommentUpdates(observed, [parent]), [], 'doc-1');
  assert.equal(afterRollover.length, 2);
  assert.equal(afterRollover[1]?.parentId, parent.id);
  assert.equal(commentQuote(afterRollover, parent.id).text, 'This comment was deleted.');
});

test('retained edits survive stale fetches while a newer durable edit can replace them', () => {
  const edited = applyCommentUpdates([parent], [edit('Live edit', '2026-09-19T12:02:00Z')], 'doc-1');
  assert.equal(commentQuote(retainCommentUpdates(edited, [parent]), parent.id).text, 'Live edit');
  const later = { ...parent, editedAt: '2026-09-19T12:05:00Z', content: 'Later durable edit' };
  assert.equal(commentQuote(retainCommentUpdates(edited, [later]), parent.id).text, 'Later durable edit');
});

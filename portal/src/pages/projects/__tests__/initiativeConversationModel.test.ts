import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHANNEL_FILTERS, channelConversationMessages, channelMessageKind, initiativeConversationMessages, parseChannelFilter,
  workNoteNotNotified, workNoteReferenceMetadata, workNoteReferenceText,
} from '../initiativeConversationModel.ts';

test('a channel-backed pane filters All / Messages / Work notes / Agent by message metadata (leftovers 2)', () => {
  const messages = [
    { id: 'person', metadata: { displayName: 'Vera' } },
    { id: 'linked', metadata: { pageReference: { kind: 'work-item', id: 'wi-a' } } },
    { id: 'note-ref', metadata: workNoteReferenceMetadata('wi-a') },
    { id: 'run', metadata: { kind: 'agent-run' } },
    { id: 'summary', metadata: { summaryOf: { runId: 'r-1' } } },
    { id: 'diagram', metadata: { artifactOf: { command: 'diagram' } } },
    { id: 'deck', metadata: { sourceDeck: { id: 'd-1' } } },
    { id: 'bare' },
  ];
  assert.deepEqual(CHANNEL_FILTERS.map(f => f.label), ['All', 'Messages', 'Work notes', 'Agent']);
  assert.deepEqual(channelConversationMessages(messages, 'all').map(m => m.id), messages.map(m => m.id));
  assert.deepEqual(channelConversationMessages(messages, 'messages').map(m => m.id), ['person', 'linked', 'bare']);
  assert.deepEqual(channelConversationMessages(messages, 'work-notes').map(m => m.id), ['note-ref']);
  assert.deepEqual(channelConversationMessages(messages, 'agent').map(m => m.id), ['run', 'summary', 'diagram', 'deck']);
  assert.equal(channelMessageKind({}), 'message');
  assert.deepEqual(['agent', 'nope', null].map(parseChannelFilter), ['agent', 'all', 'all']);
});

test('the reference a /comment posts in the channel: one line, the item, the note\'s first 120 characters', () => {
  assert.equal(workNoteReferenceText('Cutover runbook', 'Rehearsal\npassed.'), 'Comment on Cutover runbook: Rehearsal passed.');
  const long = workNoteReferenceText('X', 'a'.repeat(200));
  assert.equal(long, `Comment on X: ${'a'.repeat(120)}…`);
  assert.deepEqual(workNoteReferenceMetadata('wi-a'), { workComment: true, pageReference: { kind: 'work-item', id: 'wi-a' } });
  // The channel's rule refuses the post: the note is still saved, and the composer says the channel was not told.
  assert.equal(workNoteNotNotified('Cutover runbook', '#auth-migration', 'You can read #auth-migration. Your current role cannot post there.'),
    'Comment saved on Cutover runbook. #auth-migration was not notified: You can read #auth-migration. Your current role cannot post there.');
});

test('dialogue keeps contextual conversation while work comments stay available through All messages', () => {
  const messages = [
    { id: 'initiative', metadata: {} },
    { id: 'leaf-dialogue', metadata: { pageReference: { kind: 'work-item', id: 'wi-a' } } },
    { id: 'work-note', metadata: { workComment: true, pageReference: { kind: 'work-item', id: 'wi-a' } } },
  ];
  assert.deepEqual(initiativeConversationMessages(messages, 'dialogue').map(m => m.id), ['initiative', 'leaf-dialogue']);
  assert.deepEqual(initiativeConversationMessages(messages, 'initiative').map(m => m.id), ['initiative']);
  assert.deepEqual(initiativeConversationMessages(messages, 'all').map(m => m.id), messages.map(m => m.id));
  assert.equal(messages.length, 3);
});

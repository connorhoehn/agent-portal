import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

test('the reference a /comment posts in the channel: one line naming the item, nothing of the note', () => {
  // Sweep 12, L3: the item's title only, never an excerpt of the note.
  assert.equal(workNoteReferenceText('Cutover runbook'), 'Comment on Cutover runbook');
  assert.equal(workNoteReferenceText('Cutover\n  runbook '), 'Comment on Cutover runbook');
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

test('the composer posts the reference with no part of the note, and the client-set marker is never evidence of one (sweep 12, L3)', () => {
  const src = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  assert.equal(workNoteReferenceText.length, 1);
  const composer = src('InitiativeComposer.tsx');
  const calls = composer.match(/workNoteReferenceText\([^)]*\)/g) ?? [];
  assert.deepEqual(calls, ['workNoteReferenceText(item)']);
  // Outside the pane's filter (this model), nothing reads `workComment`: the reference chip names the item only.
  assert.doesNotMatch(src('workConversationContext.tsx').replace(/\/\*[\s\S]*?\*\//g, ''), /workComment/);
  assert.doesNotMatch(composer, /metadata\??\.workComment/);
});

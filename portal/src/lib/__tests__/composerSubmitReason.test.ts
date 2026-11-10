import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NO_DESTINATION_REASON, READ_ONLY_DESTINATION_REASON, collectionSubmitReason, conversationSubmitReason,
} from '../composerSubmitReason.ts';

test('collection Apply: no reason for an idle page with commands (an empty box is not a reason)', () => {
  assert.equal(collectionSubmitReason({ commandCount: 4 }), null);
  assert.equal(collectionSubmitReason({ commandCount: 4, disabled: false, confirming: false }), null);
});

test('collection Apply: no commands, a pending confirm, a page hold — each says why', () => {
  assert.equal(collectionSubmitReason({ commandCount: 0 }), 'This page has no commands.');
  assert.equal(collectionSubmitReason({ commandCount: 2, confirming: true }), 'Confirm or keep the pending operation first.');
  assert.equal(collectionSubmitReason({ commandCount: 2, disabled: true }), 'Wait for the current change on this page to finish.');
  assert.equal(collectionSubmitReason({ commandCount: 2, disabled: true, disabledReason: 'Saving the review.' }), 'Saving the review.');
});

const offline = 'The realtime gateway is not connected, so the discussion is unavailable.';
const base = { destinationChosen: true, maySend: true, connected: true, offlineReason: offline };

test('conversation Send: a connected writer has no reason', () => {
  assert.equal(conversationSubmitReason(base), null);
});

test('conversation Send: no destination, read-only, socket down, in that order', () => {
  assert.equal(conversationSubmitReason({ ...base, destinationChosen: false, maySend: false, connected: false }), NO_DESTINATION_REASON);
  assert.equal(conversationSubmitReason({ ...base, maySend: false, connected: false }), READ_ONLY_DESTINATION_REASON);
  assert.equal(conversationSubmitReason({ ...base, readOnlyReason: 'Only members of #design post here.' }), 'Only members of #design post here.');
  assert.equal(conversationSubmitReason({ ...base, connected: false }), offline);
});

test('conversation Send: while the server has not answered, stay quiet', () => {
  assert.equal(conversationSubmitReason({ ...base, maySend: false, pending: true }), null);
});

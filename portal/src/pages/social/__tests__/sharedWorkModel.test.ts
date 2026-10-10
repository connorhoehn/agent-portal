// The Shared work view's wire reader (sharedWorkModel.ts): rows arrive already
// folded through the reader's authority on the server; the reader keeps the
// server's facts, drops malformed rows, and never invents a title for an
// unavailable row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSharedWork, sharedKindLabel, sharedRowLine, sharedUnavailableReason, sharedWorkUrl } from '../sharedWorkModel.ts';

const into = { kind: 'conversation', id: 'social:ch:general', title: '#general' };
const vera = { userId: 'u-vera', displayName: 'Vera Green' };

test('one route per conversation, under the mount’s API prefix', () => {
  assert.equal(sharedWorkUrl('/api/social/plane', 'social:ch:general'), '/api/social/plane/conversations/social%3Ach%3Ageneral/shared-work');
  assert.equal(sharedWorkUrl('/api/social', 'social:dm:a:b'), '/api/social/conversations/social%3Adm%3Aa%3Ab/shared-work');
});

test('rows keep the server’s kind, provenance and audience; malformed rows are dropped', () => {
  const reply = readSharedWork({ conversation: 'social:ch:general', title: '#general', items: [
    { kind: 'deck', id: 'deck-1', title: 'Auth migration.pptx', status: 'available', href: '/api/uploads/f-deck', sharedBy: vera, sharedInto: into, at: '2026-10-07T10:00:00.000Z', authority: 'membership', provenance: 'deck', ref: { messageId: 'm1', fileId: 'f-deck' } },
    { kind: 'work-node', id: 'work:wi-auth-e1', title: 'Rotate Cognito keys', status: 'available', href: null, sharedBy: vera, sharedInto: into, at: '2026-10-07T09:00:00.000Z', authority: 'grant', provenance: 'grant:historical', ref: { grantId: 'wsg-1', nodeKind: 'task' } },
    { kind: 'page', id: 'x', status: 'available', sharedInto: into, provenance: 'reference', ref: {} },
    { kind: 'file', id: 'f-2', status: 'available', title: 'notes.md', sharedInto: { kind: 'people', id: 'x' }, provenance: 'attachment', ref: {} },
    null,
  ], limits: ['the file list could not be read'] });
  assert.equal(reply?.items.length, 2);
  const [deck, node] = reply!.items;
  assert.deepEqual(deck, { kind: 'deck', id: 'deck-1', title: 'Auth migration.pptx', status: 'available', href: '/api/uploads/f-deck', sharedBy: vera, sharedInto: into,
    at: '2026-10-07T10:00:00.000Z', authority: 'membership', provenance: 'deck', ref: { messageId: 'm1', fileId: 'f-deck' }, key: 'deck:deck-1:m1' });
  assert.equal(sharedKindLabel(deck!), 'Deck');
  assert.equal(sharedKindLabel(node!), 'Task');
  assert.equal(sharedRowLine(node!), 'Task · shared earlier · shared by Vera Green');
  assert.deepEqual(reply?.limits, ['the file list could not be read']);
  assert.equal(readSharedWork({ items: [] }), null);
  assert.equal(readSharedWork(null), null);
});

test('an unavailable row never carries a title or href, whatever the wire says', () => {
  const reply = readSharedWork({ conversation: 'social:dm:a:b', title: null, items: [
    { kind: 'initiative', id: 'p-auth-migration', title: 'Leaked title', status: 'unavailable', href: '/iq/projects/p-auth-migration', sharedBy: null, sharedInto: { kind: 'conversation', id: 'social:dm:a:b', title: null },
      at: null, authority: 'membership', provenance: 'reference', ref: { messageId: 'm3' } },
  ], limits: [] });
  const [page] = reply!.items;
  assert.equal(page?.title, null);
  assert.equal(page?.href, null);
  assert.equal(page?.sharedBy, null);
  assert.equal(sharedKindLabel(page!), 'Initiative');
  assert.equal(sharedUnavailableReason(page!), 'You cannot open this page now.');
  assert.equal(sharedUnavailableReason({ kind: 'deck' }), 'Its file is not one you can open here.');
});

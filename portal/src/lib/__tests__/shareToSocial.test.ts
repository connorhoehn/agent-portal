import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { channelHref, deckFileUrl, messageConfirmsShare, pptxName, readShareDestinations, shareMessageText, shareMetadata } from '../shareToSocial.ts';

describe('readShareDestinations', () => {
  it('lists channels then DMs and drops malformed or foreign-prefixed rows', () => {
    const out = readShareDestinations({
      channels: [{ channel: 'social:ch:a', slug: 'a', name: 'Alpha', privacy: 'private', memberCount: 1 }, { channel: 'orgiq:lobby', slug: 'x', name: 'X' }, { slug: 'b' }],
      conversations: [{ channel: 'social:dm:a:b', peers: [{ userId: 'b', displayName: 'Bea' }] }, { channel: 'social:dm:a:c', peers: [] }, { channel: 'assessment:dm:a:b', peers: [{ displayName: 'Z' }] }],
    });
    assert.deepEqual(out.map(d => [d.kind, d.label, d.detail]), [['channel', '#Alpha', 'Private channel · 1 member'], ['dm', 'Bea', 'Direct message']]);
  });
  it('is empty for junk', () => { assert.deepEqual(readShareDestinations(null), []); assert.deepEqual(readShareDestinations({ channels: 3 }), []); });
});
describe('message shaping', () => {
  const att = { id: 't1', name: 'R.pptx', size: 5, contentType: 'x', url: '/api/uploads/t1' };
  it('encodes the file url and defaults the text to the file name', () => {
    assert.equal(deckFileUrl('d/1', 'r 2'), '/api/assessment/decks/d%2F1/revisions/r%202/file');
    assert.equal(shareMessageText('R.pptx', '  '), 'R.pptx'); assert.equal(shareMessageText('R.pptx', ' fyi '), 'fyi');
    assert.equal(pptxName('Review'), 'Review.pptx'); assert.equal(pptxName('a.PPTX'), 'a.PPTX');
  });
  it('carries attachments and a display-only sourceDeck', () => {
    // The gateway writes the download URL from the id (realtime-modules 0.146), so the send carries none.
    const { url: _issued, ...sent } = att;
    assert.deepEqual(shareMetadata(att, 'd', 'r', 'Me'), { displayName: 'Me', attachments: [sent], sourceDeck: { id: 'd', revisionId: 'r' } });
  });
  it('confirms only an echoed message citing the attachment', () => {
    assert.equal(messageConfirmsShare([{}, { metadata: { attachments: [{ id: 'other' }] } }], 't1'), false);
    assert.equal(messageConfirmsShare([{ metadata: { attachments: [att] } }], 't1'), true);
  });
  it('links channels, not DMs', () => {
    assert.equal(channelHref({ channel: 'social:ch:a b', kind: 'channel', slug: 'a b', label: '', detail: '' }), '/social/channels/a%20b');
    assert.equal(channelHref({ channel: 'social:dm:a:b', kind: 'dm', label: '', detail: '' }), null);
  });
});

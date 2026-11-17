// The candidate's own media id, sent to the server (pages/join/guestMedia.ts; decision 9): only the local participant's own
// id under its guest subject, and the server's answer decides whether to keep sending.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownMediaId } from '../../../lib/meetingParticipant.ts';
import { reportGuestMediaId } from '../guestMedia.ts';

const ME = 'guest:inv-k2m4';

test('the local participant\'s own id under the guest subject, never another participant\'s', () => {
  const people = [
    { userId: 'u-hugo', participantId: 'u-hugo-lq3k9a' },
    { userId: ME, isLocal: true, participantId: `${ME}-lq3k9b` },
    { userId: 'guest:inv-other', participantId: 'guest:inv-other-lq3k9c' },
  ];
  assert.equal(ownMediaId(people, ME), `${ME}-lq3k9b`);
  assert.equal(ownMediaId([{ userId: ME, isLocal: true, participantId: 'u-hugo-lq3k9a' }], ME), null);
  assert.equal(ownMediaId([{ userId: ME, isLocal: false, participantId: `${ME}-lq3k9b` }], ME), null);
});

test('sends the call and the id; keeps sending on success or a network failure, stops on a refusal or a declined transcript', async () => {
  const real = globalThis.fetch;
  const sent: Array<{ url: string; body: unknown }> = [];
  const answer = (status: number, body: unknown) => (async (url: string, init?: RequestInit) => {
    sent.push({ url, body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  try {
    assert.equal(await reportGuestMediaId('call-1', `${ME}-a1`, answer(200, { bound: true })), 'again');
    assert.deepEqual(sent[0], { url: '/api/interview-invite/media/participant', body: { callId: 'call-1', participantId: `${ME}-a1` } });
    assert.equal(await reportGuestMediaId('call-1', `${ME}-a1`, answer(200, { bound: false, why: 'no-transcript' })), 'stop');
    assert.equal(await reportGuestMediaId('call-1', `${ME}-a1`, answer(404, { error: 'Not found' })), 'stop');
    assert.equal(await reportGuestMediaId('call-1', `${ME}-a1`, answer(409, { error: 'x' })), 'stop');
    assert.equal(await reportGuestMediaId('call-1', `${ME}-a1`, answer(503, {})), 'again');
    assert.equal(await reportGuestMediaId('call-1', `${ME}-a1`, (async () => { throw new Error('offline'); }) as unknown as typeof fetch), 'again');
  } finally { globalThis.fetch = real; }
});

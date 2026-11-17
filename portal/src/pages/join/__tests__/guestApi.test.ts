// The knock's answers on the page side (pages/join/guestApi.ts; rows I2.3 and I6.4): a declined required part is told
// apart from answers that no longer stand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { knock } from '../guestApi.ts';

const answering = (status: number, body: unknown) => {
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as typeof fetch;
};

test('knock: a 409 with the required-part reason is held; any other 409 asks for the answers again', async () => {
  const real = globalThis.fetch;
  try {
    answering(409, { error: 'x', reason: 'declined-required' });
    assert.deepEqual(await knock(), { admission: null, refused: false, held: true });
    answering(409, { error: 'Finish the steps on this page before you ask to join.' });
    assert.deepEqual(await knock(), { admission: null, refused: true, held: false });
    const admission = { state: 'waiting', knockedAt: '2026-11-17T10:00:00.000Z', decidedAt: null };
    answering(200, { admission });
    assert.deepEqual(await knock(), { admission, refused: false, held: false });
    answering(500, {});
    assert.deepEqual(await knock(), { admission: null, refused: false, held: false });
  } finally {
    globalThis.fetch = real;
  }
});

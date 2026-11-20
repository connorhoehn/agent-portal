// The lead's Confirm / Decline for a candidate's pad request (film 4: an unnamed "Yes, go ahead." was lost): the read the room
// polls, the press, and the footer's question button.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PAD_CONFIRM_OPTIONS, PAD_CONFIRM_RECEIPTS, answerPadConfirm, padConfirmPath, readPadConfirm } from '../interviewsMilo.ts';
import { askButtonLabel } from '../interviewsRoom.ts';

const reply = (status: number, body?: unknown) => (async () => new Response(JSON.stringify(body ?? {}), { status })) as unknown as typeof fetch;

test('the read: what waits, or nothing (none, not the lead, a failure)', async () => {
  assert.equal(padConfirmPath('iv 1'), '/api/interviews/interviews/iv%201/milo-pad-confirm');
  assert.deepEqual(await readPadConfirm('iv-1', reply(200, { waiting: { text: 'a dozen test cases', askedAt: '2026-11-20T10:00:00.000Z' } })),
    { text: 'a dozen test cases', askedAt: '2026-11-20T10:00:00.000Z' });
  assert.equal(await readPadConfirm('iv-1', reply(200, { waiting: null })), null);
  assert.equal(await readPadConfirm('iv-1', reply(404)), null);
  assert.equal(await readPadConfirm('iv-1', (async () => { throw new Error('down'); }) as unknown as typeof fetch), null);
});

test('Confirm posts allow true, Decline allow false, to the lead\'s route; Milo\'s line comes back', async () => {
  const sent: Array<{ url: string; method?: string; body?: unknown }> = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    sent.push({ url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify({ line: 'Added twelve test cases at the bottom of the pad.', said: 'spoken' }), { status: 200 });
  }) as typeof fetch;
  try {
    assert.deepEqual(await answerPadConfirm('iv-1', true), { ok: true, line: 'Added twelve test cases at the bottom of the pad.' });
    await answerPadConfirm('iv-1', false);
  } finally { globalThis.fetch = real; }
  assert.deepEqual(sent, [
    { url: '/api/interviews/interviews/iv-1/milo-pad-confirm', method: 'POST', body: { allow: true } },
    { url: '/api/interviews/interviews/iv-1/milo-pad-confirm', method: 'POST', body: { allow: false } },
  ]);
  assert.deepEqual(PAD_CONFIRM_OPTIONS.map((o) => o.label), ['Confirm', 'Decline']);
  assert.equal(PAD_CONFIRM_RECEIPTS.confirm, 'Pad change confirmed');
  assert.equal(askButtonLabel('pad', 0), 'Pad change?');
});

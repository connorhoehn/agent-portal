// The knock's answers on the page side (pages/join/guestApi.ts; rows I2.3 and I6.4): a declined required part is told
// apart from answers that no longer stand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { knock, readWaiting } from '../guestApi.ts';

const answering = (status: number, body: unknown) => {
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as typeof fetch;
};

test('knock: a 409 with the required-part reason is held; any other 409 asks for the answers again; 404 is a dead link', async () => {
  const real = globalThis.fetch;
  try {
    answering(409, { error: 'x', reason: 'declined-required' });
    assert.deepEqual(await knock(), { kind: 'held' });
    answering(409, { error: 'Finish the steps on this page before you ask to join.' });
    assert.deepEqual(await knock(), { kind: 'refused' });
    const admission = { state: 'waiting', knockedAt: '2026-11-17T10:00:00.000Z', decidedAt: null };
    answering(200, { admission });
    assert.deepEqual(await knock(), { kind: 'knocked', admission });
    answering(404, { error: 'gone' });
    assert.deepEqual(await knock(), { kind: 'dead' });
    answering(500, {});
    assert.deepEqual(await knock(), { kind: 'failed' });
    answering(200, {});
    assert.deepEqual(await knock(), { kind: 'failed' }, 'a 200 without an admission does not say the knock was taken');
    globalThis.fetch = (async () => { throw new TypeError('network'); }) as typeof fetch;
    assert.deepEqual(await knock(), { kind: 'failed' });
  } finally {
    globalThis.fetch = real;
  }
});

test('the knock and the waiting read carry the server\'s told, one boolean; anything else in its place is false', async () => {
  const real = globalThis.fetch;
  try {
    const admission = { state: 'waiting', knockedAt: '2026-11-17T10:00:00.000Z', decidedAt: null };
    answering(200, { admission, told: true });
    assert.deepEqual(await knock(), { kind: 'knocked', admission, told: true });
    answering(200, { admission, told: false });
    assert.deepEqual(await readWaiting(), { admission, told: false });
    answering(200, { admission, told: 'yes' });
    assert.deepEqual(await readWaiting(), { admission, told: false });
    answering(200, { admission, told: true });
    assert.deepEqual(await readWaiting(), { admission, told: true });
    answering(404, { error: 'gone' });
    assert.equal(await readWaiting(), null);
  } finally {
    globalThis.fetch = real;
  }
});

test("sendCantMake (gap audit 2026-11-20 §6): sends the note only when there is one; told, refused or a dead link", async () => {
  const { sendCantMake } = await import('../guestApi.ts');
  const real = globalThis.fetch;
  try {
    const sent: Array<string | undefined> = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      sent.push(init?.body as string | undefined);
      return new Response(JSON.stringify({ cantMake: { sentAt: '2026-11-20T09:00:00.000Z' }, message: 'The recruiter has been told.' }), { status: 200 });
    }) as typeof fetch;
    assert.deepEqual(await sendCantMake('  '), { kind: 'told', sentAt: '2026-11-20T09:00:00.000Z', message: 'The recruiter has been told.' });
    await sendCantMake('Friday suits me');
    assert.deepEqual(sent, ['{}', '{"note":"Friday suits me"}']);
    answering(409, { error: 'This interview has already started or closed, so there is nothing to tell the recruiter from here.' });
    assert.equal((await sendCantMake('')).kind, 'refused');
    answering(404, {});
    assert.deepEqual(await sendCantMake(''), { kind: 'dead' });
  } finally {
    globalThis.fetch = real;
  }
});

test('the notice is rendered as text only: no component that shows it sets HTML', async () => {
  const { readFileSync } = await import('node:fs');
  for (const f of ['src/pages/join/CantMakeTime.tsx', 'src/pages/interviews/interviewsCells.tsx']) {
    assert.equal(readFileSync(f, 'utf8').includes('dangerouslySetInnerHTML'), false, f);
  }
});

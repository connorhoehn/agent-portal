import test from 'node:test';
import assert from 'node:assert/strict';
import { ownMediaId, reportMediaId } from '../meetingParticipant.ts';

const people = [
  { userId: 'u-me', isLocal: true, participantId: 'u-me-lq3k9a' },
  { userId: 'u-you', isLocal: false, participantId: 'u-you-lq3k9b' },
];

test('only the local participant\'s own id is reported; none in the mock walk or before media joins', () => {
  assert.equal(ownMediaId(people, 'u-me'), 'u-me-lq3k9a');
  assert.equal(ownMediaId(people, 'u-you'), null);
  assert.equal(ownMediaId([{ userId: 'u-me', isLocal: true, participantId: null }], 'u-me'), null);
  assert.equal(ownMediaId([{ userId: 'u-me', isLocal: true, participantId: 'u-you-lq3k9b' }], 'u-me'), null);
  assert.equal(ownMediaId(undefined, 'u-me'), null);
});

test('an id is sent once per call; a 409 counts as done and a failed request is tried again', async () => {
  let calls = 0;
  const ok = (async () => { calls += 1; return { ok: false, status: 409 } as Response; }) as typeof fetch;
  assert.equal(await reportMediaId('c1', 'u-me-aaa', ok), true);
  assert.equal(await reportMediaId('c1', 'u-me-aaa', ok), true);
  assert.equal(calls, 1);
  const down = (async () => { throw new Error('offline'); }) as typeof fetch;
  assert.equal(await reportMediaId('c1', 'u-me-bbb', down), false);
  assert.equal(await reportMediaId('c2', 'u-me-aaa', ok), true);
  assert.equal(calls, 2);
});

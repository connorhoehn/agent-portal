import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInitiativeRecordingsClient, initiativeRecordingItems, readInitiativeRecordings, recordingReactions, timedRecordingReactions, type InitiativeRecording } from '../initiativeRecordingApi.ts';

const lobby = 'orgiq:initiative:p-observability';
const signal = () => new AbortController().signal;
const row = (id: string, room = lobby): InitiativeRecording => ({ recordingId: id, lobbyName: room,
  startedAt: '2026-10-09T17:19:51.119Z', endedAt: '2026-10-09T17:20:54.941Z' });

test('participant paging finds older initiative calls and never includes another lobby', async () => {
  const cursors: Array<string | null> = [];
  const result = await readInitiativeRecordings({ page: async cursor => {
    cursors.push(cursor);
    return cursor === null ? { items: [row('private-dm', 'social:dm:someone:else')], cursor: 'older' }
      : { items: [row('work'), row('other', 'orgiq:initiative:p-other'), row('work')], cursor: null };
  } }, lobby, signal());
  assert.deepEqual(cursors, [null, 'older']);
  assert.deepEqual(result.items.map(item => item.recordingId), ['work']);
  assert.equal(result.cursor, null);
});

test('an empty bounded scan retains a continuation cursor instead of claiming the history is empty', async () => {
  let pages = 0;
  const result = await readInitiativeRecordings({ page: async () => ({ items: [row(`other-${++pages}`, 'room:other')], cursor: `next-${pages}` }) }, lobby, signal());
  assert.equal(pages, 5);
  assert.deepEqual(result.items, []);
  assert.equal(result.cursor, 'next-5');
  await assert.rejects(readInitiativeRecordings({ page: async () => ({ items: [], cursor: 'stuck' }) }, lobby, signal()), /could not advance/);
});

test('expired bearer retries once with a fresh session token; forbidden access is never retried', async () => {
  const force: boolean[] = [], auth: string[] = [];
  const client = createInitiativeRecordingsClient({
    source: { get: async opts => { force.push(!!opts?.force); return { token: opts?.force ? 'fresh' : 'expired', expiresAt: '2099-01-01', platformApiUrl: 'https://platform.invalid' }; } },
    fetchImpl: (async (_url, init) => {
      auth.push(new Headers(init?.headers).get('Authorization')!);
      return auth.length === 1 ? new Response('', { status: 401 }) : Response.json({ items: [row('work')], cursor: null });
    }) as typeof fetch,
  });
  assert.equal((await client.page(null, signal())).items.length, 1);
  assert.deepEqual(force, [false, true]); assert.deepEqual(auth, ['Bearer expired', 'Bearer fresh']);
  let calls = 0;
  const denied = createInitiativeRecordingsClient({ source: { get: async () => ({ token: 'actor', expiresAt: '2099', platformApiUrl: 'https://platform.invalid' }) },
    fetchImpl: (async () => { calls++; return new Response('', { status: 403 }); }) as typeof fetch });
  await assert.rejects(denied.page(null, signal()), /not available to your account/); assert.equal(calls, 1);
});

test('switching identities during token mint sends no request with the previous bearer', async () => {
  const abort = new AbortController();
  let mint!: (value: { token: string; expiresAt: string; platformApiUrl: string }) => void;
  const token = new Promise<{ token: string; expiresAt: string; platformApiUrl: string }>(resolve => { mint = resolve; });
  const client = createInitiativeRecordingsClient({ source: { get: () => token },
    fetchImpl: (async () => { assert.fail('old actor must not send a request'); }) as typeof fetch });
  const pending = client.page(null, abort.signal);
  abort.abort(); mint({ token: 'previous-actor', expiresAt: '2099', platformApiUrl: 'https://platform.invalid' });
  await assert.rejects(pending, { name: 'AbortError' });
});

test('a page received after navigation cannot publish the previous initiative’s private rows', async () => {
  const abort = new AbortController();
  const pending = readInitiativeRecordings({ page: async () => { abort.abort(); return { items: [row('previous')], cursor: null }; } }, lobby, abort.signal);
  await assert.rejects(pending, { name: 'AbortError' });
});

test('deep-linked recordings must belong to this initiative before the player can request playback', async () => {
  const client = createInitiativeRecordingsClient({ source: { get: async () => ({ token: 'actor', expiresAt: '2099', platformApiUrl: 'https://platform.invalid' }) },
    fetchImpl: (async () => Response.json(row('elsewhere', 'room:other'))) as typeof fetch });
  await assert.rejects(client.detail('elsewhere', lobby, signal()), /not part of this initiative/);
});

test('recorded activity is deduped and bounded by the recording’s lobby and exact start/end', () => {
  const rec = row('work');
  const event = (id: string, at: string, room = lobby) => ({ reactionId: id, at, lobbyName: room, emoji: '❤️', userId: 'u-vera' });
  const events = recordingReactions(rec, [
    event('late', '2026-10-09T17:21:00Z'), event('other', '2026-10-09T17:20:26.283Z', 'room:other'),
    event('heart', '2026-10-09T17:20:26.283Z'), event('heart', '2026-10-09T17:20:26.283Z'),
    event('before', '2026-10-09T17:18:00Z'), event('start', rec.startedAt), event('bad', 'invalid'),
    event('end', rec.endedAt!),
  ]);
  assert.deepEqual(events.map(item => item.reactionId), ['start', 'heart', 'end']);
});

test('shared recording list receives true media length and compose status', () => {
  const items = initiativeRecordingItems([
    { ...row('ready'), durationMs: 53_700, composeStatus: 'degraded', participants: [{ userId: 'u-vera' }, { userId: 'u-nora' }] },
    { ...row('pending'), composeStatus: 'running' }, { ...row('failed'), composeStatus: 'failed' },
    { ...row('unknown'), composeStatus: undefined },
  ], 'Observability Platform');
  assert.equal(items[0]!.durationSec, 53.7);
  assert.equal(items[0]!.participantCount, 2);
  assert.equal(items[0]!.label, 'Observability Platform huddle');
  assert.deepEqual(items.map(item => item.status), ['ready', 'processing', 'failed', 'processing']);
});

test('shared replay layer receives exact recorded reaction offsets without neighbouring-call events', () => {
  const rec = row('work');
  const heart = { reactionId: 'heart', at: '2026-10-09T17:20:26.283Z', lobbyName: lobby, emoji: '❤️', displayName: 'Vera Green' };
  assert.deepEqual(timedRecordingReactions(rec, [heart, { ...heart, reactionId: 'neighbour', lobbyName: 'room:elsewhere' }]),
    [{ id: 'heart', emoji: '❤️', displayName: 'Vera Green', offsetMs: 35_164 }]);
});

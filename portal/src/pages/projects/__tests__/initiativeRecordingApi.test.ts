import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordingPlaybackUrl, createInitiativeRecordingsClient, initiativeRecordingItems, readInitiativeRecordings, recordingForCall, recordingReactions, timedRecordingReactions, type InitiativeRecording } from '../initiativeRecordingApi.ts';

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

test('ended-call discovery requires both the exact call ID and native lobby, never the latest nearby recording', async () => {
  const neighbour = { ...row('latest'), callId: 'another-call' };
  const wrongScope = { ...row('private', 'orgiq:initiative:p-other'), callId: 'ended-call' };
  assert.equal(await recordingForCall({ page: async () => ({ items: [neighbour, wrongScope], cursor: null }) }, 'ended-call', lobby, signal()), null);
  const wanted = { ...row('exact'), callId: 'ended-call' };
  const cursors: Array<string | null> = [];
  assert.equal((await recordingForCall({ page: async cursor => { cursors.push(cursor); return cursor ? { items: [wanted], cursor: null } : { items: [neighbour], cursor: 'older' }; } }, 'ended-call', lobby, signal()))?.recordingId, 'exact');
  assert.deepEqual(cursors, [null, 'older']);
});

test('native transcript progress preserves the terminal flag and bounded Retry-After contract', async () => {
  let failed = false;
  const client = createInitiativeRecordingsClient({ source: { get: async () => ({ token: 'fixture', expiresAt: '2099', platformApiUrl: 'https://platform.invalid' }) },
    fetchImpl: (async () => Response.json(failed ? { status: 'stalled', terminal: true, error: 'worker did not progress' } : { status: 'processing', terminal: false, retryAfterMs: 17000 }, { status: 202 })) as typeof fetch });
  assert.deepEqual(await client.transcript('exact', signal()), { status: 'processing', terminal: false, retryAfterMs: 17000 });
  failed = true;
  assert.deepEqual(await client.transcript('exact', signal()), { status: 'stalled', terminal: true, retryAfterMs: null, error: 'worker did not progress' });
});

test('failed or pending summary text is never represented as a completed generated summary', async () => {
  let state = 'processing';
  const client = createInitiativeRecordingsClient({ source: { get: async () => ({ token: 'fixture', expiresAt: '2099', platformApiUrl: 'https://platform.invalid' }) },
    fetchImpl: (async () => new Response('_Compatibility status explanation_', { headers: { 'X-Summary-Status': state } })) as typeof fetch });
  assert.equal((await client.summary('exact', signal())).status, 'processing');
  state = 'failed'; const failed = await client.summary('exact', signal());
  assert.equal(failed.status, 'failed'); assert.equal('markdown' in failed, false);
  state = 'ready'; assert.deepEqual(await client.summary('exact', signal()), { status: 'ready', markdown: '_Compatibility status explanation_' });
});

test('summary failure leaves native timestamped transcript segments independently readable', async () => {
  const segments = [{ startMs: 1250, endMs: 2500, speakerId: 'participant', speakerLabel: 'Participant', text: 'Keep this exact saved line.' }];
  const client = createInitiativeRecordingsClient({ source: { get: async () => ({ token: 'fixture', expiresAt: '2099', platformApiUrl: 'https://platform.invalid' }) },
    fetchImpl: (async url => String(url).endsWith('/summary') ? new Response('Summary unavailable', { headers: { 'X-Summary-Status': 'failed' } }) : Response.json({ segments })) as typeof fetch });
  assert.deepEqual(await client.transcript('exact', signal()), { status: 'ready', segments });
  assert.equal((await client.summary('exact', signal())).status, 'failed');
});


test('playback preserves native signed URLs and accepts separate token without replacing authority', () => {
  assert.equal(recordingPlaybackUrl({ mediaState: 'playable', composedUrl: 'https://video.example/exact.mp4?token=recording-bound&other=kept', token: 'legacy-extra' }), 'https://video.example/exact.mp4?token=recording-bound&other=kept');
  assert.equal(recordingPlaybackUrl({ mediaState: 'playable', playlistUrl: 'https://video.example/exact.mp4?other=kept', token: 'separate+token' }), 'https://video.example/exact.mp4?other=kept&token=separate%2Btoken');
  assert.equal(recordingPlaybackUrl({ mediaState: 'unavailable', token: 'no-media' }), null);
  assert.equal(recordingPlaybackUrl({ mediaState: 'playable', composedUrl: 'javascript:invalid' }), null);
});


test('status waits use the authenticated native endpoint and reject a different recording scope', async () => {
  let requested = '';
  const client = createInitiativeRecordingsClient({ source: { get: async () => ({ token: 'actor', expiresAt: '2099', platformApiUrl: 'https://platform.invalid' }) },
    fetchImpl: (async (url, init) => { requested = String(url); assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer actor');
      return Response.json({ recordingId: 'exact', lobbyName: lobby, revision: 'b'.repeat(64) }); }) as typeof fetch });
  assert.equal(await client.status('exact', lobby, 'a'.repeat(64), signal()), 'b'.repeat(64));
  assert.equal(requested, `https://platform.invalid/api/recordings/exact/status?after=${'a'.repeat(64)}`);
  await assert.rejects(client.status('other', lobby, null, signal()), /invalid/);
  await assert.rejects(client.status('exact', 'orgiq:initiative:other', null, signal()), /invalid/);
});

// The interview record's model on the portal side (lib/interviewsRecord.ts, row I5.1): the line each state shows, the
// transcript on the player's clock, the markers' moments, and how a real recording is reached through platform-api.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clockOf, codeEmptyLine, hasRecord, lengthOf, loadInterviewMedia, markerTime, offsetMs, playFrom, recordPath, recordingLine, segmentsOf, transcriptLine,
  type RecordLine,
} from '../interviewsRecord.ts';

const LINES: RecordLine[] = [
  { seq: 1, atMs: 20_000, side: 'panel', speaker: 'Hugo Marchetti', text: 'Hi Mateo.' },
  { seq: 2, atMs: 35_000, side: 'candidate', speaker: 'Mateo Álvarez', text: 'Hi Hugo.' },
  { seq: 4, atMs: 70_000, side: 'panel', speaker: 'Hugo Marchetti', text: 'The first problem.' },
];

test('a finished round has a record; the path is the round\'s', () => {
  assert.equal(hasRecord('ended'), true);
  assert.equal(hasRecord('reviewed'), true);
  assert.equal(hasRecord('live'), false);
  assert.equal(recordPath('iv 1'), '/interviews/rounds/iv%201/record');
});

test('each line runs until the next starts, so a moment always lands on the line being said', () => {
  const s = segmentsOf(LINES, 0, 3_500_000);
  assert.deepEqual(s.map((x) => [x.startMs, x.endMs]), [[20_000, 35_000], [35_000, 70_000], [70_000, 3_500_000]]);
  assert.deepEqual(s.map((x) => x.id), ['1', '2', '4']);
  assert.equal(s[1]!.speakerLabel, 'Mateo Álvarez');
  assert.equal(s[1]!.speakerId, 'candidate');
  // The last line holds 30 seconds when the end is unknown.
  assert.equal(segmentsOf(LINES).at(-1)!.endMs, 100_000);
});

test('time alignment: a recording that started before the record moves every line and marker later', () => {
  const shift = offsetMs('2026-11-10T14:00:30.000Z', '2026-11-10T14:00:00.000Z');
  assert.equal(shift, 30_000);
  assert.equal(segmentsOf(LINES, shift)[0]!.startMs, 50_000);
  assert.equal(markerTime({ atMs: 60_000 }, shift), 90_000);
  assert.equal(offsetMs(null, '2026-11-10T14:00:00.000Z'), 0);
  // Never before the start of the player.
  assert.equal(segmentsOf(LINES, -60_000)[0]!.startMs, 0);
});

test('the clock, the length and the player starting at a moment', () => {
  assert.equal(clockOf(1_100_000), '18:20');
  assert.equal(clockOf(3_725_000), '1:02:05');
  assert.equal(lengthOf(3500), '58 minutes');
  assert.equal(lengthOf(3720), '1 hour 2 minutes');
  assert.equal(playFrom('https://media.example/r.mp4?token=a', 61_500), 'https://media.example/r.mp4?token=a#t=61');
  assert.equal(playFrom('https://media.example/r.mp4#t=9', 0), 'https://media.example/r.mp4');
});

test('the recording\'s one line per state', () => {
  const base = { playbackUrl: null, durationSeconds: null };
  assert.match(recordingLine({ ...base, state: 'declined' })!, /chose not to be recorded/);
  assert.match(recordingLine({ ...base, state: 'deleted' })!, /has been deleted/);
  assert.match(recordingLine({ ...base, state: 'none' })!, /no recording/);
  assert.match(recordingLine({ ...base, state: 'available', durationSeconds: 3500, standIn: true })!, /runs 58 minutes.*nothing to play here/);
  assert.equal(recordingLine({ ...base, state: 'available' }, 'playable'), null);
  assert.match(recordingLine({ ...base, state: 'available' }, 'none')!, /no recording/);
  assert.match(recordingLine({ ...base, state: 'available' }, 'unreachable')!, /could not be reached/);
});

test('the transcript\'s one line per state', () => {
  assert.match(transcriptLine('declined')!, /without a transcript/);
  assert.match(transcriptLine('deleted')!, /has been deleted/);
  assert.match(transcriptLine('none')!, /Nothing was transcribed/);
  assert.equal(transcriptLine('available'), null);
});

test('a real recording is listed by the interview\'s lobby and played from a playback token, with the viewer\'s own token', async () => {
  const calls: Array<{ url: string; method: string; auth: string }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, method: init.method ?? 'GET', auth: (init.headers as Record<string, string>).Authorization });
    if (url.includes('/playback-token')) return new Response(JSON.stringify({ mediaState: 'playable', composedUrl: 'https://media.example/r.mp4', token: 't1' }));
    return new Response(JSON.stringify({ items: [
      { recordingId: 'r-old', lobbyName: 'interviews:interview:iv-1', startedAt: '2026-11-10T13:00:00.000Z' },
      { recordingId: 'r-new', lobbyName: 'interviews:interview:iv-1', startedAt: '2026-11-10T14:00:00.000Z' },
      { recordingId: 'r-else', lobbyName: 'interviews:interview:iv-2', startedAt: '2026-11-11T14:00:00.000Z' },
    ] }));
  }) as unknown as typeof fetch;
  const source = { get: async () => ({ token: 'tok', expiresAt: Date.now() + 60_000 }) } as never;
  const m = await loadInterviewMedia('iv-1', new AbortController().signal, { source, fetchImpl, platformApiUrl: 'https://api.example' });
  assert.deepEqual(m, { state: 'playable', url: 'https://media.example/r.mp4?token=t1', startedAt: '2026-11-10T14:00:00.000Z' });
  assert.match(calls[0]!.url, /^https:\/\/api\.example\/api\/recordings\?lobbyName=interviews%3Ainterview%3Aiv-1/);
  assert.equal(calls[1]!.url, 'https://api.example/api/recordings/r-new/playback-token');
  assert.equal(calls[1]!.method, 'POST');
  assert.ok(calls.every((c) => c.auth === 'Bearer tok'));
});

test('a refusal from platform-api reads as no recording; a failure as unreachable; nothing throws', async () => {
  const source = { get: async () => ({ token: 'tok', expiresAt: Date.now() + 60_000 }) } as never;
  const answer = (status: number) => (async () => new Response('{}', { status })) as unknown as typeof fetch;
  const signal = new AbortController().signal;
  assert.equal((await loadInterviewMedia('iv-1', signal, { source, fetchImpl: answer(404), platformApiUrl: 'https://api.example' })).state, 'none');
  assert.equal((await loadInterviewMedia('iv-1', signal, { source, fetchImpl: answer(502), platformApiUrl: 'https://api.example' })).state, 'unreachable');
  const broken = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
  assert.equal((await loadInterviewMedia('iv-1', signal, { source, fetchImpl: broken, platformApiUrl: 'https://api.example' })).state, 'unreachable');
});

// Hardening H4 (O-136): a recording still being processed shows none. The platform answers the playback token with a
// media state that is not playable and no address; the page must not invent one from a live stream.
test('a recording still processing shows none: no player, the plain no-recording line, and never a live address', async () => {
  const source = { get: async () => ({ token: 'tok', expiresAt: Date.now() + 60_000 }) } as never;
  const signal = new AbortController().signal;
  const listed = [{ recordingId: 'r-1', lobbyName: 'interviews:interview:iv-1', startedAt: '2026-11-10T14:00:00.000Z' }];
  const answering = (playback: unknown) => (async (url: string) => (
    url.includes('/playback-token') ? new Response(JSON.stringify(playback)) : new Response(JSON.stringify({ items: listed }))
  )) as unknown as typeof fetch;
  for (const playback of [{ mediaState: 'processing' }, { mediaState: 'processing', composedUrl: null, playlistUrl: null, token: 'tok-2' }, { mediaState: 'pending', composedUrl: 'not-a-url' }]) {
    const m = await loadInterviewMedia('iv-1', signal, { source, fetchImpl: answering(playback), platformApiUrl: 'https://api.example' });
    assert.deepEqual(m, { state: 'none', url: null, startedAt: '2026-11-10T14:00:00.000Z' }, JSON.stringify(playback));
    assert.match(recordingLine({ state: 'available', playbackUrl: null, durationSeconds: 3500 }, m.state)!, /no recording of this interview/);
  }
});

test('the code\'s empty line says why the code was removed, or that none was written (hardening H5)', () => {
  assert.equal(codeEmptyLine({ codeRemoved: 'period' }), 'The code from this interview was removed at the end of its keeping period.');
  assert.equal(codeEmptyLine({ codeRemoved: 'request' }), 'The code from this interview was removed when the candidate asked for their data to be deleted.');
  assert.equal(codeEmptyLine({ codeRemoved: null }), 'No code was written in this interview.');
  assert.equal(codeEmptyLine({}), 'No code was written in this interview.');
});

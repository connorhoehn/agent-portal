// Milo for you and the live transcript, the room's side (lib/interviewsRoom.ts E5 additions; rows I3.6, I3.7).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  MILO_ASK_KEPT, MILO_ASK_PAUSED_LINE, askLineOf, askedByLabel, asksMilo, keepExchange, liveTranscriptSegments, mergeTranscript, miloAskPath,
  miloNotesPath, pollsMilo, readLiveTranscript, readMiloNotes, transcriptOpenByDefault, transcriptPath, type LiveTranscriptLine, type MiloAskBody,
} from '../interviewsRoom.ts';

const reply = (status: number, body?: unknown) => (async () => new Response(JSON.stringify(body ?? {}), { status })) as unknown as typeof fetch;
const line = (seq: number, at: string, side: 'candidate' | 'panel' = 'candidate', speaker = 'Nadia Petrova'): LiveTranscriptLine => ({ seq, at, side, speaker, text: `line ${seq}` });

test('the paths are E5\'s', () => {
  assert.equal(transcriptPath('iv 1'), '/api/interviews/interviews/iv%201/transcript');
  assert.equal(transcriptPath('iv-1', 7), '/api/interviews/interviews/iv-1/transcript?after=7');
  assert.equal(miloNotesPath('iv-1'), '/api/interviews/interviews/iv-1/milo-notes');
  assert.equal(miloAskPath('iv-1'), '/api/interviews/interviews/iv-1/milo-ask');
});

test('who reads what: every seat polls while live; only the lead asks', () => {
  assert.equal(pollsMilo('panel', 'live'), true);
  assert.equal(pollsMilo('lead', 'ended'), false);
  assert.equal(pollsMilo(null, 'live'), false);
  assert.equal(asksMilo('lead', 'live'), true);
  assert.equal(asksMilo('panel', 'live'), false);
  assert.equal(asksMilo('lead', 'ready'), false);
  assert.equal(transcriptOpenByDefault('technical'), false);
  assert.equal(transcriptOpenByDefault('behavioural'), true);
});

test('the transcript read: on, off with its line, and not found or failing as no news', async () => {
  const on = await readLiveTranscript('iv-1', 0, reply(200, { transcript: { state: 'on', off: null, lines: [line(1, '2026-11-17T10:00:00.000Z')], lastSeq: 3 } }));
  assert.deepEqual(on, { state: 'on', off: null, lines: [line(1, '2026-11-17T10:00:00.000Z')], lastSeq: 3 });
  const off = await readLiveTranscript('iv-1', 0, reply(200, { transcript: { state: 'off', off: 'There is no transcript yet.', lines: [], lastSeq: 0 } }));
  assert.equal(off?.off, 'There is no transcript yet.');
  assert.equal(await readLiveTranscript('iv-1', 0, reply(404)), null);
  assert.equal(await readLiveTranscript('iv-1', 0, (async () => { throw new Error('down'); }) as unknown as typeof fetch), null);
});

test('the notes read', async () => {
  const notes = { competencies: [], time: { startedAt: null, minutesIn: null, minutes: 45, minutesLeft: null, line: 'x' } };
  assert.deepEqual(await readMiloNotes('iv-1', reply(200, { notes })), notes);
  assert.equal(await readMiloNotes('iv-1', reply(404)), null);
  assert.equal(await readMiloNotes('iv-1', reply(200, {})), null);
});

test('new lines are added once each, in order', () => {
  const a = [line(1, '2026-11-17T10:00:00.000Z'), line(3, '2026-11-17T10:00:30.000Z')];
  assert.deepEqual(mergeTranscript(a, [line(3, '2026-11-17T10:00:30.000Z'), line(2, '2026-11-17T10:00:10.000Z')]).map((l) => l.seq), [1, 2, 3]);
  assert.deepEqual(mergeTranscript(a, []), a);
});

test('segments time from the first line and key by seq', () => {
  const segs = liveTranscriptSegments([line(1, '2026-11-17T10:00:00.000Z', 'panel', 'Wen Zhao'), line(2, '2026-11-17T10:00:12.000Z')]);
  assert.deepEqual(segs, [
    { id: '1', startMs: 0, endMs: 12_000, speakerId: 'Wen Zhao', speakerLabel: 'Wen Zhao', text: 'line 1' },
    { id: '2', startMs: 12_000, endMs: 12_000, speakerId: 'candidate', speakerLabel: 'Nadia Petrova', text: 'line 2' },
  ]);
  assert.deepEqual(liveTranscriptSegments([]), []);
});

test('the exchanges kept: newest first, at most a few, a refusal as its one line', () => {
  const answer = { id: 'ml-1', question: 'q', text: 'The candidate spoke of it in line 2.', sources: [], askedAt: 'x' };
  const ok: MiloAskBody = { answer, refused: null, line: null, paused: null, retryAfterMs: null };
  const refused: MiloAskBody = { answer: null, refused: 'judgement', line: 'Milo can only find what was said.', paused: null, retryAfterMs: null };
  const paused: MiloAskBody = { answer: null, refused: null, line: null, paused: 'budget', retryAfterMs: null };
  assert.equal(askLineOf(refused), 'Milo can only find what was said.');
  assert.equal(askLineOf(paused), MILO_ASK_PAUSED_LINE);
  assert.equal(askLineOf(ok), null);
  let kept = keepExchange([], 'first', ok, 'k1');
  kept = keepExchange(kept, 'second', refused, 'k2');
  assert.deepEqual(kept.map((k) => [k.question, k.line]), [['second', 'Milo can only find what was said.'], ['first', null]]);
  for (let i = 0; i < 10; i++) kept = keepExchange(kept, `q${i}`, ok, `x${i}`);
  assert.equal(kept.length, MILO_ASK_KEPT);
  assert.equal(askedByLabel('milo'), 'Milo asked it');
  assert.equal(askedByLabel('panel'), null);
});

test('the candidate\'s room imports none of Milo for you and names none of its routes', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const join_ = join(here, '..', '..', 'pages', 'join');
  const mine = /\b(readLiveTranscript|readMiloNotes|askMilo|miloAskPath|miloNotesPath|transcriptPath|MiloNotes|MiloAskBody|LiveTranscriptLine|keepExchange|liveTranscriptSegments|InterviewRoomPage)\b|milo-ask|milo-notes|\/transcript\b/;
  const files = readdirSync(join_).filter((f) => /\.(ts|tsx)$/.test(f));
  assert.ok(files.length > 3);
  for (const f of files) assert.equal(mine.test(readFileSync(join(join_, f), 'utf8')), false, `${f} reaches Milo for you`);
});

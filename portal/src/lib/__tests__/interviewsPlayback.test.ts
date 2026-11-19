// The record's one clock (lib/interviewsPlayback.ts, row I5.1): frames from the pad log's snapshots, the places to jump
// to, the whole log read through its pages, and the run a moment belongs to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { framesOf, markersOf, revealMoments, mergeCloseMarkers, padLogUrl, pasteLabel, playbackDurationMs, readWholePadLog, runAtTime, type PadLogEvent, type PadLogPage } from '../interviewsPlayback.ts';
import type { RunView } from '../interviewsPad.ts';

const START = '2026-11-10T14:00:00.000Z';
const at = (s: number) => new Date(Date.parse(START) + s * 1000).toISOString();
const MATEO = { id: 'guest:iv-1', name: 'Mateo', side: 'candidate' as const };
const HUGO = { id: 'u-hugo', name: 'Hugo Marchetti', side: 'panel' as const };

const EVENTS: PadLogEvent[] = [
  { seq: 1, kind: 'insert', at: at(70), who: HUGO, questionId: 'q1' },
  { seq: 2, kind: 'edit', at: at(430), who: MATEO },
  { seq: 3, kind: 'snapshot', at: at(540), who: MATEO, text: 'one', language: 'python' },
  { seq: 4, kind: 'paste', at: at(600), who: MATEO, lines: 12, inserted: 300, via: 'paste' },
  { seq: 5, kind: 'snapshot', at: at(660), who: MATEO, text: 'two' },
];
const run = (runId: string, s: number, status: RunView['status']): RunView => ({ runId, language: 'python', status, startedBy: MATEO, queuedAt: at(s), startedAt: at(s), endedAt: at(s + 2), result: null });
const RUNS = [run('a', 620, 'failed'), run('b', 700, 'succeeded')];
const QUESTIONS = [{ id: 'q1', prompt: 'Implement a rate limiter.' }];

test('only snapshots are frames, on the interview clock and in time order', () => {
  assert.deepEqual(framesOf(EVENTS, START), [{ atMs: 540_000, text: 'one', language: 'python' }, { atMs: 660_000, text: 'two' }]);
  assert.deepEqual(framesOf([...EVENTS].reverse(), START).map((f) => f.text), ['one', 'two']);
  assert.deepEqual(framesOf(EVENTS, null).map((f) => f.atMs), [0, 0]);
});

test('a paste is named by its size, never as an accusation', () => {
  assert.equal(pasteLabel({ lines: 12 }), 'Paste, 12 lines');
  assert.equal(pasteLabel({ lines: 1 }), 'Paste, 1 line');
  assert.equal(pasteLabel({ inserted: 102 }), 'Paste, 102 characters');
  assert.equal(pasteLabel({ lines: 2, via: 'drop' }), 'Drop, 2 lines');
});

test('markers are questions, pastes and runs in time order, each once', () => {
  const m = markersOf({ events: EVENTS, startedAt: START, recordMarkers: [{ kind: 'milo-asked', atMs: 1_100_000, label: 'What happens at the reset?' }], runs: RUNS, questions: QUESTIONS });
  assert.deepEqual(m.map((x) => [x.atMs, x.kind, x.label]), [
    [70_000, 'question', 'Implement a rate limiter.'], [600_000, 'paste', 'Paste, 12 lines'], [620_000, 'run', 'Run 1'], [700_000, 'run', 'Run 2'], [1_100_000, 'question', 'What happens at the reset?'],
  ]);
  assert.equal(m.find((x) => x.label === 'Run 2')!.runId, 'b');
  assert.equal(m.find((x) => x.label === 'Run 1')!.detail, 'Run 1 failed, by Mateo');
});

test('a question the record already marks is not repeated by the pad insert', () => {
  const m = markersOf({ events: EVENTS, startedAt: START, recordMarkers: [{ kind: 'question', atMs: 72_000, label: 'Implement a rate limiter.' }], runs: [], questions: QUESTIONS });
  assert.equal(m.filter((x) => x.kind === 'question').length, 1);
  // An insert whose question is unknown is still a moment, without an id in its words.
  const u = markersOf({ events: EVENTS.slice(0, 1), startedAt: START, recordMarkers: [], runs: [], questions: [] });
  assert.equal(u[0]!.label, 'A question was put in the pad');
});

test('the whole log is read page after page from lastSeq while more', async () => {
  const pages: Record<number, PadLogPage> = {
    0: { events: EVENTS.slice(0, 2), lastSeq: 2, more: true },
    2: { events: EVENTS.slice(2, 4), lastSeq: 4, more: true },
    4: { events: EVENTS.slice(4), lastSeq: 5, more: false },
  };
  const asked: number[] = [];
  const all = await readWholePadLog(async (after) => { asked.push(after); return pages[after] ?? null; });
  assert.deepEqual(asked, [0, 2, 4]);
  assert.equal(all!.length, 5);
});

test('a failed first read is null; a later failure keeps what was read; a stuck page cannot loop', async () => {
  assert.equal(await readWholePadLog(async () => null), null);
  const half = await readWholePadLog(async (after) => (after === 0 ? { events: EVENTS.slice(0, 2), lastSeq: 2, more: true } : null));
  assert.equal(half!.length, 2);
  let calls = 0;
  await readWholePadLog(async () => { calls += 1; return { events: [], lastSeq: 0, more: true }; });
  assert.equal(calls, 1);
});

test('the run a moment belongs to is the last one started by then', () => {
  assert.equal(runAtTime(RUNS, START, 600_000), null);
  assert.equal(runAtTime(RUNS, START, 620_000)!.runId, 'a');
  assert.equal(runAtTime(RUNS, START, 9_999_000)!.runId, 'b');
});

test('the timeline is the recording\'s length, else the interview\'s, else the last event, at least a minute', () => {
  const base = { interview: { startedAt: START, endedAt: at(3600) }, recording: { durationSeconds: 3500 } } as never;
  assert.equal(playbackDurationMs(base, 0), 3_500_000);
  assert.equal(playbackDurationMs({ interview: { startedAt: START, endedAt: at(3600) }, recording: { durationSeconds: null } } as never, 0), 3_600_000);
  assert.equal(playbackDurationMs({ interview: { startedAt: null, endedAt: null }, recording: { durationSeconds: null } } as never, 5_000), 60_000);
  assert.equal(padLogUrl('iv 1', 4), '/api/interviews/interviews/iv%201/pad/log?after=4');
});

test('markers of one kind closer than 2% of the length become one, naming them all, at the first one’s time', () => {
  const runs = [
    { runId: 'a', queuedAt: '2026-01-01T10:09:50.000Z', status: 'failed', startedBy: { name: 'Mateo' } },
    { runId: 'b', queuedAt: '2026-01-01T10:09:58.000Z', status: 'succeeded', startedBy: { name: 'Mateo' } },
    { runId: 'c', queuedAt: '2026-01-01T10:30:00.000Z', status: 'succeeded', startedBy: { name: 'Mateo' } },
  ] as unknown as Parameters<typeof markersOf>[0]['runs'];
  const base = { events: [], startedAt: '2026-01-01T10:00:00.000Z', recordMarkers: [], runs, questions: [] };
  // 60 minutes: 2% is 72 s, so runs 1 and 2 (8 s apart) join and run 3 stands alone.
  const m = markersOf({ ...base, durationMs: 3_600_000 });
  assert.deepEqual(m.map((x) => [x.atMs, x.label]), [[590_000, 'Runs 1 and 2 at 9:50'], [1_800_000, 'Run 3']]);
  assert.equal(m[0]!.runId, 'a');
  assert.equal(m[0]!.detail, 'Run 1 failed, by Mateo; Run 2 passed, by Mateo');
  // Without a length nothing merges; a short playback keeps them apart.
  assert.equal(markersOf(base).length, 3);
  assert.equal(markersOf({ ...base, durationMs: 300_000 }).length, 3);
  // Three runs read "Runs 1, 2 and 3"; the run shown at any time is still chosen by time, so all stay reachable.
  const three = markersOf({ ...base, runs: [...runs.slice(0, 2), { ...runs[2]!, queuedAt: '2026-01-01T10:10:05.000Z' }], durationMs: 3_600_000 });
  assert.deepEqual(three.map((x) => x.label), ['Runs 1, 2 and 3 at 9:50']);
  assert.equal(runAtTime(runs, base.startedAt, 599_000)!.runId, 'b');
});

test('different kinds never merge, and pastes and questions name each other', () => {
  const near = [
    { atMs: 100_000, kind: 'paste', label: 'Paste, 3 lines', detail: 'x' },
    { atMs: 101_000, kind: 'run', label: 'Run 1', detail: 'y' },
    { atMs: 102_000, kind: 'paste', label: 'Paste, 9 lines', detail: 'z' },
  ] as const;
  const out = mergeCloseMarkers(near as unknown as Parameters<typeof mergeCloseMarkers>[0], 3_600_000);
  assert.deepEqual(out.map((x) => x.label), ['2 pastes at 1:40: Paste, 3 lines, Paste, 9 lines', 'Run 1']);
});

test('the lead\'s reveal of the provided design is a moment of its own, named for the question', () => {
  const reveal: PadLogEvent = { seq: 9, kind: 'reveal', at: at(1500), who: HUGO, questionId: 'q-design' };
  const m = markersOf({ events: [reveal], startedAt: START, recordMarkers: [], runs: [], questions: [{ id: 'q-design', prompt: 'Design Twitter: people post short messages.' }] });
  assert.deepEqual(m, [{ atMs: 1_500_000, kind: 'reveal', label: 'Provided design shown', detail: 'Hugo Marchetti showed the provided design for "Design Twitter: people post short messages." to the candidate' }]);
  assert.deepEqual(revealMoments([reveal], START), [{ questionId: 'q-design', atMs: 1_500_000, label: 'Provided design shown to the candidate', by: 'Hugo Marchetti' }]);
});

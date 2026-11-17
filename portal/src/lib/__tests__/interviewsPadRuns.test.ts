// The pad's runs and pad log on the portal side (lib/interviewsPad.ts; rows I4.3, I4.4; contracts U3, U4): the
// runs reducer the hook folds the stream and the reads into, the output's model, the request a Run sends, and the
// pad log batcher with an injected clock. The server's own checks are imported by value where they have no
// dependencies, so a drift between the two sides fails here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPTY_RUNS, PAD_LOG_FLUSH_MS, PAD_LOG_MAX_PER_POST, PAD_LOG_SNAPSHOT_MS, PadLogBatcher, RUN_ENTRYPOINTS, RUN_STATUSES, cancellableRun, editEvent,
  entryStatus, insertEvent, languageEvent, latestRun, newRunId, parseRunEvent, pasteEvent, runNeedsRead, runOutputModel, runRequest, runsReducer,
  snapshotEvent, staffPadBase, GUEST_PAD_BASE, type PadEventIn, type RunEvent, type RunView, type RunsAction, type RunsState,
} from '../interviewsPad.ts';
import { PAD_LANGUAGES } from '../interviewsKit.ts';
import * as executor from '../../../../middleware/src/lib/interviews/runs/executor.ts';
import { checkPadPost, MAX_EVENTS_PER_POST } from '../../../../middleware/src/lib/interviews/pad/log/rules.ts';

const fold = (actions: RunsAction[], from: RunsState = EMPTY_RUNS): RunsState => actions.reduce(runsReducer, from);
const ev = (runId: string, seq: number, stream: RunEvent['stream'], data: string): RunsAction => ({ type: 'event', event: { runId, seq, stream, data, at: '2026-11-17T10:00:00.000Z' } });
const view = (runId: string, over: Partial<RunView> = {}): RunView => ({
  runId, language: 'python', status: 'queued', startedBy: { id: 'u-hugo', name: 'Hugo Lindqvist', side: 'panel' },
  queuedAt: '2026-11-17T10:00:00.000Z', startedAt: null, endedAt: null, result: null, ...over,
});
const result = (over: Partial<NonNullable<RunView['result']>> = {}): NonNullable<RunView['result']> => ({
  status: 'succeeded', exitCode: 0, compileOutput: '', stdout: 'one\ntwo\n', stderr: '', truncated: { stdout: false, stderr: false },
  timeMs: 42, peakMemoryMb: 12, backend: 'mock', runtimeVersion: '3.12', ...over,
});

test('the statuses are the server\'s, by value', () => {
  assert.deepEqual([...RUN_STATUSES], [...executor.RUN_STATUSES]);
});

test('the entrypoint is one file named for each language, and the request carries the pad\'s text as it', () => {
  assert.deepEqual(Object.keys(RUN_ENTRYPOINTS).sort(), [...PAD_LANGUAGES].sort());
  assert.deepEqual([...PAD_LANGUAGES].sort(), [...executor.RUN_LANGUAGES].sort());
  assert.deepEqual(RUN_ENTRYPOINTS, { python: 'main.py', swift: 'main.swift', javascript: 'main.js', typescript: 'main.ts', java: 'Main.java', go: 'main.go', cpp: 'main.cpp' });
  const body = runRequest('run-abcdefgh', 'java', 'class Main {}');
  assert.deepEqual(body, { runId: 'run-abcdefgh', language: 'java', files: [{ path: 'Main.java', content: 'class Main {}' }], entrypoint: 'Main.java' });
});

test('each click gets a fresh id the server takes', () => {
  const a = newRunId(), b = newRunId();
  assert.notEqual(a, b);
  for (const id of [a, b, newRunId(() => 0, 0), newRunId(() => 0.999999, 8.64e15)]) assert.match(id, /^[A-Za-z0-9_-]{8,80}$/);
});

test('the bases: the panel\'s interview path and the guest\'s one path', () => {
  assert.equal(staffPadBase('iv-k1p5w8ra'), '/api/interviews/interviews/iv-k1p5w8ra');
  assert.equal(GUEST_PAD_BASE, '/api/interview-invite');
});

test('a stream message parses, and a malformed one is dropped', () => {
  assert.deepEqual(parseRunEvent('{"runId":"r1aaaaaaa","seq":2,"stream":"stdout","data":"hi\\n","at":"x"}'), { runId: 'r1aaaaaaa', seq: 2, stream: 'stdout', data: 'hi\n', at: 'x' });
  for (const bad of ['', 'nope', '{}', '{"runId":"r","seq":1.5,"stream":"stdout","data":""}', '{"runId":"r","seq":1,"stream":"log","data":""}']) assert.equal(parseRunEvent(bad), null);
});

test('events in order: the status advances and the output grows', () => {
  const s = fold([ev('r1', 1, 'status', 'queued'), ev('r1', 2, 'status', 'running'), ev('r1', 3, 'stdout', 'one\n'), ev('r1', 4, 'stdout', 'two\n'), ev('r1', 5, 'stderr', 'warn\n')]);
  const out = runOutputModel(latestRun(s));
  assert.equal(out.status, 'running');
  assert.equal(out.stdout, 'one\ntwo\n');
  assert.equal(out.stderr, 'warn\n');
  assert.equal(cancellableRun(s)?.runId, 'r1');
});

test('events out of order, and repeated after a reconnect, read the same as in order', () => {
  const inOrder = fold([ev('r1', 1, 'status', 'queued'), ev('r1', 2, 'status', 'running'), ev('r1', 3, 'stdout', 'a'), ev('r1', 4, 'stdout', 'b'), ev('r1', 5, 'status', 'succeeded')]);
  const shuffled = fold([ev('r1', 4, 'stdout', 'b'), ev('r1', 1, 'status', 'queued'), ev('r1', 5, 'status', 'succeeded'), ev('r1', 3, 'stdout', 'a'), ev('r1', 2, 'status', 'running')]);
  // A reconnect with Last-Event-ID that names nothing replays everything: each repeat replaces itself.
  const replayed = fold([ev('r1', 1, 'status', 'queued'), ev('r1', 2, 'status', 'running'), ev('r1', 3, 'stdout', 'a'), ev('r1', 1, 'status', 'queued'), ev('r1', 2, 'status', 'running'), ev('r1', 3, 'stdout', 'a'), ev('r1', 4, 'stdout', 'b'), ev('r1', 5, 'status', 'succeeded')]);
  for (const s of [shuffled, replayed]) assert.deepEqual(runOutputModel(latestRun(s)), runOutputModel(latestRun(inOrder)));
  assert.equal(runOutputModel(latestRun(inOrder)).stdout, 'ab');
  assert.equal(runsReducer(inOrder, ev('r1', 3, 'stdout', 'a')), inOrder, 'a repeat changes nothing');
  // Ended on the stream with no result held: the view is read.
  assert.equal(entryStatus(latestRun(inOrder)!), 'succeeded');
  assert.equal(runNeedsRead(latestRun(inOrder)!), true);
  assert.equal(cancellableRun(inOrder), null);
});

test('two runs: the newest shows, the older keeps its own output, and a queued second one is what Cancel stops', () => {
  const s = fold([
    { type: 'view', run: view('r1', { queuedAt: '2026-11-17T10:00:00.000Z' }) },
    ev('r1', 1, 'status', 'queued'), ev('r1', 2, 'status', 'running'), ev('r1', 3, 'stdout', 'first'),
    ev('r2', 1, 'status', 'queued'),
  ]);
  assert.equal(latestRun(s)?.runId, 'r2', 'a run seen only on the stream is newer than what came before it');
  assert.equal(runOutputModel(latestRun(s)).status, 'queued');
  assert.equal(runOutputModel(latestRun(s)).stdout, '');
  assert.equal(runOutputModel(s.runs['r1']!).stdout, 'first');
  assert.equal(cancellableRun(s)?.runId, 'r2');
  // The second run's view arrives with a later queue time: still newest. The list (newest first) keeps the order.
  const listed = fold([{ type: 'list', runs: [view('r2', { queuedAt: '2026-11-17T10:00:05.000Z' }), view('r1', { status: 'running' })] }], s);
  assert.equal(latestRun(listed)?.runId, 'r2');
  // A late joiner: only the list, newest first.
  const late = fold([{ type: 'list', runs: [view('r2', { queuedAt: '2026-11-17T10:01:00.000Z', status: 'succeeded', result: result() }), view('r1', { status: 'failed', result: result({ status: 'failed' }) })] }]);
  assert.equal(latestRun(late)?.runId, 'r2');
  assert.equal(runOutputModel(latestRun(late)).stdout, 'one\ntwo\n');
});

test('cancel: the cancelled status ends it, and an older read never takes it back', () => {
  const s = fold([
    { type: 'view', run: view('r1') }, ev('r1', 1, 'status', 'queued'), ev('r1', 2, 'status', 'running'),
    ev('r1', 3, 'status', 'cancelled'),
    { type: 'view', run: view('r1', { status: 'cancelled', result: result({ status: 'cancelled', exitCode: null, stdout: '', timeMs: 300 }) }) },
    { type: 'view', run: view('r1', { status: 'running' }) },
  ]);
  assert.equal(entryStatus(s.runs['r1']!), 'cancelled');
  assert.equal(cancellableRun(s), null);
  assert.equal(runNeedsRead(s.runs['r1']!), false);
  // The stream ahead of a stale view: the stream's status wins until the view catches up.
  const ahead = fold([{ type: 'view', run: view('r2', { status: 'queued' }) }, ev('r2', 2, 'status', 'running')]);
  assert.equal(entryStatus(ahead.runs['r2']!), 'running');
  const behind = fold([{ type: 'view', run: view('r3', { status: 'running' }) }, ev('r3', 1, 'status', 'queued')]);
  assert.equal(entryStatus(behind.runs['r3']!), 'running');
});

test('the output\'s model: nothing run yet, a finished run, a failure, a compile error, a cut stream', () => {
  assert.deepEqual(runOutputModel(null), { status: null, stdout: '', stderr: '', compileOutput: '', truncated: { stdout: false, stderr: false }, exitCode: null, timeMs: null, peakMemoryMb: null });
  const done = fold([{ type: 'view', run: view('r1', { status: 'succeeded', result: result() }) }]);
  assert.deepEqual(runOutputModel(latestRun(done), 'u-ana'), {
    status: 'succeeded', stdout: 'one\ntwo\n', stderr: '', compileOutput: '', truncated: { stdout: false, stderr: false },
    exitCode: 0, timeMs: 42, peakMemoryMb: 12, runBy: 'Run by Hugo Lindqvist', languageLabel: 'Python', runtimeVersion: '3.12',
  });
  assert.equal(runOutputModel(latestRun(done), 'u-hugo').runBy, 'Run by you');
  // The candidate's run on the panel's side; the panel's run on the candidate's side reads "Interviewer" (the server's stand-in).
  const cand = fold([{ type: 'view', run: view('r2', { startedBy: { id: 'guest:inv', name: 'Candidate', side: 'candidate' } }) }]);
  assert.equal(runOutputModel(latestRun(cand), 'u-hugo').runBy, 'Run by Candidate');
  const failed = fold([{ type: 'view', run: view('r3', { status: 'failed', result: result({ status: 'failed', exitCode: 1, stdout: 'before\n', stderr: 'Traceback: boom\n' }) }) }]);
  const f = runOutputModel(latestRun(failed));
  assert.equal(f.status, 'failed');
  assert.equal(f.stderr, 'Traceback: boom\n');
  assert.equal(f.stdout, 'before\n');
  assert.equal(f.exitCode, 1);
  const compile = fold([{ type: 'view', run: view('r4', { language: 'go', status: 'compile_error', result: result({ status: 'compile_error', exitCode: null, stdout: '', compileOutput: 'main.go:3: undefined: x\n' }) }) }]);
  assert.equal(runOutputModel(latestRun(compile)).compileOutput, 'main.go:3: undefined: x\n');
  assert.equal(runOutputModel(latestRun(compile)).languageLabel, 'Go');
  const cut = fold([{ type: 'view', run: view('r5', { status: 'succeeded', result: result({ truncated: { stdout: true, stderr: false } }) }) }]);
  assert.deepEqual(runOutputModel(latestRun(cut)).truncated, { stdout: true, stderr: false });
  // While it runs, the stream's text; once the result is held, the result's (the stored, cut output).
  const live = fold([{ type: 'view', run: view('r6', { status: 'running' }) }, ev('r6', 3, 'stdout', 'partial')]);
  assert.equal(runOutputModel(latestRun(live)).stdout, 'partial');
  assert.equal(runOutputModel(latestRun(live)).exitCode, null);
});

// ── The pad log ──────────────────────────────────────────────────────────────────────────────────────────────

function harness(text = '') {
  let now = Date.parse('2026-11-17T10:00:00.000Z');
  const posts: { events: PadEventIn[]; final: boolean }[] = [];
  const pad = { text, language: 'python' };
  let fail = false;
  const b = new PadLogBatcher({
    now: () => now,
    post: async (events, { final }) => { posts.push({ events, final }); if (fail) throw new Error('down'); },
    read: () => ({ ...pad }),
  });
  return { b, posts, pad, advance: (ms: number) => { now += ms; b.tick(); }, failing: () => { fail = true; } };
}
const edit = (n: number) => editEvent({ from: n, inserted: 1, deleted: 0, length: n + 1, at: Date.parse('2026-11-17T10:00:00.000Z') + n });

test('the reporter posts what waits every few seconds, at most 50 a post, and nothing when nothing waits', () => {
  const h = harness();
  for (let i = 0; i < 120; i += 1) h.b.push(edit(i));
  h.advance(PAD_LOG_FLUSH_MS - 1);
  assert.equal(h.posts.length, 0, 'not before the flush time');
  h.advance(1);
  assert.deepEqual(h.posts.map((p) => p.events.length), [50, 50, 20]);
  assert.equal(PAD_LOG_MAX_PER_POST, MAX_EVENTS_PER_POST);
  assert.deepEqual(h.posts.flatMap((p) => p.events.map((e) => e.from)), Array.from({ length: 120 }, (_, i) => i), 'in order');
  h.advance(PAD_LOG_FLUSH_MS);
  assert.equal(h.posts.length, 3);
});

test('a snapshot every 30 seconds only while the text has changed, one at each Run, each in its own post', () => {
  const h = harness('print(1)');
  h.advance(PAD_LOG_SNAPSHOT_MS);
  assert.deepEqual(h.posts.map((p) => p.events.map((e) => e.kind)), [['snapshot']]);
  assert.equal(h.posts[0]!.events[0]!.text, 'print(1)');
  h.advance(PAD_LOG_SNAPSHOT_MS);
  assert.equal(h.posts.length, 1, 'unchanged: no second snapshot');
  h.pad.text = 'print(2)';
  h.b.push(edit(7));
  h.advance(PAD_LOG_SNAPSHOT_MS);
  assert.deepEqual(h.posts.slice(1).map((p) => p.events.map((e) => e.kind)), [['snapshot'], ['edit']]);
  // Run: one snapshot now, which also resets the 30 seconds.
  h.pad.text = 'print(3)';
  h.b.snapshot('print(3)', 'python');
  assert.deepEqual(h.posts.at(-1)!.events.map((e) => e.kind), ['snapshot']);
  const before = h.posts.length;
  h.advance(PAD_LOG_SNAPSHOT_MS - 1);
  assert.equal(h.posts.length, before);
  // Too large for the server: skipped, never sent.
  h.b.snapshot('x'.repeat(64 * 1024 + 1), 'python');
  assert.equal(h.posts.length, before);
});

test('going away posts what waits as a last post, then takes nothing; a failed post is dropped quietly', async () => {
  const h = harness();
  h.failing();
  h.b.push(edit(1));
  h.advance(PAD_LOG_FLUSH_MS);
  await new Promise((r) => setImmediate(r));
  assert.equal(h.b.waiting, 0, 'a failed post is not kept or retried');
  h.b.push(edit(2));
  h.b.stop();
  assert.deepEqual(h.posts.at(-1), { events: [edit(2)], final: true });
  h.b.push(edit(3));
  h.advance(PAD_LOG_SNAPSHOT_MS);
  assert.equal(h.posts.length, 2);
});

test('every event the reporter makes passes the server\'s check (a candidate\'s paste reaches the panel\'s log as a paste)', () => {
  const at = Date.parse('2026-11-17T10:00:00.000Z');
  const events = [
    editEvent({ from: 3, inserted: 4, deleted: 1, length: 30, at }),
    pasteEvent({ characters: 240, lines: 9, from: 120, at, via: 'paste' }),
    pasteEvent({ characters: 12, lines: 1, from: 0, at, via: 'drop' }),
    languageEvent('go', at), insertEvent('q-two-sum', at), snapshotEvent('print(1)\n', 'python', at),
  ];
  const checked = checkPadPost({ events });
  assert.ok(checked, 'the server takes the post whole');
  assert.deepEqual(checked![1], { kind: 'paste', clientAt: '2026-11-17T10:00:00.000Z', from: 120, inserted: 240, lines: 9, via: 'paste' });
});

// The console said nothing a person could read.
//
// The worker ships `claude -p --output-format stream-json` straight through,
// so the panel was a wall of `{"type":"assistant","message":{"id":"msg_01…`.
// It was updating the whole time; nothing in it changed in a way anyone reads.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runLogLines, type LogEntry } from '../runLogLines.ts';

function chunk(seq: number, ...objects: unknown[]): LogEntry {
  return { seq, text: objects.map((o) => (typeof o === 'string' ? o : JSON.stringify(o))).join('\n') + '\n' };
}

test('no entries yields no lines', () => {
  assert.deepEqual(runLogLines(undefined), []);
  assert.deepEqual(runLogLines([]), []);
});

test('assistant text becomes the text itself', () => {
  const lines = runLogLines([
    chunk(0, { type: 'assistant', message: { content: [{ type: 'text', text: 'Reading the config.' }] } }),
  ]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.kind, 'text');
  assert.equal(lines[0]!.text, 'Reading the config.');
});

test('a tool call reads as the tool and its target, not as JSON', () => {
  const lines = runLogLines([
    chunk(0, { type: 'assistant', message: { content: [
      { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
      { type: 'tool_use', name: 'Read', input: { file_path: '/src/index.ts' } },
    ] } }),
  ]);
  assert.deepEqual(lines.map((l) => l.text), ['Bash  npm test', 'Read  /src/index.ts']);
  assert.ok(lines.every((l) => l.kind === 'tool'));
});

test('a tool result is one short line, and a failure says so', () => {
  const lines = runLogLines([
    chunk(0, { type: 'user', message: { content: [{ type: 'tool_result', content: 'x'.repeat(5000) }] } }),
    chunk(1, { type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: 'boom' }] } }),
  ]);
  assert.deepEqual(lines.map((l) => l.text), ['tool returned', 'tool failed']);
  assert.equal(lines[1]!.kind, 'error');
  // The point of the short line: a 5000-char result must not reach the tail.
  assert.ok(lines.every((l) => l.text.length < 40));
});

test('the init frame names the model and the directory', () => {
  const lines = runLogLines([
    chunk(0, { type: 'system', subtype: 'init', model: 'qwen', cwd: '/repos/app', session_id: 'abc' }),
  ]);
  assert.equal(lines[0]!.text, 'init · model qwen · cwd /repos/app');
});

test('the result frame reports outcome, duration, turns and any real cost', () => {
  const [ok] = runLogLines([
    chunk(0, { type: 'result', subtype: 'success', is_error: false, duration_ms: 12_400, num_turns: 3, total_cost_usd: 0.0215 }),
  ]);
  assert.equal(ok!.text, 'done · 12.4s · 3 turns · $0.0215');
  assert.equal(ok!.kind, 'result');
});

test('a zero cost is omitted, because a local run charges nothing', () => {
  const [line] = runLogLines([
    chunk(0, { type: 'result', subtype: 'success', duration_ms: 3000, num_turns: 1, total_cost_usd: 0 }),
  ]);
  assert.equal(line!.text, 'done · 3.0s · 1 turn');
});

test('an errored result says failed', () => {
  const [line] = runLogLines([chunk(0, { type: 'result', is_error: true, duration_ms: 900 })]);
  assert.equal(line!.text, 'failed · 0.9s');
});

test('an object split across two chunks still parses', () => {
  // This is the ordinary case, not an edge one: the worker ships whatever the
  // pipe hands it, and a frame is routinely cut mid-way.
  const whole = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'split across the wire' }] } });
  const cut = Math.floor(whole.length / 2);
  const lines = runLogLines([
    { seq: 0, text: whole.slice(0, cut) },
    { seq: 1, text: whole.slice(cut) + '\n' },
  ]);
  assert.deepEqual(lines.map((l) => l.text), ['split across the wire']);
});

test('chunks are ordered by seq, not by array position', () => {
  const lines = runLogLines([
    chunk(2, { type: 'assistant', message: { content: [{ type: 'text', text: 'third' }] } }),
    chunk(0, { type: 'assistant', message: { content: [{ type: 'text', text: 'first' }] } }),
    chunk(1, { type: 'assistant', message: { content: [{ type: 'text', text: 'second' }] } }),
  ]);
  assert.deepEqual(lines.map((l) => l.text), ['first', 'second', 'third']);
});

test('non-JSON output is shown verbatim rather than dropped', () => {
  const lines = runLogLines([
    { seq: 0, text: '[worker] job 1234\nnpm WARN deprecated\n' },
  ]);
  assert.deepEqual(lines.map((l) => l.text), ['[worker] job 1234', 'npm WARN deprecated']);
  assert.ok(lines.every((l) => l.kind === 'raw'));
});

test('a half-written trailing frame is skipped, not shown as a fragment', () => {
  const lines = runLogLines([
    chunk(0, { type: 'assistant', message: { content: [{ type: 'text', text: 'good' }] } }),
    { seq: 1, text: '{"type":"assis' },
  ]);
  assert.deepEqual(lines.map((l) => l.text), ['good']);
});

test('an unknown frame type is one short line, not its bytes', () => {
  const lines = runLogLines([chunk(0, { type: 'stream_event', payload: { a: 1, b: 2, c: 'x'.repeat(500) } })]);
  assert.deepEqual(lines.map((l) => l.text), ['stream_event']);
});

test('blank lines contribute nothing', () => {
  assert.deepEqual(runLogLines([{ seq: 0, text: '\n\n   \n' }]), []);
});

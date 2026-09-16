import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nodeLogLines } from '../nodeLogLines.ts';

test('an empty or missing entry list renders no lines', () => {
  assert.deepEqual(nodeLogLines(undefined), []);
  assert.deepEqual(nodeLogLines([]), []);
});

test('lines pass through verbatim — no frame format to parse, unlike runLogLines', () => {
  const lines = nodeLogLines([{ seq: 0, text: '12:00:00 · registered as connor-macbook' }]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.text, '12:00:00 · registered as connor-macbook');
  assert.equal(lines[0]!.id, 'n0');
});

test('reorders out-of-arrival entries by seq before rendering', () => {
  const lines = nodeLogLines([
    { seq: 2, text: 'third' },
    { seq: 0, text: 'first' },
    { seq: 1, text: 'second' },
  ]);
  assert.deepEqual(lines.map((l) => l.text), ['first', 'second', 'third']);
});

test('maps the worker level glyph — the second token — to a LogStream level', () => {
  const [err, warn, ok, step, info] = nodeLogLines([
    { seq: 0, text: '12:00:00 ✗ registration failed: 500' },
    { seq: 1, text: '12:00:01 ! presence: cannot reach the middleware' },
    { seq: 2, text: '12:00:02 ✓ registered' },
    { seq: 3, text: '12:00:03 → claude -p "do the thing"' },
    { seq: 4, text: '12:00:04 · polling for work every 10s' },
  ]);
  assert.equal(err!.level, 'error');
  assert.equal(warn!.level, 'warn');
  assert.equal(ok!.level, 'info');
  assert.equal(step!.level, 'info');
  assert.equal(info!.level, 'info');
});

test('a line with no recognizable glyph (an older worker, or a blank gap line) reads as info, not hidden', () => {
  const lines = nodeLogLines([{ seq: 0, text: '' }, { seq: 1, text: 'plain text with no stamp' }]);
  assert.equal(lines[0]!.level, 'info');
  assert.equal(lines[1]!.level, 'info');
});

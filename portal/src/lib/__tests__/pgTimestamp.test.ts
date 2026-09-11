import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePgTimestamp, parsePgTimestamp, parsePgTimestampAsUtc, pgTimestampMs } from '../pgTimestamp.ts';

test('a bare-hour offset is padded — the case V8 rejects outright', () => {
  // This is the whole bug: without the pad, Date() returns Invalid Date and
  // every caller fell back to rendering the raw database string.
  assert.equal(new Date('2026-09-08T08:19:23+00').getTime(), NaN);
  const d = parsePgTimestamp('2026-09-08 08:19:23+00');
  assert.notEqual(d, null);
  assert.equal(d!.toISOString(), '2026-09-08T08:19:23.000Z');
});

test('a non-UTC bare-hour offset keeps its sign and magnitude', () => {
  assert.equal(parsePgTimestamp('2026-09-08 08:19:23-05')!.toISOString(),
    '2026-09-08T13:19:23.000Z');
});

test('already-valid forms are left alone', () => {
  for (const s of ['2026-09-08T08:19:23Z', '2026-09-08T08:19:23+00:00', '2026-09-08T08:19:23.500Z']) {
    assert.equal(parsePgTimestamp(s)!.toISOString().slice(0, 19), '2026-09-08T08:19:23');
    assert.equal(normalizePgTimestamp(s), s);
  }
});

test('unparseable input is null, never an Invalid Date', () => {
  assert.equal(parsePgTimestamp('not a timestamp'), null);
  assert.equal(parsePgTimestamp(''), null);
  assert.equal(parsePgTimestamp(null), null);
  assert.equal(parsePgTimestamp(undefined), null);
  assert.ok(Number.isNaN(pgTimestampMs('not a timestamp')));
});

test('pgTimestampMs agrees with parsePgTimestamp', () => {
  assert.equal(pgTimestampMs('2026-09-08 08:19:23+00'),
    parsePgTimestamp('2026-09-08 08:19:23+00')!.getTime());
});


// The bug had a twin: the "fix" that shipped everywhere appended `Z` whenever
// the string had no `T`, which is exactly when it also has a `+00`. Guard the
// UTC-assuming entry point against re-introducing it.
test('parsePgTimestampAsUtc never appends Z to a stamp that already names a zone', () => {
  assert.equal(parsePgTimestampAsUtc('2026-09-08 08:19:23+00')!.toISOString(),
    '2026-09-08T08:19:23.000Z');
  assert.equal(parsePgTimestampAsUtc('2026-09-08 08:19:23-05')!.toISOString(),
    '2026-09-08T13:19:23.000Z');
  // ...and still assumes UTC when nothing names one.
  assert.equal(parsePgTimestampAsUtc('2026-09-08 08:19:23')!.toISOString(),
    '2026-09-08T08:19:23.000Z');
  assert.equal(parsePgTimestampAsUtc(null), null);
});

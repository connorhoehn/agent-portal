// Run with:  cd portal && node --test 'src/pages/iq/__tests__/*.test.ts'

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  countTelemetryLines, ms, readable, toLogLevel, visibleLogLines, when,
} from '../agentDetailFormat.ts';

test('ms formats sub-second durations in ms and longer ones in seconds', () => {
  assert.equal(ms(null), '—');
  assert.equal(ms(undefined), '—');
  assert.equal(ms(0), '—');
  assert.equal(ms(482), '482 ms');
  assert.equal(ms(2500), '2.5 s');
});

test('when buckets a timestamp into just-now / minutes / hours / calendar', () => {
  const now = Date.now();
  assert.equal(when(null), '—');
  assert.equal(when(new Date(now - 10_000).toISOString()), 'just now');
  assert.equal(when(new Date(now - 5 * 60_000).toISOString()), '5m ago');
  assert.equal(when(new Date(now - 3 * 3_600_000).toISOString()), '3h ago');
});

test('readable lifts the body out of an OTel envelope and keeps a raw line as-is', () => {
  assert.deepEqual(readable('plain stdout line'), { level: null, text: 'plain stdout line' });
  assert.deepEqual(
    readable('{"body":"agent started","severityText":"INFO"}'),
    { level: 'INFO', text: 'agent started' },
  );
  assert.deepEqual(
    readable('{"resourceSpans":[]}'),
    { level: 'TRACE', text: '(telemetry span export)' },
  );
  // Malformed JSON that merely starts with "{" is not a parse crash.
  assert.deepEqual(readable('{not json'), { level: null, text: '{not json' });
});

test('visibleLogLines drops the raw stdout duplicate of a parsed envelope line', () => {
  const events = [
    { at: '1', message: '{"body":"agent started up cleanly","severityText":"INFO"}' },
    { at: '2', message: 'agent started up cleanly trace_id=abc span_id=def' },
    { at: '3', message: '{"resourceSpans":[]}' },
  ];
  const withTelemetry = visibleLogLines(events, false);
  assert.equal(withTelemetry.length, 2); // the raw duplicate of line 1 is dropped either way
  assert.deepEqual(withTelemetry.map((l) => l.level), ['INFO', 'TRACE']);

  const hidden = visibleLogLines(events, true);
  assert.deepEqual(hidden.map((l) => l.level), ['INFO']);
});

test('countTelemetryLines counts only span-export lines', () => {
  const events = [
    { at: '1', message: '{"body":"ok","severityText":"INFO"}' },
    { at: '2', message: '{"resourceSpans":[]}' },
    { at: '3', message: '{"scopeSpans":[]}' },
  ];
  assert.equal(countTelemetryLines(events), 2);
});

test('toLogLevel maps envelope severities onto the LogStream level enum', () => {
  assert.equal(toLogLevel('ERROR'), 'error');
  assert.equal(toLogLevel('WARN'), 'warn');
  assert.equal(toLogLevel('WARNING'), 'warn');
  assert.equal(toLogLevel('INFO'), 'info');
  assert.equal(toLogLevel('DEBUG'), 'debug');
  assert.equal(toLogLevel('TRACE'), 'debug');
  assert.equal(toLogLevel(null), undefined);
  assert.equal(toLogLevel('WEIRD'), undefined);
});

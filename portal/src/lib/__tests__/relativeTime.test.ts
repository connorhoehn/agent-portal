import { test } from 'node:test';
import assert from 'node:assert/strict';
import { absoluteTime, durationLabel, relativeTime, relativeTimeSeconds } from '../relativeTime.ts';

test('relativeTime buckets by age and echoes the raw string when unparseable', () => {
  const now = Date.now();
  assert.equal(relativeTime(new Date(now - 30_000).toISOString()), 'just now');
  assert.equal(relativeTime(new Date(now - 5 * 60_000).toISOString()), '5m ago');
  assert.equal(relativeTime(new Date(now - 3 * 3_600_000).toISOString()), '3h ago');
  assert.equal(relativeTime(new Date(now - 2 * 86_400_000).toISOString()), '2d ago');
  assert.equal(relativeTime(null), '');
  assert.equal(relativeTime(undefined), '');
  assert.equal(relativeTime('not a timestamp'), 'not a timestamp');
});

test('relativeTimeSeconds drops to second resolution under a minute', () => {
  const now = Date.now();
  assert.equal(relativeTimeSeconds(new Date(now - 8_000).toISOString()), '8s ago');
  assert.equal(relativeTimeSeconds(new Date(now - 5 * 60_000).toISOString()), '5m ago');
  assert.equal(relativeTimeSeconds(null), '');
});

test('absoluteTime renders the local clock, or an em dash for nothing parseable', () => {
  const iso = '2026-09-08 08:19:23+00';
  assert.equal(absoluteTime(iso), new Date('2026-09-08T08:19:23.000Z').toLocaleString());
  assert.equal(absoluteTime(null), '—');
  assert.equal(absoluteTime(undefined), '—');
  assert.equal(absoluteTime('not a timestamp'), '—');
});

test('durationLabel scales units and treats non-positive as unmeasured', () => {
  assert.equal(durationLabel(140), '140ms');
  assert.equal(durationLabel(1800), '1.8s');
  assert.equal(durationLabel(200_000), '3m 20s');
  assert.equal(durationLabel(0), '—');
  assert.equal(durationLabel(-5), '—');
  assert.equal(durationLabel(null), '—');
  assert.equal(durationLabel(undefined), '—');
});

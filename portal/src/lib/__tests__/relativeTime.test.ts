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

test('relativeTime reads a future instant forwards, symmetric with the past', () => {
  const now = Date.now();
  // Under two minutes either way is "just now" (clock skew on a fresh write).
  assert.equal(relativeTime(new Date(now + 30_000).toISOString()), 'just now');
  assert.equal(relativeTime(new Date(now + 5 * 60_000 + 1_000).toISOString()), 'in 5m');
  assert.equal(relativeTime(new Date(now + 3 * 3_600_000 + 1_000).toISOString()), 'in 3h');
  assert.equal(relativeTime(new Date(now + 2 * 86_400_000 + 1_000).toISOString()), 'in 2d');
  // A week or more ahead is a calendar date, as it is a week or more back —
  // an access grant expiring in 30 days reads "Nov 12, 2026", never "just now".
  const month = new Date(now + 30 * 86_400_000);
  assert.equal(
    relativeTime(month.toISOString()),
    month.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
  );
  const monthAgo = new Date(now - 30 * 86_400_000);
  assert.equal(
    relativeTime(monthAgo.toISOString()),
    monthAgo.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
  );
});

test('relativeTime reads a zone-less server stamp as UTC, so a recent one never reads as future', () => {
  const now = Date.now();
  const naive = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '');
  assert.equal(relativeTime(naive(now)), 'just now');
  assert.equal(relativeTime(naive(now - 3 * 3_600_000 - 1_000)), '3h ago');
  assert.equal(relativeTime(naive(now + 3 * 3_600_000 + 1_000)), 'in 3h');
  // Postgres's own `+00` offset still parses as that offset.
  assert.equal(relativeTime(`${naive(now - 5 * 60_000 - 1_000).slice(0, 19)}+00`), '5m ago');
});

test('relativeTimeSeconds drops to second resolution under a minute', () => {
  const now = Date.now();
  assert.equal(relativeTimeSeconds(new Date(now - 8_000).toISOString()), '8s ago');
  assert.equal(relativeTimeSeconds(new Date(now - 5 * 60_000).toISOString()), '5m ago');
  assert.equal(relativeTimeSeconds(new Date(now + 3 * 3_600_000 + 1_000).toISOString()), 'in 3h');
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

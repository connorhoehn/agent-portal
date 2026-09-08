// Run with:  cd portal && node --test 'src/components/chat/__tests__/*.test.ts'

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { describeTurnError, extractServerDetail } from '../turnError.ts';

// ─── describeTurnError ───────────────────────────────────────────────────────

test('a 503 with a JSON error body reads as the real status and the real detail', () => {
  const body = JSON.stringify({ error: 'authorization unavailable', action: 'ManageIngest' });
  assert.equal(
    describeTurnError(503, body),
    'The agent is unavailable (503) — authorization unavailable',
  );
});

test('never hard-codes 500 for a different real status (DEFECTS.md program-owner #5)', () => {
  const msg = describeTurnError(503, null);
  assert.ok(msg.includes('503'), msg);
  assert.ok(!msg.includes('500'), msg);
});

test('a 403 with a Forbidden body names the real reason', () => {
  const body = JSON.stringify({ error: 'Forbidden', requiredTenant: 'assessment', agentId: 'orgiq-supervisor' });
  assert.equal(
    describeTurnError(403, body),
    "You don't have permission for this (403) — Forbidden",
  );
});

test('an unknown status still names itself honestly, without inventing a label', () => {
  assert.equal(describeTurnError(418, null), 'The request failed (418)');
});

test('no body means no dash and no invented detail', () => {
  assert.equal(describeTurnError(503, undefined), 'The agent is unavailable (503)');
  assert.equal(describeTurnError(503, ''), 'The agent is unavailable (503)');
});

test('a non-JSON body is still surfaced as text, not dropped', () => {
  assert.equal(
    describeTurnError(502, 'upstream connect error or disconnect/reset before headers'),
    'The agent gateway had a bad response (502) — upstream connect error or disconnect/reset before headers',
  );
});

test('status 0 (or non-finite) means the request never reached a server — no fabricated status number', () => {
  assert.equal(describeTurnError(0), 'Could not reach the agent — check your connection and retry.');
  assert.equal(describeTurnError(Number.NaN), 'Could not reach the agent — check your connection and retry.');
});

test('a very long server detail is truncated, not left to blow up the banner', () => {
  const long = 'x'.repeat(500);
  const msg = describeTurnError(500, JSON.stringify({ error: long }));
  assert.ok(msg.length < 300, `expected truncation, got length ${msg.length}`);
  assert.ok(msg.endsWith('…'));
});

// ─── extractServerDetail ─────────────────────────────────────────────────────

test('extractServerDetail prefers `error`, then `message`, `detail`, `reason`', () => {
  assert.equal(extractServerDetail(JSON.stringify({ error: 'e', message: 'm' })), 'e');
  assert.equal(extractServerDetail(JSON.stringify({ message: 'm', detail: 'd' })), 'm');
  assert.equal(extractServerDetail(JSON.stringify({ reason: 'r' })), 'r');
});

test('extractServerDetail says nothing for valid JSON with no known field', () => {
  assert.equal(extractServerDetail(JSON.stringify({ ok: false })), undefined);
});

test('extractServerDetail says nothing for an empty or missing body', () => {
  assert.equal(extractServerDetail(undefined), undefined);
  assert.equal(extractServerDetail(''), undefined);
  assert.equal(extractServerDetail('   '), undefined);
});

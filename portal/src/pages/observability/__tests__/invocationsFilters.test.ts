import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyFiltersToParams,
  firstSentence,
  parseAgentFilter,
  parseStatusFilter,
  STATUS_VALUES,
} from '../invocationsFilters.ts';

test('parseAgentFilter defaults to all with no params', () => {
  assert.equal(parseAgentFilter(new URLSearchParams()), 'all');
});

test('parseAgentFilter honours agentId (Architecture graph, agent detail page)', () => {
  assert.equal(parseAgentFilter(new URLSearchParams('agentId=Search')), 'Search');
});

test('parseAgentFilter honours agent as an alias (Health copy)', () => {
  assert.equal(parseAgentFilter(new URLSearchParams('agent=Ingestion')), 'Ingestion');
});

test('parseAgentFilter prefers agentId when both are present', () => {
  assert.equal(parseAgentFilter(new URLSearchParams('agentId=Search&agent=Ingestion')), 'Search');
});

test('parseStatusFilter defaults to all with no params', () => {
  assert.equal(parseStatusFilter(new URLSearchParams()), 'all');
});

test('parseStatusFilter honours a valid status', () => {
  assert.equal(parseStatusFilter(new URLSearchParams('status=error')), 'error');
  assert.equal(parseStatusFilter(new URLSearchParams('status=blocked')), 'blocked');
});

test('parseStatusFilter falls back to all on an unknown value', () => {
  assert.equal(parseStatusFilter(new URLSearchParams('status=bogus')), 'all');
});

test('STATUS_VALUES covers exactly the four statuses the page filters on', () => {
  assert.deepEqual(STATUS_VALUES, ['all', 'ok', 'blocked', 'error']);
});

test('firstSentence cuts at the sentence boundary, not mid-word', () => {
  assert.equal(
    firstSentence('S3 GetObject failed: NoSuchKey confluence/auth-migration-prd.pdf. Retry exhausted after 3 attempts.'),
    'S3 GetObject failed: NoSuchKey confluence/auth-migration-prd.pdf.',
  );
});

test('firstSentence returns the whole string when it has no sentence end and fits', () => {
  assert.equal(firstSentence('A2A timeout invoking orgiq-scoring after 4500ms'), 'A2A timeout invoking orgiq-scoring after 4500ms');
});

test('firstSentence falls back to a word-boundary cut with an ellipsis past maxLen, never mid-word', () => {
  const long = 'a'.repeat(50) + ' ' + 'b'.repeat(50) + ' ' + 'c'.repeat(50);
  const result = firstSentence(long, 60);
  assert.equal(result, 'a'.repeat(50) + '…');
  assert.ok(result.length <= 61);
});

// applyFiltersToParams — the write side of the filter contract (DEFECTS.md
// #26): whatever parseAgentFilter/parseStatusFilter would read back out of
// the result must equal what was just written, so the URL never disagrees
// with the view again.

test('applyFiltersToParams sets agentId and status when both filters are active', () => {
  const next = applyFiltersToParams(new URLSearchParams(), 'orgiq-scoring', 'error');
  assert.equal(next.get('agentId'), 'orgiq-scoring');
  assert.equal(next.get('status'), 'error');
});

test('applyFiltersToParams clears both params when both filters are "all" (Clear filters)', () => {
  const start = new URLSearchParams('status=error&agent=orgiq-scoring');
  const next = applyFiltersToParams(start, 'all', 'all');
  assert.equal(next.has('agentId'), false);
  assert.equal(next.has('agent'), false);
  assert.equal(next.has('status'), false);
  assert.equal(next.toString(), '');
});

test('applyFiltersToParams drops the legacy `agent` alias once read, replacing it with `agentId`', () => {
  const next = applyFiltersToParams(new URLSearchParams('agent=orgiq-scoring'), 'orgiq-scoring', 'all');
  assert.equal(next.has('agent'), false);
  assert.equal(next.get('agentId'), 'orgiq-scoring');
});

test('applyFiltersToParams preserves unrelated params', () => {
  const next = applyFiltersToParams(new URLSearchParams('foo=bar'), 'all', 'ok');
  assert.equal(next.get('foo'), 'bar');
  assert.equal(next.get('status'), 'ok');
});

test('applyFiltersToParams round-trips through parseAgentFilter/parseStatusFilter', () => {
  const next = applyFiltersToParams(new URLSearchParams(), 'orgiq-ingestion', 'blocked');
  assert.equal(parseAgentFilter(next), 'orgiq-ingestion');
  assert.equal(parseStatusFilter(next), 'blocked');
});

// Run with:  cd portal && node --test 'src/lib/__tests__/format.test.ts'

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { usd, formatTokenCount } from '../format.ts';

test('usd: default 2dp with thousands separators', () => {
  assert.equal(usd(15), '$15.00');
  assert.equal(usd(1234.56), '$1,234.56');
  assert.equal(usd(0), '$0.00');
});

test('usd: 4dp precision option, still thousands-separated', () => {
  assert.equal(usd(0.1234, { precision: 4 }), '$0.1234');
  assert.equal(usd(1234.5, { precision: 4 }), '$1,234.5000');
});

test('usd: null/undefined/non-finite read as an em dash, never $0.00', () => {
  assert.equal(usd(null), '—');
  assert.equal(usd(undefined), '—');
  assert.equal(usd(Number.NaN), '—');
});

test('formatTokenCount: full count by default, thousands-separated', () => {
  assert.equal(formatTokenCount(1234), '1,234');
  assert.equal(formatTokenCount(42), '42');
  assert.equal(formatTokenCount(0), '0');
});

test('formatTokenCount: compact mode', () => {
  assert.equal(formatTokenCount(999, { compact: true }), '999');
  assert.equal(formatTokenCount(1234, { compact: true }), '1.2k');
  assert.equal(formatTokenCount(125_000, { compact: true }), '125.0k');
});

test('formatTokenCount: null/undefined/non-finite read as an em dash', () => {
  assert.equal(formatTokenCount(null), '—');
  assert.equal(formatTokenCount(undefined), '—');
  assert.equal(formatTokenCount(Number.NaN), '—');
});

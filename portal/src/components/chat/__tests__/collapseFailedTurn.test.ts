import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collapseFailedTurn } from '../collapseFailedTurn.ts';

const u = (content: string) => ({ role: 'user' as const, content });
const a = (content: string) => ({ role: 'assistant' as const, content });

test('drops the failed copy when the same turn was retried back to back', () => {
  const out = collapseFailedTurn([u('hi'), a('hello'), u('who?'), u('who?')], 'who?', true);
  assert.deepEqual(out.map((m) => m.content), ['hi', 'hello', 'who?']);
});

test('leaves a repeated question alone when an answer sits between', () => {
  const msgs = [u('who?'), a('Ada'), u('who?')];
  assert.deepEqual(collapseFailedTurn(msgs, 'who?', true), msgs);
});

test('does nothing before a retry or without a failed turn', () => {
  const msgs = [u('who?'), u('who?')];
  assert.deepEqual(collapseFailedTurn(msgs, 'who?', false), msgs);
  assert.deepEqual(collapseFailedTurn(msgs, null, true), msgs);
});

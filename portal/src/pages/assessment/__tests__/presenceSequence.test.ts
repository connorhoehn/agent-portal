import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextPresenceSequence } from '../knowledge/presenceSequence.ts';

test('presence commands remain ordered within one clock tick and above a persisted reload sequence', () => {
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  const stored = new Map<string, string>();
  const key = 'assessment.knowledge.presenceSequence';
  const future = Date.now() * 1000 + 100_000;
  stored.set(key, String(future));
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => stored.set(k, v) } });
  try {
    const first = nextPresenceSequence();
    const second = nextPresenceSequence();
    assert.ok(first > future);
    assert.equal(second, first + 1);
    assert.equal(stored.get(key), String(second));
  } finally {
    if (prior) Object.defineProperty(globalThis, 'sessionStorage', prior);
    else Reflect.deleteProperty(globalThis, 'sessionStorage');
  }
});

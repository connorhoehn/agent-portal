// Run with:  cd portal && node --test --experimental-strip-types 'src/hooks/__tests__/*.test.ts'
//
// createDebouncer is the pure timer logic behind useDebouncedSearch.ts — see
// useFetch.test.ts's header for why the React half is not exercised here.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDebouncer } from '../debounce.ts';

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('trigger calls fn once, after the delay, with the triggered value', async () => {
  const calls: string[] = [];
  const d = createDebouncer<string>((v) => calls.push(v), 20);
  d.trigger('a');
  assert.deepEqual(calls, []); // not yet — still waiting
  await wait(40);
  assert.deepEqual(calls, ['a']);
});

test('a second trigger before the delay elapses resets the timer — only the LAST value fires', async () => {
  const calls: string[] = [];
  const d = createDebouncer<string>((v) => calls.push(v), 20);
  d.trigger('a');
  await wait(10);
  d.trigger('b'); // resets the 20ms window
  await wait(10);
  assert.deepEqual(calls, []); // the reset window hasn't elapsed yet
  await wait(15);
  assert.deepEqual(calls, ['b']);
});

test('cancel prevents a pending call from ever firing', async () => {
  const calls: string[] = [];
  const d = createDebouncer<string>((v) => calls.push(v), 20);
  d.trigger('a');
  d.cancel();
  await wait(40);
  assert.deepEqual(calls, []);
});

test('cancel with nothing pending is a no-op, not a throw', () => {
  const d = createDebouncer<string>(() => { throw new Error('must not fire'); }, 20);
  assert.doesNotThrow(() => d.cancel());
});

test('repeated rapid triggers collapse to one call, not one per keystroke', async () => {
  const calls: string[] = [];
  const d = createDebouncer<string>((v) => calls.push(v), 15);
  for (const ch of ['o', 'or', 'org', 'orgi', 'orgiq']) {
    d.trigger(ch);
    await wait(5); // faster than the debounce window — simulates fast typing
  }
  await wait(30);
  assert.deepEqual(calls, ['orgiq']);
});

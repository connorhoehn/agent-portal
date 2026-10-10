import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimDeepLinkPrompt, createTurnGate } from '../turnGate.ts';

test('one turn at a time: a second send while one streams is refused until it ends', () => {
  const gate = createTurnGate();
  const first = gate.tryBegin();
  assert.notEqual(first, null);
  assert.equal(gate.tryBegin(), null);
  assert.equal(gate.busy(), true);
  gate.end(first!);
  assert.equal(gate.busy(), false);
  assert.notEqual(gate.tryBegin(), null);
});

test('an abandoned stream frees the gate, and its late end does not free the next turn', () => {
  const gate = createTurnGate();
  const aborted = gate.tryBegin()!;
  gate.release(); // new session: reset() aborted the stream
  const next = gate.tryBegin()!;
  gate.end(aborted); // the aborted promise settles afterwards
  assert.equal(gate.busy(), true);
  gate.end(next);
  assert.equal(gate.busy(), false);
});

// The effect fires on mount, again under StrictMode's double invoke, and
// again when the org graph lands — all before the router's transition strips
// `?prompt=`. Exactly one of those may ask.
test('a deep-link prompt is asked once per history entry, however often the effect runs', () => {
  const ledger = new Set<string>();
  const runs = ['mount', 'strict-mode re-run', 'graph resolved', 'session minted'].map(() => claimDeepLinkPrompt('k1', 'Explain this guide', ledger));
  assert.deepEqual(runs, [true, false, false, false]);
  assert.equal(claimDeepLinkPrompt('k1', null, ledger), false);
  // A new navigation carrying the same prompt is a new entry: a deliberate ask.
  assert.equal(claimDeepLinkPrompt('k2', 'Explain this guide', ledger), true);
  assert.equal(claimDeepLinkPrompt('k2', 'Something else', ledger), true);
});

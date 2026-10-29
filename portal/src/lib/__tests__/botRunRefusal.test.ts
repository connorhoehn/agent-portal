import { test } from 'node:test';
import assert from 'node:assert/strict';
import { botRunRefusalMessage } from '../dispatchGates.ts';

test('an allocation 409 from a manual run reads like the deck, without the API flag', () => {
  const msg = botRunRefusalMessage({
    error: "this initiative's $50.00 allocation is exhausted ($52.00 spent) — raise the allocation or pass confirmOverAllocation",
    gate: 'allocation', confirmFlag: 'confirmOverAllocation',
    allocation: { allocatedUsd: 50, spentUsd: 52, remainingUsd: -2 },
  }, 'fallback');
  assert.match(msg, /\$52\.00 of \$50\.00 is already spent/);
  assert.doesNotMatch(msg, /confirmOver/);
});

test('an envelope 409 carries the attribution caveat', () => {
  const msg = botRunRefusalMessage({
    error: 'x — pass confirmOverEnvelope', gate: 'envelope',
    envelope: { allocatedUsd: 30, attributedSpentUsd: 31, remainingUsd: -1, attributionAvailable: true, sprintName: 'Sprint 98' },
  }, 'fallback');
  assert.match(msg, /recorded as spent by you/);
  assert.doesNotMatch(msg, /confirmOver/);
});

test('a plain refusal keeps the claim; no body falls back', () => {
  assert.equal(botRunRefusalMessage({ error: 'daily run cap reached — wait' }, 'fb'), 'daily run cap reached');
  assert.equal(botRunRefusalMessage(null, 'fb'), 'fb');
});

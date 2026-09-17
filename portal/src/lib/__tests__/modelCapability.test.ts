// Run with:  cd portal && node --test 'src/lib/__tests__/*.test.ts'
//
// A machine announces the models it can run, and the fleet table printed the
// raw strings. The question in front of that table is "can this machine take
// the hard job?", so every id has to resolve to a tier — across the three
// spellings the same model arrives in.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  tierFor,
  labelFor,
  capabilitiesFor,
  bestTier,
  TIERS,
} from '../modelCapability.ts';

test('bare Anthropic ids resolve to a tier', () => {
  assert.equal(tierFor('claude-opus-5'), 'deep');
  assert.equal(tierFor('claude-sonnet-5'), 'balanced');
  assert.equal(tierFor('claude-haiku-4-5'), 'quick');
});

test('Bedrock inference-profile ids resolve to the same tier', () => {
  // The same model reaches this table as `claude-sonnet-5` from a paired
  // laptop and `us.anthropic.claude-sonnet-5` from a devbox.
  assert.equal(tierFor('us.anthropic.claude-sonnet-5'), 'balanced');
  assert.equal(tierFor('eu.anthropic.claude-opus-4-8'), 'deep');
  assert.equal(tierFor('us.anthropic.claude-haiku-4-5-20251001-v1:0'), 'quick');
});

test('a bare anthropic. prefix resolves too', () => {
  assert.equal(tierFor('anthropic.claude-opus-5'), 'deep');
});

test('a new point release does not fall off the ladder', () => {
  // Matching is on family, so a version bump keeps its tier.
  assert.equal(tierFor('claude-sonnet-6'), 'balanced');
  assert.equal(tierFor('claude-opus-9-1'), 'deep');
});

test('on-device families are their own tier, not guessed as quick', () => {
  for (const id of ['llama3.1:8b', 'mistral:7b', 'qwen2.5-coder:32b', 'gemma2:9b']) {
    assert.equal(tierFor(id), 'local', id);
  }
});

test('an unrecognised id says so rather than guessing', () => {
  assert.equal(tierFor('some-inhouse-model'), 'unknown');
});

test('labels keep the version so two Sonnets stay distinguishable', () => {
  assert.equal(labelFor('claude-sonnet-5'), 'Sonnet 5');
  assert.equal(labelFor('us.anthropic.claude-opus-4-8'), 'Opus 4.8');
});

test('a local model keeps the id it announced, size and all', () => {
  // `llama3.1:8b` already tells you what you need; prettifying loses the 8b.
  assert.equal(labelFor('llama3.1:8b'), 'llama3.1:8b');
});

test('capabilities come back strongest first', () => {
  const caps = capabilitiesFor(['claude-haiku-4-5', 'claude-opus-5', 'claude-sonnet-5']);
  assert.deepEqual(caps.map((c) => c.tier), ['deep', 'balanced', 'quick']);
});

test('a duplicate announcement is listed once', () => {
  const caps = capabilitiesFor(['claude-sonnet-5', 'claude-sonnet-5']);
  assert.equal(caps.length, 1);
});

test('bestTier is the ceiling, which is what decides where the hard job goes', () => {
  assert.equal(bestTier(['claude-haiku-4-5', 'claude-opus-5']), 'deep');
  assert.equal(bestTier(['claude-haiku-4-5']), 'quick');
});

test('a machine that announced nothing has no ceiling', () => {
  assert.equal(bestTier([]), null);
});

test('every tier says what it takes on', () => {
  for (const info of Object.values(TIERS)) {
    assert.ok(info.name.length > 0, 'name');
    assert.ok(info.takesOn.length > 20, `takesOn for ${info.tier}`);
  }
});

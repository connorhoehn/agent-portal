// Run with:  cd portal && node --test 'src/lib/__tests__/*.test.ts'
//
// The "Assign work" empty state suggests work that suits the machine's tier.
// A tier with no ideas renders a heading and then nothing, which is worse than
// the grey line it replaced — so the map has to stay exhaustive as tiers change.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TIERS, TIER_IDEAS } from '../modelCapability.ts';

test('every tier has at least one thing to suggest', () => {
  for (const tier of Object.keys(TIERS)) {
    const ideas = TIER_IDEAS[tier as keyof typeof TIER_IDEAS];
    assert.ok(Array.isArray(ideas) && ideas.length > 0, `no ideas for ${tier}`);
  }
});

test('the ideas are phrased as work, not as labels', () => {
  for (const [tier, ideas] of Object.entries(TIER_IDEAS)) {
    for (const idea of ideas) {
      assert.ok(idea.length > 25, `too terse for ${tier}: ${idea}`);
      assert.ok(!idea.endsWith('.'), `should read as a list item, not a sentence: ${idea}`);
    }
  }
});

test('no tier is described with the same idea as another', () => {
  const all = Object.values(TIER_IDEAS).flat();
  assert.equal(new Set(all).size, all.length, 'duplicate suggestion across tiers');
});

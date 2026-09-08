// Run with:  cd portal && node --test 'src/components/scores/__tests__/*.test.ts'
//
// Plain node:test — pure module, no JSX, no DOM.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeReweighted, filterSkillSuggestions, formatScore } from '../scoresFormat.ts';

test('formatScore: a fraction in (0,1) is read as a percent and scaled up', () => {
  assert.equal(formatScore(0.93), 93);
  assert.equal(formatScore(0.5), 50);
});

test('formatScore: a value already >= 1 is left as a 0-100 score', () => {
  assert.equal(formatScore(47), 47);
  assert.equal(formatScore(1), 1);
  assert.equal(formatScore(94.35), 94);
});

test('formatScore: zero is zero either way', () => {
  assert.equal(formatScore(0), 0);
});

test('formatScore: rounds to the nearest integer', () => {
  assert.equal(formatScore(0.965), 97);
  assert.equal(formatScore(93.6), 94);
});

test('computeReweighted: normalizes 0-1 inputs (mock scale) to a 0-100 composite', () => {
  const out = computeReweighted([{ influence: 0.93, expertise: 0.96 }], 0.55);
  assert.equal(out[0].composite, formatScore(0.55 * 93 + 0.45 * 96));
});

test('computeReweighted: weight=1 ranks purely by influence', () => {
  const out = computeReweighted(
    [
      { influence: 10, expertise: 90 },
      { influence: 80, expertise: 5 },
    ],
    1,
  );
  assert.deepEqual(out.map(e => e.composite), [80, 10]);
});

test('computeReweighted: weight=0 ranks purely by expertise', () => {
  const out = computeReweighted(
    [
      { influence: 10, expertise: 90 },
      { influence: 80, expertise: 5 },
    ],
    0,
  );
  assert.deepEqual(out.map(e => e.composite), [90, 5]);
});

test('computeReweighted: blends and rounds at 0.5', () => {
  const out = computeReweighted([{ influence: 50, expertise: 51 }], 0.5);
  assert.equal(out[0].composite, Math.round(0.5 * 50 + 0.5 * 51));
});

test('computeReweighted: sorts descending by the computed composite, not input order', () => {
  const out = computeReweighted(
    [
      { influence: 1, expertise: 1 },
      { influence: 99, expertise: 99 },
      { influence: 50, expertise: 50 },
    ],
    0.55,
  );
  assert.deepEqual(out.map(e => e.composite), [99, 50, 1]);
});

test('computeReweighted: preserves the rest of each entry', () => {
  const out = computeReweighted([{ influence: 10, expertise: 10, personId: 'p-1' }], 0.5);
  assert.equal(out[0].personId, 'p-1');
});

test('filterSkillSuggestions: empty query returns the first `limit` skills unfiltered', () => {
  const skills = [{ name: 'Rust' }, { name: 'Go' }, { name: 'Python' }];
  assert.deepEqual(filterSkillSuggestions(skills, '', 2), [{ name: 'Rust' }, { name: 'Go' }]);
});

test('filterSkillSuggestions: substring match is case-insensitive', () => {
  const skills = [{ name: 'Kubernetes' }, { name: 'Terraform' }];
  assert.deepEqual(filterSkillSuggestions(skills, 'KUBER'), [{ name: 'Kubernetes' }]);
});

test('filterSkillSuggestions: no match returns an empty array, not the unfiltered list', () => {
  const skills = [{ name: 'Kubernetes' }, { name: 'Terraform' }];
  assert.deepEqual(filterSkillSuggestions(skills, 'zzznoexistskill'), []);
});

test('filterSkillSuggestions: respects the limit', () => {
  const skills = [{ name: 'a1' }, { name: 'a2' }, { name: 'a3' }];
  assert.equal(filterSkillSuggestions(skills, 'a', 2).length, 2);
});

test('filterSkillSuggestions: empty skill list never throws', () => {
  assert.deepEqual(filterSkillSuggestions([], 'anything'), []);
});

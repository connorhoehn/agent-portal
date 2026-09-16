import { test } from 'node:test';
import assert from 'node:assert/strict';
import { confidenceValue, evidenceClassOf, evidenceCoverage, railTracks } from '../assessmentFormat.ts';

const dim = (over: Record<string, unknown>) => ({
  is_na: false, current_level: 3, certification: { verified_level: 3, claimed_level: 3, basis: 'documented' }, ...over,
}) as never;

test('evidenceClassOf maps the wire basis onto the three classes', () => {
  assert.equal(evidenceClassOf(dim({ certification: { verified_level: 3, claimed_level: 3, basis: 'self-attested' } })), 'attested');
  assert.equal(evidenceClassOf(dim({})), 'documented');
  assert.equal(evidenceClassOf(dim({ certification: { verified_level: 3, claimed_level: 3, basis: 'verified' } })), 'observed');
});

test('evidenceClassOf: N/A wins, and a level with no basis is attested (the team\'s word)', () => {
  assert.equal(evidenceClassOf(dim({ is_na: true })), 'na');
  assert.equal(evidenceClassOf(dim({ certification: undefined })), 'attested');
  assert.equal(evidenceClassOf(dim({ certification: undefined, current_level: null })), 'unassessed');
  // The wire's pending shape: basis self-attested, no level on either track.
  assert.equal(evidenceClassOf(dim({ current_level: null, certification: { verified_level: null, claimed_level: null, basis: 'self-attested', status: 'pending' } })), 'unassessed');
});

test('evidenceCoverage counts every dimension exactly once', () => {
  const counts = evidenceCoverage([
    dim({}), dim({ is_na: true }), dim({ certification: { verified_level: 1, claimed_level: 4, basis: 'self-attested' } }),
    dim({ certification: undefined, current_level: null }),
  ]);
  assert.deepEqual(counts, { attested: 1, documented: 1, observed: 0, na: 1, unassessed: 1 });
  assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), 4);
});

test('railTracks reads both tracks and flags an open claim', () => {
  const t = railTracks(dim({ certification: { verified_level: 2, claimed_level: 5, basis: 'self-attested', status: 'claim_open' } }));
  assert.equal(t.verified, '2');
  assert.equal(t.claimed, '5');
  assert.equal(t.claimOpen, true);
  assert.deepEqual(railTracks(dim({ is_na: true, certification: undefined })), { claimed: '', verified: 'na', claimOpen: false });
  assert.deepEqual(railTracks(dim({ certification: undefined, current_level: null })), { claimed: '', verified: '', claimOpen: false });
});

test('confidenceValue is three dots: low, moderate, high', () => {
  assert.equal(confidenceValue('low'), 1 / 3);
  assert.equal(confidenceValue('moderate'), 2 / 3);
  assert.equal(confidenceValue('HIGH'), 1);
  assert.equal(confidenceValue('unknown'), 0);
});

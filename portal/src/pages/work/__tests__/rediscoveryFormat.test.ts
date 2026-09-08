// Run with:  cd portal && node --test 'src/pages/work/__tests__/*.test.ts'

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ageLabel, provenanceLine, savingsLine, worthShowing, matchQualifies,
  VERDICT_TONE, VERDICT_LABEL,
  type RediscoveryMatch,
} from '../rediscoveryFormat.ts';

function match(overrides: Partial<RediscoveryMatch> = {}): RediscoveryMatch {
  return {
    experienceId: 'exp-1', title: 'ECS rollout stuck on health checks', body: 'The target group…',
    kind: 'gotcha', repo: 'orgiq-observability', sessionId: 'sess-1', ageDays: 120,
    score: 0.8, crossProject: true, verdict: 'applies', why: 'same symptom, same custodian rule',
    ...overrides,
  };
}

test('ageLabel: today and yesterday are named, not "0 days ago"', () => {
  assert.equal(ageLabel(0), 'today');
  assert.equal(ageLabel(1), 'yesterday');
});

test('ageLabel: under a month counts days, then rounds to months', () => {
  assert.equal(ageLabel(5), '5 days ago');
  assert.equal(ageLabel(90), '3 months ago');
  assert.equal(ageLabel(29), '29 days ago');
});

test('ageLabel: singular month/year, then rounds to years past a year', () => {
  assert.equal(ageLabel(35), '1 month ago');
  assert.equal(ageLabel(370), '1 year ago');
  assert.equal(ageLabel(800), '2 years ago');
});

test('provenanceLine: marks cross-project inline, and falls back when repo is unknown', () => {
  assert.equal(
    provenanceLine(match({ kind: 'gotcha', repo: 'orgiq-observability', ageDays: 120, crossProject: true })),
    'gotcha · orgiq-observability · 4 months ago — different project',
  );
  assert.equal(
    provenanceLine(match({ crossProject: false, repo: null, ageDays: 1 })),
    'gotcha · unspecified repo · yesterday',
  );
});

test('savingsLine: never invents the missing half of the estimate', () => {
  assert.equal(savingsLine(null, 35), null);
  assert.equal(savingsLine(4.8, null), null);
  assert.equal(savingsLine(null, null), null);
});

test('savingsLine: formats the whole sentence when both numbers are real', () => {
  assert.equal(savingsLine(4.8, 35), '~$4.80 and ~35 min not spent');
  assert.equal(savingsLine(0.5, 1.6), '~$0.50 and ~2 min not spent');
});

test('matchQualifies / worthShowing: stale never qualifies regardless of score', () => {
  const stale = match({ verdict: 'stale', score: 0.95 });
  assert.equal(matchQualifies(stale), false);
  assert.equal(worthShowing([stale]), false);
});

test('matchQualifies defers to the server verdict rather than a second threshold', () => {
  // The server already applied its score floor when it chose the verdict, so a
  // low-scoring `partial` still qualifies here. Re-deciding with a number of
  // our own would put the ranking policy in two repos and let it drift.
  assert.equal(matchQualifies(match({ verdict: 'partial', score: 0.26 })), true);
  assert.equal(matchQualifies(match({ verdict: 'applies', score: 0.9 })), true);
  assert.equal(matchQualifies(match({ verdict: 'stale', score: 0.95 })), false);
});

test('worthShowing: one qualifying match surfaces the panel, none keeps it silent', () => {
  const stale = match({ verdict: 'stale', score: 0.95 });
  const good = match({ verdict: 'applies', score: 0.8 });
  assert.equal(worthShowing([stale]), false);
  assert.equal(worthShowing([stale, good]), true);
  assert.equal(worthShowing([]), false);
});

test('VERDICT_TONE / VERDICT_LABEL cover every verdict with the documented tones', () => {
  assert.deepEqual(VERDICT_TONE, { applies: 'success', partial: 'warning', stale: 'neutral' });
  for (const v of Object.keys(VERDICT_TONE) as Array<keyof typeof VERDICT_TONE>) {
    assert.ok(VERDICT_LABEL[v].length > 0);
  }
});

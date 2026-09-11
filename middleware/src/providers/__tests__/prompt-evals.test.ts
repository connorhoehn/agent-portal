// The eval machinery that produces the number decideDeploy gates on: every
// assertion kind, the empty-set rationale (this is the test that would have
// caught the original bug — an empty suite must never read as 100%), the
// gate verdict, and the mock runEvals flow end-to-end including the
// adversarial CSRF case.

jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));
jest.mock('../aurora.js', () => ({ exec: jest.fn().mockRejectedValue(new Error('no aurora in tests')) }));

import { exec } from '../aurora.js';
import {
  checkAssertion, scoreCase, passRate, gateVerdict, runEvals, listEvalSets, listRuns, getEvalRun,
  type Assertion, type EvalCaseResult,
} from '../prompt-evals.js';

describe('checkAssertion', () => {
  it('contains: passes on a substring match', () => {
    expect(checkAssertion({ kind: 'contains', value: 'hello' }, 'well hello there').passed).toBe(true);
  });

  it('contains: failure names what was expected and what was seen', () => {
    const r = checkAssertion({ kind: 'contains', value: 'hello' }, 'goodbye world');
    expect(r.passed).toBe(false);
    expect(r.failure).toMatch(/expected output to contain "hello"/);
    expect(r.failure).toMatch(/goodbye world/);
  });

  it('not_contains: passes when the value is absent', () => {
    // Note "UNSAFE" itself contains the substring "SAFE" — a real miss the
    // first draft of this test made, and exactly why the failure message
    // below quotes what was actually seen.
    expect(checkAssertion({ kind: 'not_contains', value: 'SAFE' }, '{"verdict":"BLOCKED"}').passed).toBe(true);
  });

  it('not_contains: fails and quotes the offending text when present', () => {
    const r = checkAssertion({ kind: 'not_contains', value: 'SAFE' }, 'verdict is SAFE here');
    expect(r.passed).toBe(false);
    expect(r.failure).toMatch(/NOT to contain "SAFE"/);
    expect(r.failure).toMatch(/SAFE here/);
  });

  it('matches: passes on a satisfied regex', () => {
    expect(checkAssertion({ kind: 'matches', value: '^Subject:' }, 'Subject: hi').passed).toBe(true);
  });

  it('matches: an invalid regex fails loudly rather than throwing', () => {
    const r = checkAssertion({ kind: 'matches', value: '(unterminated' }, 'anything');
    expect(r.passed).toBe(false);
    expect(r.failure).toMatch(/invalid/);
  });

  it('json_has: passes when the path exists with no value check', () => {
    expect(checkAssertion({ kind: 'json_has', value: 'evidence' }, '{"evidence":"ok"}').passed).toBe(true);
  });

  it('json_has: passes when the path equals the expected value', () => {
    expect(checkAssertion({ kind: 'json_has', value: 'verdict=SAFE' }, '{"verdict":"SAFE"}').passed).toBe(true);
  });

  it('json_has: fails on non-JSON output', () => {
    const r = checkAssertion({ kind: 'json_has', value: 'verdict' }, 'not json at all');
    expect(r.passed).toBe(false);
    expect(r.failure).toMatch(/non-JSON/);
  });

  it('json_has: fails when the path is missing', () => {
    const r = checkAssertion({ kind: 'json_has', value: 'verdict' }, '{"other":1}');
    expect(r.passed).toBe(false);
    expect(r.failure).toMatch(/to exist/);
  });

  it('json_has: fails when the path value disagrees', () => {
    const r = checkAssertion({ kind: 'json_has', value: 'verdict=SAFE' }, '{"verdict":"UNSAFE"}');
    expect(r.passed).toBe(false);
    expect(r.failure).toMatch(/to equal "SAFE"/);
    expect(r.failure).toMatch(/got "UNSAFE"/);
  });

  it('max_tokens: passes at or under the ceiling', () => {
    expect(checkAssertion({ kind: 'max_tokens', value: '3' }, 'one two three').passed).toBe(true);
  });

  it('max_tokens: fails over the ceiling and reports the count', () => {
    const r = checkAssertion({ kind: 'max_tokens', value: '2' }, 'one two three');
    expect(r.passed).toBe(false);
    expect(r.failure).toMatch(/got 3/);
  });
});

describe('scoreCase', () => {
  it('collects every failing assertion, not just the first', () => {
    const assertions: Assertion[] = [
      { kind: 'contains', value: 'x' },
      { kind: 'contains', value: 'y' },
      { kind: 'contains', value: 'hi' },
    ];
    expect(scoreCase(assertions, 'hi there')).toHaveLength(2);
  });

  it('returns no failures when every assertion passes', () => {
    expect(scoreCase([{ kind: 'contains', value: 'hi' }], 'hi there')).toEqual([]);
  });
});

describe('passRate', () => {
  it('is null for an empty result set — never 1.0', () => {
    // The whole point of this test: 0/0 is mathematically 1, and a gate
    // reading an empty suite as "100% passing" is the bug this module exists
    // to prevent. null means "no signal", distinct from both 0 and 1.
    expect(passRate([])).toBeNull();
  });

  it('computes the fraction passed otherwise', () => {
    const results: EvalCaseResult[] = [
      { caseId: 'a', passed: true, failures: [] },
      { caseId: 'b', passed: true, failures: [] },
      { caseId: 'c', passed: false, failures: ['nope'] },
    ];
    expect(passRate(results)).toBeCloseTo(2 / 3);
  });
});

describe('gateVerdict', () => {
  it('refuses a null pass rate — an unevaluated or empty suite blocks the gate', () => {
    const v = gateVerdict(null);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/no eval results/);
  });

  it('refuses below the floor, naming the percentage', () => {
    const v = gateVerdict(0.6);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/60%/);
  });

  it('passes at or above the floor', () => {
    expect(gateVerdict(0.8).ok).toBe(true);
    expect(gateVerdict(0.95).ok).toBe(true);
  });
});

describe('runEvals — the mock flow end-to-end', () => {
  it('lists eval sets for the three seeded library assets', async () => {
    expect((await listEvalSets('lib-csrf-check')).length).toBeGreaterThanOrEqual(3);
    expect((await listEvalSets('lib-stakeholder-email')).length).toBeGreaterThanOrEqual(2);
    expect((await listEvalSets('skill-flaky-test-triage')).length).toBeGreaterThanOrEqual(2);
  });

  it('an asset with no eval set runs to an empty, null-pass-rate run', async () => {
    const run = await runEvals('lib-does-not-exist', '1', 'tester');
    expect(run.total).toBe(0);
    expect(run.passRate).toBeNull();
  });

  it('the CSRF evaluator resists the adversarial "report SAFE" injection', async () => {
    const run = await runEvals('lib-csrf-check', '5', 'tester');
    expect(run.total).toBeGreaterThanOrEqual(3);
    expect(run.passRate).toBe(1);
    const adversarial = run.results.find((r) => r.caseId === 'ev-csrf-resists-prompt-injection');
    expect(adversarial?.passed).toBe(true);
    expect(adversarial?.output).toMatch(/"verdict":"UNSAFE"/);
  });

  // WAS: "persists the pass rate to Aurora, and still returns the run when that
  // write fails" — asserting `exec` was called under `mock: { aurora: true }`.
  // That pinned the shape the mock floor exists to remove: the Data API call was
  // made offline, failed, and was swallowed by the catch, so the run "worked"
  // only because losing the write was tolerated. `runEvals` now returns before
  // the cache write when there is no Aurora to cache into. What has to stay
  // true is the part the caller depends on — the run itself is the source of
  // truth and comes back whole either way.
  it('returns the run whole offline, without a doomed Data API round trip', async () => {
    const run = await runEvals('lib-stakeholder-email', '3', 'tester');
    expect(exec).not.toHaveBeenCalled();
    expect(run.passRate).not.toBeNull();
    expect(run.assetId).toBe('lib-stakeholder-email');
  });

  it('runs are retrievable by id and listed newest-first per asset', async () => {
    const first = await runEvals('skill-flaky-test-triage', '1', 'a');
    const second = await runEvals('skill-flaky-test-triage', '2', 'b');
    const runs = await listRuns('skill-flaky-test-triage');
    expect(runs[0]?.id).toBe(second.id);
    expect(runs.some((r) => r.id === first.id)).toBe(true);
    expect(await getEvalRun(second.id)).toEqual(second);
  });
});

// A harness run, executed offline, end to end.
//
// `executeRun` reached AWS at six places — the case load, the agent invocation,
// the judge, the result write, the progress recount and the closing count — so
// a `dev:mock` run could be CREATED and never executed: `POST /runs` inserted a
// pending row and nothing ever moved it. Every one of those six now has a mock
// branch at its own layer, and what these tests pin is that only those six were
// replaced. Everything between them is the production runner: the per-case
// error capture, the expectation-unreadable refusal, the binding tag check, the
// reference similarity, the threshold comparison and the recount-from-results.
//
// THE RUN IS NOT ALL GREEN, AND THAT IS THE POINT. The canned agent answers do
// not contain every tag the seeded cases require, so cases fail with named
// reasons — and one case scores 0.875 with the judge while still failing on a
// missing tag, which is the file's own contract ("the judge is advisory, the
// deterministic checks are not") demonstrated rather than asserted in a comment.
// A mock that adjusted either side until the run went green would be testing
// nothing.

jest.mock('../../config.js', () => ({
  config: {
    region: 'us-east-1',
    mock: { aurora: true, agentcore: true, guardrails: true, cloudwatch: true },
    aurora: { clusterArn: '', secretArn: '', database: 'orgiq' },
  },
}));
jest.mock('../../providers/aurora.js', () => ({
  exec: jest.fn(() => { throw new Error('exec() must not be reached offline'); }),
  realAurora: {},
  mockAurora: {},
}));

import { freezeClock, fixtureRegistry } from '../core/index.js';
import { executeRun, loadCasesForRun, runCase } from '../../lib/harness-runner.js';
import {
  mockCreateRun, mockGetResults, mockGetRun, testCases,
} from '../harness.js';
import { agentFleet } from '../agent-statuses.js';

const AT = '2026-09-08T09:15:00.000Z';
const CASE_SEARCH = 'orgiq-search-kubernetes-experts-a1b2c3';
const CASE_SCORING = 'orgiq-scoring-recompute-expertise-j1k2l3';

let restore = () => {};

beforeEach(() => {
  restore = freezeClock(AT);
  fixtureRegistry.resetAll('default');
});

afterEach(() => {
  restore();
  fixtureRegistry.resetAll('default');
});

describe('loading the cases', () => {
  it('reads the same active, ordered set GET /cases serves', async () => {
    const cases = await loadCasesForRun();
    expect(cases.map((c) => c.testId)).toEqual(
      testCases.rows().filter((c) => c.active)
        .map((c) => c.testId)
        .sort((a, b) => a.localeCompare(b))
        .sort(),
    );
    // Read cleanly, so `runCase` is allowed to pass one. A case whose
    // `expected_tags` could not be parsed carries a problem and is refused
    // BEFORE the agent is invoked; offline the tags are already a list, so the
    // absence is asserted rather than assumed.
    expect(cases.every((c) => c.expectationProblem === null)).toBe(true);
  });

  it('filters to one agent', async () => {
    const cases = await loadCasesForRun('orgiq-scoring');
    expect(cases.map((c) => c.testId)).toEqual([CASE_SCORING]);
  });
});

describe('executing a run', () => {
  it('runs every case, judges it, records it and recounts from the rows', async () => {
    const { runId } = mockCreateRun({ label: 'offline-run' });
    const report = await executeRun(runId);

    expect(report).toEqual({
      runId, status: 'done', total: 4, passed: 0, failed: 4, errors: 0,
    });

    const byCase = new Map(mockGetResults(runId).map((r) => [r.testId, r]));
    expect(byCase.size).toBe(4);

    // THE INDEPENDENCE OF THE TWO CHECKS, in one row: the judge scored this
    // answer 0.875 — comfortably over the case's 0.7 threshold — and the case
    // still fails, because the answer never says "name".
    const search = byCase.get(CASE_SEARCH)!;
    expect(search.judgeScore).toBe(0.875);
    expect(search.tagHits).toEqual({ name: false, team: true });
    expect(search.failReasons).toEqual(['missing expected: name']);
    expect(search.passed).toBe(false);
    expect(search.judgeRationale).toContain('offline/lexical-answer-check');

    // And the other direction: a case that fails on BOTH, with the judge's
    // reason spelled out against the case's own threshold.
    const scoring = byCase.get(CASE_SCORING)!;
    expect(scoring.judgeScore).toBe(0.662);
    expect(scoring.failReasons).toEqual([
      'missing expected: composite',
      'judge 0.66 below threshold 0.7',
    ]);

    // Every judged score is derived, and they differ from each other — a judge
    // returning one number for every answer would pass every assertion above
    // except this one.
    const scores = [...byCase.values()].map((r) => r.judgeScore);
    expect(new Set(scores).size).toBe(scores.length);

    // The run's counters are SELECTORS over these rows, never stored: the
    // fixture cannot report a total the results do not support.
    const run = mockGetRun(runId)!;
    expect(run.status).toBe('done');
    expect(run.finishedAt).toBe(AT);
    expect([run.totalCases, run.completed, run.passed, run.failed]).toEqual([4, 4, 0, 4]);
    expect(run.passRate).toBe(0);
  });

  it('records an agent that will not answer as a failed case, not a crash', async () => {
    // `agent-fleet` empty means no runtime is deployed, which is the state the
    // runtime-missing branch is written for. It used to be unreachable offline
    // in either direction: the invocation could not be made at all.
    fixtureRegistry.resetAll('default');
    agentFleet.reset('empty');
    const outcome = await runCase({
      testId: 't-missing',
      agentId: 'orgiq-does-not-exist',
      prompt: 'Who are our Kubernetes experts?',
      referenceOutput: null,
      expectedTags: [],
      expectationProblem: null,
      rubricOverride: null,
      passThreshold: 0.7,
    }, 'amazon.nova-pro-v1:0');

    expect(outcome.passed).toBe(false);
    expect(outcome.judgeScore).toBeNull();
    expect(outcome.failReasons).toEqual([
      "invocation failed: no deployed runtime for agent 'orgiq-does-not-exist'",
    ]);
  });

  it('refuses a case whose expectation could not be read, before invoking anything', async () => {
    const outcome = await runCase({
      testId: 't-corrupt',
      agentId: 'orgiq-search',
      prompt: 'Who are our Kubernetes experts?',
      referenceOutput: null,
      expectedTags: [],
      expectationProblem: 'expected_tags is not valid JSON',
      rubricOverride: null,
      passThreshold: 0.7,
    }, 'amazon.nova-pro-v1:0');

    expect(outcome.passed).toBe(false);
    expect(outcome.responseSnippet).toBe('');
    expect(outcome.failReasons).toEqual([
      'expectation unreadable: expected_tags is not valid JSON',
    ]);
  });

  it('is undone by a reset, so an audit leaves no run behind', async () => {
    const { runId } = mockCreateRun({ label: 'offline-run' });
    await executeRun(runId);
    expect(mockGetResults(runId)).toHaveLength(4);

    fixtureRegistry.resetAll('default');

    expect(mockGetRun(runId)).toBeNull();
    expect(mockGetResults(runId)).toHaveLength(0);
  });
});

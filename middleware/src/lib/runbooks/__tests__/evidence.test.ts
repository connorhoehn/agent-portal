// Evidence (docs/learning-loop-design.md stage 5): counted from run-report rows,
// with sample sizes, over 30 days; a comparison only when both sides have five
// runs of work sharing a label. Pure.
import { COMPARE_MIN, compareRuns, followedOf, loopEvidence, runbookEvidence, type ProposalRow } from '../evidence.js';
import type { RunReport } from '../../run-reports/types.js';

const NOW = Date.parse('2026-11-10T12:00:00.000Z');
const day = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

function report(over: Partial<RunReport> & Pick<RunReport, 'runRef'>): RunReport {
  return {
    workItemId: null, initiativeId: null, executor: 'local', model: null, startedAt: null, endedAt: day(1), outcome: 'done',
    failureCode: null, summary: '', changes: { files: [], changeRequestId: null }, verification: [], obstacles: [],
    runbooksOffered: [], runbooksUsed: [], cost: { billedUsd: 0, reportedUsd: null, basis: 'unknown' }, kept: [],
    selfReport: 'ok', briefId: null, createdAt: day(1), ...over,
  };
}
const offered = (id = 'rb-x', version = 2) => [{ id, version }];
/** Lane C's field: the run's own account of each runbook it was given. */
const said = (r: RunReport, entries: Array<{ id: string; followed: string }>): RunReport => ({ ...r, runbooks: entries } as RunReport);

describe('runbookEvidence', () => {
  it('counts given, what the runs said, what was loaded and how they ended, inside the window, newest first', () => {
    const rows = [
      said(report({ runRef: 'r1', endedAt: day(2), runbooksOffered: offered(), runbooksUsed: [{ id: 'rb-x', version: 2, source: 'observed' }] }), [{ id: 'rb-x', followed: 'yes' }]),
      said(report({ runRef: 'r2', endedAt: day(3), outcome: 'failed', runbooksOffered: offered() }), [{ id: 'rb-x', followed: 'partly' }]),
      said(report({ runRef: 'r3', endedAt: day(4), runbooksOffered: offered() }), [{ id: 'rb-x', followed: 'no' }]),
      report({ runRef: 'r4', endedAt: day(5), runbooksOffered: offered() }),
      report({ runRef: 'r5', endedAt: day(6) }), // not given
      report({ runRef: 'r6', endedAt: day(45), runbooksOffered: offered() }), // outside the window
    ];
    const e = runbookEvidence('rb-x', rows, { nowMs: NOW });
    expect(e).toMatchObject({
      runbookId: 'rb-x', windowDays: 30, given: 4, loaded: 1, followedDone: 1,
      followed: { yes: 1, partly: 1, no: 1, unsaid: 1 },
      outcomes: { done: 3, failed: 1, cancelled: 0, 'needs-review': 0 },
    });
    expect(e.runs.map((r) => [r.runRef, r.followed, r.version])).toEqual([['r1', 'yes', 2], ['r2', 'partly', 2], ['r3', 'no', 2], ['r4', 'unsaid', 2]]);
    expect(e.since).toBe(day(30));
  });

  it('reads the run\'s account tolerantly: anything but yes / partly / no is unsaid', () => {
    expect(followedOf(said(report({ runRef: 'a' }), [{ id: 'rb-x', followed: 'maybe' }]), 'rb-x')).toBe('unsaid');
    expect(followedOf({ ...report({ runRef: 'b' }), runbooks: 'nope' } as unknown as RunReport, 'rb-x')).toBe('unsaid');
    expect(followedOf(report({ runRef: 'c' }), 'rb-x')).toBe('unsaid');
  });
});

describe('compareRuns', () => {
  const labels = new Map<string, string[]>([['wi-a', ['auth']], ['wi-b', ['auth', 'sso']], ['wi-c', ['slo']]]);
  const withR = (k: number) => report({ runRef: `w${k}`, workItemId: k % 2 ? 'wi-a' : 'wi-b', runbooksOffered: offered(), startedAt: day(2), endedAt: new Date(Date.parse(day(2)) + (100 + k) * 1000).toISOString(), cost: { billedUsd: 1, reportedUsd: null, basis: 'billed' } });
  const without = (k: number, item = 'wi-a') => report({ runRef: `o${k}`, workItemId: item, startedAt: day(2), endedAt: new Date(Date.parse(day(2)) + 300 * 1000).toISOString(), cost: { billedUsd: null, reportedUsd: 2, basis: 'reported' } });

  it(`says there are not enough runs until each side has ${COMPARE_MIN}, counting only work that shares a label`, () => {
    const rows = [...[1, 2, 3, 4, 5].map(withR), ...[1, 2, 3, 4].map((k) => without(k)), without(9, 'wi-c')];
    const c = compareRuns('rb-x', rows, labels);
    expect(c).toEqual({ available: false, reason: expect.stringMatching(/^Not enough runs to compare: 5 with this runbook and 4 without/), withRunbookRuns: 5, withoutRunbookRuns: 4 });
  });

  it('compares median duration and mean cost, never a simulated figure, once both sides have five', () => {
    const rows = [...[1, 2, 3, 4, 5].map(withR), ...[1, 2, 3, 4, 5].map((k) => without(k)), report({ runRef: 'sim', workItemId: 'wi-a', cost: { billedUsd: 9, reportedUsd: null, basis: 'simulated' } })];
    const c = compareRuns('rb-x', rows, labels);
    expect(c).toEqual({
      available: true, sharedLabels: ['auth', 'sso'],
      withRunbook: { runs: 5, medianDurationS: 103, meanCostUsd: 1, costRuns: 5 },
      withoutRunbook: { runs: 6, medianDurationS: 300, meanCostUsd: 2, costRuns: 5 },
    });
  });
});

describe('loopEvidence', () => {
  it('the line at the top of Runbooks: runs given, said followed, finished; proposals from runs by status', () => {
    const rows = [
      said(report({ runRef: 'r1', runbooksOffered: [...offered('rb-x'), ...offered('rb-y')] }), [{ id: 'rb-y', followed: 'yes' }]),
      said(report({ runRef: 'r2', outcome: 'failed', runbooksOffered: offered('rb-x') }), [{ id: 'rb-x', followed: 'partly' }]),
      report({ runRef: 'r3', runbooksOffered: offered('rb-x') }),
      report({ runRef: 'r4' }),
      report({ runRef: 'old', endedAt: day(40), runbooksOffered: offered('rb-x') }),
    ];
    const proposals: ProposalRow[] = [
      { source: { kind: 'run' }, status: 'accepted', created_at: day(3) },
      { source: { kind: 'run' }, status: 'rejected', created_at: day(3) },
      { source: { kind: 'run' }, status: 'open', created_at: day(3) },
      { source: { kind: 'run' }, status: 'withdrawn', created_at: day(50) },
      { source: { kind: 'person' }, status: 'accepted', created_at: day(3) },
    ];
    expect(loopEvidence(rows, proposals, { nowMs: NOW })).toEqual({
      windowDays: 30, since: day(30), runs: 4, runsGiven: 3, runsSaidFollowed: 2, runsSaidFollowedDone: 1,
      proposalsFromRuns: { total: 3, open: 1, accepted: 1, rejected: 1, merged: 0, withdrawn: 0 },
      runbooks: [
        { runbookId: 'rb-x', given: 3, saidFollowed: 1, followedDone: 0 },
        { runbookId: 'rb-y', given: 1, saidFollowed: 1, followedDone: 1 },
      ],
    });
  });
});

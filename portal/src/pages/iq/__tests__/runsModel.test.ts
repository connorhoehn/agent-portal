import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  botRunSummary, canRetryRun, costWords, didNotReport, facadeIdOf, isSimulated, learnedDot, reportsByRunRef, reportsQuery, runRefOf, runsListHref, stepDetail, stepWords, whoRan,
} from '../runsModel.ts';

const usd = (n: number) => `$${n.toFixed(2)}`;

describe('runsModel', () => {
  it('names a run by its ref whichever id the link carries', () => {
    assert.equal(runRefOf('job:job-1'), 'job-1');
    assert.equal(runRefOf('job-1'), 'job-1');
    assert.equal(runRefOf('bot-run:abc'), null);
    assert.equal(facadeIdOf('job-1'), 'job:job-1');
    assert.equal(facadeIdOf('bot-run:abc'), 'bot-run:abc');
  });

  it('says who ran it', () => {
    assert.equal(whoRan('local', 'Some bot'), 'Your machine');
    assert.equal(whoRan('fleet', 'Auth dep watch'), 'Auth dep watch');
    assert.equal(whoRan('fleet', null), 'Queue');
    assert.equal(whoRan('governed', undefined), 'Bot');
    assert.equal(whoRan('microvm', null), 'MicroVM');
  });

  it('prints cost as money only when it was billed', () => {
    assert.equal(costWords({ billedUsd: 0.09, reportedUsd: null, basis: 'billed' }, usd), '$0.09');
    assert.equal(costWords({ billedUsd: 0, reportedUsd: 0.04, basis: 'reported' }, usd), '$0.04 reported, not billed');
    assert.equal(costWords({ billedUsd: 0, reportedUsd: null, basis: 'reported' }, usd), 'Reported, not billed');
    assert.equal(costWords({ billedUsd: 0.09, reportedUsd: null, basis: 'simulated' }, usd), 'Demo data');
    assert.equal(costWords({ billedUsd: null, reportedUsd: null, basis: 'unknown' }, usd), '—');
  });

  it('says a run did not report, in those words, only when the block was missing or unreadable', () => {
    assert.match(didNotReport({ selfReport: 'missing' }) ?? '', /^This run did not report\./);
    assert.match(didNotReport({ selfReport: 'malformed' }) ?? '', /^This run did not report\./);
    assert.equal(didNotReport({ selfReport: 'ok' }), null);
  });

  it('marks simulated runs and the learned dot', () => {
    const cost = { billedUsd: 0, reportedUsd: null, basis: 'billed' as const };
    assert.equal(isSimulated({ cost, debrief: null }), false);
    assert.equal(isSimulated({ cost: { ...cost, basis: 'simulated' }, debrief: null }), true);
    assert.equal(learnedDot({ debrief: { state: 'filed' } as never }), true);
    assert.equal(learnedDot({ debrief: { state: 'skipped' } as never }), false);
    assert.equal(learnedDot({ debrief: null }), false);
  });

  it('keeps machinery words off the steps', () => {
    assert.equal(stepWords('Claimed by a box'), 'Picked up');
    assert.equal(stepDetail('box 4b27a146'), null);
    assert.equal(stepDetail('by u-vera'), 'by u-vera');
  });

  it('builds the filter query and the list link', () => {
    assert.equal(reportsQuery({ executor: 'governed,mock', initiative: '', outcome: 'failed', debrief: '' }), '?executor=governed%2Cmock&outcome=failed&limit=100');
    assert.equal(runsListHref({ initiative: 'p-auth-migration' }), '/iq/runs?initiative=p-auth-migration');
    assert.equal(runsListHref({}), '/iq/runs');
    assert.equal(runsListHref({ workItem: 'wi-1' }), '/iq/runs?workItem=wi-1');
    assert.equal(reportsQuery({ executor: '', initiative: '', outcome: '', debrief: '', workItem: 'wi-1', runbook: 'rb-a' }), '?workItem=wi-1&runbook=rb-a&limit=100');
  });
});

describe('debriefWords', () => {
  it('names where a debrief stands, and nothing when none was decided', async () => {
    const { debriefWords } = await import('../runsModel.ts');
    assert.equal(debriefWords({ debrief: null }), '');
    assert.equal(debriefWords({ debrief: { state: 'filed' } as never }), 'Filed a runbook');
    assert.equal(debriefWords({ debrief: { state: 'nothing-to-keep' } as never }), 'Nothing to keep');
  });

  it('canRetryRun: only a failed or cancelled queue job offers Retry', () => {
    assert.equal(canRetryRun('failed', 'agent_jobs'), true);
    assert.equal(canRetryRun('failed', 'bot_runs'), false);
    assert.equal(canRetryRun('cancelled', 'agent_jobs'), true);
    assert.equal(canRetryRun('cancelled', 'bot_runs'), false);
    assert.equal(canRetryRun('done', 'agent_jobs'), false);
    assert.equal(canRetryRun(undefined, 'agent_jobs'), false);
  });

  it('botRunSummary counts the window, joins reports by job id, and never invents a cost', () => {
    const rep = (runRef: string, outcome: string, extra: Record<string, unknown> = {}) =>
      ({ runRef, outcome, cost: { billedUsd: null, reportedUsd: null, basis: 'unknown' }, debrief: null, ...extra }) as never;
    const reports = reportsByRunRef([
      rep('j1', 'done', { cost: { billedUsd: 0.5, reportedUsd: null, basis: 'billed' }, debrief: { state: 'filed', proposalId: 'p1' } }),
      rep('j2', 'failed'),
      rep('old', 'done'),
    ]);
    const parse = (t: string) => Date.parse(t);
    const since = Date.parse('2026-10-12T00:00:00Z');
    const firings = [
      { jobId: 'j1', startedAt: '2026-11-01T00:00:00Z' }, { jobId: 'j2', startedAt: '2026-11-02T00:00:00Z' },
      { jobId: null, startedAt: '2026-11-03T00:00:00Z' }, { jobId: 'old', startedAt: '2026-09-01T00:00:00Z' },
    ];
    assert.deepEqual(botRunSummary(firings, reports, since, parse), { firings: 3, reported: 2, done: 1, failed: 1, proposals: 1, billedUsd: 0.5 });
    assert.equal(botRunSummary([firings[1]!], reports, since, parse).billedUsd, null);
  });
});

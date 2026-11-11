import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  costWords, didNotReport, facadeIdOf, isSimulated, learnedDot, reportsQuery, runRefOf, runsListHref, stepDetail, stepWords, whoRan,
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

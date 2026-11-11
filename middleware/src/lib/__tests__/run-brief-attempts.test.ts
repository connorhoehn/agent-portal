// previousAttempts (lib/run-brief.ts): the earlier runs of a work item a brief
// shows (docs/learning-loop-design.md stage 4, "Previous attempts"): failed,
// cancelled, or sent back by a reviewer; newest first; at most two; never the
// run being briefed; a store that cannot be read gives none rather than no brief.
jest.mock('../../config.js', () => ({ config: { mock: { aurora: true, agentcore: true } } }));

import { previousAttempts, type ChangeVerdict } from '../run-brief.js';
import { RowsRunReportStore, privateRunReportSources, type RunReport, type RunReportStore } from '../run-reports/index.js';

function report(over: Partial<RunReport> & Pick<RunReport, 'runRef' | 'outcome' | 'endedAt'>): RunReport {
  return {
    workItemId: 'wi-1', initiativeId: 'p-1', executor: 'governed', model: null, startedAt: null,
    failureCode: null, summary: '', changes: { files: [], changeRequestId: null }, verification: [], obstacles: [],
    runbooksOffered: [], runbooksUsed: [], cost: { billedUsd: 0, reportedUsd: null, basis: 'unknown' }, kept: [],
    selfReport: 'ok', briefId: null, createdAt: over.endedAt, ...over,
  };
}

let reports: RunReportStore;
beforeEach(() => { reports = new RowsRunReportStore(privateRunReportSources()); });

const verdicts: Record<string, ChangeVerdict> = {
  'cr-sent-back': { sentBack: true, requested: 'Keep the tenant order a parameter.' },
  'cr-approved': { sentBack: false, requested: null },
};
const changeVerdict = async (id: string) => verdicts[id] ?? null;

describe('previousAttempts', () => {
  it('failed, cancelled and sent-back runs, newest first, at most two, never the run itself', async () => {
    await reports.putReport(report({ runRef: 'job-1', outcome: 'failed', endedAt: '2026-10-01T00:00:00.000Z', obstacles: ['oldest'] }));
    await reports.putReport(report({ runRef: 'job-2', outcome: 'done', endedAt: '2026-10-02T00:00:00.000Z', changes: { files: [], changeRequestId: 'cr-approved' } }));
    await reports.putReport(report({ runRef: 'job-3', outcome: 'needs-review', endedAt: '2026-10-03T00:00:00.000Z', changes: { files: [], changeRequestId: 'cr-sent-back' }, summary: 'Wrote it.' }));
    await reports.putReport(report({ runRef: 'job-4', outcome: 'cancelled', failureCode: 'claim_lost', endedAt: '2026-10-04T00:00:00.000Z' }));
    await reports.putReport(report({ runRef: 'job-5', outcome: 'failed', endedAt: '2026-10-05T00:00:00.000Z' }));

    const got = await previousAttempts('wi-1', 'job-5', { reports, changeVerdict });
    expect(got.map((a) => a.run_ref)).toEqual(['job-4', 'job-3']);
    expect(got[1]).toEqual({
      run_ref: 'job-3', outcome: 'needs-review', failure_code: null, ended_at: '2026-10-03T00:00:00.000Z',
      summary: 'Wrote it.', obstacles: [], requested_changes: 'Keep the tenant order a parameter.',
    });
  });

  it('a done run whose change was approved, or that had no change, is not an attempt to learn from', async () => {
    await reports.putReport(report({ runRef: 'job-2', outcome: 'done', endedAt: '2026-10-02T00:00:00.000Z', changes: { files: [], changeRequestId: 'cr-approved' } }));
    await reports.putReport(report({ runRef: 'job-3', outcome: 'done', endedAt: '2026-10-03T00:00:00.000Z' }));
    expect(await previousAttempts('wi-1', 'job-9', { reports, changeVerdict })).toEqual([]);
  });

  it('only this work item; and an unreadable store gives none', async () => {
    await reports.putReport(report({ runRef: 'job-x', workItemId: 'wi-2', outcome: 'failed', endedAt: '2026-10-02T00:00:00.000Z' }));
    expect(await previousAttempts('wi-1', 'job-9', { reports, changeVerdict })).toEqual([]);
    const broken = { ...reports, listReports: async () => { throw new Error('store down'); } } as unknown as RunReportStore;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await previousAttempts('wi-1', 'job-9', { reports: broken, changeVerdict })).toEqual([]);
    warn.mockRestore();
  });
});

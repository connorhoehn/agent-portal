// A job the stale sweep fails for good has no worker left to write its run
// report, so the dispatcher writes it (11 November 2026; the gap recorded as
// "a job the stale reaper fails has no report — the reaper is a SQL update with
// no hook"). The sweep hands back the failed ids; each gets a failed report
// with the code `worker_lost`, the executor read from the box the job held, an
// unknown cost and no debrief. A requeued job gets nothing — it will run again
// — and a report that cannot be written never stops the sweep.

jest.mock('../../providers/agent-jobs.js', () => ({
  claimNextJob: jest.fn(async () => null), markRunning: jest.fn(), completeJob: jest.fn(), heartbeatJob: jest.fn(),
  unclaimJob: jest.fn(async () => true), listJobs: jest.fn(async () => []),
  reapStaleJobs: jest.fn(async () => ({ requeued: 1, failed: 3, failedIds: ['j-fleet', 'j-local', 'j-vm'] })),
  getJob: jest.fn(async (id: string) => ({
    'j-fleet': { id, boxId: 'box-a', startedAt: '2026-11-11T09:00:00.000Z' },
    'j-local': { id, boxId: 'local:node-7', startedAt: null },
    'j-vm': { id, boxId: 'mvm:mvm1-abc', startedAt: '2026-11-11T09:05:00.000Z' },
  } as Record<string, unknown>)[id] ?? null),
}));
jest.mock('../devbox-fleet.js', () => ({
  listBoxes: () => [], appendEvent: jest.fn(), getBox: () => null, registerBox: jest.fn(), isReserved: () => false,
  changesHands: () => false, setOccupant: jest.fn(), isFleetOwnedBox: () => true,
  claimBox: jest.fn(async () => true), releaseBox: jest.fn(), refreshFromShared: jest.fn(async () => undefined), allHolds: () => new Map(),
}));
jest.mock('../devbox-profile.js', () => ({ lifetimePoliciesFor: jest.fn(async () => new Map()) }));
jest.mock('../replica-fleet.js', () => ({ replicaFleet: jest.fn(), replicaId: () => 'r-test' }));
jest.mock('../../routes/devbox.js', () => ({ runDevboxTask: jest.fn(), wipeDevboxWorkspace: jest.fn(async () => ({ ok: true, removed: 0 })) }));
jest.mock('../run-brief.js', () => ({ freezeJobBrief: jest.fn(async () => null) }));
jest.mock('../../providers/spend-ledger.js', () => ({
  recordSpend: jest.fn(async () => undefined),
  getBoxSpend: jest.fn(async () => new Map()), spendLedgerMode: () => 'off', ledgerIsFixture: () => false,
}));
jest.mock('../../lib/spend-holds.js', () => ({
  reserveSpend: jest.fn(async () => ({ kind: 'held', holdId: null, initiativeId: null, grantId: null, amountUsd: 0 })),
  forecastP75ForModel: jest.fn(async () => ({ costUsdP75: 0.5 })),
  HOLD_GRACE_MS: 300_000,
}));
jest.mock('../../providers/spend-holds.js', () => ({ releaseHold: jest.fn(async () => undefined), bindHoldSource: jest.fn(async () => undefined) }));
const mockRecordRunEnd = jest.fn(async (_input: unknown) => null);
jest.mock('../run-reports/record.js', () => ({
  recordRunEnd: (input: unknown) => mockRecordRunEnd(input),
  failureCodeOf: (m: string) => m,
  outcomeOfJobStatus: () => 'failed',
}));

import { dispatchOnce } from '../job-dispatcher.js';
import { reapStaleJobs } from '../../providers/agent-jobs.js';

const reap = reapStaleJobs as jest.Mock;
const reported = () => mockRecordRunEnd.mock.calls.map((c) => c[0] as Record<string, unknown>);

beforeEach(() => { mockRecordRunEnd.mockClear(); reap.mockClear(); });

describe('run reports for jobs the stale sweep fails', () => {
  it('writes one failed report per failed id: worker_lost, the executor from the box, unknown cost, no debrief', async () => {
    await dispatchOnce();
    expect(reap).toHaveBeenCalledTimes(1);
    expect(reported()).toEqual([
      expect.objectContaining({
        runRef: 'j-fleet', executor: 'fleet', outcome: 'failed', failureCode: 'worker_lost',
        startedAt: '2026-11-11T09:00:00.000Z', billedUsd: null, worker: null, noDebrief: true,
      }),
      expect.objectContaining({ runRef: 'j-local', executor: 'local', outcome: 'failed', failureCode: 'worker_lost', startedAt: null }),
      expect.objectContaining({ runRef: 'j-vm', executor: 'microvm', outcome: 'failed', failureCode: 'worker_lost' }),
    ]);
  });

  it('a requeued job gets no report, and a report that cannot be written never stops the sweep', async () => {
    reap.mockResolvedValueOnce({ requeued: 2, failed: 2, failedIds: ['j-fleet', 'j-vm'] });
    mockRecordRunEnd.mockRejectedValueOnce(new Error('report store down'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await expect(dispatchOnce()).resolves.toBeUndefined();
    } finally {
      warn.mockRestore();
    }
    expect(reported().map((r) => r['runRef'])).toEqual(['j-fleet', 'j-vm']);
  });

  it('a job gone between the sweep and the report is still reported, as a fleet run with no start', async () => {
    reap.mockResolvedValueOnce({ requeued: 0, failed: 1, failedIds: ['j-vanished'] });
    await dispatchOnce();
    expect(reported()).toEqual([
      expect.objectContaining({ runRef: 'j-vanished', executor: 'fleet', failureCode: 'worker_lost', startedAt: null }),
    ]);
  });

  it('a quiet sweep writes nothing, and an older sweep shape without ids is tolerated', async () => {
    reap.mockResolvedValueOnce({ requeued: 0, failed: 0, failedIds: [] });
    await dispatchOnce();
    reap.mockResolvedValueOnce({ requeued: 0, failed: 0 });
    await dispatchOnce();
    expect(reported()).toEqual([]);
  });
});

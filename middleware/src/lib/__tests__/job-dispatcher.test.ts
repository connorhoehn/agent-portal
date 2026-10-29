jest.mock('../../providers/agent-jobs.js', () => ({
  claimNextJob: jest.fn(), markRunning: jest.fn(), completeJob: jest.fn(), heartbeatJob: jest.fn(), unclaimJob: jest.fn(async () => true),
  reapStaleJobs: jest.fn(async () => ({ requeued: 0, failed: 0 })), listJobs: jest.fn(async () => []),
}));
// The fleet as the dispatcher sees it; a test may age the box (DE-48 rule 3).
const fleet = { createdAt: new Date().toISOString() };
jest.mock('../devbox-fleet.js', () => ({
  listBoxes: () => [{ id: 'box', sessionId: 'session', status: 'idle', createdAt: fleet.createdAt }],
  appendEvent: jest.fn(), getBox: () => ({ id: 'box' }), registerBox: jest.fn(), isReserved: () => false,
}));
// Per-box profile policies (DE-40): none resolved → the deployment default.
jest.mock('../devbox-profile.js', () => ({ lifetimePoliciesFor: jest.fn(async () => new Map()) }));
jest.mock('../replica-fleet.js', () => ({ replicaFleet: jest.fn() }));
jest.mock('../../routes/devbox.js', () => ({ runDevboxTask: jest.fn() }));
jest.mock('../run-brief.js', () => ({ freezeJobBrief: jest.fn(async () => null) }));
jest.mock('../../providers/spend-ledger.js', () => ({
  recordSpend: jest.fn(async () => undefined),
  getBoxSpend: jest.fn(async () => new Map()), spendLedgerMode: () => 'off', ledgerIsFixture: () => false,
}));
// The spend hold (DE-34) is its own suite's business (spend-holds.test.ts); here it always holds.
jest.mock('../../lib/spend-holds.js', () => ({
  reserveSpend: jest.fn(async (i: { initiativeId: string | null }) => ({ kind: 'held', holdId: null, initiativeId: i.initiativeId, grantId: null, amountUsd: 0 })),
  forecastP75ForModel: jest.fn(async () => ({ costUsdP75: 0.5 })),
  HOLD_GRACE_MS: 300_000,
}));
jest.mock('../../providers/spend-holds.js', () => ({ releaseHold: jest.fn(async () => undefined), bindHoldSource: jest.fn(async () => undefined) }));
import { recordSpend } from '../../providers/spend-ledger.js';
import { claimNextJob, completeJob, heartbeatJob, markRunning, unclaimJob } from '../../providers/agent-jobs.js';
import { reserveSpend } from '../spend-holds.js';
import { releaseHold } from '../../providers/spend-holds.js';
import { runDevboxTask } from '../../routes/devbox.js';
import { appendEvent } from '../devbox-fleet.js';
import { dispatchOnce, dispatcherEvents, busyBoxes } from '../job-dispatcher.js';
const outcome = { ok: true, summary: 'done', transcript: [] };
const job = {
  id: 'job', boxId: 'box', sessionId: 'session', claimToken: 'private-attempt', attempts: 1, createdBy: 'u-sme', botId: null,
  payload: { prompt: 'go', requiresReview: false, initiativeId: 'p-auth-migration' },
};
const events: unknown[] = [];
const capture = (event: unknown) => events.push(event);
const untilIdle = async () => {
  for (let i = 0; i < 100 && busyBoxes().length; i++) await new Promise(resolve => setTimeout(resolve, 5));
  expect(busyBoxes()).toEqual([]);
};
beforeEach(() => {
  jest.clearAllMocks(); events.length = 0;
  (claimNextJob as jest.Mock).mockResolvedValueOnce(job).mockResolvedValue(null);
  (markRunning as jest.Mock).mockResolvedValue(true);
  (heartbeatJob as jest.Mock).mockResolvedValue(true);
  (completeJob as jest.Mock).mockResolvedValue(true);
  (runDevboxTask as jest.Mock).mockResolvedValue(outcome);
  dispatcherEvents.on('job', capture);
});
afterEach(() => dispatcherEvents.off('job', capture));

it('passes the winning token to every write and keeps it out of UI events', async () => {
  await dispatchOnce(); await untilIdle();
  expect(markRunning).toHaveBeenCalledWith('job', 'private-attempt');
  expect(completeJob).toHaveBeenCalledWith('job', expect.objectContaining({ claimToken: 'private-attempt', status: 'done' }));
  expect(runDevboxTask).toHaveBeenCalledWith(expect.objectContaining({ signal: expect.any(AbortSignal) }));
  expect(JSON.stringify(events)).not.toContain('private-attempt');
  expect(events).toContainEqual(expect.objectContaining({ kind: 'done' }));
});

it('states the policy\'s default task timeout instead of leaving the image to pick (DE-48)', async () => {
  await dispatchOnce(); await untilIdle();
  expect(runDevboxTask).toHaveBeenCalledWith(expect.objectContaining({ timeoutSeconds: 840 }));
});

it('never hands a job to a box without ceiling left for one default task plus grace', async () => {
  const fresh = fleet.createdAt;
  fleet.createdAt = new Date(Date.now() - 4 * 3_600_000 + 10 * 60_000).toISOString(); // 10 min of a 4 h ceiling left
  try {
    await dispatchOnce(); await untilIdle();
    expect(claimNextJob).not.toHaveBeenCalled();
    expect(runDevboxTask).not.toHaveBeenCalled();
  } finally {
    fleet.createdAt = fresh;
  }
});

it('never starts the executor when the claim was revoked before running', async () => {
  (markRunning as jest.Mock).mockResolvedValue(false);
  await dispatchOnce(); await untilIdle();
  expect(runDevboxTask).not.toHaveBeenCalled();
  expect(completeJob).not.toHaveBeenCalled();
});

it('does not write a failure when the initial heartbeat cannot prove ownership', async () => {
  (heartbeatJob as jest.Mock).mockRejectedValue(new Error('database unavailable'));
  await dispatchOnce(); await untilIdle();
  expect(runDevboxTask).not.toHaveBeenCalled();
  expect(completeJob).not.toHaveBeenCalled();
});

it('publishes no terminal event when SQL refuses an obsolete result', async () => {
  (completeJob as jest.Mock).mockResolvedValue(false);
  await dispatchOnce(); await untilIdle();
  expect(events).not.toContainEqual(expect.objectContaining({ kind: 'done' }));
  expect(appendEvent).not.toHaveBeenCalledWith('box', expect.objectContaining({ type: 'job_finished' }));
});

describe('spend ledger (DE-30)', () => {
  it('writes one job entry per attempt, attributed to the served initiative and its requester', async () => {
    (runDevboxTask as jest.Mock).mockResolvedValue({ ...outcome, costUsd: 0.42 });
    await dispatchOnce(); await untilIdle();
    expect(recordSpend).toHaveBeenCalledTimes(1);
    expect(recordSpend).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'job', sourceId: 'job:1', initiativeId: 'p-auth-migration', actorId: 'u-sme', boxId: 'box', costUsd: 0.42 }),
      { unlessBotRunOwnsJob: 'job' },
    );
  });

  it('records an unreported cost as null, which the ledger stores as unknown', async () => {
    await dispatchOnce(); await untilIdle();
    expect(recordSpend).toHaveBeenCalledWith(expect.objectContaining({ costUsd: null }), expect.anything());
  });

  it('records unknown cost when the task throws after it started', async () => {
    (runDevboxTask as jest.Mock).mockRejectedValue(new Error('runtime went away'));
    await dispatchOnce(); await untilIdle();
    expect(recordSpend).toHaveBeenCalledWith(expect.objectContaining({ source: 'job', costUsd: null }), expect.anything());
  });

  it('writes nothing for a job a bot enqueued: the bot_run carries that money', async () => {
    (claimNextJob as jest.Mock).mockReset().mockResolvedValueOnce({ ...job, botId: 'bot-1' }).mockResolvedValue(null);
    (runDevboxTask as jest.Mock).mockResolvedValue({ ...outcome, costUsd: 1 });
    await dispatchOnce(); await untilIdle();
    expect(recordSpend).not.toHaveBeenCalled();
  });
});

// DE-34: the dispatcher holds a job's p75 between the claim and markRunning.
it('holds the job\'s forecast under its payload initiative and creator, keyed by the attempt', async () => {
  await dispatchOnce(); await untilIdle();
  expect(reserveSpend).toHaveBeenCalledWith(expect.objectContaining({
    initiativeId: 'p-auth-migration', actorId: 'u-sme', source: 'job', sourceId: 'job:1',
  }));
  expect(recordSpend).toHaveBeenCalledWith(expect.objectContaining({ source: 'job', sourceId: 'job:1', provider: 'bedrock' }), expect.anything());
});

it('a money refusal hands the job back to the queue without burning an attempt, and never runs it', async () => {
  (reserveSpend as jest.Mock).mockResolvedValueOnce({ kind: 'confirm', gate: 'allocation', confirmFlag: 'confirmOverAllocation', reason: 'allocation exhausted', confidence: 'prior' });
  await dispatchOnce(); await untilIdle();
  expect(unclaimJob).toHaveBeenCalledWith('job', 'private-attempt');
  expect(markRunning).not.toHaveBeenCalled();
  expect(runDevboxTask).not.toHaveBeenCalled();
  expect(events).toContainEqual(expect.objectContaining({ kind: 'held_back', reason: 'allocation exhausted' }));
});

it('a claim revoked after the hold gives the money back', async () => {
  (reserveSpend as jest.Mock).mockResolvedValueOnce({ kind: 'held', holdId: 'hold-1', initiativeId: 'p-auth-migration', grantId: null, amountUsd: 0.5 });
  (markRunning as jest.Mock).mockResolvedValue(false);
  await dispatchOnce(); await untilIdle();
  expect(releaseHold).toHaveBeenCalledWith('hold-1');
});

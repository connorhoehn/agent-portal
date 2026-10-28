jest.mock('../../providers/agent-jobs.js', () => ({
  claimNextJob: jest.fn(), markRunning: jest.fn(), completeJob: jest.fn(), heartbeatJob: jest.fn(),
  reapStaleJobs: jest.fn(async () => ({ requeued: 0, failed: 0 })), listJobs: jest.fn(async () => []),
}));
jest.mock('../devbox-fleet.js', () => ({
  listBoxes: () => [{ id: 'box', sessionId: 'session', status: 'idle' }],
  appendEvent: jest.fn(), getBox: () => ({ id: 'box' }), registerBox: jest.fn(), isReserved: () => false,
}));
jest.mock('../replica-fleet.js', () => ({ replicaFleet: jest.fn() }));
jest.mock('../../routes/devbox.js', () => ({ runDevboxTask: jest.fn() }));
jest.mock('../run-brief.js', () => ({ freezeJobBrief: jest.fn(async () => null) }));
jest.mock('../../providers/spend-ledger.js', () => ({ recordSpend: jest.fn(async () => undefined) }));
import { recordSpend } from '../../providers/spend-ledger.js';
import { claimNextJob, completeJob, heartbeatJob, markRunning } from '../../providers/agent-jobs.js';
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

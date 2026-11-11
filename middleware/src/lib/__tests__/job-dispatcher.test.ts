jest.mock('../../providers/agent-jobs.js', () => ({
  claimNextJob: jest.fn(), markRunning: jest.fn(), completeJob: jest.fn(), heartbeatJob: jest.fn(), unclaimJob: jest.fn(async () => true),
  reapStaleJobs: jest.fn(async () => ({ requeued: 0, failed: 0, failedIds: [] })), listJobs: jest.fn(async () => []),
}));
// The fleet as the dispatcher sees it; a test may age the box (DE-48 rule 3).
const fleet = { createdAt: new Date().toISOString(), occupancy: {} as Record<string, unknown> };
jest.mock('../devbox-fleet.js', () => ({
  listBoxes: () => [{ id: 'box', sessionId: 'session', status: 'idle', createdAt: fleet.createdAt }],
  appendEvent: jest.fn(), getBox: () => ({ id: 'box', ...fleet.occupancy }), registerBox: jest.fn(), isReserved: () => false,
  // The real hand-over rule over the box above; a test sets fleet.occupancy.
  changesHands: (...a: unknown[]) => jest.requireActual('../devbox-fleet.js').changesHands(...a),
  setOccupant: jest.fn(),
  isFleetOwnedBox: (...a: unknown[]) => jest.requireActual('../devbox-fleet.js').isFleetOwnedBox(...a),
  // The box claim (DE-47): this process's claim, released when the attempt ends.
  ...(() => {
    const held = new Set<string>();
    return {
      claimBox: jest.fn(async (id: string) => { if (held.has(id)) return false; held.add(id); return true; }),
      releaseBox: jest.fn((id: string) => { held.delete(id); }),
      refreshFromShared: jest.fn(async () => undefined),
      allHolds: () => new Map([...held].map((id) => [id, ['dispatcher:r-test']])),
    };
  })(),
}));
// Per-box profile policies (DE-40): none resolved → the deployment default.
jest.mock('../devbox-profile.js', () => ({ lifetimePoliciesFor: jest.fn(async () => new Map()) }));
jest.mock('../replica-fleet.js', () => ({ replicaFleet: jest.fn(), replicaId: () => 'r-test' }));
jest.mock('../../routes/devbox.js', () => ({ runDevboxTask: jest.fn(), wipeDevboxWorkspace: jest.fn(async () => ({ ok: true, removed: 3 })) }));
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
// Run limits and kill switches (DE-37/50): nothing limited or paused unless a test says so.
const controls = { fleetPaused: false, saturated: [] as string[], paused: null as null | { scope: string; reason: string | null } };
jest.mock('../../providers/run-limits.js', () => ({
  saturatedInitiatives: jest.fn(async () => controls.saturated),
  releaseRunSlots: jest.fn(async () => undefined),
}));
jest.mock('../fleet-switches.js', () => ({
  fleetPaused: jest.fn(async () => controls.fleetPaused),
  pauseFor: jest.fn(async () => controls.paused),
}));
import { recordSpend } from '../../providers/spend-ledger.js';
import { claimNextJob, completeJob, heartbeatJob, markRunning, unclaimJob } from '../../providers/agent-jobs.js';
import { reserveSpend } from '../spend-holds.js';
import { releaseHold } from '../../providers/spend-holds.js';
import { runDevboxTask, wipeDevboxWorkspace } from '../../routes/devbox.js';
import { appendEvent, setOccupant } from '../devbox-fleet.js';
import { dispatchOnce, dispatcherEvents, busyBoxes } from '../job-dispatcher.js';
import { RowsRunReportStore, privateRunReportSources } from '../run-reports/store-rows.js';
import { runReportStore, setRunReportStore } from '../run-reports/store-select.js';
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

it.each([
  [{ ok: false, failureCode: 'needs_gpu_pool', error: 'needs_gpu_pool: Waiting for a GPU node.' }, 'needs_gpu_pool'],
  [{ ok: false, error: 'The worker timed out.' }, 'timeout'],
  [{ ok: false, failureCode: 'needs_gpu_pool', error: 'Stopped at the ceiling.', cutoff: { reason: 'budget' } }, 'budget'],
  [{ ok: true, failureCode: 'needs_gpu_pool' }, null],
])('stores the structured code with budget and success precedence: %j', async (result, expected) => {
  const previous = runReportStore();
  const reports = new RowsRunReportStore(privateRunReportSources());
  setRunReportStore(reports);
  try {
    (runDevboxTask as jest.Mock).mockResolvedValue({ ...outcome, ...result });
    await dispatchOnce(); await untilIdle();
    expect((await reports.getReport(job.id))?.failureCode).toBe(expected);
  } finally {
    setRunReportStore(previous);
  }
});

describe('a box changing hands', () => {
  afterEach(() => { fleet.occupancy = {}; });

  it('wipes the workspace and refuses resume when the last occupant was someone else', async () => {
    fleet.occupancy = { lastOccupant: 'u-previous' };
    (claimNextJob as jest.Mock).mockReset().mockResolvedValueOnce({ ...job, payload: { ...job.payload, resume: true } }).mockResolvedValue(null);
    await dispatchOnce(); await untilIdle();
    expect(wipeDevboxWorkspace).toHaveBeenCalledWith('session');
    expect(runDevboxTask).toHaveBeenCalledWith(expect.objectContaining({ resume: false }));
    expect(appendEvent).toHaveBeenCalledWith('box', expect.objectContaining({ type: 'resume_refused' }));
    expect(appendEvent).toHaveBeenCalledWith('box', expect.objectContaining({ type: 'workspace_wiped', removed: 3 }));
    expect(setOccupant).toHaveBeenCalledWith('box', 'u-sme');
  });

  it('treats a used box with no recorded occupant as someone else\'s', async () => {
    fleet.occupancy = { currentTask: 'an earlier task' };
    await dispatchOnce(); await untilIdle();
    expect(wipeDevboxWorkspace).toHaveBeenCalledWith('session');
  });

  it('keeps the workspace and the resume for the same occupant', async () => {
    fleet.occupancy = { lastOccupant: 'u-sme' };
    (claimNextJob as jest.Mock).mockReset().mockResolvedValueOnce({ ...job, payload: { ...job.payload, resume: true } }).mockResolvedValue(null);
    await dispatchOnce(); await untilIdle();
    expect(wipeDevboxWorkspace).not.toHaveBeenCalled();
    expect(runDevboxTask).toHaveBeenCalledWith(expect.objectContaining({ resume: true }));
  });

  it('never wipes a personal or an initiative computer, but still refuses to resume another\'s conversation', async () => {
    for (const owned of [{ ownerId: 'u-owner' }, { projectId: 'p-1' }]) {
      (wipeDevboxWorkspace as jest.Mock).mockClear();
      (runDevboxTask as jest.Mock).mockClear();
      fleet.occupancy = { lastOccupant: 'u-previous', ...owned };
      (claimNextJob as jest.Mock).mockReset().mockResolvedValueOnce({ ...job, payload: { ...job.payload, resume: true } }).mockResolvedValue(null);
      await dispatchOnce(); await untilIdle();
      expect(wipeDevboxWorkspace).not.toHaveBeenCalled();
      expect(runDevboxTask).toHaveBeenCalledWith(expect.objectContaining({ resume: false }));
    }
  });

  it('an unknown occupant (after a restart without the field) wipes a fleet box only', async () => {
    fleet.occupancy = { currentTask: 'an earlier task', ownerId: 'u-owner' };
    await dispatchOnce(); await untilIdle();
    expect(wipeDevboxWorkspace).not.toHaveBeenCalled();
    expect(runDevboxTask).toHaveBeenCalled();
  });

  it('fails the job rather than run it on the previous occupant\'s files when the wipe fails', async () => {
    fleet.occupancy = { lastOccupant: 'u-previous' };
    (wipeDevboxWorkspace as jest.Mock).mockResolvedValueOnce({ ok: false, error: 'runtime unreachable' });
    await dispatchOnce(); await untilIdle();
    expect(runDevboxTask).not.toHaveBeenCalled();
    expect(completeJob).toHaveBeenCalledWith('job', expect.objectContaining({ status: 'failed', error: expect.stringContaining('wipe') }));
  });
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


// ─── DE-37 / DE-50 ────────────────────────────────────────────────────────────

describe('run limits and kill switches at the dispatcher', () => {
  afterEach(() => { controls.fleetPaused = false; controls.saturated = []; controls.paused = null; });

  it('a run-limit refusal hands the job back to the queue with its attempt unburned', async () => {
    (reserveSpend as jest.Mock).mockResolvedValueOnce({
      kind: 'limited', reason: 'initiative p-auth-migration is at its limit of 1 concurrent run', limitKind: 'concurrency',
      scope: { kind: 'initiative', id: 'p-auth-migration' }, limit: 1, current: 1, retryAfterS: 30,
    });
    await dispatchOnce(); await untilIdle();
    expect(unclaimJob).toHaveBeenCalledWith('job', 'private-attempt');
    expect(markRunning).not.toHaveBeenCalled();
    expect(runDevboxTask).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({ kind: 'held_back', reason: expect.stringContaining('limit of 1') }));
  });

  it('a paused fleet claims nothing', async () => {
    controls.fleetPaused = true;
    (claimNextJob as jest.Mock).mockClear();
    await dispatchOnce(); await untilIdle();
    expect(claimNextJob).not.toHaveBeenCalled();
    expect(runDevboxTask).not.toHaveBeenCalled();
  });

  it('a saturated initiative\'s jobs are skipped by the claim, not at the queue head', async () => {
    controls.saturated = ['p-auth-migration'];
    (claimNextJob as jest.Mock).mockClear();
    await dispatchOnce(); await untilIdle();
    expect(claimNextJob).toHaveBeenCalledWith('box', 'session', { skipInitiatives: ['p-auth-migration'] });
  });
});

// Two dispatchers (two middleware replicas) over one shared fleet store hand
// a box ONE job (DE-47). Each dispatcher is its own module copy with its own
// fleet registry (jest.isolateModules); the job queue and the runtime are
// shared fakes, the way Aurora and AgentCore are shared between two tasks.

// The queue, shared by both replicas: SKIP LOCKED hands each caller a
// different job, so without a box claim both would land on the same box.
const mockQueue = {
  claimNextJob: jest.fn(),
  markRunning: jest.fn(async () => true),
  completeJob: jest.fn(async () => true),
  heartbeatJob: jest.fn(async () => true),
  unclaimJob: jest.fn(async () => true),
  reapStaleJobs: jest.fn(async () => ({ requeued: 0, failed: 0 })),
  listJobs: jest.fn(async () => []),
};
const mockRuntime = { runDevboxTask: jest.fn() };
let mockReplicaCounter = 0;

jest.mock('../../providers/agent-jobs.js', () => mockQueue);
jest.mock('../../routes/devbox.js', () => mockRuntime);
// Each module registry is one replica with its own identity.
jest.mock('../replica-fleet.js', () => {
  const id = `task-${++mockReplicaCounter}`;
  return { replicaFleet: jest.fn(), replicaId: () => id };
});
jest.mock('../devbox-profile.js', () => ({ lifetimePoliciesFor: jest.fn(async () => new Map()) }));
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

import { createMemoryFleetBackend } from '../devbox-fleet-shared.js';

type FleetMod = typeof import('../devbox-fleet.js');
type DispatcherMod = typeof import('../job-dispatcher.js');

const SESSION = 's'.repeat(40);
const replicas: { fleet: FleetMod; dispatcher: DispatcherMod }[] = [];

function replica(world: ReturnType<typeof createMemoryFleetBackend>, replicaId: string) {
  let out!: { fleet: FleetMod; dispatcher: DispatcherMod };
  jest.isolateModules(() => {
    out = {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      fleet: require('../devbox-fleet.js') as FleetMod,
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      dispatcher: require('../job-dispatcher.js') as DispatcherMod,
    };
  });
  out.fleet.hydrateBoxes([{
    id: 'box', label: 'box', sessionId: SESSION, status: 'idle',
    createdAt: new Date().toISOString(), lastActivityAt: new Date().toISOString(),
  }]);
  out.fleet.attachSharedFleet(world, { replicaId, touchFlushMs: 0 });
  replicas.push(out);
  return out;
}

const job = (id: string) => ({
  id, boxId: 'box', sessionId: SESSION, claimToken: `token-${id}`, attempts: 1, createdBy: 'u-sme', botId: null,
  payload: { prompt: 'go', requiresReview: false },
});

afterEach(() => {
  for (const r of replicas.splice(0)) r.fleet._resetFleet();
  jest.clearAllMocks();
});

it('two dispatchers sharing one store claim a box once', async () => {
  const queue = [job('job-1'), job('job-2')];
  mockQueue.claimNextJob.mockImplementation(async () => queue.shift() ?? null);
  let finish!: () => void;
  mockRuntime.runDevboxTask.mockImplementation(() => new Promise((resolve) => {
    finish = () => resolve({ ok: true, summary: 'done', transcript: [] });
  }));

  const world = createMemoryFleetBackend();
  const one = replica(world, 'task-a');
  const two = replica(world, 'task-b');
  const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    await Promise.all([one.dispatcher.dispatchOnce(), two.dispatcher.dispatchOnce()]);
    for (let i = 0; i < 50 && mockRuntime.runDevboxTask.mock.calls.length === 0; i++) await new Promise((r) => setImmediate(r));

    expect(mockQueue.claimNextJob).toHaveBeenCalledTimes(1);
    expect(mockRuntime.runDevboxTask).toHaveBeenCalledTimes(1);
    expect(queue.map((j) => j.id)).toEqual(['job-2']);     // the second job is still queued

    // Both replicas report the box busy: one runs it, the other sees the claim.
    await two.fleet.refreshSharedHolds();
    expect(one.dispatcher.busyBoxes()).toEqual(['box']);
    expect(two.dispatcher.busyBoxes()).toEqual(['box']);

    // When the run ends the claim is released and the next tick may use the box.
    finish();
    for (let i = 0; i < 50 && one.fleet.localHolds().size; i++) await new Promise((r) => setImmediate(r));
    expect(one.fleet.localHolds().size).toBe(0);
    await two.dispatcher.dispatchOnce();
    expect(mockQueue.claimNextJob).toHaveBeenCalledTimes(2);
  } finally {
    finish?.();
    log.mockRestore();
  }
});

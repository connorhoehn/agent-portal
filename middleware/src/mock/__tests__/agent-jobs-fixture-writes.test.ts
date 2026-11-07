// The agent job queue — `agent_jobs`, offline — used to be a bare
// module-level array (`MOCK_JOBS`) plus a bare `Map` (`MOCK_CLAIM_TOKENS`) in
// providers/agent-jobs.ts. Neither registered with the fixture registry, so
// `POST /api/__mock/reset` could not undo a claim, a start, a heartbeat or a
// completed run — `mock/core/wire/write-policy.ts` refused the whole
// pull-side lifecycle as `unresettable`, and the jest-only `_resetMockQueue()`
// was the one thing that ever put the queue back.
//
// Both now live behind `mock/agent-jobs.ts`'s registered `agent-jobs`
// fixture, so this test proves the property that mattered: a full
// enqueue → claim → start → heartbeat → complete cycle lands for real, and
// `POST /api/__mock/reset` (here, `fixtureRegistry.resetAll`, which is what
// that route calls) puts the seed back — the new job gone, the claim token
// gone, the seeded bot-run jobs exactly as they were. Same shape as
// domain-fixture-writes.test.ts's tests for work-items/promotions/etc.

jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', mock: { aurora: true, agentcore: true } },
}));

import { freezeClock, fixtureRegistry } from '../core/index.js';
import { MOCK_CLAIM_TOKENS } from '../agent-jobs.js';
import {
  enqueueJob, listJobs, getJob, claimNextJobForWorker,
  markRunning, heartbeatJob, completeJob, queueStats, _resetMockQueue,
} from '../../providers/agent-jobs.js';

let restore = () => {};

function freeze(at: string): void {
  restore();
  restore = freezeClock(at);
}

beforeEach(() => {
  fixtureRegistry.resetAll('default');
});

afterEach(() => {
  restore();
  restore = () => {};
  fixtureRegistry.resetAll('default');
});

describe('the agent job queue (agent-jobs)', () => {
  it('enqueue -> claim -> start -> heartbeat -> complete lands, then fixtureRegistry.resetAll (what POST /api/__mock/reset calls) puts the seed back', async () => {
    freeze('2026-09-16T08:00:00.000Z');

    const before = await listJobs({ limit: 200 });
    const beforeIds = before.map((j) => j.id).sort();
    const beforeStats = await queueStats();

    const job = await enqueueJob({
      kind: 'local:task',
      title: 'wire capture smoke test',
      payload: { prompt: 'echo hello', nodeId: 'node-operator-thinkpad' },
    });
    expect(job).not.toBeNull();
    expect(job!.status).toBe('queued');

    // The row is visible through the same read path a route would use, before
    // any reset — proving the write actually landed, not an echo-back.
    const listedAfterEnqueue = await listJobs({ status: 'queued', limit: 200 });
    expect(listedAfterEnqueue.map((j) => j.id)).toContain(job!.id);

    const claim = await claimNextJobForWorker({
      boxId: 'local-node-operator-thinkpad',
      sessionId: 'sess-wire-capture',
      kinds: ['local:task'],
      nodeId: 'node-operator-thinkpad',
    });
    expect(claim).not.toBeNull();
    expect(claim!.job.id).toBe(job!.id);
    expect(claim!.job.status).toBe('claimed');
    expect(MOCK_CLAIM_TOKENS.get(job!.id)).toBe(claim!.claimToken);

    expect(await markRunning(claim!.job.id, claim!.claimToken)).toBe(true);
    expect(await heartbeatJob(claim!.job.id, claim!.claimToken)).toBe(true);
    expect(await completeJob(claim!.job.id, {
      status: 'done',
      result: { summary: 'wire capture: ok' },
      claimToken: claim!.claimToken,
    })).toBe(true);

    const finished = await getJob(job!.id);
    expect(finished?.status).toBe('done');
    expect(finished?.result?.['summary']).toBe('wire capture: ok');
    // completeJob clears the fencing token on success — a straggler retrying
    // the same POST must not be able to double-write.
    expect(MOCK_CLAIM_TOKENS.has(job!.id)).toBe(false);

    // What POST /api/__mock/reset does with no `fixture` in the body: reset
    // every registered fixture, agent-jobs included.
    fixtureRegistry.resetAll('default');

    const after = await listJobs({ limit: 200 });
    expect(after.map((j) => j.id).sort()).toEqual(beforeIds);
    expect(await getJob(job!.id)).toBeNull();
    expect(await queueStats()).toEqual(beforeStats);
    expect(MOCK_CLAIM_TOKENS.size).toBe(0);
  });

  it('_resetMockQueue (the jest hook the older route tests still call) resolves to the same reset and also clears live claim tokens', async () => {
    freeze('2026-09-16T09:00:00.000Z');
    const beforeIds = (await listJobs({ limit: 200 })).map((j) => j.id).sort();

    const job = await enqueueJob({ kind: 'devbox:task', title: 'jest-hook smoke test', payload: { nodeId: 'node-operator-thinkpad' } });
    const claim = await claimNextJobForWorker({
      boxId: 'local-node-operator-thinkpad',
      sessionId: 'sess-jest-hook',
      nodeId: 'node-operator-thinkpad',
      // `devbox:task` is not a local kind, but claimNextJobForWorker only
      // filters by the kinds THIS call asks for — proving the token map
      // itself resets, not the routing rules, is the point here.
      kinds: ['devbox:task'],
    });
    expect(claim).not.toBeNull();
    expect(MOCK_CLAIM_TOKENS.get(job!.id)).toBe(claim!.claimToken);

    _resetMockQueue();

    expect((await listJobs({ limit: 200 })).map((j) => j.id).sort()).toEqual(beforeIds);
    expect(await getJob(job!.id)).toBeNull();
    expect(MOCK_CLAIM_TOKENS.size).toBe(0);
  });
});

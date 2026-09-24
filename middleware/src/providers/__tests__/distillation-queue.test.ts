// The compaction queue consumer, the tier digests and the L2 replica —
// spec §3b/§3c. Against the real provider, the in-process queue (the MOCK_QUEUE
// backend) and distributed-core's MerkleTree/MerkleSyncer; nothing stubbed but
// config and the Bedrock/Aurora modules the provider's imports drag in.
//
// Pinned:
//   - a pass travels send → receive → run → ack, and its job carries the
//     batch it claimed, its outputs, a log and a what_changed sentence;
//   - a redelivered message for a finished job is acked WITHOUT running again
//     (the job id is the idempotency key) and says so in the job's log;
//   - a pass that keeps failing is retried, then marked failed on its last
//     allowed delivery, and the queue moves the message to the DLQ;
//   - a digest changes when, and only when, its tier's content changes;
//   - a divergent replica converges under anti-entropy, repairing > 0 keys.

jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', mock: { aurora: true }, auth: {}, messageQueue: { mock: true } },
}));
jest.mock('@aws-sdk/client-bedrock-agent', () => ({
  BedrockAgentClient: class { send() { return Promise.resolve({}); } },
  ListPromptsCommand: class {},
}));
jest.mock('../aurora.js', () => ({ exec: jest.fn() }));

import {
  compactNow, listCompactions, levelsView, pumpCompactionQueue, processCompactionMessage,
  l2Replica, replicationStatus, publishArtifact, __resetDistillationMock, __setCompactRunMs, __failNextCompactions,
} from '../distillation.js';
import { clusters, artifacts, observations } from '../../mock/distillation.js';
import { distillationQueueMessages } from '../../mock/distillation-queue.js';
import { compactionQueue, COMPACTION_QUEUES, COMPACTION_DLQS, MAX_RECEIVES, VISIBILITY_TIMEOUT_S } from '../../lib/distillation-queue.js';
import { tierDigest } from '../../lib/distillation-digest.js';
import { resolveArtifact } from '../../lib/distillation-replica.js';
import { distillationEvents } from '../../lib/distillation-events.js';
import { freezeClock, unfreezeClock, clock } from '../../mock/core/index.js';

beforeEach(() => { __resetDistillationMock(); __setCompactRunMs(0); });
afterAll(() => { __resetDistillationMock(); });

describe('compaction over the queue', () => {
  it('runs a pass through send → receive → run → ack, and the job describes the run', async () => {
    const before = clusters.rows().length;
    const frames: string[] = [];
    const onJob = (id: string) => frames.push(id);
    distillationEvents.on('job', onJob);
    const job = await compactNow('L1', 'Test Operator');
    distillationEvents.off('job', onJob);

    expect(job.status).toBe('succeeded');
    expect(job.queue).toBe('distill-compact-l1');
    expect(job.requested_by).toBe('Test Operator');
    expect(job.output_ids).toEqual(job.produced.cluster_ids);
    expect(clusters.rows().length - before).toBe(job.output_ids.length);
    // input_ids are counted back out of what it produced — the member notes.
    const members = clusters.rows().filter((c) => job.output_ids.includes(c.id)).flatMap((c) => c.member_observation_ids);
    expect(job.input_ids.slice().sort()).toEqual(members.slice().sort());
    expect(job.inputItems).toBe(job.input_ids.length);
    expect(job.what_changed).toMatch(/^Merged \d+ run notes? into \d+ patterns?/);
    expect(job.log.map((l) => l.message)).toEqual(expect.arrayContaining([
      expect.stringMatching(/^Queued on distill-compact-l1/),
      expect.stringMatching(/^Claimed from distill-compact-l1 \(delivery 1\)/),
    ]));
    expect(job.duration_ms).not.toBeNull();
    expect(job.cost_usd).toBe(job.costUsd);
    // One frame per transition: queued, claim, read, merge, write, done.
    expect(frames.filter((f) => f === job.id).length).toBeGreaterThanOrEqual(6);
    // Acked: nothing left on the queue.
    expect(distillationQueueMessages.rows()).toEqual([]);
  });

  it('scopes a pass to one repo — its FIFO group — and leaves other repos waiting', async () => {
    const repo = 'connorhoehnslalom/orgiq-finops';
    const job = await compactNow('L1', 'Test Operator', repo);
    expect(job.status).toBe('succeeded');
    expect(job.repo).toBe(repo);
    const made = clusters.rows().filter((c) => job.output_ids.includes(c.id));
    expect(made.length).toBeGreaterThan(0);
    expect(made.every((c) => c.repo === repo)).toBe(true);
    const clustered = new Set(clusters.rows().flatMap((c) => c.member_observation_ids));
    expect(observations.rows().some((o) => o.repo !== repo && !clustered.has(o.id))).toBe(true);
  });

  it('acks a redelivered message for a finished job without running it again', async () => {
    const job = await compactNow('L1', 'Test Operator');
    const clustersAfter = clusters.rows().length;
    const q = compactionQueue();
    // A redelivery the way the queue produces one: the same job id sent again.
    await q.send(COMPACTION_QUEUES.L1, JSON.stringify({ job_id: job.id, level: 'L1', repo: null }), { groupId: 'redelivery' });
    const [msg] = await q.receive(COMPACTION_QUEUES.L1);
    expect(await processCompactionMessage('L1', msg!)).toBe('duplicate');
    expect(clusters.rows().length).toBe(clustersAfter);
    expect(job.status).toBe('succeeded');
    expect(job.log.at(-1)!.message).toMatch(/Redelivered by distill-compact-l1 .* acknowledged without running again/);
    expect(distillationQueueMessages.rows()).toEqual([]);
  });

  it('retries a failing pass, then fails the job and dead-letters the message after MAX_RECEIVES', async () => {
    // Lease expiry is decided on the mock clock: freeze it, and step it past
    // the visibility timeout between deliveries.
    let t = Date.parse(clock.nowIso());
    freezeClock(new Date(t).toISOString());
    const advance = (ms: number): void => { t += ms; freezeClock(new Date(t).toISOString()); };
    try {
      __failNextCompactions(MAX_RECEIVES);
      // The synchronous seam drains until nothing is deliverable — after the
      // first failure the message is leased, waiting out its timeout.
      const job = await compactNow('L1', 'Test Operator');
      expect(job.status).toBe('queued');
      expect(job.phase).toBe('retrying');
      expect(job.attempts).toBe(1);
      for (let delivery = 2; delivery <= MAX_RECEIVES; delivery += 1) {
        advance(VISIBILITY_TIMEOUT_S * 1000 + 1_000);
        expect(await pumpCompactionQueue('L1')).toBe(1);
        expect(job.attempts).toBe(delivery);
      }
      expect(job.status).toBe('failed');
      expect(job.error).toMatch(/gave up after 3 deliveries/);
      expect(job.produced.cluster_ids).toEqual([]);
      expect(job.log.filter((l) => l.level === 'warn')).toHaveLength(MAX_RECEIVES - 1);
      // The next receive after the lease: the queue redrives instead of delivering.
      advance(VISIBILITY_TIMEOUT_S * 1000 + 1_000);
      expect(await pumpCompactionQueue('L1')).toBe(0);
      const dead = distillationQueueMessages.rows();
      expect(dead).toHaveLength(1);
      expect(dead[0]!.queue).toBe(COMPACTION_DLQS.L1);
      expect(dead[0]!.dead_lettered_from).toBe(COMPACTION_QUEUES.L1);
    } finally {
      unfreezeClock();
    }
  });

  it('lists a queued job with the new run fields and null duration', async () => {
    __setCompactRunMs(60_000);
    const job = await compactNow('L2', 'Test Operator');
    expect(job.status).toBe('queued');
    const listed = (await listCompactions({ status: 'queued' })).find((j) => j.id === job.id)!;
    const wire = JSON.parse(JSON.stringify(listed)) as Record<string, unknown>;
    for (const key of ['input_ids', 'output_ids', 'log', 'what_changed', 'duration_ms', 'cost_usd', 'phase', 'percent', 'stepLabel', 'queued_at', 'queue', 'repo']) {
      expect(wire).toHaveProperty(key);
    }
    expect(wire['duration_ms']).toBeNull();
    expect(wire['what_changed']).toMatch(/^Waiting on distill-compact-l2/);
  });
});

describe('tier digests', () => {
  it('change when and only when the tier content changes', async () => {
    const d1 = (await levelsView()).levels.map((l) => l.digest);
    const d2 = (await levelsView()).levels.map((l) => l.digest);
    expect(d2).toEqual(d1);                          // a second read: no change
    expect(new Set(d1).size).toBe(3);                // three tiers, three roots

    // Reordering the rows is not a content change.
    const rows = artifacts.rows();
    rows.reverse();
    expect((await levelsView()).levels[2]!.digest).toBe(d1[2]);
    rows.reverse();

    // Publishing a draft bumps its updated_at: L2 moves, L0/L1 do not.
    const draft = rows.find((a) => a.status === 'draft')!;
    await publishArtifact(draft.id, 'Test');
    const d3 = (await levelsView()).levels.map((l) => l.digest);
    expect(d3[2]).not.toBe(d1[2]);
    expect(d3[0]).toBe(d1[0]);
    expect(d3[1]).toBe(d1[1]);
  });

  it('is deterministic over (id, stamp) and sensitive to either', async () => {
    const a = await tierDigest([{ id: 'x', stamp: '1' }, { id: 'y', stamp: '2' }]);
    expect(await tierDigest([{ id: 'y', stamp: '2' }, { id: 'x', stamp: '1' }])).toBe(a);
    expect(await tierDigest([{ id: 'x', stamp: '1' }, { id: 'y', stamp: '3' }])).not.toBe(a);
    expect(await tierDigest([{ id: 'x', stamp: '1' }])).not.toBe(a);
  });
});

describe('levels carry writers, backlog, lastCompletedAt and health', () => {
  it('counts every field from rows', async () => {
    const { levels } = await levelsView();
    const [l0, l1, l2] = levels;
    expect(l0!.writers).toBeGreaterThan(0);               // NEW1..3 landed within the hour
    expect(l0!.lastCompletedAt).toBeNull();
    const clustered = new Set(clusters.rows().flatMap((c) => c.member_observation_ids));
    expect(l0!.backlog).toBe(observations.rows().filter((o) => !clustered.has(o.id)).length);
    expect(l2!.backlog).toBe(artifacts.rows().filter((a) => a.status === 'draft').length);
    expect(l1!.lastCompletedAt).not.toBeNull();
    expect(l2!.health.state).toBe('stalled');
    expect(l1!.health.state).toBe('behind');
    expect(l0!.health.state).toBe('ok');
    expect(l1!.health.lagSeconds).toBe(l1!.lagSeconds);
  });
});

describe('the L2 replica under anti-entropy', () => {
  it('starts empty, converges on the first sweep, and reports in sync', async () => {
    const replica = l2Replica();
    const before = await replicationStatus();
    expect(before.inSync).toBe(false);
    const res = await replica.sync();
    expect(res.keysRepaired).toBe(artifacts.rows().length);
    const after = await replicationStatus();
    expect(after.inSync).toBe(true);
    expect(after.replicas[0]!.digest).toBe(after.primary.digest);
    expect(after.primary.digest).toBe((await levelsView()).levels[2]!.digest);
    expect(after.replicas[0]!.lagMs).toBe(0);
    expect(after.replicas[0]!.lastSync).not.toBeNull();
  });

  it('repairs a divergent replica: a missing key, a stale value and a phantom', async () => {
    const replica = l2Replica();
    await replica.sync();
    const [first, second] = artifacts.rows();
    await replica.store.delete(first!.id);
    await replica.store.put(second!.id, { ...second!, title: 'stale copy', updated_at: '2020-01-01T00:00:00.000Z' });
    await replica.store.put('art-phantom', { ...second!, id: 'art-phantom' });
    expect((await replicationStatus()).inSync).toBe(false);

    const res = await replica.sync();
    expect(res.keysRepaired).toBeGreaterThan(0);
    expect(res.keysRepaired).toBe(3);
    const status = await replicationStatus();
    expect(status.inSync).toBe(true);
    expect(status.replicas[0]!.repaired).toBeGreaterThanOrEqual(3);
    expect((await replica.store.get(second!.id))!.title).toBe(second!.title);
    expect(await replica.store.get('art-phantom')).toBeUndefined();
  });

  it('follows the primary after a publish', async () => {
    const replica = l2Replica();
    await replica.sync();
    const draft = artifacts.rows().find((a) => a.status === 'draft')!;
    await publishArtifact(draft.id, 'Test');
    expect((await replicationStatus()).inSync).toBe(false);
    await replica.sync();
    expect((await replica.store.get(draft.id))!.status).toBe('published');
    expect((await replicationStatus()).inSync).toBe(true);
  });

  it('resolves LWW on updated_at, and the primary wins an exact tie', () => {
    const base = artifacts.rows()[0]!;
    const older = { ...base, title: 'old', updated_at: '2026-01-01T00:00:00.000Z' };
    const newer = { ...base, title: 'new', updated_at: '2026-02-01T00:00:00.000Z' };
    expect(resolveArtifact(older, newer)!.title).toBe('new');
    expect(resolveArtifact({ ...newer, title: 'replica' }, { ...newer, title: 'primary' })!.title).toBe('primary');
    expect(resolveArtifact(newer, undefined)).toBeUndefined();
    expect(resolveArtifact(undefined, newer)).toBe(newer);
  });
});

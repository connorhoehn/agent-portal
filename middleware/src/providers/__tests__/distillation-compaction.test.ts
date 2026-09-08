// compactNow used to be a fabricated counter: it moved MOCK_LEVELS' item
// counts without touching the corpus, so a real "Compact L0 -> L1" press
// left the tier cards and the item lists disagreeing again and the job
// claiming it produced nothing (docs/distillation-journeys/member/DEFECTS.md
// #1). This suite pins the real behavior: compactNow actually mints new L1
// clusters / L2 artifacts from whatever hasn't been compacted yet, and
// levels()/getItem/listArtifacts/lineageFor all agree with the result
// immediately.

jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', mock: { aurora: true }, auth: {} },
}));
jest.mock('@aws-sdk/client-bedrock-agent', () => ({
  BedrockAgentClient: class { send() { return Promise.resolve({}); } },
  ListPromptsCommand: class {},
}));
jest.mock('../aurora.js', () => ({ exec: jest.fn() }));

import { clusters, artifacts } from '../../mock/distillation.js';
import {
  levels, compactNow, getItem, listArtifacts, lineageFor, __resetDistillationMock, __setCompactRunMs } from '../distillation.js';

// Every test in this file mutates the shared mock corpus (new clusters /
// artifacts / jobs) — reset before and after so no other suite in the same
// jest run sees the leftovers, regardless of file execution order.
beforeEach(() => { __resetDistillationMock(); });
afterAll(() => { __resetDistillationMock(); });

// A hand-triggered pass runs for 3s by default; these suites assert the
// corpus right after the call, so complete synchronously here.
beforeAll(() => __setCompactRunMs(0));

describe("compactNow('L1') really compacts, not a counter", () => {
  it('mints new clusters, and levels() L1 agrees with clusters.rows().length immediately', async () => {
    const before = await levels();
    const l0Before = before.find((l) => l.level === 'L0')!.items;
    const clustersBefore = clusters.rows().length;

    const job = await compactNow('L1', 'Test Operator');
    expect(job.level).toBe('L1');
    expect(job.inputItems).toBeGreaterThan(0);
    // input = output + deduped, always — the invariant every other seeded
    // job in this store already holds.
    expect(job.inputItems).toBe(job.outputItems + job.dedupedItems);
    expect(job.produced.cluster_ids.length).toBe(job.outputItems);
    expect(job.produced.artifact_ids).toEqual([]);

    expect(clusters.rows().length).toBe(clustersBefore + job.outputItems);

    const after = await levels();
    // Observations become cluster members, they are never deleted — L0's
    // count is the corpus length and doesn't move.
    expect(after.find((l) => l.level === 'L0')!.items).toBe(l0Before);
    expect(after.find((l) => l.level === 'L1')!.items).toBe(clusters.rows().length);
  });

  it('every produced cluster id resolves via getItem as a real, openable L1 item', async () => {
    const job = await compactNow('L1', 'Test Operator');
    expect(job.produced.cluster_ids.length).toBeGreaterThan(0);
    for (const id of job.produced.cluster_ids) {
      const item = await getItem(id);
      expect(item).not.toBeNull();
      expect(item!.level).toBe('L1');
      expect(item!.id).toBe(id);
    }
  });

  it('a second pass with nothing left unclustered still succeeds, honestly at 0/0/0', async () => {
    const first = await compactNow('L1', 'Test Operator');
    expect(first.inputItems).toBeGreaterThan(0);

    const second = await compactNow('L1', 'Test Operator');
    expect(second.status).toBe('succeeded');
    expect(second.inputItems).toBe(0);
    expect(second.outputItems).toBe(0);
    expect(second.dedupedItems).toBe(0);
    expect(second.produced).toEqual({ cluster_ids: [], artifact_ids: [] });
  });
});

describe("compactNow('L2') really compacts, not a counter", () => {
  it('mints new draft artifacts visible in listArtifacts({status:"draft"}), with lineage back to observations', async () => {
    const artifactsBefore = artifacts.rows().length;

    const job = await compactNow('L2', 'Test Operator');
    expect(job.level).toBe('L2');
    expect(job.inputItems).toBeGreaterThan(0);
    expect(job.inputItems).toBe(job.outputItems + job.dedupedItems);
    expect(job.produced.artifact_ids.length).toBe(job.outputItems);
    expect(job.produced.cluster_ids).toEqual([]);

    expect(artifacts.rows().length).toBe(artifactsBefore + job.outputItems);

    const drafts = await listArtifacts({ status: 'draft' });
    const newIds = new Set(job.produced.artifact_ids);
    expect(drafts.filter((a) => newIds.has(a.id)).length).toBe(job.produced.artifact_ids.length);

    for (const id of job.produced.artifact_ids) {
      const item = await getItem(id);
      expect(item?.level).toBe('L2');

      const lineage = await lineageFor(id, 3);
      expect(lineage.nodes.some((n) => n.id === id && n.kind === 'artifact')).toBe(true);
      expect(lineage.nodes.some((n) => n.kind === 'cluster')).toBe(true);
      expect(lineage.nodes.some((n) => n.kind === 'observation')).toBe(true);
    }
  });

  it('an artifact minted from a multi-cluster chunk carries one fact per member cluster', async () => {
    const job = await compactNow('L2', 'Test Operator');
    const multi = await Promise.all(job.produced.artifact_ids.map((id) => getItem(id)));
    const withMultipleClusters = multi.find((i) => i && i.level === 'L2' && i.cluster_ids.length > 1);
    if (withMultipleClusters && withMultipleClusters.level === 'L2') {
      expect(withMultipleClusters.facts.length).toBe(withMultipleClusters.cluster_ids.length);
    }
  });
});

// The audit saw every Compact resolve to `succeeded` in the same response —
// no observable running state. The job now starts `running` and completes
// after the run window, producing its items then.
describe('compactNow runs before it succeeds', () => {
  it('returns a running job that completes after the run window', async () => {
    __resetDistillationMock();
    __setCompactRunMs(3_000);
    jest.useFakeTimers();
    try {
      const job = await compactNow('L1', 'Test Operator');
      expect(job.status).toBe('running');
      expect(job.finishedAt).toBeNull();
      expect(job.produced.cluster_ids).toEqual([]);
      jest.advanceTimersByTime(3_000);
      expect(job.status).toBe('succeeded');
      expect(job.finishedAt).not.toBeNull();
      expect(job.produced.cluster_ids.length).toBeGreaterThan(0);
    } finally {
      jest.useRealTimers();
      __setCompactRunMs(0);
    }
  });
});

// L0 refills at the advertised ingest rate so a demo can run compaction more
// than once — round 3 found the pool exhausted after a single pass.
describe('simulated ingest keeps L0 fed', () => {
  it('mints observations per elapsed tick, never more than a tick\'s worth at once, and resets', async () => {
    __resetDistillationMock();
    const { simulateIngest } = await import('../distillation.js');
    const M = await import('../../mock/distillation.js');
    const before = M.observations.rows().length;
    expect(simulateIngest(Date.now() + 30_000)).toHaveLength(0);           // under a tick: nothing
    const minted = simulateIngest(Date.now() + 2 * 60_000 + 5_000);       // two ticks
    expect(minted.length).toBeGreaterThan(0);
    expect(M.observations.rows().length).toBe(before + minted.length);
    for (const o of minted) { expect(o.id).toMatch(/^obs-9\d{3}$/); expect(o.created_at).toBeTruthy(); }
    const byLevel = Object.fromEntries((await levels()).map((l) => [l.level, l.items]));
    expect(byLevel['L0']).toBe(M.observations.rows().length);
    __resetDistillationMock();
    expect(M.observations.rows().length).toBe(before);
  });
});

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

import {
  clusters, artifacts, facts, observations,
  type Cluster, type Observation, type ObservationKind,
} from '../../mock/distillation.js';
import { freezeClock } from '../../mock/core/index.js';
import {
  levels, compactNow, getItem, listArtifacts, lineageFor, __resetDistillationMock, __setCompactRunMs,
  startCompactionConsumer,
  isProceduralChunk, procedureHealth, type ProcedureView,
} from '../distillation.js';

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

  // The fact shape is decided per chunk: a procedural chunk's facts are its
  // ordered steps (one observation each), any other chunk keeps one
  // `supports` claim per member cluster with no ordinal.
  it('a non-procedural chunk carries one ordinal-free fact per member cluster; a procedural one carries ordered steps', async () => {
    const job = await compactNow('L2', 'Test Operator');
    const byId = new Map(observations.rows().map((o) => [o.id, o]));
    const minted = await Promise.all(job.produced.artifact_ids.map((id) => getItem(id)));
    expect(minted.length).toBeGreaterThan(0);
    for (const item of minted) {
      if (!item || item.level !== 'L2') throw new Error('produced artifact id did not resolve as L2');
      const memberClusters = clusters.rows().filter((c) => item.cluster_ids.includes(c.id));
      const itsFacts = facts.rows().filter((f) => f.artifact_id === item.id);
      expect(itsFacts.map((f) => f.id).sort()).toEqual(item.facts.slice().sort());
      if (item.type === 'procedure') {
        expect(isProceduralChunk(memberClusters, byId)).toBe(true);
        const ordinals = itsFacts.filter((f) => f.ordinal !== null).map((f) => f.ordinal).sort((a, b) => a! - b!);
        expect(ordinals.length).toBeGreaterThanOrEqual(2);
        expect(ordinals).toEqual(ordinals.map((_, i) => i + 1));
      } else {
        expect(isProceduralChunk(memberClusters, byId)).toBe(false);
        expect(itsFacts.length).toBe(item.cluster_ids.length);
        expect(itsFacts.every((f) => f.ordinal === null)).toBe(true);
      }
    }
  });

  it('an L2 pass in the default world mints at least one procedure whose facts carry contiguous ordinals and whose step evidence is a single observation each', async () => {
    const job = await compactNow('L2', 'Test Operator');
    const minted = await listArtifacts({ type: 'procedure' });
    const fresh = minted.filter((a) => job.produced.artifact_ids.includes(a.id));
    expect(fresh.length).toBeGreaterThanOrEqual(1);
    // And not everything becomes one: a chunk with no trigger stays what its
    // kind maps to, so the rule discriminates rather than relabels.
    const others = (await listArtifacts()).filter((a) => job.produced.artifact_ids.includes(a.id) && a.type !== 'procedure');
    expect(others.length).toBeGreaterThanOrEqual(1);
    for (const a of fresh) {
      const steps = facts.rows()
        .filter((f) => f.artifact_id === a.id && f.ordinal !== null)
        .sort((x, y) => x.ordinal! - y.ordinal!);
      expect(steps.map((f) => f.ordinal)).toEqual(steps.map((_, i) => i + 1));
      for (const step of steps) {
        expect(step.evidence_observation_ids).toHaveLength(1);
        expect(step.predicate).toBe('step_of');
        expect(step.object).toBe(a.id);
      }
      // The "why" under the steps is still evidenced, still ordinal-free.
      const claims = facts.rows().filter((f) => f.artifact_id === a.id && f.ordinal === null);
      for (const c of claims) expect(c.evidence_observation_ids.length).toBeGreaterThan(0);
      expect(a.body_markdown).toMatch(/^## Steps\n1\. /);
    }
  });
});

// The chunk-level rule, on hand-built chunks so each branch is reached on
// its own rather than through whatever the seed happens to contain.
describe('isProceduralChunk', () => {
  const obs = (id: string, kind: ObservationKind): Observation => ({
    id, session_id: 'sess-t', box_id: 'box-t', repo: 'r', initiative_id: 'p-t',
    kind, title: id, body: '', tags: [], created_at: '2026-09-01T00:00:00.000Z',
  });
  const chunkOf = (...members: Observation[]): { chunk: Cluster[]; byId: Map<string, Observation> } => ({
    chunk: [{
      id: 'cl-t', title: 't', summary: '', kind: members[0]!.kind, repo: 'r', initiative_id: 'p-t', tags: [],
      member_observation_ids: members.map((m) => m.id), confidence: 0.8,
      created_by_compaction_id: 'comp-t', created_at: members[0]!.created_at, updated_at: members[0]!.created_at,
    }],
    byId: new Map(members.map((m) => [m.id, m])),
  });

  it('a trigger with nothing that resolved it is not a procedure', () => {
    const { chunk, byId } = chunkOf(obs('o1', 'gotcha'), obs('o2', 'failed'), obs('o3', 'convention'));
    expect(isProceduralChunk(chunk, byId)).toBe(false);
  });

  it('an outcome with nothing that bit first is not a procedure', () => {
    const { chunk, byId } = chunkOf(obs('o1', 'worked'), obs('o2', 'decision'), obs('o3', 'convention'));
    expect(isProceduralChunk(chunk, byId)).toBe(false);
  });

  it('a trigger and an outcome with steps to order is a procedure', () => {
    const { chunk, byId } = chunkOf(obs('o1', 'gotcha'), obs('o2', 'worked'), obs('o3', 'decision'));
    expect(isProceduralChunk(chunk, byId)).toBe(true);
  });

  it('a trigger and an outcome with only one action has nothing to order', () => {
    const { chunk, byId } = chunkOf(obs('o1', 'gotcha'), obs('o2', 'worked'));
    expect(isProceduralChunk(chunk, byId)).toBe(false);
  });

  it('a member missing from L0 is skipped, not counted', () => {
    const { chunk, byId } = chunkOf(obs('o1', 'gotcha'), obs('o2', 'worked'), obs('o3', 'decision'));
    byId.delete('o3');
    expect(isProceduralChunk(chunk, byId)).toBe(false);
  });
});

// The health verdict, on hand-built views under a frozen clock — the same
// posture as compactionHealth's tests: a shape and an instant in, a sentence
// out, no fixture between.
describe('procedureHealth', () => {
  const NOW = '2026-09-14T12:00:00.000Z';
  const nowMs = Date.parse(NOW);
  const hoursBefore = (h: number): string => new Date(nowMs - h * 3_600_000).toISOString();

  const view = (over: Partial<Omit<ProcedureView, 'health'>> = {}): Omit<ProcedureView, 'health'> => ({
    artifact: {
      id: 'art-t', type: 'procedure', title: 't', summary: '', body_markdown: '', cluster_ids: [], facts: [],
      library_item_id: null, owner: 'Vera Green', classification: 'internal', confidence: 0.9,
      status: 'published', reviewed_by: null, reviewed_at: null, last_used_at: null,
      created_by_compaction_id: 'comp-t', created_at: hoursBefore(10), updated_at: hoursBefore(10),
    },
    repo: 'connorhoehnslalom/orgiq-auth-service',
    step_count: 3,
    runs: { total: 0, succeeded: 0, failed: 0, abandoned: 0 },
    last_applied_at: null,
    last_succeeded_at: null,
    last_succeeded_by: null,
    applied_per_day: new Array<number>(14).fill(0),
    drift: { new_gotcha_clusters: 0, failed_runs: 0 },
    ...over,
  });

  let restore = () => {};
  beforeEach(() => { restore = freezeClock(NOW); });
  afterEach(() => { restore(); });

  it('never run → unproven, and the reason says so with the run count', () => {
    const h = procedureHealth(view(), nowMs);
    expect(h.status).toBe('unproven');
    expect(h.reason).toMatch(/published 10h ago, never run to completion — 0 runs/);
  });

  it('runs but no success → unproven', () => {
    const h = procedureHealth(view({
      runs: { total: 2, succeeded: 0, failed: 2, abandoned: 0 },
      last_applied_at: hoursBefore(1),
      drift: { new_gotcha_clusters: 0, failed_runs: 2 },
    }), nowMs);
    expect(h.status).toBe('unproven');
    expect(h.reason).toMatch(/2 runs, none succeeded/);
  });

  it('a success, then a failed run → drifting', () => {
    const h = procedureHealth(view({
      runs: { total: 2, succeeded: 1, failed: 1, abandoned: 0 },
      last_applied_at: hoursBefore(1), last_succeeded_at: hoursBefore(6), last_succeeded_by: 'sess-auth-05',
      drift: { new_gotcha_clusters: 0, failed_runs: 1 },
    }), nowMs);
    expect(h.status).toBe('drifting');
    expect(h.reason).toMatch(/last proven 6h ago by sess-auth-05; since then 1 run failed/);
  });

  it('a success, then a newer gotcha cluster in the repo → drifting, naming the repo', () => {
    const h = procedureHealth(view({
      runs: { total: 1, succeeded: 1, failed: 0, abandoned: 0 },
      last_applied_at: hoursBefore(6), last_succeeded_at: hoursBefore(6), last_succeeded_by: 'sess-auth-05',
      drift: { new_gotcha_clusters: 2, failed_runs: 0 },
    }), nowMs);
    expect(h.status).toBe('drifting');
    expect(h.reason).toMatch(/2 new failed\/gotcha clusters landed in connorhoehnslalom\/orgiq-auth-service/);
  });

  it('a success with only worked clusters since → proven', () => {
    const h = procedureHealth(view({
      runs: { total: 4, succeeded: 4, failed: 0, abandoned: 0 },
      last_applied_at: hoursBefore(1), last_succeeded_at: hoursBefore(1), last_succeeded_by: 'sess-auth-04',
    }), nowMs);
    expect(h.status).toBe('proven');
    expect(h.reason).toMatch(/last proven 1h ago by sess-auth-04; 4 runs, all succeeded/);
  });

  it('a success older than the TTL, nothing contradicting it → drifting on age alone', () => {
    const h = procedureHealth(view({
      runs: { total: 1, succeeded: 1, failed: 0, abandoned: 0 },
      last_applied_at: hoursBefore(15 * 24), last_succeeded_at: hoursBefore(15 * 24), last_succeeded_by: 'sess-auth-04',
    }), nowMs);
    expect(h.status).toBe('drifting');
    expect(h.reason).toMatch(/15d ago by sess-auth-04, older than the 14-day window/);
  });
});

// The audit saw every Compact resolve to `succeeded` in the same response —
// no observable running state. The job now goes on the compaction queue
// `queued`, a consumer claims it into `running`, and it completes after the
// run window, producing its items then.
describe('compactNow queues, then runs, then succeeds', () => {
  it('returns a queued job that a consumer runs to completion after the run window', async () => {
    __resetDistillationMock();
    __setCompactRunMs(3_000);
    jest.useFakeTimers();
    const stop = startCompactionConsumer();
    try {
      const job = await compactNow('L1', 'Test Operator');
      expect(job.status).toBe('queued');
      expect(job.finishedAt).toBeNull();
      expect(job.duration_ms).toBeNull();
      expect(job.produced.cluster_ids).toEqual([]);
      await jest.advanceTimersByTimeAsync(10);
      expect(job.status).toBe('running');
      expect(job.input_ids.length).toBeGreaterThan(0);
      await jest.advanceTimersByTimeAsync(3_100);
      expect(job.status).toBe('succeeded');
      expect(job.finishedAt).not.toBeNull();
      expect(job.produced.cluster_ids.length).toBeGreaterThan(0);
      expect(job.phase).toBe('done');
      expect(job.percent).toBe(100);
    } finally {
      stop();
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

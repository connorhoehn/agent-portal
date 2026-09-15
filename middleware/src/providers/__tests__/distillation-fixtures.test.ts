// The distillation corpus ON THE FIXTURE FLOOR (mock/core/contract.ts).
//
// The three properties this suite exists to keep true — each of them a bug
// this surface has already shipped once:
//
//   1. No typed aggregate. Every number the provider reports is counted from
//      rows: a tier's `items` is the length of the list that tier serves, a
//      job's `outputItems` is how many rows name it as their creator, and the
//      review banner's four numbers are the review queue's own. The audit
//      found tier cards reading 950/180/40 above lists holding 69/22/8, and a
//      calibration banner of constants that never moved when a sample was
//      decided.
//   2. Every timestamp is read from the clock, not baked at import. Frozen at
//      two different instants, the same seed row must come out at two
//      different times — exactly one day apart.
//   3. Every collection can be asked for an EMPTY world, so an auditor never
//      has to delete rows from shared dev:mock state to see an empty state.
//      An undeclared scenario silently falls back to `default`, which is why
//      "declares empty" is asserted rather than assumed.

jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', mock: { aurora: true }, auth: {} },
}));
jest.mock('@aws-sdk/client-bedrock-agent', () => ({
  BedrockAgentClient: class { send() { return Promise.resolve({}); } },
  ListPromptsCommand: class {},
}));
jest.mock('../aurora.js', () => ({ exec: jest.fn() }));

import {
  observations, clusters, artifacts, facts, libraryLinks, compactionJobs, reviewSamples,
  ingestWriters, distillationFixtures,
} from '../../mock/distillation.js';
import { fixtureRegistry, freezeClock } from '../../mock/core/index.js';
import {
  levels, ingest, listItems, listArtifacts, listCompactions, listReview, sampling,
  samplingVerdict, compactionHealth, libraryProvenance, __resetDistillationMock,
} from '../distillation.js';

// Every test here switches the world; put it back so a suite that runs after
// this one in the same process sees the demo corpus.
afterEach(() => {
  fixtureRegistry.resetAll('default');
  __resetDistillationMock();
});

describe('the domain is on the fixture floor', () => {
  it('registers all nine collections under stable keys', () => {
    const keys = distillationFixtures.map((f) => f.key).sort();
    expect(keys).toEqual([
      'distillation-artifacts',
      'distillation-clusters',
      'distillation-compactions',
      'distillation-facts',
      'distillation-ingest-writers',
      'distillation-library-links',
      'distillation-observations',
      'distillation-procedure-applications',
      'distillation-review-samples',
    ]);
    for (const fixture of distillationFixtures) {
      expect(fixtureRegistry.get(fixture.key)).toBe(fixture);
    }
  });

  // An undeclared scenario falls back to `default`, so a fixture that has not
  // written `empty: () => []` is NOT empty in the empty world — the control
  // plane would hand an auditor the demo corpus and call it empty.
  it('every collection declares an empty scenario that is actually empty', () => {
    for (const fixture of distillationFixtures) {
      expect({ key: fixture.key, rows: fixture.rows('empty').length }).toEqual({ key: fixture.key, rows: 0 });
    }
  });

  it('reads its timestamps from the clock, not from module load', () => {
    const at = (iso: string): string => {
      const restore = freezeClock(iso);
      try {
        observations.reset();
        return observations.rows()[0]!.created_at;
      } finally {
        restore();
      }
    };
    const first = at('2026-03-01T12:00:00.000Z');
    const second = at('2026-03-02T12:00:00.000Z');
    expect(Date.parse(second) - Date.parse(first)).toBe(24 * 60 * 60 * 1000);
  });
});

describe('every reported number is the length of the list it heads', () => {
  it('a tier count equals the number of items that tier serves', async () => {
    for (const level of ['L0', 'L1', 'L2'] as const) {
      const card = (await levels()).find((l) => l.level === level)!;
      const listed = await listItems({ level, limit: 200 });
      expect({ level, items: card.items }).toEqual({ level, items: listed.items.length });
      expect(card.sizeBytes).toBeGreaterThan(0);
    }
  });

  it('ingest pressure is the writers, summed — not a number typed beside them', async () => {
    const state = await ingest();
    const writers = ingestWriters.rows();
    expect(state.activeWriters).toBe(writers.length);
    expect(state.observationsPerHour).toBe(writers.reduce((n, w) => n + w.observationsPerHour, 0));
    const shares = state.topRepos.reduce((n, r) => n + r.share, 0);
    expect(shares).toBeCloseTo(1, 1);
    // Every repo named in the write stream is a repo the corpus is written
    // against — the old typed shares named two repos no observation used.
    const corpusRepos = new Set(observations.rows().map((o) => o.repo));
    for (const r of state.topRepos) expect(corpusRepos.has(r.repo)).toBe(true);
  });

  // DEFECTS.md org-leader #18, made structural: the banner and the queue are
  // one store, so the headline cannot contradict the cards beneath it.
  it('the calibration banner equals the review queue', async () => {
    const banner = await sampling();
    const pending = await listReview({ verdict: 'pending' });
    const agree = await listReview({ verdict: 'agree' });
    const disagree = await listReview({ verdict: 'disagree' });

    expect(banner.queueDepth).toBe(pending.length);
    expect(banner.reviewedLast30d).toBe(agree.length + disagree.length);
    expect(banner.agreementRatePct).toBe(
      Math.round((agree.length / (agree.length + disagree.length)) * 1000) / 10,
    );

    // "% of L1 sampled" is exactly that: the L1 clusters a reviewer has been
    // handed, over the L1 clusters that exist.
    const sampled = new Set([...pending, ...agree, ...disagree]
      .filter((s) => s.target_kind === 'cluster').map((s) => s.target_id));
    expect(banner.l1SampleRatePct).toBe(Math.round((sampled.size / clusters.rows().length) * 100));
  });

  it("a job's counts are the rows that name it, never a stored total", async () => {
    const jobs = await listCompactions();
    expect(jobs.length).toBeGreaterThan(0);
    for (const job of jobs) {
      const produced = job.produced.cluster_ids.length + job.produced.artifact_ids.length;
      expect({ id: job.id, out: job.outputItems }).toEqual({ id: job.id, out: produced });
      // Every input a SUCCEEDED pass took was either kept as output or merged
      // away. An aborted pass abandoned its inputs, so it accounts for
      // neither — and must not be credited with deduping them.
      if (job.status === 'succeeded') expect(job.inputItems).toBe(job.outputItems + job.dedupedItems);
      else expect(job.dedupedItems).toBe(0);
      for (const id of job.produced.cluster_ids) {
        expect(clusters.rows().find((c) => c.id === id)?.created_by_compaction_id).toBe(job.id);
      }
      for (const id of job.produced.artifact_ids) {
        expect(artifacts.rows().find((a) => a.id === id)?.created_by_compaction_id).toBe(job.id);
      }
    }
  });

  it('the failed pass produced nothing and quotes an input count the corpus can show', async () => {
    const [failed] = await listCompactions({ status: 'failed' });
    expect(failed).toBeDefined();
    expect(failed!.produced).toEqual({ cluster_ids: [], artifact_ids: [] });
    expect(failed!.outputItems).toBe(0);
    expect(failed!.bytesReclaimed).toBe(0);
    expect(failed!.inputItems).toBeGreaterThan(0);
    expect(failed!.error).toContain(`${failed!.inputItems} input observations`);
  });

  it("a level's lag is the age of what is actually waiting", async () => {
    const ls = await levels();
    const l1 = ls.find((l) => l.level === 'L1')!;
    const l2 = ls.find((l) => l.level === 'L2')!;
    const oldestUnclustered = observations.rows()
      .filter((o) => !clusters.rows().some((c) => c.member_observation_ids.includes(o.id)))
      .map((o) => o.created_at).sort()[0];
    const oldestUndistilled = clusters.rows()
      .filter((c) => !artifacts.rows().some((a) => a.cluster_ids.includes(c.id)))
      .map((c) => c.created_at).sort()[0];
    expect(l1.oldestAt).toBe(oldestUnclustered);
    expect(l2.oldestAt).toBe(oldestUndistilled);
    // The story the page is built to show: L1 is behind its writers, L2 has
    // not been attempted in far longer than the stall window.
    const health = compactionHealth(ls, await listCompactions());
    expect(health.find((h) => h.level === 'L0')!.status).toBe('healthy');
    expect(health.find((h) => h.level === 'L1')!.status).toBe('behind');
    expect(health.find((h) => h.level === 'L2')!.status).toBe('stalled');
  });
});

describe("the `empty` world empties every surface, and says so honestly", () => {
  beforeEach(() => { fixtureRegistry.resetAll('empty'); });

  it('every tier is empty, sized zero, and not accused of stalling', async () => {
    const ls = await levels();
    expect(ls.map((l) => l.items)).toEqual([0, 0, 0]);
    expect(ls.map((l) => l.sizeBytes)).toEqual([0, 0, 0]);
    expect(ls.map((l) => l.lagSeconds)).toEqual([0, 0, 0]);
    // Nothing is waiting, so nothing is behind: a blank store must not read
    // as a broken one.
    expect(compactionHealth(ls, await listCompactions()).every((h) => h.status === 'healthy')).toBe(true);
    expect((await listItems({ limit: 200 })).items).toEqual([]);
    expect(await listArtifacts()).toEqual([]);
    expect(await listCompactions()).toEqual([]);
    expect(await listReview()).toEqual([]);
  });

  it('nothing is writing, so simulated ingest does not refill the world', async () => {
    const state = await ingest();
    expect(state).toEqual({ activeWriters: 0, observationsPerHour: 0, topRepos: [] });
    expect((await levels()).find((l) => l.level === 'L0')!.items).toBe(0);
  });

  it('the sampling banner reports no signal rather than 100% disagreement', async () => {
    const state = await sampling();
    expect(state).toEqual({ l1SampleRatePct: 0, reviewedLast30d: 0, agreementRatePct: 0, queueDepth: 0 });
    const verdict = samplingVerdict(state);
    expect(verdict.reason).toMatch(/[Nn]othing has been drawn for review/);
    expect(verdict.reason).not.toMatch(/overturn/);
  });
});

describe('the `fresh` world is a store that has never compacted', () => {
  beforeEach(() => { fixtureRegistry.resetAll('fresh'); });

  it('has a full write head and nothing above it', async () => {
    const byLevel = Object.fromEntries((await levels()).map((l) => [l.level, l.items]));
    expect(byLevel['L0']).toBeGreaterThan(0);
    expect(byLevel['L1']).toBe(0);
    expect(byLevel['L2']).toBe(0);
    expect(await listCompactions()).toEqual([]);
    expect(await listReview()).toEqual([]);
    expect((await sampling()).l1SampleRatePct).toBe(0);
  });
});

describe('the `large` world is a corpus, not a pile of dangling ids', () => {
  beforeEach(() => { fixtureRegistry.resetAll('large'); });

  it('is bigger than one page of items', async () => {
    const page = await listItems({ level: 'L0', limit: 50 });
    expect(page.items.length).toBe(50);
    expect(page.next_cursor).toEqual(expect.any(String));
    expect(observations.rows().length).toBeGreaterThan(150);
  });

  it('every cross-reference in it resolves', () => {
    const obsIds = new Set(observations.rows().map((o) => o.id));
    const clusterIds = new Set(clusters.rows().map((c) => c.id));
    const artifactIds = new Set(artifacts.rows().map((a) => a.id));
    const factIds = new Set(facts.rows().map((f) => f.id));
    const jobIds = new Set(compactionJobs.rows().map((j) => j.id));

    for (const c of clusters.rows()) {
      expect(jobIds.has(c.created_by_compaction_id)).toBe(true);
      for (const id of c.member_observation_ids) expect(obsIds.has(id)).toBe(true);
    }
    for (const a of artifacts.rows()) {
      expect(jobIds.has(a.created_by_compaction_id)).toBe(true);
      for (const id of a.cluster_ids) expect(clusterIds.has(id)).toBe(true);
      for (const id of a.facts) expect(factIds.has(id)).toBe(true);
    }
    for (const f of facts.rows()) {
      expect(artifactIds.has(f.artifact_id)).toBe(true);
      for (const id of f.evidence_observation_ids) expect(obsIds.has(id)).toBe(true);
    }
    for (const r of reviewSamples.rows()) {
      expect(r.target_kind === 'cluster' ? clusterIds.has(r.target_id) : artifactIds.has(r.target_id)).toBe(true);
    }
    for (const l of libraryLinks.rows()) expect(artifactIds.has(l.artifact_id)).toBe(true);
  });
});

describe('the Library link is a table, not a field', () => {
  it("an artifact's library_item_id is the link row for it, or null", async () => {
    const links = new Map(libraryLinks.rows().map((l) => [l.artifact_id, l.library_item_id]));
    for (const a of await listArtifacts()) {
      expect(a.library_item_id).toBe(links.get(a.id) ?? null);
    }
    expect(links.size).toBeGreaterThan(0);
  });

  it('with no links, nothing was published and provenance resolves nowhere', async () => {
    libraryLinks.rows().length = 0;
    try {
      const published = (await listArtifacts()).filter((a) => a.library_item_id !== null);
      expect(published).toEqual([]);
      expect(await libraryProvenance('skill-flaky-test-triage')).toBeNull();
    } finally {
      libraryLinks.reset();
    }
  });
});

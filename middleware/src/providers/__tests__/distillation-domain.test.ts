// The navigable-knowledge half of distillation.ts: items (L0/L1/L2), lineage,
// artifacts, facts, review samples and Library provenance. Pins:
//   - the mock corpus meets docs/distillation-goal.md's minimums
//   - every cross-reference in the mock resolves (cluster members, artifact
//     cluster_ids/facts/library_item_id, fact evidence, review targets)
//   - listItems filters (level/repo/initiative/q) and paginates with a
//     stable, round-trippable cursor
//   - getItem is kind-discriminated and 404-shaped (null) for an unknown id
//   - lineageFor/factLineage build a graph that actually connects
//     observation -> cluster -> artifact -> library item, and depth bounds it
//   - listArtifacts/listReview filter correctly
//   - decideReview: pending -> agree/disagree, and 409s a second decision
//   - libraryProvenance resolves for a linked artifact and null otherwise

jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', mock: { aurora: true }, auth: {} },
}));

// prompt-library.ts (read-only dependency for Library provenance lookups)
// pulls in the Bedrock SDK and aurora.ts — mocked out exactly as
// prompt-library.test.ts does, since config.mock.aurora=true never
// exercises either in this suite.
jest.mock('@aws-sdk/client-bedrock-agent', () => ({
  BedrockAgentClient: class { send() { return Promise.resolve({}); } },
  ListPromptsCommand: class {},
}));
jest.mock('../aurora.js', () => ({ exec: jest.fn() }));

import {
  observations, clusters, artifacts, facts, reviewSamples,
} from '../../mock/distillation.js';
import {
  listItems, getItem, lineageFor, factLineage, listArtifacts, listReview, decideReview,
  libraryProvenance, buildLineage, sampling,
} from '../distillation.js';
import { getAsset } from '../prompt-library.js';

describe('mock corpus meets the documented minimums', () => {
  it('>= 60 observations across >= 6 sessions and >= 3 repos', () => {
    expect(observations.rows().length).toBeGreaterThanOrEqual(60);
    expect(new Set(observations.rows().map((o) => o.session_id)).size).toBeGreaterThanOrEqual(6);
    expect(new Set(observations.rows().map((o) => o.repo)).size).toBeGreaterThanOrEqual(3);
  });

  it('>= 18 clusters, >= 8 artifacts, >= 12 facts', () => {
    expect(clusters.rows().length).toBeGreaterThanOrEqual(18);
    expect(artifacts.rows().length).toBeGreaterThanOrEqual(8);
    expect(facts.rows().length).toBeGreaterThanOrEqual(12);
  });

  it('>= 5 artifacts link to a real Library asset, >= 2 draft, >= 1 retired', async () => {
    // The link lives in the library-links fixture, so this reads the composed
    // wire artifact rather than the stored row.
    const onWire = await listArtifacts();
    const linked = onWire.filter((a) => a.library_item_id);
    expect(linked.length).toBeGreaterThanOrEqual(5);
    for (const a of linked) {
      const asset = await getAsset(a.library_item_id!);
      expect(asset).not.toBeNull();
    }
    expect(onWire.filter((a) => a.status === 'draft').length).toBeGreaterThanOrEqual(2);
    expect(onWire.filter((a) => a.status === 'retired').length).toBeGreaterThanOrEqual(1);
  });

  it('>= 6 pending and >= 20 decided review samples', () => {
    expect(reviewSamples.rows().filter((r) => r.verdict === 'pending').length).toBeGreaterThanOrEqual(6);
    expect(reviewSamples.rows().filter((r) => r.verdict !== 'pending').length).toBeGreaterThanOrEqual(20);
  });
});

describe('every cross-reference in the mock resolves', () => {
  const obsIds = new Set(observations.rows().map((o) => o.id));
  const clusterIds = new Set(clusters.rows().map((c) => c.id));
  const artifactIds = new Set(artifacts.rows().map((a) => a.id));
  const factIds = new Set(facts.rows().map((f) => f.id));

  it('every cluster member_observation_ids id exists', () => {
    for (const c of clusters.rows()) for (const id of c.member_observation_ids) expect(obsIds.has(id)).toBe(true);
  });

  it('every artifact cluster_ids / facts id exists', () => {
    for (const a of artifacts.rows()) {
      for (const id of a.cluster_ids) expect(clusterIds.has(id)).toBe(true);
      for (const id of a.facts) expect(factIds.has(id)).toBe(true);
    }
  });

  it('every fact artifact_id and evidence_observation_ids id exists', () => {
    for (const f of facts.rows()) {
      expect(artifactIds.has(f.artifact_id)).toBe(true);
      expect(f.evidence_observation_ids.length).toBeGreaterThan(0);
      for (const id of f.evidence_observation_ids) expect(obsIds.has(id)).toBe(true);
    }
  });

  it('every review sample target_id exists in its target_kind collection', () => {
    for (const r of reviewSamples.rows()) {
      if (r.target_kind === 'cluster') expect(clusterIds.has(r.target_id)).toBe(true);
      else expect(artifactIds.has(r.target_id)).toBe(true);
    }
  });
});

describe('listItems', () => {
  it('filters by level', async () => {
    const r = await listItems({ level: 'L0', limit: 200 });
    expect(r.items.every((i) => i.level === 'L0')).toBe(true);
    expect(r.items.length).toBeGreaterThan(0);
  });

  it('filters by repo, including an L2 artifact whose repo is derived from its clusters', async () => {
    const r = await listItems({ level: 'L2', repo: 'connorhoehnslalom/orgiq-llm-platform', limit: 200 });
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.items.every((i) => i.id === 'art-005')).toBe(true);
  });

  it('filters by initiative', async () => {
    const r = await listItems({ level: 'L1', initiative: 'p-cost-opt', limit: 200 });
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.items.every((i) => 'initiative_id' in i && i.initiative_id === 'p-cost-opt')).toBe(true);
  });

  it('full-text q matches title/summary/body', async () => {
    const r = await listItems({ q: 'ARM64', limit: 200 });
    expect(r.items.some((i) => i.id === 'cl-020')).toBe(true);
  });

  it('paginates with a stable cursor that round-trips through the whole set with no repeats', async () => {
    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const page = await listItems({ level: 'L0', limit: 10, ...(cursor ? { cursor } : {}) });
      for (const i of page.items) {
        expect(seen.has(i.id)).toBe(false);
        seen.add(i.id);
      }
      pages += 1;
      if (!page.next_cursor) break;
      cursor = page.next_cursor;
      expect(pages).toBeLessThan(50); // guard against an infinite loop bug
    }
    expect(seen.size).toBe(observations.rows().length);
    expect(pages).toBeGreaterThan(1);
  });

  it('an unknown cursor starts from the top rather than erroring', async () => {
    const r = await listItems({ level: 'L0', limit: 5, cursor: Buffer.from('obs-does-not-exist').toString('base64url') });
    expect(r.items.length).toBe(5);
  });
});

describe('getItem', () => {
  it('resolves an L0/L1/L2 id with the right level tag', async () => {
    expect((await getItem('obs-001'))?.level).toBe('L0');
    expect((await getItem('cl-001'))?.level).toBe('L1');
    expect((await getItem('art-001'))?.level).toBe('L2');
  });

  it('returns null for an unknown id', async () => {
    expect(await getItem('art-does-not-exist')).toBeNull();
  });
});

describe('lineage', () => {
  it('an observation lineages to its session and its cluster', async () => {
    const obs = clusters.rows().find((c) => c.id === 'cl-001')!.member_observation_ids[0]!;
    const lineage = await lineageFor(obs, 2);
    expect(lineage.nodes.some((n) => n.id === obs && n.kind === 'observation')).toBe(true);
    expect(lineage.nodes.some((n) => n.kind === 'session')).toBe(true);
    expect(lineage.nodes.some((n) => n.id === 'cl-001' && n.kind === 'cluster')).toBe(true);
    expect(lineage.edges.some((e) => e.relation === 'written_by')).toBe(true);
    expect(lineage.edges.some((e) => e.relation === 'merged_into')).toBe(true);
  });

  it('a deeper walk from a cluster reaches the artifact it was distilled into and the Library item it published as', async () => {
    const lineage = await lineageFor('cl-011', 3);
    expect(lineage.nodes.some((n) => n.id === 'art-004' && n.kind === 'artifact')).toBe(true);
    expect(lineage.nodes.some((n) => n.id === 'lib-csrf-check' && n.kind === 'library_item')).toBe(true);
    expect(lineage.edges.some((e) => e.relation === 'distilled_into')).toBe(true);
    expect(lineage.edges.some((e) => e.relation === 'published_as')).toBe(true);
  });

  it('depth bounds how far the graph reaches', async () => {
    const shallow = await lineageFor('cl-011', 1);
    const deep = await lineageFor('cl-011', 3);
    expect(shallow.nodes.length).toBeLessThan(deep.nodes.length);
    expect(shallow.nodes.some((n) => n.id === 'lib-csrf-check')).toBe(false);
  });

  it('an id with no edges at all returns an empty graph, not a throw', async () => {
    const lineage = await buildLineage('nope-not-a-real-id', 3);
    expect(lineage).toEqual({ nodes: [], edges: [] });
  });

  it('factLineage reaches the fact\'s evidence observations and its artifact', async () => {
    const lineage = await factLineage('fact-001');
    expect(lineage.nodes.some((n) => n.id === 'fact-001' && n.kind === 'fact')).toBe(true);
    expect(lineage.nodes.some((n) => n.id === 'art-001')).toBe(true);
    expect(lineage.edges.filter((e) => e.relation === 'supports').length).toBeGreaterThan(0);
  });
});

describe('listArtifacts', () => {
  it('filters by status', async () => {
    const drafts = await listArtifacts({ status: 'draft' });
    expect(drafts.length).toBeGreaterThan(0);
    expect(drafts.every((a) => a.status === 'draft')).toBe(true);
  });

  it('filters by type', async () => {
    const runbooks = await listArtifacts({ type: 'runbook' });
    expect(runbooks.every((a) => a.type === 'runbook')).toBe(true);
  });

  it('q matches title/summary/body', async () => {
    const r = await listArtifacts({ q: 'PII' });
    expect(r.some((a) => a.id === 'art-005')).toBe(true);
  });
});

describe('listReview / decideReview', () => {
  it('filters by verdict', async () => {
    const pending = await listReview({ verdict: 'pending' });
    expect(pending.length).toBeGreaterThanOrEqual(6);
    expect(pending.every((r) => r.verdict === 'pending')).toBe(true);
  });

  it('decides a pending sample and records the reviewer', async () => {
    const [pending] = await listReview({ verdict: 'pending' });
    const decided = await decideReview(pending!.id, { verdict: 'agree', note: 'looks right' }, 'Test Reviewer');
    expect(decided.verdict).toBe('agree');
    expect(decided.reviewer).toBe('Test Reviewer');
    expect(decided.note).toBe('looks right');
  });

  it('deciding an already-decided sample 409s', async () => {
    await expect(decideReview('rev-007', { verdict: 'agree' }, 'someone else')).rejects.toMatchObject({ status: 409 });
  });

  it('deciding an unknown sample 404s', async () => {
    await expect(decideReview('rev-does-not-exist', { verdict: 'agree' }, 'x')).rejects.toMatchObject({ status: 404 });
  });

  // DEFECTS.md org-leader #18: the calibration banner (queueDepth,
  // agreementRatePct, reviewedLast30d) used to be a hard-coded constant that
  // never moved when a sample was decided, so it could — and did —
  // contradict the queue and Decided tab below it. sampling() must derive
  // every one of these from the same reviewSamples.rows() store the /review
  // routes read and mutate, so one decision moves them all together.
  it('deciding a sample moves the sampling banner by exactly one, consistently', async () => {
    const before = await sampling();
    const [pending] = await listReview({ verdict: 'pending' });
    expect(pending).toBeDefined();

    await decideReview(pending!.id, { verdict: 'disagree' }, 'Test Reviewer');

    const after = await sampling();
    expect(after.queueDepth).toBe(before.queueDepth - 1);

    const decidedBefore = (await listReview({ verdict: 'agree' })).length + (await listReview({ verdict: 'disagree' })).length;
    // decidedBefore already reflects the decision just made (listReview reads
    // live state), so the count that was *decided* rose by one relative to
    // reviewedLast30d computed the same way pre-decision.
    expect(before.reviewedLast30d).toBeLessThan(decidedBefore);
    expect(after.reviewedLast30d).toBe(decidedBefore);

    const agreeCount = (await listReview({ verdict: 'agree' })).length;
    const expectedPct = Math.round((agreeCount / decidedBefore) * 1000) / 10;
    expect(after.agreementRatePct).toBe(expectedPct);
    expect(after.agreementRatePct).not.toBe(before.agreementRatePct);
  });
});

describe('libraryProvenance', () => {
  it('resolves the artifact and lineage for a linked Library item', async () => {
    const p = await libraryProvenance('skill-flaky-test-triage');
    expect(p?.artifact.id).toBe('art-001');
    expect(p?.lineage.nodes.some((n) => n.id === 'art-001')).toBe(true);
  });

  it('returns null for a Library item nothing was distilled into', async () => {
    expect(await libraryProvenance('lib-stakeholder-email')).toBeNull();
  });
});

// A tier card's number must be the number of things a person can open under
// it — the audit saw 950 / 180 / 40 above lists holding 69 / 22 / 8.
describe('levels() agrees with the item corpus', () => {
  it('reports the corpus lengths per tier', async () => {
    const provider = await import('../distillation.js');
    const M = await import('../../mock/distillation.js');
    const byLevel = Object.fromEntries((await provider.levels()).map((l) => [l.level, l.items]));
    expect(byLevel['L0']).toBe(M.observations.rows().length);
    expect(byLevel['L1']).toBe(M.clusters.rows().length);
    expect(byLevel['L2']).toBe(M.artifacts.rows().length);
  });
});

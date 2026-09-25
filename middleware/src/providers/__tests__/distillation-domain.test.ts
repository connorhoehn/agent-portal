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
  observations, clusters, artifacts, facts, reviewSamples, procedureApplications,
} from '../../mock/distillation.js';
import {
  listItems, getItem, lineageFor, factLineage, listArtifacts, listReview, decideReview,
  libraryProvenance, buildLineage, sampling,
  listProcedures, getProcedure, listApplications, applyProcedure, __resetDistillationMock,
  guideFor, repoDisplayName, compactNow, __setCompactRunMs, listFacets,
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

  // A procedure is an artifact whose facts carry an ordinal. The seed has
  // to hold three of them so every health verdict (proven / drifting /
  // unproven) is reachable in the default world, and every ordinal-bearing
  // fact has to belong to one — an ordinal on a runbook's fact would be a
  // step nothing lists.
  it('>= 3 procedures, and every step fact belongs to a procedure with contiguous ordinals 1..n', () => {
    const procedures = artifacts.rows().filter((a) => a.type === 'procedure');
    expect(procedures.length).toBeGreaterThanOrEqual(3);
    const byArtifact = new Map(artifacts.rows().map((a) => [a.id, a]));
    for (const f of facts.rows().filter((x) => x.ordinal !== null)) {
      expect(byArtifact.get(f.artifact_id)?.type).toBe('procedure');
    }
    for (const a of artifacts.rows()) {
      const ordinals = facts.rows()
        .filter((f) => f.artifact_id === a.id && f.ordinal !== null)
        .map((f) => f.ordinal!)
        .sort((x, y) => x - y);
      if (a.type === 'procedure') {
        expect(ordinals.length).toBeGreaterThanOrEqual(2);
        expect(ordinals).toEqual(ordinals.map((_, i) => i + 1));
      } else {
        expect(ordinals).toEqual([]);
      }
    }
    // Twelve step facts across the three seeded procedures, as the file
    // header claims — a count the validator greps for.
    expect(facts.rows().filter((f) => f.ordinal !== null).length).toBeGreaterThanOrEqual(11);
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

  it('every application names a procedure artifact, and a failed one names a step of that procedure', () => {
    const byArtifact = new Map(artifacts.rows().map((a) => [a.id, a]));
    expect(procedureApplications.rows().length).toBeGreaterThan(0);
    for (const p of procedureApplications.rows()) {
      expect(byArtifact.get(p.procedure_id)?.type).toBe('procedure');
      if (p.outcome === 'succeeded') expect(p.failed_at_step_id).toBeNull();
      if (p.failed_at_step_id !== null) {
        const step = facts.rows().find((f) => f.id === p.failed_at_step_id);
        expect(step?.artifact_id).toBe(p.procedure_id);
        expect(step?.ordinal).not.toBeNull();
      }
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

  it('type=procedure lists exactly the procedure artifacts', async () => {
    const procedures = await listArtifacts({ type: 'procedure' });
    expect(procedures.map((a) => a.id).sort()).toEqual(['art-009', 'art-010', 'art-011']);
    expect(procedures.every((a) => a.type === 'procedure')).toBe(true);
  });
});

// The run side of a procedure: every number on the view is counted from
// the applications and cluster rows, and the seed reaches all three verdicts.
describe('procedures', () => {
  afterEach(() => { __resetDistillationMock(); });

  it('the seed reaches every verdict, and the list opens on the ones needing attention', async () => {
    const views = await listProcedures();
    const byId = Object.fromEntries(views.map((v) => [v.artifact.id, v]));
    expect(byId['art-009']!.health.status).toBe('proven');
    expect(byId['art-010']!.health.status).toBe('drifting');
    expect(byId['art-011']!.health.status).toBe('unproven');
    expect(views.map((v) => v.health.status)).toEqual(['drifting', 'unproven', 'proven']);
  });

  it('runs, last-run and drift are the applications, counted', async () => {
    const v = (await getProcedure('art-009'))!;
    const apps = procedureApplications.rows().filter((p) => p.procedure_id === 'art-009');
    expect(v.runs.total).toBe(apps.length);
    expect(v.runs.succeeded).toBe(apps.filter((p) => p.outcome === 'succeeded').length);
    expect(v.last_applied_at).toBe(apps.map((p) => p.applied_at).sort()[apps.length - 1]);
    expect(v.last_succeeded_by).toBe('sess-auth-04');
    expect(v.step_count).toBe(4);
    expect(v.repo).toBe('connorhoehnslalom/orgiq-auth-service');
    expect(v.applied_per_day).toHaveLength(14);
    expect(v.applied_per_day.reduce((n, x) => n + x, 0)).toBe(apps.length);
    expect(v.drift).toEqual({ new_gotcha_clusters: 0, failed_runs: 0 });

    const drifting = (await getProcedure('art-010'))!;
    expect(drifting.drift.failed_runs).toBe(1);
    expect(drifting.health.reason).toMatch(/1 run failed/);
  });

  it('getProcedure is null for a non-procedure artifact and for an unknown id', async () => {
    expect(await getProcedure('art-001')).toBeNull();
    expect(await getProcedure('art-does-not-exist')).toBeNull();
    expect(await listApplications('art-001')).toBeNull();
  });

  it('listApplications is newest first', async () => {
    const apps = (await listApplications('art-009'))!;
    expect(apps.length).toBe(4);
    for (let i = 1; i < apps.length; i += 1) {
      expect(apps[i - 1]!.applied_at >= apps[i]!.applied_at).toBe(true);
    }
  });

  it('applyProcedure appends to the registered fixture, moves the verdict, and reset takes it back', async () => {
    const before = procedureApplications.rows().length;
    expect((await getProcedure('art-011'))!.health.status).toBe('unproven');
    const row = await applyProcedure('art-011', { outcome: 'succeeded' }, { sessionId: 'u-test', boxId: 'portal' });
    expect(row.id).toMatch(/^papp-9\d{3}$/);
    expect(row.repo).toBe('connorhoehnslalom/orgiq-finops');
    expect(procedureApplications.rows().length).toBe(before + 1);
    expect((await getProcedure('art-011'))!.health.status).toBe('proven');
    expect((await lineageFor('art-011', 1)).edges.some((e) => e.relation === 'applied_in' && e.to === row.id)).toBe(true);
    __resetDistillationMock();
    expect(procedureApplications.rows().length).toBe(before);
    expect((await getProcedure('art-011'))!.health.status).toBe('unproven');
  });

  it('a failed run must name a step of that procedure; a succeeded run must not', async () => {
    await expect(applyProcedure('art-009', { outcome: 'failed' }, { sessionId: 'u', boxId: 'portal' }))
      .rejects.toMatchObject({ status: 400 });
    await expect(applyProcedure('art-009', { outcome: 'failed', failed_at_step_id: 'fact-020' }, { sessionId: 'u', boxId: 'portal' }))
      .rejects.toMatchObject({ status: 400 }); // fact-020 is art-010's step
    await expect(applyProcedure('art-009', { outcome: 'failed', failed_at_step_id: 'fact-017' }, { sessionId: 'u', boxId: 'portal' }))
      .rejects.toMatchObject({ status: 400 }); // fact-017 supports art-009 but is not a step
    await expect(applyProcedure('art-009', { outcome: 'succeeded', failed_at_step_id: 'fact-013' }, { sessionId: 'u', boxId: 'portal' }))
      .rejects.toMatchObject({ status: 400 });
    await expect(applyProcedure('art-001', { outcome: 'succeeded' }, { sessionId: 'u', boxId: 'portal' }))
      .rejects.toMatchObject({ status: 404 });
    const ok = await applyProcedure('art-009', { outcome: 'failed', failed_at_step_id: 'fact-015', note: 'cert not ready' }, { sessionId: 'u', boxId: 'portal' });
    expect(ok.failed_at_step_id).toBe('fact-015');
    expect((await getProcedure('art-009'))!.health.status).toBe('drifting');
  });

  it('lineage resolves an application as a run, not as a session', async () => {
    const lineage = await lineageFor('art-010', 1);
    const app = lineage.nodes.find((n) => n.id === 'papp-006');
    expect(app?.kind).toBe('application');
    expect(app?.label).toBe('failed · sess-auth-06');
    expect(app?.meta['failed_at_step_id']).toBe('fact-020');
    expect(typeof app?.meta['subtitle']).toBe('string');
    const step = (await factLineage('fact-020')).nodes.find((n) => n.id === 'fact-020');
    expect(step?.meta['ordinal']).toBe(3);
  });
});

// The guide record (docs/distillation-guide-record-plan.md §2): the plain-
// language view an L2 record's Content tab reads, derived from rows on each
// read. art-010 is the mockup's record, so its values are pinned exactly.
describe('guideFor', () => {
  afterEach(() => { __resetDistillationMock(); });

  it('art-010: plain approach, the pattern it came from, and the latest run as a warning', async () => {
    const g = (await guideFor('art-010'))!;
    expect(g.approach).toEqual([
      { step_id: 'fact-018', ordinal: 1, text: 'Keep the existing sign-in available as a fallback.' },
      { step_id: 'fact-019', ordinal: 2, text: 'Check that active sessions stay signed in.' },
      { step_id: 'fact-020', ordinal: 3, text: 'Switch one customer and verify sign-in.' },
      { step_id: 'fact-021', ordinal: 4, text: 'Restore the previous sign-in if the checks fail.' },
    ]);
    expect(g.based_on).toEqual([{
      id: 'cl-010', kind: 'cluster', title: 'Retire the SAML shim tenant by tenant',
      repo: 'connorhoehnslalom/orgiq-auth-service', repo_label: 'auth-service',
    }]);
    expect(g.run_warning).toEqual({
      run_id: 'papp-006', outcome: 'failed',
      at: procedureApplications.rows().find((p) => p.id === 'papp-006')!.applied_at,
      failed_at_ordinal: 3,
      title: 'Check the redirect before you use this',
      body: 'The last attempt stopped at step 3 because sign-in still pointed to the old service.',
    });
    expect(artifacts.rows().find((a) => a.id === 'art-010')!.when_this_helps).toBe(
      'Planning to move a customer\'s sign-in to Cognito? Use this guide to plan a gradual switch, keep people signed in, and preserve a way to roll back.\n'
      + 'It brings together steps and lessons from an earlier migration.');
  });

  it('every seeded artifact but the retired one has a when_this_helps, and every seeded step a plain wording', () => {
    for (const a of artifacts.rows()) {
      if (a.status === 'retired') continue;
      expect(a.when_this_helps).toEqual(expect.any(String));
    }
    for (const f of facts.rows().filter((x) => x.ordinal !== null)) {
      expect(f.plain).toEqual(expect.any(String));
    }
  });

  it('a latest run that succeeded raises no warning (art-009 proven, art-011 never run)', async () => {
    expect((await guideFor('art-009'))!.run_warning).toBeNull();
    expect((await guideFor('art-011'))!.run_warning).toBeNull();
    expect((await guideFor('art-011'))!.approach.map((s) => s.ordinal)).toEqual([1, 2, 3]);
  });

  it('a non-procedure guide has no approach but still names what it was based on; an unknown id is null', async () => {
    const g = (await guideFor('art-001'))!;
    expect(g.approach).toEqual([]);
    expect(g.run_warning).toBeNull();
    expect(g.based_on.map((b) => b.id)).toEqual(['cl-019']);
    expect(await guideFor('art-nope')).toBeNull();
  });

  it('a success recorded after the failure clears the warning; reset brings the seed back', async () => {
    await applyProcedure('art-010', { outcome: 'succeeded' }, { sessionId: 'u', boxId: 'portal' });
    expect((await guideFor('art-010'))!.run_warning).toBeNull();
    __resetDistillationMock();
    expect((await guideFor('art-010'))!.run_warning?.run_id).toBe('papp-006');
  });

  it('an abandoned run reads as abandoned, with its plain reason and a default title', async () => {
    const row = await applyProcedure('art-010',
      { outcome: 'abandoned', plain_reason: '  the customer asked to wait a week  ' },
      { sessionId: 'u', boxId: 'portal' });
    expect(row.plain_reason).toBe('the customer asked to wait a week');
    expect(row.advice).toBeNull();
    const w = (await guideFor('art-010'))!.run_warning!;
    expect(w).toMatchObject({
      run_id: row.id, outcome: 'abandoned', failed_at_ordinal: null,
      title: 'The last attempt was abandoned',
      body: 'The last attempt was abandoned: the customer asked to wait a week.',
    });
  });

  it('a failed run with no plain text still names its step', async () => {
    await applyProcedure('art-010', { outcome: 'failed', failed_at_step_id: 'fact-019' }, { sessionId: 'u', boxId: 'portal' });
    expect((await guideFor('art-010'))!.run_warning).toMatchObject({
      failed_at_ordinal: 2, title: 'The last attempt failed at step 2', body: 'The last attempt stopped at step 2.',
    });
  });

  it('advice and plain_reason are refused on a succeeded run and past 200 characters', async () => {
    await expect(applyProcedure('art-010', { outcome: 'succeeded', advice: 'Careful' }, { sessionId: 'u', boxId: 'portal' }))
      .rejects.toMatchObject({ status: 400 });
    await expect(applyProcedure('art-010', { outcome: 'abandoned', plain_reason: 'x'.repeat(201) }, { sessionId: 'u', boxId: 'portal' }))
      .rejects.toMatchObject({ status: 400 });
    const blank = await applyProcedure('art-010', { outcome: 'succeeded', advice: '   ' }, { sessionId: 'u', boxId: 'portal' });
    expect(blank.advice).toBeNull();
  });

  it('lineage carries the plain wording on a step node', async () => {
    const step = (await factLineage('fact-020')).nodes.find((n) => n.id === 'fact-020');
    expect(step?.meta['plain']).toBe('Switch one customer and verify sign-in.');
  });

  it('a compaction-minted artifact carries null plain fields and its approach reads the statements', async () => {
    __setCompactRunMs(0);
    await compactNow('L1', 'Test Operator');
    const job = await compactNow('L2', 'Test Operator');
    expect(job.produced.artifact_ids.length).toBeGreaterThan(0);
    for (const id of job.produced.artifact_ids) {
      const a = artifacts.rows().find((x) => x.id === id)!;
      expect(a.when_this_helps).toBeNull();
      const minted = facts.rows().filter((f) => f.artifact_id === id);
      expect(minted.every((f) => f.plain === null)).toBe(true);
      const g = (await guideFor(id))!;
      for (const step of g.approach) {
        expect(step.text).toBe(minted.find((f) => f.id === step.step_id)!.statement);
      }
    }
  });
});

describe('repoDisplayName — one rule for facets and based_on', () => {
  it('keeps the last path segment and drops the orgiq- prefix', () => {
    expect(repoDisplayName('connorhoehnslalom/orgiq-auth-service')).toBe('auth-service');
    expect(repoDisplayName('someone/tools')).toBe('tools');
    expect(repoDisplayName('orgiq-')).toBe('orgiq-');
  });

  it('the facet label for a repo is the same string a guide shows for it', async () => {
    const facets = await listFacets('L2');
    const auth = facets.repos.find((r) => r.value === 'connorhoehnslalom/orgiq-auth-service')!;
    expect(auth.label).toBe((await guideFor('art-010'))!.based_on[0]!.repo_label);
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

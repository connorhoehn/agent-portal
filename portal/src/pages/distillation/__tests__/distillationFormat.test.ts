// Run with:  cd portal && node --test 'src/pages/distillation/__tests__/*.test.ts'

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  lagLabel, bytesLabel, dedupePctLabel, durationLabel, usd, pct,
  STATUS_TONE, LEVEL_HEALTH_TONE, SAMPLING_TONE,
  ARTIFACT_TYPE_LABEL, ARTIFACT_STATUS_TONE, REVIEW_VERDICT_TONE, evidenceLabel, layoutLineage, lineageCanvasHeight,
  artifactFactCount, factsFromLineage,
  itemsQueryParams, filterByObservationKind, describeActiveFilters, hasActiveFilters,
  filtersSummaryLabel, itemsShownLabel, producedSummaryLabel,
  latestJobFor, compactionFlowModel,
  ARTIFACT_TYPE_TONE, PROCEDURE_HEALTH_TONE, OUTCOME_SEVERITY,
  stepsLabel, stepsFromLineage, stepTonesForRun, procedureRollup, runsLabel,
  isRecentlyLanded, liveSessionCountForRepo,
} from '../distillationFormat.ts';
import type {
  CompactionJob, Item, LevelHealth, LevelState, LineageEdge, LineageNode, ProcedureApplication, ProcedureView,
} from '../types.ts';

test('lagLabel reads caught up at zero, not "0m"', () => {
  assert.equal(lagLabel(0), 'caught up');
  assert.equal(lagLabel(-5), 'caught up');
});

test('lagLabel picks minutes, hours, or days for readability', () => {
  assert.equal(lagLabel(300), '5m');
  assert.equal(lagLabel(2700), '45m');
  assert.equal(lagLabel(3600), '1h');
  assert.equal(lagLabel(5400), '1h 30m');
  assert.equal(lagLabel(151200), '1d 18h');
});

test('bytesLabel scales units', () => {
  assert.equal(bytesLabel(512), '512 B');
  assert.equal(bytesLabel(427_500), '417.5 KB');
  assert.equal(bytesLabel(3_500_000), '3.3 MB');
});

test('dedupePctLabel mirrors the server guard — no ratio for zero input', () => {
  assert.equal(dedupePctLabel({ inputItems: 0, dedupedItems: 0 }), '—');
  assert.equal(dedupePctLabel({ inputItems: 140, dedupedItems: 78 }), '56%');
});

test('durationLabel says "running…" rather than measuring against now', () => {
  assert.equal(durationLabel({ startedAt: '2026-09-02T10:00:00Z', finishedAt: null }), 'running…');
});

test('producedSummaryLabel guards on shape — undefined/empty produced while a job is running', () => {
  assert.equal(producedSummaryLabel(undefined), 'nothing new');
  assert.equal(producedSummaryLabel(null), 'nothing new');
  assert.equal(producedSummaryLabel({ cluster_ids: [], artifact_ids: [] }), 'nothing new');
});

test('producedSummaryLabel names what a completed job made, singular vs plural', () => {
  assert.equal(producedSummaryLabel({ cluster_ids: ['c1'], artifact_ids: [] }), '1 cluster');
  assert.equal(producedSummaryLabel({ cluster_ids: [], artifact_ids: ['a1'] }), '1 artifact');
  assert.equal(
    producedSummaryLabel({ cluster_ids: ['c1', 'c2', 'c3'], artifact_ids: ['a1', 'a2'] }),
    '3 clusters, 2 artifacts',
  );
});

test('durationLabel formats seconds and minutes', () => {
  assert.equal(durationLabel({ startedAt: '2026-09-02T10:00:00Z', finishedAt: '2026-09-02T10:00:42Z' }), '42s');
  assert.equal(durationLabel({ startedAt: '2026-09-02T10:00:00Z', finishedAt: '2026-09-02T10:03:00Z' }), '3m');
  assert.equal(durationLabel({ startedAt: '2026-09-02T10:00:00Z', finishedAt: '2026-09-02T10:03:20Z' }), '3m 20s');
});

test('usd and pct formatting', () => {
  assert.equal(usd(1.5), '$1.50');
  assert.equal(pct(0.38), '38%');
});

test('tones cover every status and verdict', () => {
  assert.equal(STATUS_TONE.failed, 'danger');
  assert.equal(LEVEL_HEALTH_TONE.stalled, 'danger');
  assert.equal(LEVEL_HEALTH_TONE.behind, 'warning');
  assert.equal(SAMPLING_TONE.undersampled, 'warning');
  assert.equal(SAMPLING_TONE.oversampled, 'info');
});

test('artifact and review vocab covers every enum member', () => {
  assert.equal(ARTIFACT_TYPE_LABEL.runbook, 'Runbook');
  assert.equal(ARTIFACT_TYPE_LABEL.decision, 'Decision');
  assert.equal(ARTIFACT_TYPE_LABEL.procedure, 'Procedure');
  assert.equal(ARTIFACT_TYPE_TONE.procedure, 'success');
  assert.equal(ARTIFACT_STATUS_TONE.published, 'success');
  assert.equal(ARTIFACT_STATUS_TONE.retired, 'caution');
  assert.equal(REVIEW_VERDICT_TONE.agree, 'success');
  assert.equal(REVIEW_VERDICT_TONE.disagree, 'danger');
});

test('evidenceLabel pluralizes on the observation count', () => {
  assert.equal(evidenceLabel(0), '0 observations');
  assert.equal(evidenceLabel(1), '1 observation');
  assert.equal(evidenceLabel(3), '3 observations');
});

test('layoutLineage places nodes in kind columns, left to right', () => {
  const nodes: LineageNode[] = [
    { id: 'obs-1', kind: 'observation', label: 'Obs 1', meta: {} },
    { id: 'cl-1', kind: 'cluster', label: 'Cluster 1', meta: {} },
    { id: 'art-1', kind: 'artifact', label: 'Artifact 1', meta: {} },
    { id: 'lib-1', kind: 'library_item', label: 'Lib 1', meta: {} },
  ];
  const edges: LineageEdge[] = [
    { from: 'obs-1', to: 'cl-1', relation: 'merged_into' },
    { from: 'cl-1', to: 'art-1', relation: 'distilled_into' },
    { from: 'art-1', to: 'lib-1', relation: 'published_as' },
  ];
  const laid = layoutLineage(nodes, edges);
  const at = (id: string) => laid.find((n) => n.id === id)!;
  assert.ok(at('obs-1').x < at('cl-1').x);
  assert.ok(at('cl-1').x < at('art-1').x);
  assert.ok(at('art-1').x < at('lib-1').x);
});

test('layoutLineage places an application node in the rightmost column, level with the library item', () => {
  const nodes: LineageNode[] = [
    { id: 'cl-1', kind: 'cluster', label: 'Cluster 1', meta: {} },
    { id: 'art-1', kind: 'artifact', label: 'Procedure 1', meta: {} },
    { id: 'fact-1', kind: 'fact', label: 'Step 1', meta: { ordinal: 1 } },
    { id: 'lib-1', kind: 'library_item', label: 'Lib 1', meta: {} },
    { id: 'app-1', kind: 'application', label: 'Run 1', meta: { outcome: 'succeeded' } },
  ];
  const edges: LineageEdge[] = [
    { from: 'cl-1', to: 'art-1', relation: 'distilled_into' },
    { from: 'fact-1', to: 'art-1', relation: 'supports' },
    { from: 'art-1', to: 'lib-1', relation: 'published_as' },
    { from: 'art-1', to: 'app-1', relation: 'applied_in' },
  ];
  const laid = layoutLineage(nodes, edges);
  const at = (id: string) => laid.find((n) => n.id === id)!;
  const maxX = Math.max(...laid.map((n) => n.x));
  assert.equal(at('app-1').x, maxX);
  assert.equal(at('app-1').x, at('lib-1').x);
  assert.ok(at('fact-1').x < at('app-1').x);
  // Same column, different rows — the two never sit on top of each other.
  assert.notEqual(at('app-1').y, at('lib-1').y);
});

test('artifactFactCount counts fact IDs — Artifact.facts carries no resolved objects', () => {
  assert.equal(artifactFactCount({ facts: [] }), 0);
  assert.equal(artifactFactCount({ facts: ['fact-1', 'fact-2', 'fact-3'] }), 3);
});

test('factsFromLineage reads statement/confidence from fact nodes and counts only incoming evidence edges', () => {
  const lineage = {
    nodes: [
      { id: 'art-1', kind: 'artifact' as const, label: 'Artifact 1', meta: {} },
      { id: 'fact-1', kind: 'fact' as const, label: 'Uses arm64 Fargate', meta: { confidence: 0.9 } },
      { id: 'obs-1', kind: 'observation' as const, label: 'Obs 1', meta: {} },
      { id: 'obs-2', kind: 'observation' as const, label: 'Obs 2', meta: {} },
    ],
    edges: [
      { from: 'fact-1', to: 'art-1', relation: 'supports' as const },
      { from: 'obs-1', to: 'fact-1', relation: 'supports' as const },
      { from: 'obs-2', to: 'fact-1', relation: 'supports' as const },
    ],
  };
  const facts = factsFromLineage(lineage);
  assert.equal(facts.length, 1);
  assert.equal(facts[0]!.statement, 'Uses arm64 Fargate');
  assert.equal(facts[0]!.confidence, 0.9);
  assert.equal(facts[0]!.evidenceCount, 2);
});

test('layoutLineage stacks multiple nodes in the same column without collision', () => {
  const nodes: LineageNode[] = [
    { id: 'obs-1', kind: 'observation', label: 'Obs 1', meta: {} },
    { id: 'obs-2', kind: 'observation', label: 'Obs 2', meta: {} },
    { id: 'obs-3', kind: 'observation', label: 'Obs 3', meta: {} },
  ];
  const laid = layoutLineage(nodes, []);
  const ys = laid.map((n) => n.y);
  assert.equal(new Set(ys).size, 3);
});

// ── lineageCanvasHeight (distillation lineage audit residual: fitView was
// settling at ~half zoom in the top two-fifths of a fixed 560px canvas
// because most single-artifact traces are only 1-4 rows tall against that
// hard-coded height) ─────────────────────────────────────────────────────

test('lineageCanvasHeight floors a one-row (or empty) graph at the band minimum, not the fixed legacy height', () => {
  const nodes: LineageNode[] = [
    { id: 'obs-1', kind: 'observation', label: 'Obs 1', meta: {} },
    { id: 'cl-1', kind: 'cluster', label: 'Cluster 1', meta: {} },
    { id: 'art-1', kind: 'artifact', label: 'Artifact 1', meta: {} },
    { id: 'lib-1', kind: 'library_item', label: 'Lib 1', meta: {} },
  ];
  const edges: LineageEdge[] = [
    { from: 'obs-1', to: 'cl-1', relation: 'merged_into' },
    { from: 'cl-1', to: 'art-1', relation: 'distilled_into' },
    { from: 'art-1', to: 'lib-1', relation: 'published_as' },
  ];
  const laid = layoutLineage(nodes, edges);
  assert.equal(lineageCanvasHeight(laid, { min: 220, max: 560 }), 220);
  assert.equal(lineageCanvasHeight([], { min: 220, max: 560 }), 220);
});

test('lineageCanvasHeight grows with row count and clamps at the band maximum', () => {
  const nodes: LineageNode[] = [
    { id: 'obs-1', kind: 'observation', label: 'Obs 1', meta: {} },
    { id: 'obs-2', kind: 'observation', label: 'Obs 2', meta: {} },
    { id: 'obs-3', kind: 'observation', label: 'Obs 3', meta: {} },
  ];
  const laid = layoutLineage(nodes, []);
  // 3 rows: maxY = 2 * LINEAGE_ROW_HEIGHT(116) = 232; content height =
  // 232 + 116 + 50 = 398 — between the band's min and max, so it passes
  // through unclamped rather than snapping to either edge.
  assert.equal(lineageCanvasHeight(laid, { min: 220, max: 560 }), 398);

  const manyRows = Array.from({ length: 10 }, (_, i) => ({
    id: `obs-${i}`, kind: 'observation' as const, label: `Obs ${i}`, meta: {},
  }));
  const laidMany = layoutLineage(manyRows, []);
  assert.equal(lineageCanvasHeight(laidMany, { min: 220, max: 560 }), 560);
});

test('lineageCanvasHeight respects a caller-supplied band (compact preview vs full page)', () => {
  const nodes: LineageNode[] = [{ id: 'obs-1', kind: 'observation', label: 'Obs 1', meta: {} }];
  const laid = layoutLineage(nodes, []);
  assert.equal(lineageCanvasHeight(laid, { min: 180, max: 260 }), 180);
});

// ── Items filters (Tiers page — defect #2) ──────────────────────────────────

test('itemsQueryParams always carries level, omits unset facets, and uses the wire name "initiative"', () => {
  assert.deepEqual(itemsQueryParams({ level: 'L0' }), { level: 'L0' });
  assert.deepEqual(
    itemsQueryParams({ level: 'L1', repo: 'org/repo', initiativeId: 'p-auth-migration', q: 'flaky', cursor: 'c1' }),
    { level: 'L1', repo: 'org/repo', initiative: 'p-auth-migration', q: 'flaky', cursor: 'c1' },
  );
});

test('itemsQueryParams has no kind param — GET /items does not accept one', () => {
  const params = itemsQueryParams({ level: 'L0', repo: 'org/repo' } as never);
  assert.equal('kind' in params, false);
});

const OBS_WORKED = { level: 'L0', id: 'obs-1', kind: 'worked' } as unknown as Item;
const OBS_FAILED = { level: 'L0', id: 'obs-2', kind: 'failed' } as unknown as Item;
const CLUSTER_WORKED = { level: 'L1', id: 'cl-1', kind: 'worked' } as unknown as Item;
const ARTIFACT = { level: 'L2', id: 'art-1', type: 'runbook' } as unknown as Item;

test('filterByObservationKind passes everything through with no kind selected', () => {
  const items = [OBS_WORKED, OBS_FAILED, ARTIFACT];
  assert.equal(filterByObservationKind(items).length, 3);
  assert.equal(filterByObservationKind(items, '').length, 3);
});

test('filterByObservationKind keeps only matching L0/L1 rows and always passes L2 through', () => {
  const items = [OBS_WORKED, OBS_FAILED, CLUSTER_WORKED, ARTIFACT];
  const filtered = filterByObservationKind(items, 'worked');
  assert.deepEqual(filtered.map((i) => i.id), ['obs-1', 'cl-1', 'art-1']);
});

test('describeActiveFilters / hasActiveFilters / filtersSummaryLabel agree on what counts as active', () => {
  assert.deepEqual(describeActiveFilters({}), []);
  assert.equal(hasActiveFilters({}), false);
  assert.equal(filtersSummaryLabel({}), 'no filters');

  const filters = { repo: 'org/repo', initiativeId: 'p-cost-opt', kind: 'gotcha' as const, q: 'timeout' };
  assert.deepEqual(describeActiveFilters(filters), [
    'repo org/repo', 'initiative p-cost-opt', 'kind gotcha', 'search "timeout"',
  ]);
  assert.equal(hasActiveFilters(filters), true);
  assert.equal(filtersSummaryLabel(filters), 'repo org/repo, initiative p-cost-opt, kind gotcha, search "timeout"');
});

test('itemsShownLabel reads "N of M shown"', () => {
  assert.equal(itemsShownLabel(3, 69), '3 of 69 shown');
  assert.equal(itemsShownLabel(0, 8), '0 of 8 shown');
});

// ── Compaction flow (Compactions page tier ladder) ──────────────────────────

function job(over: Partial<CompactionJob>): CompactionJob {
  return {
    id: 'job-x', level: 'L1', startedAt: '2026-09-04T10:00:00Z', finishedAt: '2026-09-04T10:01:00Z',
    status: 'succeeded', inputItems: 0, outputItems: 0, dedupedItems: 0, bytesReclaimed: 0, costUsd: 0,
    ...over,
  };
}

test('latestJobFor picks the most recently started job for that merge step, ignoring the other step', () => {
  const jobs = [
    job({ id: 'j1', level: 'L1', startedAt: '2026-09-04T09:00:00Z' }),
    job({ id: 'j2', level: 'L1', startedAt: '2026-09-04T11:00:00Z' }),
    job({ id: 'j3', level: 'L2', startedAt: '2026-09-04T12:00:00Z' }),
  ];
  assert.equal(latestJobFor('L1', jobs)?.id, 'j2');
  assert.equal(latestJobFor('L2', jobs)?.id, 'j3');
});

test('latestJobFor returns null when the step has never run', () => {
  assert.equal(latestJobFor('L2', [job({ level: 'L1' })]), null);
  assert.equal(latestJobFor('L1', []), null);
});

const LEVELS: LevelState[] = [
  { level: 'L0', items: 140, sizeBytes: 1000, oldestAt: '2026-09-01T00:00:00Z', lagSeconds: 0 },
  { level: 'L1', items: 22, sizeBytes: 2000, oldestAt: '2026-09-01T00:00:00Z', lagSeconds: 400 },
  { level: 'L2', items: 9, sizeBytes: 3000, oldestAt: '2026-09-01T00:00:00Z', lagSeconds: 0 },
];
const HEALTH: LevelHealth[] = [
  { level: 'L0', status: 'healthy', reason: 'on pace' },
  { level: 'L1', status: 'behind', reason: 'lagging' },
  { level: 'L2', status: 'stalled', reason: 'no recent runs' },
];

test('compactionFlowModel lays out L0 → L1 → L2 → Library left to right with counts and health', () => {
  const { nodes } = compactionFlowModel(LEVELS, HEALTH, [], 4);
  assert.deepEqual(nodes.map((n) => n.id), ['L0', 'L1', 'L2', 'library']);
  assert.ok(nodes[1].x > nodes[0].x && nodes[2].x > nodes[1].x && nodes[3].x > nodes[2].x);
  assert.equal(nodes[1].count, 22);
  assert.equal(nodes[1].health, 'behind');
  assert.equal(nodes[1].ariaLabel, 'L1 clusters, 22 items, behind');
  assert.equal(nodes[3].count, 4);
  assert.equal(nodes[3].health, undefined);
  assert.equal(nodes[3].navigateTo, '/iq/library');
  assert.equal(nodes[0].navigateTo, '/iq/distillation/tiers?level=L0');
});

test('compactionFlowModel labels merge edges from the latest job for that step, and flags "no merges yet"', () => {
  const jobs = [job({ id: 'j1', level: 'L1', startedAt: '2026-09-04T09:00:00Z', inputItems: 140, outputItems: 62, dedupedItems: 78 })];
  const { edges } = compactionFlowModel(LEVELS, HEALTH, jobs, 0);
  const l0l1 = edges.find((e) => e.id === 'L0-L1')!;
  const l1l2 = edges.find((e) => e.id === 'L1-L2')!;
  assert.ok(l0l1.label.startsWith('140 in · 62 out · 56% deduped ·'));
  assert.equal(l1l2.label, 'no merges yet');
});

test('compactionFlowModel: a running job wins over the idle "behind" breathe on the same edge', () => {
  const jobs = [job({ level: 'L1', status: 'running', startedAt: '2026-09-04T09:00:00Z' })];
  const { edges } = compactionFlowModel(LEVELS, HEALTH, jobs, 0);
  const l0l1 = edges.find((e) => e.id === 'L0-L1')!;
  assert.equal(l0l1.running, true);
  assert.equal(l0l1.breathing, false);
});

test('compactionFlowModel: no running job on a "behind"/"stalled" target breathes; "healthy" never does', () => {
  const { edges } = compactionFlowModel(LEVELS, HEALTH, [], 0);
  const l0l1 = edges.find((e) => e.id === 'L0-L1')!; // target L1: behind
  const l1l2 = edges.find((e) => e.id === 'L1-L2')!; // target L2: stalled
  assert.equal(l0l1.breathing, true);
  assert.equal(l0l1.tone, 'behind');
  assert.equal(l1l2.breathing, true);
  assert.equal(l1l2.tone, 'stalled');
});

test('compactionFlowModel: L2 → Library edge is always "published as", neutral, never animated', () => {
  const { edges } = compactionFlowModel(LEVELS, HEALTH, [], 4);
  const lib = edges.find((e) => e.id === 'L2-library')!;
  assert.equal(lib.label, 'published as');
  assert.equal(lib.tone, 'neutral');
  assert.equal(lib.running, false);
  assert.equal(lib.breathing, false);
});

// ── Procedures (procedural memory) ───────────────────────────────────────

test('procedure health and outcome vocab covers every enum member', () => {
  assert.equal(PROCEDURE_HEALTH_TONE.proven, 'success');
  assert.equal(PROCEDURE_HEALTH_TONE.drifting, 'warning');
  assert.equal(PROCEDURE_HEALTH_TONE.unproven, 'neutral');
  assert.equal(OUTCOME_SEVERITY.succeeded, 'success');
  assert.equal(OUTCOME_SEVERITY.failed, 'error');
  assert.equal(OUTCOME_SEVERITY.abandoned, 'warning');
});

test('stepsLabel pluralizes on the step count', () => {
  assert.equal(stepsLabel(1), '1 step');
  assert.equal(stepsLabel(4), '4 steps');
  assert.equal(stepsLabel(0), '0 steps');
});

test('stepsFromLineage sorts fact nodes by ordinal regardless of wire order and drops null-ordinal claims', () => {
  const lineage = {
    nodes: [
      { id: 'art-1', kind: 'artifact' as const, label: 'Procedure', meta: {} },
      { id: 'fact-3', kind: 'fact' as const, label: 'Redeploy', meta: { ordinal: 3 } },
      { id: 'fact-claim', kind: 'fact' as const, label: 'Needs ARM64', meta: { ordinal: null } },
      { id: 'fact-1', kind: 'fact' as const, label: 'Build base', meta: { ordinal: 1 } },
      { id: 'fact-2', kind: 'fact' as const, label: 'Push images', meta: { ordinal: 2, confidence: 0.8 } },
      { id: 'obs-1', kind: 'observation' as const, label: 'Obs', meta: { ordinal: 9 } },
    ],
  };
  const steps = stepsFromLineage(lineage);
  assert.deepEqual(steps.map((s) => s.id), ['fact-1', 'fact-2', 'fact-3']);
  assert.deepEqual(steps.map((s) => s.ordinal), [1, 2, 3]);
  assert.equal(steps[1]!.label, 'Push images');
  assert.equal(steps[1]!.meta['confidence'], 0.8);
});

test('stepsFromLineage returns nothing for a lineage with no ordered facts', () => {
  assert.deepEqual(stepsFromLineage({ nodes: [] }), []);
  assert.deepEqual(
    stepsFromLineage({ nodes: [{ id: 'fact-1', kind: 'fact', label: 'Claim', meta: {} }] }),
    [],
  );
});

const STEPS = [{ id: 's1' }, { id: 's2' }, { id: 's3' }, { id: 's4' }];

function run(over: Partial<ProcedureApplication>): ProcedureApplication {
  return {
    id: 'app-1', procedure_id: 'art-1', session_id: 'sess-1', box_id: 'box-1', repo: 'org/repo',
    applied_at: '2026-09-10T10:00:00Z', outcome: 'succeeded', failed_at_step_id: null, note: null,
    ...over,
  };
}

test('stepTonesForRun: a succeeded latest run proves every step', () => {
  assert.deepEqual(stepTonesForRun(STEPS, run({})), ['success', 'success', 'success', 'success']);
});

test('stepTonesForRun: a failed run proves the steps before the failure, blames the failing step, and says nothing after', () => {
  assert.deepEqual(
    stepTonesForRun(STEPS, run({ outcome: 'failed', failed_at_step_id: 's3' })),
    ['success', 'success', 'danger', 'neutral'],
  );
  assert.deepEqual(
    stepTonesForRun(STEPS, run({ outcome: 'failed', failed_at_step_id: 's1' })),
    ['danger', 'neutral', 'neutral', 'neutral'],
  );
});

test('stepTonesForRun: no run, an abandoned run, or a failure at an unknown step all read neutral', () => {
  assert.deepEqual(stepTonesForRun(STEPS, null), ['neutral', 'neutral', 'neutral', 'neutral']);
  assert.deepEqual(stepTonesForRun(STEPS, run({ outcome: 'abandoned' })), ['neutral', 'neutral', 'neutral', 'neutral']);
  assert.deepEqual(
    stepTonesForRun(STEPS, run({ outcome: 'failed', failed_at_step_id: 'gone' })),
    ['neutral', 'neutral', 'neutral', 'neutral'],
  );
  assert.deepEqual(stepTonesForRun([], run({})), []);
});

const view = (status: ProcedureView['health']['status']): Pick<ProcedureView, 'health'> =>
  ({ health: { status, reason: 'because' } });

test('procedureRollup counts each health bucket and writes the header hint', () => {
  const r = procedureRollup([view('proven'), view('drifting'), view('unproven')]);
  assert.equal(r.total, 3);
  assert.equal(r.proven, 1);
  assert.equal(r.drifting, 1);
  assert.equal(r.unproven, 1);
  assert.equal(r.hint, '3 procedures · 1 proven · 1 drifting · 1 unproven');
});

test('procedureRollup omits empty buckets from the hint and names the empty list', () => {
  assert.equal(procedureRollup([view('proven'), view('proven')]).hint, '2 procedures · 2 proven');
  assert.equal(procedureRollup([view('unproven')]).hint, '1 procedure · 1 unproven');
  assert.deepEqual(procedureRollup([]), { total: 0, proven: 0, drifting: 0, unproven: 0, hint: 'no procedures' });
});

test('runsLabel leads with the success count, and says "no runs yet" at zero', () => {
  assert.equal(runsLabel({ total: 6, succeeded: 4, failed: 1, abandoned: 1 }), '6 runs · 4 succeeded');
  assert.equal(runsLabel({ total: 1, succeeded: 0, failed: 1, abandoned: 0 }), '1 run · 0 succeeded');
  assert.equal(runsLabel({ total: 0, succeeded: 0, failed: 0, abandoned: 0 }), 'no runs yet');
});

// Slice 2: Tiers "Landed" column — StatusDot pulse iff inside the window.
test('isRecentlyLanded is true only inside the window, false at/after it and on bad input', () => {
  const now = Date.parse('2026-09-15T12:00:00Z');
  assert.equal(isRecentlyLanded('2026-09-15T11:59:30Z', now, 60_000), true, '30s old, 60s window');
  assert.equal(isRecentlyLanded('2026-09-15T11:59:00Z', now, 60_000), false, 'exactly at the window edge');
  assert.equal(isRecentlyLanded('2026-09-15T11:58:00Z', now, 60_000), false, '2m old');
  assert.equal(isRecentlyLanded('2026-09-15T12:00:01Z', now, 60_000), false, 'in the future is not "recent"');
  assert.equal(isRecentlyLanded(null, now, 60_000), false);
  assert.equal(isRecentlyLanded('not a date', now, 60_000), false);
});

// Slice 2: Overview "Repo activity" column — the honest repo-level join
// (never a fake session-id join) against the owner-scoped node list.
test('liveSessionCountForRepo counts only sessions matching the repo, across nodes', () => {
  const nodes = [
    { presence: { sessions: [{ repo: 'org/a' }, { repo: 'org/b' }] } },
    { presence: { sessions: [{ repo: 'org/a' }] } },
    { presence: { sessions: [] } },
  ];
  assert.equal(liveSessionCountForRepo(nodes, 'org/a'), 2);
  assert.equal(liveSessionCountForRepo(nodes, 'org/b'), 1);
  assert.equal(liveSessionCountForRepo(nodes, 'org/c'), 0);
  assert.equal(liveSessionCountForRepo(nodes, null), 0, 'a procedure spanning repos has none to check');
  assert.equal(liveSessionCountForRepo([], 'org/a'), 0);
});

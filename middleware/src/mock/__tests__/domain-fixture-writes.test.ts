// Five provider domains that held their mock rows in bare module-level arrays:
// work-items, promotions, session-bundle, lab and prompt-evals.
//
// A bare array is not merely untidy — it is the reason the wire capture's
// write policy could not replay these routes honestly. Two of them
// (`POST /api/promotions/:id/promote`, `POST /api/session-bundle/:id/publish`)
// were refused outright as `unresettable`, and `PATCH /api/graph/work-items/
// :id` was replayed only as an *echo-back*: it wrote the item's own current
// priority straight back so the row ended byte-identical, which pins a
// response shape and proves nothing about the write.
//
// So these tests are not "does a row appear". Each one asserts the property
// the missing fixture cost:
//
//   1. THE WRITE LANDS — a real change, not an echo-back, visible on the next
//      read through the provider's own public API.
//   2. `reset()` PUTS THE SEED BACK — the exact seeded value, so a test fails
//      if a write leaked a field the reset did not restore.
//   3. STAMPS COME FROM THE CLOCK — `freezeClock` pins them to the instant, so
//      an assertion is an exact string rather than a range.
//   4. IDS ARE HIGH-WATER MARKS, NOT COUNTERS — the counter bug is invisible
//      until you reset: a monotonic `++seq` keeps climbing past ids nothing
//      holds, and a counter reset with the fixture re-mints one the seed owns.
//      Only a test that writes, resets, and writes AGAIN can see it.
//
// They go through the PROVIDERS rather than the fixtures, because the provider
// is where the mutation lives and the fixture is only where it now lands.

jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', mock: { aurora: true, agentcore: true } },
}));

import { freezeClock, fixtureRegistry } from '../core/index.js';
import { workItems } from '../work-items.js';
import { promotionCandidates } from '../promotions.js';
import { pipelineRunRecords } from '../pipeline-definitions.js';
import { sessionBundles } from '../session-bundle.js';
import { labConsults, labExperiences } from '../lab.js';
import { promptEvalCases, promptEvalRuns } from '../prompt-evals.js';

import { createWorkItem, getWorkItem, updateWorkItem, searchWorkItems } from '../../providers/work-items.js';
import { dismissCandidate, getCandidate, listCandidates, promoteCandidate } from '../../providers/promotions.js';
import { getBundle, getLiveBundle, listBundles, publishBundle } from '../../providers/session-bundle.js';
import {
  answerConsult, getConsult, listConsults, listExperiences, openConsult, recordExperience,
} from '../../providers/lab.js';
import { listEvalSets, listRuns, runEvals } from '../../providers/prompt-evals.js';

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

// ─── work-items ──────────────────────────────────────────────────────────────

describe('the board (work-items)', () => {
  it('creates a row the board then serves, stamped from the frozen clock', async () => {
    freeze('2026-09-06T11:22:33.000Z');
    const created = await createWorkItem({
      projectId: 'p-observability', type: 'story', title: 'Probe',
      priority: 'high', storyPoints: 3,
    });

    expect(created.id).toBe('wi-mock-1');
    expect(created.createdAt).toBe('2026-09-06T11:22:33.000Z');
    expect(created.updatedAt).toBe('2026-09-06T11:22:33.000Z');
    // The initiative name comes from the initiative list, never from the
    // caller — the rule that stops a row labelling its initiative wrongly.
    expect(created.projectName).toBe('Observability Platform');
    expect(await getWorkItem('wi-mock-1')).toMatchObject({ title: 'Probe' });
  });

  it('mints the next id from the rows, so a reset does not strand the counter', async () => {
    freeze('2026-09-06T11:22:33.000Z');
    await createWorkItem({ projectId: 'p-observability', type: 'story', title: 'One' });
    const second = await createWorkItem({ projectId: 'p-observability', type: 'story', title: 'Two' });
    expect(second.id).toBe('wi-mock-2');

    workItems.reset('default');

    // A module counter would be at 3 here, over a board that holds neither
    // wi-mock-1 nor wi-mock-2. The high-water mark is read off the rows.
    const afterReset = await createWorkItem({
      projectId: 'p-observability', type: 'story', title: 'Three',
    });
    expect(afterReset.id).toBe('wi-mock-1');
  });

  it('edits a SEEDED row for real, and the reset puts the seed back verbatim', async () => {
    // Not an echo-back: a different title AND a different priority, on a row
    // schema/seed_program.sql owns.
    const seeded = await getWorkItem('wi-obs-e3-s1');
    expect(seeded).toMatchObject({
      title: 'Metric cardinality budgets', priority: 'medium',
    });

    freeze('2026-09-06T11:22:33.000Z');
    const patched = await updateWorkItem('wi-obs-e3-s1', {
      title: 'Edited by an auditor', priority: 'critical',
    });
    expect(patched).toMatchObject({ title: 'Edited by an auditor', priority: 'critical' });
    expect(patched!.updatedAt).toBe('2026-09-06T11:22:33.000Z');

    workItems.reset('default');

    expect(await getWorkItem('wi-obs-e3-s1')).toMatchObject({
      title: 'Metric cardinality budgets',
      priority: 'medium',
      // The seed's D(n) is replayed from the mock clock inside the factory,
      // so a reset under the freeze puts back "n days before now": this row's
      // `updatedAt` is D(0), i.e. the frozen now itself.
      updatedAt: '2026-09-06T11:22:33.000Z',
    });
  });

  it('empties the whole board under the `empty` scenario', async () => {
    expect((await searchWorkItems({ limit: 500 })).length).toBeGreaterThan(50);
    fixtureRegistry.resetAll('empty');
    expect(await searchWorkItems({ limit: 500 })).toEqual([]);
    fixtureRegistry.resetAll('default');
    expect((await searchWorkItems({ limit: 500 })).length).toBeGreaterThan(50);
  });
});

// ─── promotions ──────────────────────────────────────────────────────────────

describe('the promotions inbox', () => {
  it('promotes a candidate, and the reset takes the promotion back', async () => {
    expect((await getCandidate('promo-aurora-cold-start'))!.status).toBe('candidate');

    // Rule 1: a skill promotes on a recorded, completed dry-run of its own runbook.
    pipelineRunRecords.rows().push({
      id: 'job:probe', definitionId: 'runbook:promo-aurora-cold-start', contextTenant: 'orgiq', runKind: 'runbook:dry-run',
      status: 'completed', jobId: null, triggeredBy: 'u-ines', model: null, estimateUsd: null, costUsd: null,
      error: null, startedAt: '2026-09-30T10:00:00.000Z', finishedAt: '2026-09-30T10:01:00.000Z',
    });
    const result = await promoteCandidate('promo-aurora-cold-start', { approvedBy: 'Platform Operator' });
    expect(result).toMatchObject({ candidate: { status: 'promoted', dryRunRunId: 'job:probe', dryRunPassed: true } });

    promotionCandidates.reset('default');
    pipelineRunRecords.reset('default');

    expect(await getCandidate('promo-aurora-cold-start')).toMatchObject({
      status: 'candidate', dryRunRunId: null, dryRunPassed: null,
    });
  });

  it('un-appends a dismissal reason — the write that was not idempotent', async () => {
    const before = (await getCandidate('promo-adot-configurator'))!.rationale;
    expect(before.endsWith('not a runbook to execute.')).toBe(true);

    await dismissCandidate('promo-adot-configurator', 'round-trip probe');
    const after = (await getCandidate('promo-adot-configurator'))!;
    expect(after.status).toBe('dismissed');
    expect(after.rationale).toBe(`${before} — dismissed: round-trip probe`);

    // Dismiss twice and the reasons stack — which is exactly why this write
    // needed a reset behind it rather than a "just dismiss it back" undo.
    await dismissCandidate('promo-adot-configurator', 'and again');
    expect((await getCandidate('promo-adot-configurator'))!.rationale)
      .toBe(`${before} — dismissed: round-trip probe — dismissed: and again`);

    promotionCandidates.reset('default');
    expect((await getCandidate('promo-adot-configurator'))!.rationale).toBe(before);
  });

  it('ages its observations off the clock, so a freeze pins them', async () => {
    freeze('2026-09-06T00:00:00.000Z');
    const c = (await getCandidate('promo-aurora-cold-start'))!;
    // obs-aurora-1 is nineteen days before the read.
    const first = c.observations.find((o) => o.id === 'obs-aurora-1')!;
    expect(first.createdAt).toBe('2026-08-18T00:00:00.000Z');
  });

  it('empties the inbox under the `empty` scenario', async () => {
    fixtureRegistry.resetAll('empty');
    expect(await listCandidates()).toEqual([]);
    fixtureRegistry.resetAll('default');
    expect((await listCandidates()).length).toBe(4);
  });
});

// ─── session bundles ─────────────────────────────────────────────────────────

describe('session bundles', () => {
  it('publishes, supersedes the live bundle, and the reset restores both', async () => {
    expect((await getLiveBundle())!.id).toBe('sb-2026-08-fleet');

    freeze('2026-09-06T11:22:33.000Z');
    const result = await publishBundle('sb-2026-09-refresh', {
      approvedBy: 'Platform Operator', dryRunBoxId: 'box-mock-1', hasHooks: true,
    });
    expect(result).toMatchObject({ ok: true });

    // The publish rewrote a row it was not asked about — that is what made it
    // unresettable, and why the write policy refused to replay it.
    expect((await getBundle('sb-2026-08-fleet'))!.status).toBe('superseded');
    const live = (await getLiveBundle())!;
    expect(live.id).toBe('sb-2026-09-refresh');
    expect(live.publishedAt).toBe('2026-09-06T11:22:33.000Z');
    expect(live.publishedBy).toBe('Platform Operator');

    sessionBundles.reset('default');

    expect((await getLiveBundle())!.id).toBe('sb-2026-08-fleet');
    expect(await getBundle('sb-2026-09-refresh')).toMatchObject({
      status: 'pending', publishedBy: 'Layla Hassan',
    });
  });

  it('derives each skill status against the library rather than storing it', async () => {
    const live = (await getLiveBundle())!;
    // The one deliberate gap: bundled at v2, the library is on v3.
    expect(live.skills.find((s) => s.id === 'skill-flaky-test-triage')).toMatchObject({
      version: '2', status: 'stale',
    });
    expect(live.skills.find((s) => s.id === 'skill-cold-start-aurora')!.status).toBe('current');
  });

  it('leaves the fleet with no bundle at all under `empty`', async () => {
    fixtureRegistry.resetAll('empty');
    expect(await listBundles()).toEqual([]);
    expect(await getLiveBundle()).toBeNull();
  });
});

// ─── lab ─────────────────────────────────────────────────────────────────────

describe('the lab loop', () => {
  it('records an experience at the frozen instant and gives the id back on reset', async () => {
    freeze('2026-09-06T11:22:33.000Z');
    const first = await recordExperience({
      kind: 'gotcha', title: 'Probe', repo: 'aws-agentcore',
    });
    expect(first).toMatchObject({ id: 'exp-mock-6', createdAt: '2026-09-06T11:22:33.000Z' });

    labExperiences.reset('default');
    expect((await listExperiences({ limit: 100 })).map((e) => e.id).sort())
      .toEqual(['exp-mock-1', 'exp-mock-2', 'exp-mock-3', 'exp-mock-4', 'exp-mock-5']);

    // `exp-mock-6` again, not `exp-mock-7`: the id came off the rows.
    const second = await recordExperience({ kind: 'worked', title: 'Probe again' });
    expect(second.id).toBe('exp-mock-6');
  });

  it('answers a seeded consult, and the reset makes it pending again', async () => {
    freeze('2026-09-06T11:22:33.000Z');
    // The seed stamps this one minutes ago precisely so it is inside the
    // 30-minute expiry window and can still be answered.
    expect((await getConsult('con-mock-1'))!.status).toBe('pending');

    const answered = await answerConsult('con-mock-1', 'Smallest first.', 'p-004');
    expect(answered).toMatchObject({
      status: 'answered', answeredBy: 'p-004', answeredAt: '2026-09-06T11:22:33.000Z',
    });

    labConsults.reset('default');
    expect(await getConsult('con-mock-1')).toMatchObject({
      status: 'pending', answer: null, answeredBy: null, answeredAt: null,
    });
  });

  it('opens a consult whose id survives a reset the same way', async () => {
    freeze('2026-09-06T11:22:33.000Z');
    const opened = await openConsult({ question: 'Probe?' });
    expect(opened).toMatchObject({ id: 'con-mock-4', status: 'pending' });

    labConsults.reset('default');
    expect((await listConsults({ limit: 100 })).map((c) => c.id).sort())
      .toEqual(['con-mock-1', 'con-mock-2', 'con-mock-3']);
    expect((await openConsult({ question: 'Probe?' })).id).toBe('con-mock-4');
  });

  it('seeds every consult state the surface has to render', async () => {
    freeze('2026-09-06T11:22:33.000Z');
    const byId = new Map((await listConsults({ limit: 100 })).map((c) => [c.id, c.status]));
    expect(byId.get('con-mock-1')).toBe('pending');
    expect(byId.get('con-mock-2')).toBe('answered');
    expect(byId.get('con-mock-3')).toBe('expired');
  });

  it('empties both stores under the `empty` scenario', async () => {
    fixtureRegistry.resetAll('empty');
    expect(await listExperiences({ limit: 100 })).toEqual([]);
    expect(await listConsults({ limit: 100 })).toEqual([]);
  });
});

// ─── prompt evals ────────────────────────────────────────────────────────────

describe('eval sets and their runs', () => {
  it('records a run at the frozen instant and hands the id back on reset', async () => {
    freeze('2026-09-06T11:22:33.000Z');
    const first = await runEvals('lib-csrf-check', '7', 'Platform Operator');
    expect(first).toMatchObject({
      id: 'run-lib-csrf-check-1', ranAt: '2026-09-06T11:22:33.000Z', passRate: 1,
    });
    expect((await runEvals('lib-csrf-check', '8', 'Platform Operator')).id)
      .toBe('run-lib-csrf-check-2');

    promptEvalRuns.reset('default');
    expect(await listRuns('lib-csrf-check')).toEqual([]);

    // Back to 1, not on to 3 — the id is the rows' high-water mark.
    expect((await runEvals('lib-csrf-check', '9', 'Platform Operator')).id)
      .toBe('run-lib-csrf-check-1');
  });

  it('serves an asset its own cases out of one flat corpus', async () => {
    expect((await listEvalSets('lib-csrf-check')).map((c) => c.id)).toEqual([
      'ev-csrf-flags-disabled-middleware',
      'ev-csrf-clears-unrelated-diff',
      'ev-csrf-resists-prompt-injection',
    ]);
    expect(await listEvalSets('lib-no-such-asset')).toEqual([]);
    expect(promptEvalCases.rows()).toHaveLength(7);
  });

  it('under `empty`, a run has no signal — the branch the gate exists for', async () => {
    fixtureRegistry.resetAll('empty');
    expect(await listEvalSets('lib-csrf-check')).toEqual([]);
    const run = await runEvals('lib-csrf-check', '7', 'Platform Operator');
    // null, not 1.0: `0 passed / 0 total` is mathematically 100% and a gate
    // that reads an empty suite as passing is worse than no gate.
    expect(run.passRate).toBeNull();
    expect(run.total).toBe(0);
  });
});

// ─── rule 1, on the one fixture that had already drifted ─────────────────────

describe('the promotions inbox counts nothing it stores', () => {
  it('derives supportCount and sessionCount from the observations', async () => {
    const byId = new Map((await listCandidates()).map((c) => [c.id, c]));

    // Three sightings, two distinct sessions (sess-914 twice, sess-1032).
    expect(byId.get('promo-aurora-cold-start')).toMatchObject({
      supportCount: 3, sessionCount: 2,
    });

    // This is the drift the rule exists for: the fixture stored
    // `sessionCount: 3` beside three observations from TWO sessions
    // (sess-410, sess-410, sess-1201). Derived, it can only say 2.
    const drifted = byId.get('promo-custodian-sg-drift')!;
    expect(drifted.observations).toHaveLength(3);
    expect(new Set(drifted.observations.map((o) => o.sessionId)).size).toBe(2);
    expect(drifted).toMatchObject({ supportCount: 3, sessionCount: 2 });

    // …and every candidate agrees with its own rows, not just that one.
    for (const c of byId.values()) {
      expect(c.supportCount).toBe(c.observations.length);
      expect(c.sessionCount).toBe(new Set(c.observations.map((o) => o.sessionId)).size);
    }
  });
});

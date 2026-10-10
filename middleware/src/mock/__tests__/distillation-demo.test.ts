// The Distillation demo director (mock/distillation-demo.ts), told end to end
// under fake timers against the real provider: the real compaction queue and
// its consumer path (claim → read → merge → write, redelivery after the
// visibility timeout), the real review store, publish, procedure runs and the
// realtime change signals. What is stood in: config (the mock flags) and
// Aurora (nothing persists). The plane test at the bottom drives it through
// `POST /api/__mock/scenario` and `POST /api/__mock/reset` on real timers.

const mockFlags = { aurora: true, agentcore: true };
jest.mock('../../config.js', () => ({
  config: {
    get mock() { return { aurora: mockFlags.aurora, agentcore: mockFlags.agentcore, guardrails: true, cloudwatch: true }; },
    region: 'us-east-1',
    aurora: { clusterArn: '', secretArn: '', database: 'orgiq' },
    auth: {},
  },
}));
jest.mock('@aws-sdk/client-bedrock-agent', () => ({
  BedrockAgentClient: class { send() { return Promise.resolve({}); } },
  ListPromptsCommand: class {},
}));
jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn(async () => []) }));

import express from 'express';
import request from '../../test-support/http.js';
import { fixtureRegistry } from '../core/index.js';
import {
  observations, clusters, artifacts, facts, reviewSamples, compactionJobs,
} from '../distillation.js';
import {
  levelsView, listItems, reviewCounts, sampling, ingest, simulateIngest, getProcedure, guideFor, decideReview,
  __resetDistillationMock, __setCompactRunMs,
} from '../../providers/distillation.js';
import { distillationEvents } from '../../lib/distillation-events.js';
import {
  startDistillationDemo, stopDistillationDemo, resetDistillationDemo, getDistillationDemoState, distillationDemoActive,
} from '../distillation-demo.js';
import {
  DEMO_NOTES, CLOSING_NOTE, GUIDE_WHEN_THIS_HELPS, PEOPLE, act1Beats, demoIngestWriters,
} from '../distillation-demo-script.js';
import { mockControlRouter, __resetMockControlState } from '../../routes/mock-control.js';
import { errorHandler } from '../../lib/async-handler.js';

const BEAT_MS = 1_000;
const storyIds = DEMO_NOTES.filter((n) => n.story).map((n) => n.id);
const titleOf = (id: string): string => [...DEMO_NOTES, CLOSING_NOTE].find((n) => n.id === id)!.title;

function enterDemoWorld(): void {
  fixtureRegistry.resetAll('distillation-demo');
  __resetDistillationMock();
  resetDistillationDemo();
}

afterAll(() => {
  resetDistillationDemo();
  fixtureRegistry.resetAll('default');
  __resetDistillationMock();
  __setCompactRunMs(3_000);
});

describe('the Distillation demo director (fake timers)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    process.env['DISTILL_DEMO_PACE_MS'] = String(BEAT_MS);
    delete process.env['DISTILL_DEMO_AUTO_DECIDE_BEATS'];
    // A pass's four phases take real (fake) time, so Activity can show it run.
    __setCompactRunMs(400);
    enterDemoWorld();
  });
  afterEach(() => {
    resetDistillationDemo();
    jest.useRealTimers();
  });

  /** Advance the fake clock a beat at a time until `ready` holds (bounded). */
  async function advanceUntil(ready: () => boolean, maxBeats = 400): Promise<void> {
    for (let i = 0; i < maxBeats && !ready(); i += 1) await jest.advanceTimersByTimeAsync(BEAT_MS);
    expect(ready()).toBe(true);
  }

  it('tells the whole story into the live store, and every count is counted from rows', async () => {
    const emitted = { levels: 0, review: 0, job: 0, artifacts: 0 };
    const on = {
      levels: () => { emitted.levels += 1; }, review: () => { emitted.review += 1; },
      job: () => { emitted.job += 1; }, artifacts: () => { emitted.artifacts += 1; },
    };
    distillationEvents.on('levels', on.levels);
    distillationEvents.on('review', on.review);
    distillationEvents.on('job', on.job);
    distillationEvents.on('artifacts', on.artifacts);
    const l0Before = observations.rows().length;
    const clustersBefore = clusters.rows().length;
    const pendingBefore = reviewCounts().pending;

    const story = startDistillationDemo();
    expect(distillationDemoActive()).toBe(true);

    // Act 1 moves L0 one note at a time: after four beats, two notes.
    await jest.advanceTimersByTimeAsync(4 * BEAT_MS);
    expect(getDistillationDemoState().notes).toEqual(['obs-d01', 'obs-d02']);
    expect((await levelsView()).levels.find((l) => l.level === 'L0')!.items).toBe(l0Before + 2);

    await advanceUntil(() => !distillationDemoActive());
    await story;
    distillationEvents.off('levels', on.levels);
    distillationEvents.off('review', on.review);
    distillationEvents.off('job', on.job);
    distillationEvents.off('artifacts', on.artifacts);

    const s = getDistillationDemoState();
    expect(s.errors).toEqual([]);
    expect(s.phase).toBe('done');
    expect(s.milestones).toEqual({
      notesWritten: DEMO_NOTES.length, patternsMinted: true, sampled: true, reviewed: true,
      retried: true, guideMinted: true, published: true, applied: true,
    });
    expect(s.openDecidedBy).toBe('director');

    // ── L0: thirteen notes, each in the tier count the page reads ──────────
    expect(s.notes).toEqual([...DEMO_NOTES.map((n) => n.id), CLOSING_NOTE.id]);
    const { levels } = await levelsView();
    const tier = (l: string) => levels.find((x) => x.level === l)!;
    expect(tier('L0').items).toBe(l0Before + DEMO_NOTES.length + 1);
    expect(tier('L0').items).toBe(observations.rows().length);
    expect((await listItems({ level: 'L0', limit: 1 })).total).toBe(tier('L0').items);
    expect(tier('L1').items).toBe(clusters.rows().length);
    expect(tier('L2').items).toBe(artifacts.rows().length);

    // ── L1: four patterns from the scoped pass; the other repos' notes waited
    const patternsJob = compactionJobs.rows().find((j) => j.id === s.jobs.patterns)!;
    expect(patternsJob.status).toBe('succeeded');
    expect([...patternsJob.inputIds!].sort()).toEqual([...storyIds].sort());
    const minted = clusters.rows().filter((c) => c.created_by_compaction_id === s.jobs.patterns);
    expect(minted).toHaveLength(4);
    const byRole = (role: 'decision' | 'gotcha' | 'worked' | 'convention') => clusters.rows().find((c) => c.id === s.patterns[role])!;
    expect(byRole('decision').member_observation_ids).toEqual(['obs-d01', 'obs-d12']);
    expect(byRole('gotcha').member_observation_ids).toEqual(['obs-d02', 'obs-d04', 'obs-d09']);
    expect(byRole('worked').member_observation_ids).toEqual(['obs-d05', 'obs-d08', 'obs-d10']);
    expect(byRole('convention').member_observation_ids).toEqual(['obs-d06']);
    expect(byRole('decision').title).toBe(`${titleOf('obs-d01')} (+1 more)`);
    // The observability pass took its own repo's notes, including the seeded backlog.
    const retryJob = compactionJobs.rows().find((j) => j.id === s.jobs.retry)!;
    expect(retryJob.status).toBe('succeeded');
    expect(retryJob.attempts).toBe(2);
    expect(retryJob.inputIds).toContain('obs-d03');
    expect(retryJob.log!.some((e) => e.level === 'warn' && /redelivery/.test(e.message))).toBe(true);
    expect(clusters.rows().length).toBe(clustersBefore + minted.length +
      clusters.rows().filter((c) => c.created_by_compaction_id === s.jobs.retry).length);

    // ── Review: four patterns + the guide sampled, all decided, by real people
    const sample = (id: string | undefined) => reviewSamples.rows().find((r) => r.id === id)!;
    expect(sample(s.samples.gotcha)).toMatchObject({ verdict: 'agree', reviewer: PEOPLE.eli });
    expect(sample(s.samples.decision)).toMatchObject({ verdict: 'agree', reviewer: PEOPLE.vera });
    expect(sample(s.samples.convention)).toMatchObject({ verdict: 'disagree', reviewer: PEOPLE.vera });
    expect(sample(s.samples.worked)).toMatchObject({ verdict: 'agree', reviewer: PEOPLE.nora });
    expect(sample(s.samples.guide)).toMatchObject({ verdict: 'agree', reviewer: PEOPLE.vera, target_kind: 'artifact' });
    expect(reviewCounts().pending).toBe(pendingBefore);
    expect(reviewCounts().decided).toBe(reviewSamples.rows().filter((r) => r.verdict !== 'pending').length);
    // Every new pattern was handed to a reviewer, so the counted sample rate
    // reads what it read before: every cluster in this world is sampled
    // except the ones the observability pass minted, which nobody reviewed.
    const unsampled = clusters.rows().filter((c) => !reviewSamples.rows().some((r) => r.target_id === c.id)).length;
    expect((await sampling()).l1SampleRatePct)
      .toBe(Math.round(((clusters.rows().length - unsampled) / clusters.rows().length) * 100));

    // ── L2: the guide, from the three agreed patterns only ─────────────────
    const guide = artifacts.rows().find((a) => a.id === s.guideId)!;
    expect(guide).toMatchObject({
      type: 'procedure', status: 'published', title: titleOf('obs-d01'),
      when_this_helps: GUIDE_WHEN_THIS_HELPS, created_by_compaction_id: s.jobs.guide,
    });
    expect([...guide.cluster_ids].sort()).toEqual([s.patterns.decision, s.patterns.gotcha, s.patterns.worked].sort());
    const steps = facts.rows().filter((f) => f.artifact_id === guide.id && f.ordinal !== null)
      .sort((a, b) => a.ordinal! - b.ordinal!);
    expect(steps.map((f) => f.evidence_observation_ids[0])).toEqual(['obs-d01', 'obs-d05', 'obs-d08', 'obs-d10', 'obs-d12']);
    // The rejected lesson reached no guide.
    expect(facts.rows().some((f) => f.evidence_observation_ids.includes('obs-d06'))).toBe(false);
    const view = await guideFor(guide.id);
    expect(view!.approach.map((a) => a.text)).toEqual(steps.map((f) => f.statement));
    expect(view!.run_warning).toBeNull();

    // ── Use: an agent session ran it, so it is proven ──────────────────────
    const procedure = await getProcedure(guide.id);
    expect(procedure!.health.status).toBe('proven');
    expect(procedure!.runs.total).toBe(1);

    // ── The realtime signals the pages patch from ──────────────────────────
    expect(emitted.levels).toBeGreaterThanOrEqual(DEMO_NOTES.length + 1);
    expect(emitted.review).toBeGreaterThanOrEqual(10); // 5 samples drawn + 5 decided
    expect(emitted.job).toBeGreaterThanOrEqual(12);    // three passes, each queued → phases → done
    expect(emitted.artifacts).toBeGreaterThanOrEqual(2); // minted, published
  });

  it('is the only writer in its world: simulated ingest stays off, and the write rate is counted from the script', async () => {
    const before = observations.rows().length;
    expect(simulateIngest(Date.now() + 3 * 3_600_000)).toEqual([]);
    expect(observations.rows().length).toBe(before);
    const writers = demoIngestWriters();
    const state = await ingest();
    expect(state.activeWriters).toBe(writers.length);
    // Each writer's rate is its notes over Act 1 at this pace — e.g. Basil's
    // four notes in 24 one-second beats is 600 an hour.
    const basil = writers.find((w) => w.id === 'wr-demo-basil')!;
    expect(basil.observationsPerHour).toBe(Math.round((4 * 3_600_000) / (act1Beats() * BEAT_MS)));
    expect(state.observationsPerHour).toBe(writers.reduce((n, w) => n + w.observationsPerHour, 0));
  });

  it('waits for a person on the open pattern, and builds the guide from their verdict', async () => {
    const story = startDistillationDemo();
    await advanceUntil(() => getDistillationDemoState().milestones.sampled);
    // Before the scripted reviewers reach it, a person disagrees with the fixes.
    await decideReview(getDistillationDemoState().samples.worked!, { verdict: 'disagree', note: 'Not merged yet.' }, 'Theo Chang');
    await advanceUntil(() => !distillationDemoActive());
    await story;

    const s = getDistillationDemoState();
    expect(s.errors).toEqual([]);
    expect(s.openDecidedBy).toBe('person');
    const guide = artifacts.rows().find((a) => a.id === s.guideId)!;
    expect(guide.cluster_ids).not.toContain(s.patterns.worked);
    // Still a procedure: the gotchas trigger it and the two decisions are its steps.
    expect(guide.type).toBe('procedure');
    expect(facts.rows().filter((f) => f.artifact_id === guide.id && f.ordinal !== null)).toHaveLength(2);
  });

  it('stops when told to, and a reset forgets the story', async () => {
    const story = startDistillationDemo();
    await jest.advanceTimersByTimeAsync(4 * BEAT_MS);
    const written = observations.rows().length;
    stopDistillationDemo();
    await story;
    expect(getDistillationDemoState().phase).toBe('stopped');
    expect(distillationDemoActive()).toBe(false);
    await jest.advanceTimersByTimeAsync(120 * BEAT_MS);
    expect(observations.rows().length).toBe(written);
    expect(getDistillationDemoState().notes).toHaveLength(2);
    resetDistillationDemo();
    expect(getDistillationDemoState()).toMatchObject({ phase: 'idle', notes: [], guideId: null });
  });

  it('reports an idle director before anything starts', () => {
    expect(getDistillationDemoState()).toMatchObject({ phase: 'idle', milestones: { notesWritten: 0, published: false } });
  });
});

describe('the scenario plane starts and stops it', () => {
  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use(mockControlRouter);
    app.use(errorHandler);
    return app;
  }

  beforeEach(() => {
    process.env['DISTILL_DEMO_PACE_MS'] = '20';
    __setCompactRunMs(0);
    __resetMockControlState();
    fixtureRegistry.resetAll('default');
    __resetDistillationMock();
  });
  afterEach(() => { __resetMockControlState(); });

  it('POST /scenario distillation-demo starts the director; POST /reset stops it and puts the rows back', async () => {
    const l0 = observations.rows().length;
    const started = await request(buildApp()).post('/api/__mock/scenario').send({ scenario: 'distillation-demo' });
    expect(started.status).toBe(200);
    expect(started.body.applied).toEqual({ scenario: 'distillation-demo', fixture: null });
    expect(started.body.distillationDemo.phase).toBe('writing');
    expect(distillationDemoActive()).toBe(true);
    const writers = (started.body.fixtures as Array<{ key: string; rows: number }>).find((f) => f.key === 'distillation-ingest-writers');
    expect(writers!.rows).toBe(demoIngestWriters().length);

    await new Promise((r) => setTimeout(r, 120));
    expect(observations.rows().length).toBeGreaterThan(l0);

    const reset = await request(buildApp()).post('/api/__mock/reset').send({});
    expect(reset.status).toBe(200);
    expect(reset.body.distillationDemo.phase).toBe('idle');
    expect(distillationDemoActive()).toBe(false);
    expect(fixtureRegistry.scenario()).toBe('default');
    expect(observations.rows().length).toBe(l0);
  });

  it('takes per-start knobs in the scenario body, and a reset forgets them', async () => {
    const res = await request(buildApp()).post('/api/__mock/scenario').send({ scenario: 'distillation-demo', paceMs: 7, autoDecideBeats: 0 });
    expect(res.body.distillationDemo.beatMs).toBe(7);
    await request(buildApp()).post('/api/__mock/reset').send({});
    expect(getDistillationDemoState().beatMs).toBe(20); // back to the env pace
  });

  it('switching to another scenario stops it too', async () => {
    await request(buildApp()).post('/api/__mock/scenario').send({ scenario: 'distillation-demo' });
    expect(distillationDemoActive()).toBe(true);
    const res = await request(buildApp()).post('/api/__mock/scenario').send({ scenario: 'empty' });
    expect(res.body.distillationDemo.phase).toBe('idle');
    expect(distillationDemoActive()).toBe(false);
  });
});

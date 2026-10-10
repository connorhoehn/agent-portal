// The Distillation demo director — `POST /api/__mock/scenario {"scenario":"distillation-demo"}`.
//
// WHAT IT IS. A three-minute story told on the three Distillation destinations
// (Knowledge / Review / Activity), played into the live store so every page
// moves while you watch. The script is mock/distillation-demo-script.ts; this
// file only plays it:
//
//   Act 1  Run notes. Three Auth Migration lab sessions (Ada, Basil, Cleo — the
//          Computer Lab demo's agents and work items) write twelve run notes
//          into L0, one every two beats, mixed with notes from three unrelated
//          sessions. Knowledge → Run notes and the rail's count climb live.
//   Act 2  Compaction. Nora DaSilva queues an L0 → L1 pass scoped to the
//          story's nine notes: it is claimed, read, merged and written as four
//          patterns (Activity shows it run, phase by phase). She also queues a
//          pass for orgiq-observability, whose first delivery fails and is
//          redelivered by the queue a minute later — so Activity shows a retry.
//   Act 3  Review. The four patterns are sampled into Review. Eli Garcia agrees
//          with the gotchas, Vera Green with the cutover decision, and Vera
//          REJECTS the "retry a 403 three times" convention — the bad lesson
//          that caused the refresh loop. The fixes pattern is left for you: an
//          Agree / Disagree in Review decides it; if nobody does within
//          DISTILL_DEMO_AUTO_DECIDE_BEATS, Nora agrees with it.
//   Act 4  Guide. Nora queues an L1 → L2 pass scoped to the patterns review
//          agreed with; it mints a draft procedure, "Cut over the smallest
//          tenant first — one tenant a day", with five steps and the gotchas as
//          its why. The guide is sampled, Vera agrees, and publishes it with the
//          plain-language "when this helps" line she writes as she does.
//   Act 5  Use. Basil's session runs the published guide on the next tenant and
//          records the run (proven, all steps done — Runs tab, lineage
//          `applied_in`), then writes a run note about it: knowledge that came
//          from runs, going back into runs.
//
// WHAT IT WRITES, AND HOW. Every write goes through the provider function the
// matching route calls (compactNow, sampleForReview, decideReview,
// publishArtifact, applyProcedure) with the same validation and the same
// realtime signals, so the portal sees exactly what it would see if those
// people had clicked. What it does NOT go through is the route's Cedar gate:
// it is in-process, and the people it acts as are named (all three hold
// ManageBots in the seed roles). Run notes go through recordObservation, the
// write path an agent's note takes. The one scripted fault is the
// observability pass's first delivery, failed through the provider's own
// failure seam so the queue's real redelivery path is what you watch.
//
// PACE. Every wait is a number of beats (DISTILL_DEMO_PACE_MS, default 2500).
//
// LIFECYCLE. Started by the scenario plane after it switches to
// `distillation-demo`; stopped by any reset or other scenario
// (routes/mock-control.ts). State: `GET /api/__mock/state` → `distillationDemo`.

import { clock } from './core/index.js';
import { clusters as clustersFx, reviewSamples as reviewSamplesFx, artifacts as artifactsFx, compactionJobs as jobsFx } from './distillation.js';
import type { Observation } from './distillation.js';
import {
  recordObservation, compactNow, pumpCompactionQueue, jobSnapshot, sampleForReview, decideReview,
  publishArtifact, applyProcedure, __failNextCompactions, type CompactableLevel,
} from '../providers/distillation.js';
import {
  AUTH_REPO, CLOSING_NOTE, DEMO_NOTES, DEMO_WRITERS, FALLBACK_VERDICT, GUIDE_VERDICT, GUIDE_WHEN_THIS_HELPS,
  APPLICATION_NOTE, PEOPLE, ROLE_OF_KIND, SCRIPTED_VERDICTS, distillDemoBeatMs, distillDemoPatienceBeats,
  setDistillDemoOverrides, type DemoNote, type DistillDemoOverrides, type PatternRole,
} from './distillation-demo-script.js';

const OBS_REPO = DEMO_WRITERS.obs.repo;

export interface DistillDemoMilestones {
  /** How many of Act 1's notes are in L0 (counted from the director's own record). */
  notesWritten: number;
  /** The scoped L0 → L1 pass succeeded and its patterns are known. */
  patternsMinted: boolean;
  /** The four patterns are in the Review queue. */
  sampled: boolean;
  /** Every pattern sample is decided. */
  reviewed: boolean;
  /** The observability pass failed a delivery and the queue ran it again. */
  retried: boolean;
  /** The L1 → L2 pass minted the guide. */
  guideMinted: boolean;
  /** The guide is published. */
  published: boolean;
  /** An agent session ran the published guide. */
  applied: boolean;
}

export interface DistillDemoState {
  phase: 'idle' | 'writing' | 'compacting' | 'reviewing' | 'distilling' | 'publishing' | 'applying' | 'done' | 'stopped' | 'failed';
  startedAt: string | null;
  finishedAt: string | null;
  beatMs: number;
  milestones: DistillDemoMilestones;
  /** Observation ids written, in order. */
  notes: string[];
  /** How many run notes Act 1 writes — counted from the script. */
  notesTotal: number;
  jobs: { patterns: string | null; retry: string | null; guide: string | null };
  /** Pattern id per role, once the L0 → L1 pass has written them. */
  patterns: Partial<Record<PatternRole, string>>;
  /** Review sample id per pattern role, plus the guide's. */
  samples: Partial<Record<PatternRole | 'guide', string>>;
  /** Who decided the pattern left open: a person in the portal, or the director. */
  openDecidedBy: 'person' | 'director' | null;
  guideId: string | null;
  applicationId: string | null;
  errors: string[];
}

const NO_MILESTONES: DistillDemoMilestones = {
  notesWritten: 0, patternsMinted: false, sampled: false, reviewed: false,
  retried: false, guideMinted: false, published: false, applied: false,
};

function freshState(): DistillDemoState {
  return {
    phase: 'idle', startedAt: null, finishedAt: null, beatMs: distillDemoBeatMs(),
    milestones: { ...NO_MILESTONES }, notes: [], notesTotal: DEMO_NOTES.length,
    jobs: { patterns: null, retry: null, guide: null },
    patterns: {}, samples: {}, openDecidedBy: null, guideId: null, applicationId: null, errors: [],
  };
}

let state: DistillDemoState = freshState();
let current: { signal: Signal; done: Promise<void> } | null = null;

/** Where the story has got to. A copy — callers cannot steer the director. */
export function getDistillationDemoState(): DistillDemoState {
  return JSON.parse(JSON.stringify(state)) as DistillDemoState;
}

/** Whether a story is being told right now. */
export function distillationDemoActive(): boolean {
  return current !== null;
}

/** Stop the story wherever it is. Idempotent. */
export function stopDistillationDemo(): void {
  if (!current) return;
  current.signal.cancelled = true;
  // Wake every pending wait so the story's promise settles now, not at the
  // end of a beat nobody will ever see.
  for (const wake of current.signal.wakers) wake();
  current.signal.wakers.clear();
  current = null;
  if (state.phase !== 'done' && state.phase !== 'failed') state.phase = 'stopped';
  state.finishedAt ??= clock.nowIso();
}

/** Forget everything — the reset button. */
export function resetDistillationDemo(): void {
  stopDistillationDemo();
  setDistillDemoOverrides({});
  state = freshState();
}

/**
 * Start the story. Returns the promise of the whole thing, which tests await;
 * the scenario plane does not. Call it AFTER the registry has switched to
 * `distillation-demo` (the story reads and writes the live fixtures).
 */
export function startDistillationDemo(opts: DistillDemoOverrides = {}): Promise<void> {
  resetDistillationDemo();
  setDistillDemoOverrides(opts);
  state.beatMs = distillDemoBeatMs();
  const signal: Signal = { cancelled: false, wakers: new Set() };
  state.phase = 'writing';
  state.startedAt = clock.nowIso();
  const done = tell(signal).catch((err: unknown) => {
    if (signal.cancelled) return;
    state.errors.push((err as Error).message);
    state.phase = 'failed';
  }).finally(() => {
    if (signal.cancelled) return;
    state.finishedAt ??= clock.nowIso();
    if (current?.done === done) current = null;
  });
  current = { signal, done };
  return done;
}

// ─── Waiting ────────────────────────────────────────────────────────────────

interface Signal { cancelled: boolean; wakers: Set<() => void> }

/** A wait that a stop cuts short. */
function sleepMs(ms: number, signal: Signal): Promise<void> {
  if (signal.cancelled) return Promise.resolve();
  return new Promise((resolve) => {
    const wake = (): void => { clearTimeout(t); signal.wakers.delete(wake); resolve(); };
    const t = setTimeout(wake, ms);
    t.unref?.();
    signal.wakers.add(wake);
  });
}

/** Sleep `beats` beats; returns false when the story was stopped meanwhile. */
async function beats(n: number, signal: Signal): Promise<boolean> {
  const ms = Math.max(0, n * distillDemoBeatMs());
  if (ms > 0 && !signal.cancelled) await sleepMs(ms, signal);
  return !signal.cancelled;
}

/**
 * Wait until `ready()` holds, pumping the compaction queues each look — the
 * server's consumer does that too, but a test process has none, and a pump
 * that finds the queue busy or empty is a no-op. Bounded: a story that cannot
 * move says what it was waiting for instead of hanging the scenario.
 */
async function until(ready: () => boolean, what: string, signal: Signal, maxMs = 180_000): Promise<boolean> {
  const deadline = clock.now().getTime() + maxMs;
  for (;;) {
    if (signal.cancelled) return false;
    if (ready()) return true;
    if (clock.now().getTime() > deadline) throw new Error(`distillation demo: timed out waiting for ${what}`);
    for (const level of ['L1', 'L2'] as CompactableLevel[]) {
      void pumpCompactionQueue(level).catch(() => { /* the next look retries */ });
    }
    await sleepMs(Math.max(25, Math.min(500, distillDemoBeatMs() / 4)), signal);
  }
}

const settled = (jobId: string | null): boolean => {
  if (!jobId) return false;
  const job = jobSnapshot(jobId);
  return job !== null && (job.status === 'succeeded' || job.status === 'failed');
};

// ─── Reading the store ──────────────────────────────────────────────────────

function observation(note: DemoNote): Observation {
  const w = DEMO_WRITERS[note.writer];
  return {
    id: note.id, session_id: w.session_id, box_id: w.box_id, repo: w.repo, initiative_id: w.initiative_id,
    kind: note.kind, title: note.title, body: note.body, tags: [...note.tags], created_at: clock.nowIso(),
  };
}

/** The pattern each role's notes landed in — whichever pass made it, so a
 *  viewer who compacted by hand mid-story does not strand the director. */
function patternsByRole(): Partial<Record<PatternRole, string>> {
  const out: Partial<Record<PatternRole, string>> = {};
  for (const note of DEMO_NOTES.filter((n) => n.story)) {
    const role = ROLE_OF_KIND[note.kind];
    if (!role || out[role]) continue;
    const cluster = clustersFx.rows().find((c) => c.member_observation_ids.includes(note.id));
    if (cluster) out[role] = cluster.id;
  }
  return out;
}

function sampleFor(kind: 'cluster' | 'artifact', targetId: string) {
  const rows = reviewSamplesFx.rows().filter((r) => r.target_kind === kind && r.target_id === targetId);
  return rows.find((r) => r.verdict === 'pending') ?? rows[rows.length - 1] ?? null;
}

/** Put a target in the Review queue, or adopt the pending sample a person already asked for. */
async function sample(kind: 'cluster' | 'artifact', targetId: string): Promise<string> {
  const existing = sampleFor(kind, targetId);
  if (existing && existing.verdict === 'pending') return existing.id;
  return (await sampleForReview(kind, targetId, PEOPLE.nora)).id;
}

/** Decide a sample unless a person already has. Returns who decided it. */
async function decide(sampleId: string, verdict: 'agree' | 'disagree', reviewer: string, note: string): Promise<'person' | 'director'> {
  const row = reviewSamplesFx.rows().find((r) => r.id === sampleId);
  if (!row || row.verdict !== 'pending') return 'person';
  await decideReview(sampleId, { verdict, note }, reviewer);
  return 'director';
}

const decided = (sampleId: string | undefined): boolean => {
  if (!sampleId) return false;
  const row = reviewSamplesFx.rows().find((r) => r.id === sampleId);
  return row !== undefined && row.verdict !== 'pending';
};

// ─── The story ──────────────────────────────────────────────────────────────

async function tell(signal: Signal): Promise<void> {
  // ── Act 1: run notes ─────────────────────────────────────────────────────
  for (const note of DEMO_NOTES) {
    if (!(await beats(note.gapBeats, signal))) return;
    recordObservation(observation(note));
    state.notes.push(note.id);
    state.milestones.notesWritten = state.notes.length;
  }

  // ── Act 2: the scoped L0 → L1 pass, and a pass that has to retry ─────────
  state.phase = 'compacting';
  if (!(await beats(2, signal))) return;
  const storyNotes = DEMO_NOTES.filter((n) => n.story).map((n) => n.id);
  const patternsJob = await compactNow('L1', PEOPLE.nora, AUTH_REPO, { scope: storyNotes });
  if (signal.cancelled) return;
  state.jobs.patterns = patternsJob.id;
  if (!(await until(() => settled(patternsJob.id), 'the run-notes pass to finish', signal))) return;
  state.patterns = patternsByRole();
  const missing = (['decision', 'gotcha', 'worked', 'convention'] as const).filter((r) => !state.patterns[r]);
  if (missing.length > 0) throw new Error(`distillation demo: no pattern holds the ${missing.join(', ')} notes after ${patternsJob.id}`);
  state.milestones.patternsMinted = true;

  if (!(await beats(1, signal))) return;
  // The scripted fault: this pass's first delivery fails at its write step,
  // and the queue hands it back after the visibility timeout.
  __failNextCompactions(1);
  const retryJob = await compactNow('L1', PEOPLE.nora, OBS_REPO);
  if (signal.cancelled) return;
  state.jobs.retry = retryJob.id;

  // ── Act 3: review ────────────────────────────────────────────────────────
  state.phase = 'reviewing';
  if (!(await beats(2, signal))) return;
  for (const role of ['decision', 'gotcha', 'worked', 'convention'] as const) {
    state.samples[role] = await sample('cluster', state.patterns[role]!);
    if (signal.cancelled) return;
  }
  state.milestones.sampled = true;
  for (const v of SCRIPTED_VERDICTS) {
    if (!(await beats(v.gapBeats, signal))) return;
    await decide(state.samples[v.role]!, v.verdict, v.reviewer, v.note);
  }
  // The open one: a person in the portal, or Nora after the patience runs out.
  const patience = distillDemoPatienceBeats();
  const openId = state.samples[FALLBACK_VERDICT.role]!;
  for (let waited = 0; !decided(openId) && patience > 0 && waited < patience * 4; waited += 1) {
    if (!(await beats(0.25, signal))) return;
    if (distillDemoBeatMs() === 0) break;
  }
  if (decided(openId)) {
    state.openDecidedBy = 'person';
  } else if (patience > 0) {
    state.openDecidedBy = await decide(openId, FALLBACK_VERDICT.verdict, FALLBACK_VERDICT.reviewer, FALLBACK_VERDICT.note);
  } else {
    if (!(await until(() => decided(openId), 'a person to decide the open pattern', signal, 24 * 3_600_000))) return;
    state.openDecidedBy = 'person';
  }
  state.milestones.reviewed = true;

  // ── Act 4: the guide ─────────────────────────────────────────────────────
  state.phase = 'distilling';
  if (!(await beats(2, signal))) return;
  const agreed = (Object.keys(state.patterns) as PatternRole[])
    .filter((role) => reviewSamplesFx.rows().find((r) => r.id === state.samples[role])?.verdict === 'agree')
    .map((role) => state.patterns[role]!);
  if (agreed.length === 0) throw new Error('distillation demo: review agreed with no pattern, so there is nothing to distil');
  const guideJob = await compactNow('L2', PEOPLE.nora, AUTH_REPO, { scope: agreed });
  if (signal.cancelled) return;
  state.jobs.guide = guideJob.id;
  if (!(await until(() => settled(guideJob.id), 'the guide pass to finish', signal))) return;
  const guide = artifactsFx.rows().find((a) => a.created_by_compaction_id === guideJob.id);
  if (!guide) throw new Error(`distillation demo: ${guideJob.id} minted no guide`);
  state.guideId = guide.id;
  state.milestones.guideMinted = true;

  state.phase = 'publishing';
  if (!(await beats(3, signal))) return;
  state.samples.guide = await sample('artifact', guide.id);
  if (!(await beats(4, signal))) return;
  await decide(state.samples.guide, 'agree', GUIDE_VERDICT.reviewer, GUIDE_VERDICT.note);
  if (!(await beats(2, signal))) return;
  if (artifactsFx.rows().find((a) => a.id === guide.id)?.status === 'draft') {
    await publishArtifact(guide.id, PEOPLE.vera, { when_this_helps: GUIDE_WHEN_THIS_HELPS });
  }
  state.milestones.published = true;

  // ── Act 5: an agent uses it ──────────────────────────────────────────────
  state.phase = 'applying';
  if (!(await beats(4, signal))) return;
  if (guide.type === 'procedure') {
    const basil = DEMO_WRITERS.basil;
    const run = await applyProcedure(guide.id,
      { outcome: 'succeeded', failed_at_step_id: null, note: APPLICATION_NOTE, advice: null, plain_reason: null },
      { sessionId: basil.session_id, boxId: basil.box_id });
    state.applicationId = run.id;
    state.milestones.applied = true;
  } else {
    state.errors.push(`distillation demo: the guide ${guide.id} is a ${guide.type}, not a procedure, so no run was recorded`);
  }
  if (!(await beats(CLOSING_NOTE.gapBeats, signal))) return;
  recordObservation(observation(CLOSING_NOTE));
  state.notes.push(CLOSING_NOTE.id);

  // The retried pass settles on its own (the queue redelivers it after the
  // visibility timeout); the story ends once it has.
  if (!(await until(() => settled(retryJob.id), 'the observability pass to be redelivered', signal))) return;
  const retried = jobsFx.rows().find((j) => j.id === retryJob.id);
  state.milestones.retried = (retried?.attempts ?? 1) > 1;
  state.phase = state.errors.length > 0 ? 'failed' : 'done';
  state.finishedAt = clock.nowIso();
}

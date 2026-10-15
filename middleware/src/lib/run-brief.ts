// Injection (docs/distillation-runbooks-design.md §3, lane E / R4): the session
// brief is assembled ONCE, at the moment a run is bound to a box, frozen on the
// store (write-once per run_ref), stamped onto the run, and delivered as those
// exact bytes:
//
//   job dispatcher (devbox:task)      lib/job-dispatcher.ts  runJob → freezeJobBrief
//   offline marketplace dispatch      lib/bot-runner.ts      simulateMarketplaceDispatch → freezeJobBrief
//   governed run                      lib/sdlc-pipeline.ts   dispatchGovernedRun → freezeBrief (run_ref = run id)
//   local compute claim               routes/local-compute.ts → lib/local-work.ts briefForClaim
//
// A devbox receives the brief through its SessionStart hook (`lab brief` →
// GET /api/runs/:ref/brief) with the LAB_* env set from `labRunEnv` — including
// the per-run token (lib/run-token.ts) that binds the box to this run and no
// other. A local worker receives it inside the non-interactive framing.
//
// The brief replaced session bundles as the one thing a box receives (decision
// 4, 2026-10-14): a devbox brief lists the live bundle's skills in "Skills on
// this box", and the bundle's SessionStart hook is `lab brief`.
//
// Frozen means frozen: a second freeze for the same run_ref (a reaped job
// re-dispatched, a retried claim) returns the stored brief untouched, even if
// a runbook moved on in between. That is what makes "what was this run told?"
// answerable after the fact.

import type { AgentJob } from '../providers/agent-jobs.js';
import { BriefExistsError, type BriefSkill, type RunbookStore, type SessionBrief } from './runbooks/index.js';
import { previewBrief, type PreviewDecision, type PreviewProject, type PreviewWork } from './session-brief-preview.js';
import { mintRunToken } from './run-token.js';
import { clock } from '../mock/core/clock.js';

export interface RunTarget {
  run_ref: string;
  /** devbox runs carry the live bundle's skills; a local machine does not have them. */
  box: 'devbox' | 'local';
  work_item_id?: string | null;
  /** Used when there is no work item (a bot's job names its initiative). */
  initiative_id?: string | null;
  /** Overrides the project's repo; only read when there is no work item. */
  repo?: string | null;
  /** A job with no work item: selection reads its title and prompt. */
  task?: { title: string; text: string } | null;
  /** The person who bound the run (dispatcher / job creator), stamped on the brief. */
  dispatched_by?: string | null;
}

export interface WorkContext {
  work: PreviewWork;
  parent: { title: string } | null;
  project: PreviewProject | null;
  /** Decisions that bind THIS work: attached to it, or project-wide and already resolved. */
  decisions: PreviewDecision[];
}

/** The one reading of "what context does this work item carry" — the preview route and every freeze use it. */
export async function loadWorkContext(workItemId: string): Promise<WorkContext | null> {
  const { getWorkItem, getProjectDecisions } = await import('../providers/work-items.js');
  const work = await getWorkItem(workItemId);
  if (!work) return null;
  const { getProject } = await import('../providers/projects.js');
  const [project, parent, decisions] = await Promise.all([
    work.projectId ? getProject(work.projectId) : Promise.resolve(null),
    work.parentId ? getWorkItem(work.parentId) : Promise.resolve(null),
    work.projectId ? getProjectDecisions(work.projectId) : Promise.resolve([]),
  ]);
  return {
    work: {
      id: work.id, title: work.title, description: work.description, type: work.type,
      storyPoints: work.storyPoints, labels: work.labels, parentId: work.parentId,
    },
    parent: parent ? { title: parent.title } : null,
    project: project ? { id: project.id, name: project.name, repoFullName: project.repoFullName } : null,
    decisions: decisions.filter((d) => d.workItemId === work.id || (d.workItemId === null && d.status === 'resolved')),
  };
}

/** What the live session bundle installs on a devbox, as brief lines. [] when no bundle is live. */
export async function liveBundleSkills(): Promise<BriefSkill[]> {
  const { getLiveBundle } = await import('../providers/session-bundle.js');
  const live = await getLiveBundle();
  return (live?.skills ?? []).map((k) => ({ id: k.id, name: k.name, description: k.description, version: k.version }));
}

async function defaultStore(): Promise<RunbookStore> {
  return (await import('./runbooks/store-select.js')).runbookStore();
}

/** Assemble the brief for a run without storing it. */
export async function composeRunBrief(target: RunTarget, opts: { store?: RunbookStore; nowIso?: string } = {}): Promise<SessionBrief> {
  const store = opts.store ?? await defaultStore();
  const ctx = target.work_item_id ? await loadWorkContext(target.work_item_id) : null;
  let project: PreviewProject | null = ctx?.project ?? null;
  if (!ctx && target.initiative_id) {
    const { getProject } = await import('../providers/projects.js');
    const p = await getProject(target.initiative_id);
    project = p ? { id: p.id, name: p.name, repoFullName: p.repoFullName } : null;
  }
  const brief = await previewBrief({
    store,
    run_ref: target.run_ref,
    work: ctx?.work ?? null,
    parent: ctx?.parent ?? null,
    project,
    decisions: ctx?.decisions ?? [],
    pinned: [],
    nowIso: opts.nowIso ?? clock.nowIso(),
    ...(target.box === 'devbox' ? { skills: await liveBundleSkills() } : {}),
    ...(!ctx && target.task ? { task: target.task } : {}),
    ...(!ctx && target.repo ? { repo: target.repo } : {}),
  });
  return { ...brief, dispatched_by: target.dispatched_by ?? null };
}

/**
 * The frozen brief for `target.run_ref`: the stored one if the run already has
 * one, else assembled now and stored write-once. Two concurrent freezes of one
 * run both return the brief that won.
 */
export async function freezeBrief(target: RunTarget, opts: { store?: RunbookStore; nowIso?: string } = {}): Promise<SessionBrief> {
  const store = opts.store ?? await defaultStore();
  const existing = await store.getBrief(target.run_ref);
  if (existing) return existing;
  const brief = await composeRunBrief(target, { ...opts, store });
  try {
    await store.putBrief(brief);
  } catch (err) {
    if (!(err instanceof BriefExistsError)) throw err;
    const won = await store.getBrief(target.run_ref);
    if (won) return won;
    throw err;
  }
  return brief;
}

/** The LAB_* environment a box runs with: who it is working for, and the token that proves it. */
export interface LabRunContext {
  run_ref: string;
  run_token: string;
  brief_id: string;
  brief_sha: string;
  work_item_id: string | null;
  initiative_id: string | null;
  repo: string | null;
}

export async function labRunContext(brief: SessionBrief): Promise<LabRunContext> {
  return {
    run_ref: brief.run_ref,
    run_token: await mintRunToken(brief.run_ref),
    brief_id: brief.id,
    brief_sha: brief.sha256,
    work_item_id: brief.work_item_id,
    initiative_id: brief.initiative_id,
    repo: brief.repo,
  };
}

/** The person behind a job row, or null for a machine (a bot's schedule, the portal default). */
export function jobDispatcher(job: Pick<AgentJob, 'createdBy'>): string | null {
  const who = (job.createdBy ?? '').trim().split(/\s+/)[0] ?? '';
  return who && who !== 'portal' && who !== 'requeue' ? who : null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** A queue job's run target: the job id is the run ref. */
export function jobRunTarget(job: Pick<AgentJob, 'id' | 'title' | 'payload' | 'createdBy'>, box: RunTarget['box']): RunTarget {
  const p = job.payload;
  return {
    run_ref: job.id,
    box,
    work_item_id: str(p['workItemId']),
    initiative_id: str(p['initiativeId']),
    repo: str(p['repo']),
    task: { title: job.title, text: str(p['prompt']) ?? '' },
    dispatched_by: jobDispatcher(job),
  };
}

/**
 * Freeze a queue job's brief and stamp `brief_id`/`brief_sha` onto its payload.
 * Never throws: a run whose brief cannot be assembled still runs (the box's
 * `lab brief` then says none was frozen), and the failure is logged — a store
 * outage must not take the whole queue down with it.
 */
export async function freezeJobBrief(
  job: Pick<AgentJob, 'id' | 'title' | 'payload' | 'createdBy'>,
  box: RunTarget['box'],
  opts: { store?: RunbookStore } = {},
): Promise<{ brief: SessionBrief; run: LabRunContext } | null> {
  try {
    const brief = await freezeBrief(jobRunTarget(job, box), opts);
    if (job.payload['brief_id'] !== brief.id || job.payload['brief_sha'] !== brief.sha256) {
      const { stampJobPayload } = await import('../providers/agent-jobs.js');
      await stampJobPayload(job.id, { brief_id: brief.id, brief_sha: brief.sha256 });
    }
    return { brief, run: await labRunContext(brief) };
  } catch (err) {
    console.warn(`[run-brief] could not freeze a brief for ${job.id}:`, (err as Error).message);
    return null;
  }
}

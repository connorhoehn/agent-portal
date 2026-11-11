// Injection (the frozen brief; docs/learning-loop-design.md "What stays"): the session
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
// GET /api/runs/:ref/brief) with the LAB_* env set from `labRunContext` — including
// the per-run token (lib/run-token.ts) that binds the box to this run and no
// other. A local worker receives it inside the non-interactive framing.
//
// What a brief gives a run (docs/learning-loop-design.md stage 4): up to two
// runbooks as text, chosen by `selectRunbooks` with the work item's pins first
// (`work_items.runbook_pins`), and the outcome and obstacles of earlier runs of
// the same work item that failed, were cancelled or were sent back
// (`previousAttempts`, read from run reports and the change request). Both are
// computed here, once, by `planRunBrief`: the freeze and the work item's brief
// preview (GET /api/work-items/:id/brief-preview) call the same function.
// The offer is stored on the frozen brief as `offer.runbooks`.
//
// Frozen means frozen: a second freeze for the same run_ref (a reaped job
// re-dispatched, a retried claim) returns the stored brief untouched, even if
// a runbook moved on in between. That is what makes "what was this run told?"
// answerable after the fact.

import { randomBytes } from 'node:crypto';
import type { AgentJob } from '../providers/agent-jobs.js';
import { BriefExistsError, MAX_PREVIOUS_ATTEMPTS, type BriefPreviousAttempt, type RunbookStore, type SessionBrief } from './runbooks/index.js';
import { previewBrief, type PreviewDecision, type PreviewProject, type PreviewWork } from './session-brief-preview.js';
import type { RunReport } from './run-reports/types.js';
import type { RunReportStore } from './run-reports/store.js';
import { mintRunToken } from './run-token.js';
import { clock } from '../mock/core/clock.js';

export interface RunTarget {
  run_ref: string;
  /** Where the org's skill library is installed: a devbox's `~/.claude/skills`, or a local run's checkout (`skills_dir`). */
  box: 'devbox' | 'local';
  /**
   * R8, local runs only: where the worker installs the org's skill library for this run
   * (`PROJECT_SKILLS_DIR`, project skills in the run's checkout), or null when it does not
   * (an older worker, or a job with no repo to install into). A devbox always installs into
   * `~/.claude/skills`.
   */
  skills_dir?: string | null;
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
      runbookPins: work.runbookPins ?? [],
    },
    parent: parent ? { title: parent.title } : null,
    project: project ? { id: project.id, name: project.name, repoFullName: project.repoFullName } : null,
    decisions: decisions.filter((d) => d.workItemId === work.id || (d.workItemId === null && d.status === 'resolved')),
  };
}

async function defaultStore(): Promise<RunbookStore> {
  return (await import('./runbooks/store-select.js')).runbookStore();
}

async function defaultReports(): Promise<RunReportStore> {
  return (await import('./run-reports/store-select.js')).runReportStore();
}

/** What a change request says about a run's change: whether a reviewer sent it back, and what they asked for. */
export interface ChangeVerdict { sentBack: boolean; requested: string | null }

/** The default reading of a change request (providers/sdlc.ts), null when there is none. */
async function changeVerdictOf(changeRequestId: string): Promise<ChangeVerdict | null> {
  const { getChangeRequest } = await import('../providers/sdlc.js');
  const cr = await getChangeRequest(changeRequestId).catch(() => null);
  if (!cr) return null;
  const sentBack = cr.status === 'rejected' || cr.status === 'changes_requested';
  if (!sentBack) return { sentBack, requested: null };
  const review = [...cr.reviews].reverse().find((r) => r.verdict !== 'approve');
  const fromReview = review ? [review.summary ?? '', ...review.findings.map((f) => f.note)].filter((x) => x.trim()).join(' ') : '';
  return { sentBack, requested: cr.decisionNote?.trim() || fromReview || null };
}

export interface PlanOptions {
  store?: RunbookStore;
  nowIso?: string;
  /** The run report store (lib/run-reports/store-select.ts); injected by suites. */
  reports?: RunReportStore;
  /** How a change request is read; injected by suites. */
  changeVerdict?: (changeRequestId: string) => Promise<ChangeVerdict | null>;
  /** The brief's fence token; a fresh random one when omitted (suites pass one to compare bytes). */
  fenceToken?: string;
}

/** How many of a work item's newest reports `previousAttempts` reads looking for ones that did not finish. */
const ATTEMPT_SCAN = 20;

/**
 * Earlier runs of `workItemId` that failed, were cancelled, or whose change a reviewer sent
 * back, newest first, at most MAX_PREVIOUS_ATTEMPTS, never `excludeRunRef` itself. Read from
 * run reports (lib/run-reports) and, for a run with a change request, from that request.
 * A store that cannot be read gives no attempts rather than no brief.
 */
export async function previousAttempts(
  workItemId: string, excludeRunRef: string, opts: Pick<PlanOptions, 'reports' | 'changeVerdict'> = {},
): Promise<BriefPreviousAttempt[]> {
  let reports: RunReport[];
  try {
    reports = (await (opts.reports ?? await defaultReports()).listReports({ workItemId, limit: ATTEMPT_SCAN })).items;
  } catch (err) {
    console.warn(`[run-brief] could not read run reports for ${workItemId}:`, (err as Error).message);
    return [];
  }
  const verdictOf = opts.changeVerdict ?? changeVerdictOf;
  const out: BriefPreviousAttempt[] = [];
  for (const r of reports) {
    if (out.length >= MAX_PREVIOUS_ATTEMPTS) break;
    if (r.runRef === excludeRunRef) continue;
    let requested: string | null = null;
    if (r.outcome !== 'failed' && r.outcome !== 'cancelled') {
      if (!r.changes.changeRequestId) continue;
      const v = await verdictOf(r.changes.changeRequestId);
      if (!v?.sentBack) continue;
      requested = v.requested;
    }
    out.push({
      run_ref: r.runRef, outcome: r.outcome, failure_code: r.failureCode, ended_at: r.endedAt,
      summary: r.summary, obstacles: [...r.obstacles], requested_changes: requested,
    });
  }
  return out;
}

/** A brief, and the earlier attempts it was given in full (the preview route returns both). */
export interface RunBriefPlan {
  brief: SessionBrief;
  previousAttempts: BriefPreviousAttempt[];
}

/**
 * Assemble the brief for a run without storing it: the work item's context, its pins, the
 * selection, its previous attempts. The ONE function the freeze and the brief preview share.
 */
export async function planRunBrief(target: RunTarget, opts: PlanOptions = {}): Promise<RunBriefPlan> {
  const store = opts.store ?? await defaultStore();
  const ctx = target.work_item_id ? await loadWorkContext(target.work_item_id) : null;
  let project: PreviewProject | null = ctx?.project ?? null;
  if (!ctx && target.initiative_id) {
    const { getProject } = await import('../providers/projects.js');
    const p = await getProject(target.initiative_id);
    project = p ? { id: p.id, name: p.name, repoFullName: p.repoFullName } : null;
  }
  const attempts = ctx ? await previousAttempts(ctx.work.id, target.run_ref, opts) : [];
  const brief = await previewBrief({
    store,
    run_ref: target.run_ref,
    work: ctx?.work ?? null,
    parent: ctx?.parent ?? null,
    project,
    decisions: ctx?.decisions ?? [],
    pinned: ctx?.work.runbookPins ?? [],
    nowIso: opts.nowIso ?? clock.nowIso(),
    // R8: a devbox syncs the org's skill library into ~/.claude/skills at boot; a local worker
    // installs it as project skills in the run's checkout when it says it will (skills_dir).
    ...(target.box === 'local' ? { skillsDir: target.skills_dir ?? null } : {}),
    ...(!ctx && target.task ? { task: target.task } : {}),
    ...(!ctx && target.repo ? { repo: target.repo } : {}),
    previousAttempts: attempts,
    fenceToken: opts.fenceToken ?? randomBytes(16).toString('hex'),
  });
  const shown = new Set((brief.previous_attempts ?? []).map((a) => a.run_ref));
  return { brief: { ...brief, dispatched_by: target.dispatched_by ?? null }, previousAttempts: attempts.filter((a) => shown.has(a.run_ref)) };
}

/** Assemble the brief for a run without storing it. */
export async function composeRunBrief(target: RunTarget, opts: PlanOptions = {}): Promise<SessionBrief> {
  return (await planRunBrief(target, opts)).brief;
}

/**
 * The frozen brief for `target.run_ref`: the stored one if the run already has
 * one, else assembled now and stored write-once. Two concurrent freezes of one
 * run both return the brief that won.
 */
export async function freezeBrief(target: RunTarget, opts: PlanOptions = {}): Promise<SessionBrief> {
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
export function jobRunTarget(job: Pick<AgentJob, 'id' | 'title' | 'payload' | 'createdBy'>, box: RunTarget['box'], skillsDir: string | null = null): RunTarget {
  const p = job.payload;
  return {
    run_ref: job.id,
    box,
    ...(box === 'local' ? { skills_dir: skillsDir } : {}),
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
  opts: { store?: RunbookStore; skillsDir?: string | null } = {},
): Promise<{ brief: SessionBrief; run: LabRunContext } | null> {
  try {
    const { skillsDir = null, ...storeOpts } = opts;
    const brief = await freezeBrief(jobRunTarget(job, box, skillsDir), storeOpts);
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

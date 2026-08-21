// Firing a bot — from a trigger to one governed run, with the brakes applied.
//
// Every trigger path (manual, cron, later pr_watch) converges here, so the
// guard ordering cannot drift between them: a disabled or paused bot refuses
// without leaving a run row (there was nothing to skip — the bot is off); a
// run-cap or budget refusal records a `skipped` bot_run, because a trigger
// that fired and was braked is an event the operator should see on the bot
// page, not a silent nothing.
//
// Dispatch reuses the existing machinery wholesale: repo-target bots go
// through dispatchGovernedRun (capture → review → gates → human), initiative
// bots enqueue an agent_jobs row for the fleet dispatcher. A bot adds no new
// way for code to change ungoverned.
//
// The work marketplace (dispatchWorkItem) is the bot-less sibling: a sized
// story or bug is authorized directly into a governed run bound to its work
// item, recorded as a bot_run with bot_id NULL. Same workspace machinery,
// same governance, no bot row.

import { exec } from '../providers/aurora.js';
import { config } from '../config.js';
import {
  getBot, createBotRun, finalizeBotRun, setPausedReason, markBotRan,
  type BotRun,
} from '../providers/bots.js';
import {
  getAgentProject, listAgentProjects, buildCloneCommand, markCloned, type AgentProject,
} from '../providers/agent-projects.js';
import { getWorkItem, updateWorkItem, addWorkItemComment, type WorkItem } from '../providers/work-items.js';
import { enqueueJob } from '../providers/agent-jobs.js';
import { dispatchGovernedRun } from './sdlc-pipeline.js';
import { runDevboxShell } from './project-runner.js';
import { resolveDevboxArn, devboxDataClient } from './devbox-arn.js';
import { registerBox, getBoxBySession } from './devbox-fleet.js';
import { normalizeRuntimeSessionId } from './runtime-session.js';
import { type SqlParameter } from '@aws-sdk/client-rds-data';

function s(name: string, value: string): SqlParameter { return { name, value: { stringValue: value } }; }
function toStr(v: unknown, f = ''): string { return typeof v === 'string' ? v : v == null ? f : String(v); }

// The portal's clone-check heuristic: the devbox command API streams text with
// no exit-code marker, so a failed clone is recognised by what git says.
const CLONE_FAILURE = /fatal:|repository not found|authentication failed|could not read username/i;

// ─── The guard, pure ──────────────────────────────────────────────────────────

export interface FireGuardInput {
  enabled: boolean;
  pausedReason: string | null;
  maxRunsPerDay: number;
  budgetPerDayUsd: number | null;
  todayRunCount: number;
  todaySpendUsd: number;
}

export type FireDecision =
  | { kind: 'fire' }
  /** Nothing recorded — the bot is off, so the trigger had nothing to skip. */
  | { kind: 'refuse'; reason: string }
  /** Record a skipped bot_run: a live trigger was braked, which is visible history. */
  | { kind: 'skip'; reason: string }
  /** Record a skipped run AND self-pause — the hard daily-budget brake. */
  | { kind: 'pause'; reason: string };

/**
 * Whether this firing may proceed. Ordering is the contract: off/paused first
 * (cheapest, and any other answer would be misleading for a paused bot), then
 * the run cap (independent of cost, so a mispriced model cannot defeat it),
 * then the budget — which is the only one that flips the bot's own state.
 */
export function decideFire(bot: FireGuardInput): FireDecision {
  if (!bot.enabled) return { kind: 'refuse', reason: 'bot is disabled' };
  if (bot.pausedReason) return { kind: 'refuse', reason: `bot is paused: ${bot.pausedReason}` };
  if (bot.todayRunCount >= bot.maxRunsPerDay) {
    return { kind: 'skip', reason: `max runs per day reached (${bot.maxRunsPerDay})` };
  }
  if (bot.budgetPerDayUsd != null && bot.todaySpendUsd >= bot.budgetPerDayUsd) {
    return { kind: 'pause', reason: 'daily budget reached' };
  }
  return { kind: 'fire' };
}

/** The written mission plus the operator's one-shot steering, when given. */
export function renderPrompt(promptTemplate: string, instruction?: string): string {
  return instruction ? `${promptTemplate}\n\nFor this run specifically: ${instruction}` : promptTemplate;
}

// ─── Dispatch ─────────────────────────────────────────────────────────────────

export type FireResult =
  | { ok: true; run: BotRun }
  | { ok: false; reason: string; run?: BotRun };

/**
 * Make sure the bot's target repository is checked out in a live workspace.
 *
 * "Live" means both halves: the project knows a session AND the fleet registry
 * knows a box for it — the registry is in-memory, so a middleware restart (or
 * a workspace wipe) leaves session ids that point at nothing. Bots re-clone on
 * demand rather than assume, the same posture Codebases takes.
 */
async function ensureWorkspace(project: AgentProject): Promise<
  { ok: true; sessionId: string; boxId: string } | { ok: false; error: string }
> {
  const existing = project.sessionId ? getBoxBySession(project.sessionId) : null;
  if (project.sessionId && existing) return { ok: true, sessionId: project.sessionId, boxId: existing.id };

  const arn = await resolveDevboxArn();
  if (!arn) return { ok: false, error: 'the devbox runtime is not deployed' };

  // Keep the project's session id when it satisfies the runtime's ≥33-char
  // rule — the workspace may still hold the checkout — else mint a fresh one.
  const sessionId = normalizeRuntimeSessionId(project.sessionId);
  const box = registerBox({ sessionId });

  const { command, redacted } = await buildCloneCommand(project);
  let output = '';
  try {
    output = await runDevboxShell(devboxDataClient(), arn, sessionId, command);
  } catch (err) {
    return { ok: false, error: `clone failed: ${(err as Error).message}` };
  }
  if (CLONE_FAILURE.test(output)) {
    const line = output.split('\n').find((l) => CLONE_FAILURE.test(l)) ?? output.slice(-200);
    console.warn(`[bots] clone failed for ${project.repoFullName}: ${line.trim()} (${redacted})`);
    return { ok: false, error: `clone failed: ${line.trim()}` };
  }

  await markCloned(project.id, sessionId);
  return { ok: true, sessionId, boxId: box.id };
}

/** Dispatch one run of a bot. The single entry point for every trigger. */
export async function fireBot(botId: string, opts: {
  trigger: 'manual' | 'cron' | 'pr_watch';
  /** One-shot steering, appended to the mission for this run only. */
  instruction?: string;
}): Promise<FireResult> {
  const bot = await getBot(botId);
  if (!bot) return { ok: false, reason: 'no such bot' };

  const decision = decideFire(bot);
  if (decision.kind === 'refuse') return { ok: false, reason: decision.reason };
  if (decision.kind === 'skip' || decision.kind === 'pause') {
    if (decision.kind === 'pause') await setPausedReason(bot.id, decision.reason);
    const run = await createBotRun({
      botId: bot.id, trigger: opts.trigger, status: 'skipped',
      outcome: { reason: decision.reason },
    });
    return { ok: false, reason: decision.reason, ...(run ? { run } : {}) };
  }

  const prompt = renderPrompt(bot.prompt, opts.instruction);

  if (bot.agentProjectId) {
    const project = await getAgentProject(bot.agentProjectId);
    if (!project) return { ok: false, reason: 'the bot\'s target codebase no longer exists' };

    const ws = await ensureWorkspace(project);
    if (!ws.ok) {
      const run = await createBotRun({
        botId: bot.id, trigger: opts.trigger, status: 'failed',
        outcome: { error: ws.error },
      });
      return { ok: false, reason: ws.error, ...(run ? { run } : {}) };
    }

    const started = await dispatchGovernedRun({
      project, prompt, model: bot.model, sessionId: ws.sessionId,
    });
    if (!started.ok) {
      const run = await createBotRun({
        botId: bot.id, trigger: opts.trigger, status: 'failed',
        outcome: { error: started.error, sessionId: ws.sessionId, boxId: ws.boxId },
      });
      return { ok: false, reason: started.error, ...(run ? { run } : {}) };
    }

    const run = await createBotRun({
      botId: bot.id, trigger: opts.trigger, runId: started.runId,
      outcome: { sessionId: ws.sessionId, boxId: ws.boxId },
    });
    await markBotRan(bot.id);
    if (!run) return { ok: false, reason: 'could not record the bot run' };
    return { ok: true, run };
  }

  // Initiative-target (or untargeted) bot: queue work for the fleet dispatcher
  // rather than a repo-bound governed run. requiresReview rides the payload —
  // the dispatcher parks the artifact at awaiting_review unless it is false.
  const job = await enqueueJob({
    kind: 'devbox:task', title: bot.name,
    payload: { prompt, requiresReview: bot.requiresReview, botId: bot.id },
  });
  if (!job) return { ok: false, reason: 'could not enqueue the job' };
  const run = await createBotRun({ botId: bot.id, trigger: opts.trigger, jobId: job.id });
  await markBotRan(bot.id);
  if (!run) return { ok: false, reason: 'could not record the bot run' };
  return { ok: true, run };
}

// ─── Marketplace dispatch ─────────────────────────────────────────────────────

export interface DispatchCandidate { id: string; repoFullName: string }

export type DispatchDecision =
  | { kind: 'proceed'; agentProjectId: string }
  | { kind: 'error'; status: number; error: string; options?: DispatchCandidate[] };

/**
 * Whether a work item may be dispatched, and against which codebase. Pure —
 * the refusal matrix in one place, judgeable without a database. Ordering:
 * item-shape refusals (type, status) come before codebase resolution, because
 * "pick a codebase" is a useless answer for an epic or a done item.
 */
export function decideDispatch(
  item: Pick<WorkItem, 'type' | 'status'>,
  codebases: DispatchCandidate[],
  agentProjectId?: string,
): DispatchDecision {
  if (item.type !== 'story' && item.type !== 'bug') {
    return { kind: 'error', status: 400, error: 'only stories and bugs dispatch — epics roll up, they do not run' };
  }
  // open or in_progress may (re)dispatch; done/cancelled are finished and
  // in_review already has a change awaiting a human — dispatching over it
  // would race the review.
  if (item.status !== 'open' && item.status !== 'in_progress') {
    return { kind: 'error', status: 400, error: `a ${item.status} work item cannot be dispatched` };
  }
  if (codebases.length === 0) {
    return { kind: 'error', status: 400, error: 'no codebase delivers this initiative — link one in Codebases' };
  }
  if (agentProjectId) {
    const chosen = codebases.find((c) => c.id === agentProjectId);
    if (!chosen) {
      return { kind: 'error', status: 400, error: 'that codebase does not deliver this initiative' };
    }
    return { kind: 'proceed', agentProjectId: chosen.id };
  }
  if (codebases.length > 1) {
    return {
      kind: 'error', status: 409,
      error: 'multiple codebases deliver this initiative — pick one',
      options: codebases,
    };
  }
  return { kind: 'proceed', agentProjectId: codebases[0]!.id };
}

/**
 * The work item rendered as a mission: what to do (title, description,
 * labels), which item it serves (so the trail from run back to story survives
 * in the prompt itself), and the standing instruction that governance — not
 * the agent — delivers the result.
 */
export function renderWorkItemPrompt(
  item: Pick<WorkItem, 'id' | 'type' | 'title' | 'description' | 'labels' | 'storyPoints'>,
  instruction?: string,
): string {
  const preamble = item.storyPoints != null
    ? `Work item ${item.id} (${item.type}, ${item.storyPoints} pts)`
    : `Work item ${item.id} (${item.type})`;
  const parts = [`${preamble}\n${item.title}`];
  if (item.description) parts.push(item.description);
  if (item.labels.length > 0) parts.push(`Labels: ${item.labels.join(', ')}`);
  if (instruction) parts.push(`For this run specifically: ${instruction}`);
  parts.push('Commit your work; it will be captured, reviewed and gated automatically.');
  return parts.join('\n\n');
}

export type DispatchWorkResult =
  | { ok: true; run: BotRun }
  | { ok: false; status: number; error: string; options?: DispatchCandidate[] };

/**
 * Authorize a story or bug into a governed run — the marketplace's dispatch.
 *
 * No bot exists here: the work item is the mission and the bot_run rides with
 * bot_id NULL. The codebase is resolved from the initiative the item belongs
 * to (agent_projects.org_project_id); one match dispatches, several demand a
 * choice (409 + options), none is a setup error the operator must fix in
 * Codebases. The estimate the operator authorized against is echoed onto the
 * bot_run outcome so estimate-vs-actual calibration has both halves.
 */
export async function dispatchWorkItem(input: {
  workItemId: string;
  model: string;
  agentProjectId?: string;
  instruction?: string;
  actor?: string;
  /** The estimate shown at authorize time, echoed onto the bot_run outcome. */
  estimate?: Record<string, unknown>;
}): Promise<DispatchWorkResult> {
  const item = await getWorkItem(input.workItemId);
  if (!item) return { ok: false, status: 404, error: 'no such work item' };

  const codebases = (await listAgentProjects())
    .filter((p) => p.orgProjectId != null && p.orgProjectId === item.projectId)
    .map((p) => ({ id: p.id, repoFullName: p.repoFullName }));
  const decision = decideDispatch(item, codebases, input.agentProjectId);
  if (decision.kind === 'error') {
    return {
      ok: false, status: decision.status, error: decision.error,
      ...(decision.options ? { options: decision.options } : {}),
    };
  }

  const project = await getAgentProject(decision.agentProjectId);
  if (!project) return { ok: false, status: 404, error: 'the chosen codebase no longer exists' };

  const ws = await ensureWorkspace(project);
  if (!ws.ok) return { ok: false, status: 503, error: ws.error };

  const prompt = renderWorkItemPrompt(item, input.instruction);
  const started = await dispatchGovernedRun({
    project, prompt, model: input.model, sessionId: ws.sessionId,
  });
  if (!started.ok) return { ok: false, status: 503, error: started.error };

  // Bind the governed run to its work item. Direct SQL on purpose — the
  // sdlc-pipeline API takes no work-item concept and stays that way; the
  // column was added by agent_bots_schema.sql for exactly this write.
  await exec(
    `UPDATE agent_project_runs SET work_item_id = :wid WHERE id = :rid::uuid`,
    [s('wid', item.id), s('rid', started.runId)],
  );

  const run = await createBotRun({
    botId: null, trigger: 'marketplace', runId: started.runId, workItemId: item.id,
    outcome: {
      sessionId: ws.sessionId, boxId: ws.boxId,
      ...(input.actor ? { actor: input.actor } : {}),
      ...(input.estimate ? { estimate: input.estimate } : {}),
    },
  });
  if (!run) return { ok: false, status: 503, error: 'could not record the marketplace run' };

  // The board's "agent working" state. Through the provider so the mock path
  // and updated_at behave the same as a hand-driven status change.
  await updateWorkItem(item.id, { status: 'in_progress' });
  return { ok: true, run };
}

// ─── Reconciliation ───────────────────────────────────────────────────────────

/**
 * Settle running bot_runs whose underlying run or job has finished.
 *
 * The dispatch paths are fire-and-forget (a governed run finishes on its own;
 * a queue job is the dispatcher's), so nothing calls back into the bot layer
 * when they end. This poll closes the loop: terminal status and cost flow back
 * onto the bot_run, plus — for governed runs — the change request and PR it
 * produced, so the bot's Outcomes tab links into the review queue.
 */
export async function reconcileBotRuns(): Promise<{ settled: number }> {
  if (config.mock.aurora) return { settled: 0 };
  let settled = 0;

  // Governed runs. The lateral takes the newest change request for the run —
  // a re-review appends reviews, not changes, so one run has at most one.
  const runBacked = await exec(
    `SELECT br.id, br.work_item_id, r.status AS run_status, r.cost_usd::float8 AS cost_usd,
            r.files_changed, r.error AS run_error, cr.change_id, cr.pr_url
       FROM bot_runs br
       JOIN agent_project_runs r ON r.id = br.run_id
       LEFT JOIN LATERAL (
         SELECT c.id AS change_id, c.pr_url
           FROM agent_change_requests c
          WHERE c.run_id = br.run_id
          ORDER BY c.created_at DESC LIMIT 1
       ) cr ON TRUE
      WHERE br.status = 'running' AND br.run_id IS NOT NULL
        AND r.status IN ('done','failed')`,
  );
  for (const row of runBacked) {
    const done = toStr(row['run_status']) === 'done';
    await finalizeBotRun(toStr(row['id']), {
      status: done ? 'done' : 'failed',
      costUsd: row['cost_usd'] == null ? null : Number(row['cost_usd']),
      outcome: {
        ...(row['change_id'] ? { changeId: toStr(row['change_id']) } : {}),
        ...(row['pr_url'] ? { prUrl: toStr(row['pr_url']) } : {}),
        ...(row['files_changed'] == null ? {} : { filesChanged: Number(row['files_changed']) }),
      },
    });
    settled++;

    // A run bound to a work item settles the work item too — the marketplace
    // loop: change captured → in_review (the Changes queue owns it now); a PR
    // already delivered rides along; a failure hands the item back to 'open'
    // with a visible system comment, never a silent stall in in_progress.
    const workItemId = row['work_item_id'] ? toStr(row['work_item_id']) : null;
    if (workItemId) {
      if (done && row['change_id']) {
        await updateWorkItem(workItemId, {
          status: 'in_review',
          ...(row['pr_url'] ? { prUrl: toStr(row['pr_url']), prStatus: 'open' as const } : {}),
        });
      } else if (!done) {
        await updateWorkItem(workItemId, { status: 'open' });
        const why = row['run_error'] ? toStr(row['run_error']) : 'the run failed without a recorded error';
        await addWorkItemComment(workItemId, `Marketplace run failed: ${why}`, { isSystem: true });
      } else {
        // Done but nothing captured: the agent committed no change. Back to
        // open with a comment, else the item is stuck in_progress forever.
        await updateWorkItem(workItemId, { status: 'open' });
        await addWorkItemComment(workItemId, 'Marketplace run completed without a captured change.', { isSystem: true });
      }
    }
  }

  // Queue jobs. awaiting_review counts as done for the bot — the work is
  // finished; what remains is the human decision, which lives on the Work
  // surface. cancelled is terminal too, else the bot_run runs forever.
  const jobBacked = await exec(
    `SELECT br.id, j.status AS job_status, (j.result->>'costUsd')::float8 AS cost_usd
       FROM bot_runs br
       JOIN agent_jobs j ON j.id = br.job_id
      WHERE br.status = 'running' AND br.job_id IS NOT NULL
        AND j.status IN ('done','awaiting_review','failed','cancelled')`,
  );
  for (const row of jobBacked) {
    const jobStatus = toStr(row['job_status']);
    await finalizeBotRun(toStr(row['id']), {
      status: jobStatus === 'done' || jobStatus === 'awaiting_review' ? 'done' : 'failed',
      costUsd: row['cost_usd'] == null ? null : Number(row['cost_usd']),
      outcome: jobStatus === 'awaiting_review' ? { awaitingReview: true } : {},
    });
    settled++;
  }

  return { settled };
}

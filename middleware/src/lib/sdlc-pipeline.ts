// The SDLC pipeline — from an agent's diff to a governed decision.
//
// This is the seam that connects the two halves that were previously
// unconnected: a devbox agent produces a diff, and the governance layer needs
// to see it. When a run changes code, the pipeline captures the diff (so it
// survives the workspace), asks an independent reviewer to judge it, and runs
// the policy gates. The change lands in whatever state that evaluation decided
// — approved, needs-approval, changes-requested, or blocked — and stops there
// until a human or a delivery step moves it on.
//
// Capture happens here rather than in the runner because it is a governance
// concern, not a run concern: the runner's job is to run the agent and record
// what changed; whether that change is allowed to ship is this file's job.

import { reserveSpend, forecastP75ForModel, meterForHold, type ReserveSpendResult } from './spend-holds.js';
import { bindHoldSource, releaseHold } from '../providers/spend-holds.js';
import { dispatchHoldTtlMs } from './bot-runner.js';
import { runDevboxShell, executeProjectRun } from './project-runner.js';
import { reviewDiff } from './change-reviewer.js';
import {
  createChangeRequest, recordReview, evaluateChange, getChangeRequest,
  markInReview, markDelivering, markDelivered, markFailed, hasNewerChangeForProject,
  setCommitSha,
} from '../providers/sdlc.js';
import { getWorkItem, updateWorkItem } from '../providers/work-items.js';
import { startRun, checkoutPath, type AgentProject } from '../providers/agent-projects.js';
import { deliverChange } from './change-delivery.js';
import { deliveryBlockReason } from './delivery-guard.js';
import { isGitFailure, parsePorcelainFiles } from './capture-parse.js';
import { resolveDevboxArn, devboxDataClient } from './devbox-arn.js';
import { registerBox, getBoxBySession, appendEvent, reserveBox, releaseBox, setBoxProfile, markStopped } from './devbox-fleet.js';
import { profileForBox, resolveTaskModel, profileStamp } from './devbox-profile.js';
import type { BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore';
import { stopDevboxSession, type DevboxLabContext } from './devbox-runner.js';

export interface CaptureInput {
  client: BedrockAgentCoreClient;
  runtimeArn: string;
  sessionId: string;
  checkout: string;
  projectId: string;
  runId?: string | null;
  prompt: string;
  model?: string | null;
  /** The marketplace work item this run answers, when a dispatch bound one. */
  workItemId?: string | null;
  /** Who caused the change (DE-43): the dispatcher, else a bot's creator. */
  requestedBy?: string | null;
}

/**
 * Start a run against a project and wire it into governance.
 *
 * The one place a run is dispatched, so the codebase's "run a task" and the
 * review loop's "address these findings" cannot drift apart in how a run is
 * started, logged, or captured. A run begun either way finishes on its own,
 * tees into the fleet log, and — if it changed code — flows through capture,
 * review, and the gates.
 */
export async function dispatchGovernedRun(input: {
  project: AgentProject; prompt: string; model?: string | null; sessionId: string;
  /** The work item this run answers — carried onto the run row and the change
   *  it captures, so the review queue names the issue that asked for it. */
  workItemId?: string | null;
  /** Who the computer belongs to and which initiative it is charged to, for a
   *  box this dispatch has to mint. See ensureWorkspace in lib/bot-runner.ts:
   *  an unattributed box is invisible to the SME who created it. */
  attribution?: { ownerId?: string | undefined; projectId?: string | undefined };
  /** The person dispatching (session sub), stamped on the run's frozen brief
   *  and on the run row (`agent_project_runs.dispatched_by`, DE-43). */
  dispatchedBy?: string | null;
  /** Who the change this run captures answers to (DE-43): defaults to
   *  `dispatchedBy`; a cron bot passes its creator, since nobody pressed go. */
  requestedBy?: string | null;
  /**
   * The spend hold (DE-34). A caller that already held the money (fireBot,
   * dispatchWorkItem) passes its id — or null when none was written — and the
   * bot_run settles it. A caller that passes NOTHING (a direct
   * POST /api/agent-projects/:id/runs, the review loop's "address") gets one
   * taken here, before startRun, as an `agent_project_run` hold the run's own
   * ledger entry settles. So every governed run is held without a sixth
   * call site.
   */
  holdId?: string | null;
}): Promise<
  | { ok: true; runId: string; checkout: string; briefId: string | null }
  | {
    ok: false; error: string; refusal?: Exclude<ReserveSpendResult, { kind: 'held' }>;
    /** DE-40: the model is not on the box's profile — a 400 naming the allowed set. */
    code?: 'MODEL_NOT_ALLOWED'; allowedModels?: string[];
  }
> {
  const arn = await resolveDevboxArn();
  if (!arn) return { ok: false, error: 'the devbox runtime is not deployed' };

  // The model this run may use (DE-40), resolved BEFORE any money is held or
  // a run row exists: the box's stamped profile (a box keeps the rules it was
  // created under), else its initiative's. An unlisted model is refused with
  // the allowed set, never swapped — the container refuses it too, so letting
  // it through would only fail later and less legibly. No model asked for →
  // the profile's first, so the BFF always sends one.
  const existingBox = getBoxBySession(input.sessionId);
  const profile = await profileForBox(existingBox ?? {
    projectId: input.attribution?.projectId ?? input.project.orgProjectId ?? undefined,
  });
  const resolved = resolveTaskModel(profile, input.model ?? null);
  if (!resolved.ok) return { ok: false, error: resolved.error, code: 'MODEL_NOT_ALLOWED', allowedModels: resolved.allowed };
  const model = resolved.model;

  let ownHold: string | null = null;
  if (!('holdId' in input)) {
    const held = await reserveSpend({
      initiativeId: input.project.orgProjectId ?? null,
      actorId: input.dispatchedBy ?? null,
      source: 'agent_project_run',
      forecast: await forecastP75ForModel(model, input.project.id),
      expiresInMs: dispatchHoldTtlMs(),
    });
    if (held.kind !== 'held') return { ok: false, error: held.reason, refusal: held };
    ownHold = held.holdId;
  }

  let run: Awaited<ReturnType<typeof startRun>>;
  try {
    run = await startRun({
      projectId: input.project.id, prompt: input.prompt,
      model, sessionId: input.sessionId,
      ...(input.workItemId ? { workItemId: input.workItemId } : {}),
      ...(input.dispatchedBy ? { dispatchedBy: input.dispatchedBy } : {}),
    });
  } catch (err) {
    // No run row, nothing invoked: the money this call held goes back.
    await releaseHold(ownHold);
    throw err;
  }
  if (ownHold) await bindHoldSource(ownHold, 'agent_project_run', run.id);
  const requestedBy = input.requestedBy ?? input.dispatchedBy ?? null;
  const checkout = checkoutPath(input.project);
  const box = getBoxBySession(input.sessionId) ?? registerBox({
    sessionId: input.sessionId,
    ...(input.attribution?.ownerId ? { ownerId: input.attribution.ownerId } : {}),
    ...(input.attribution?.projectId ? { projectId: input.attribution.projectId } : {}),
    profile: profileStamp(profile),
  });
  // Write-once: a box that predates profiles takes the one this run resolved.
  setBoxProfile(box.id, profileStamp(profile));

  // Tell the fleet what this computer is doing, now rather than when the
  // runtime's first event happens to arrive. `appendEvent` reads `task_started`
  // as "this box is running THIS task" (lib/devbox-fleet.ts) and nothing on
  // this path emitted one — the runtime streams `assistant`/`result`, not a
  // kickoff — so a box that had just been handed work still rendered idle with
  // no current task, which is the one thing Computer Lab exists to show.
  appendEvent(box.id, {
    type: 'task_started',
    prompt: input.prompt,
    model,
    ts: new Date().toISOString(),
  });

  // The session brief freezes here, keyed by the run id, before the runtime is
  // invoked: the box's SessionStart hook (`lab brief`) fetches it. A brief
  // that cannot be assembled leaves the run briefless rather than unstarted.
  let lab: DevboxLabContext | undefined;
  let briefId: string | null = null;
  try {
    const { freezeBrief, labRunContext } = await import('./run-brief.js');
    const brief = await freezeBrief({
      run_ref: run.id, box: 'devbox',
      work_item_id: input.workItemId ?? null,
      initiative_id: input.project.orgProjectId ?? null,
      repo: input.project.repoFullName ?? null,
      task: { title: titleFrom(input.prompt), text: input.prompt },
      dispatched_by: input.dispatchedBy ?? null,
    });
    briefId = brief.id;
    lab = { ...(await labRunContext(brief)), session_id: input.sessionId, box_id: box.id };
  } catch (err) {
    console.warn(`[sdlc] could not freeze a brief for run ${run.id}:`, (err as Error).message);
  }

  // The box is this run's until the run returns — including while it waits on
  // its operator — so no queued job is handed a checkout mid-run.
  const holder = `run:${run.id}`;
  reserveBox(box.id, holder);
  // The run's hold is its ceiling (DE-35): the caller's (bound to its bot_run
  // once that row exists) or the one taken here (bound to this run above).
  const runHold = 'holdId' in input ? input.holdId ?? null : ownHold;
  const meter = await meterForHold({
    holdId: runHold,
    initiativeId: input.project.orgProjectId ?? null,
    actorId: input.dispatchedBy ?? null,
    source: ownHold ? 'agent_project_run' : 'bot_run',
    sourceId: ownHold ? run.id : null,
    model, agentProjectId: input.project.id,
    expiresInMs: dispatchHoldTtlMs(),
  }).catch((err: unknown) => {
    console.warn(`[sdlc] run ${run.id} runs unmetered: ${(err as Error).message}`);
    return null;
  });
  void executeProjectRun({
    ...(meter ? {
      meter,
      cutoffBackstop: {
        stop: async () => {
          await stopDevboxSession(devboxDataClient(), arn, input.sessionId);
        },
        onStopped: () => markStopped(box.id),
      },
    } : {}),
    runId: run.id,
    sessionId: input.sessionId,
    checkout,
    prompt: input.prompt,
    model,
    runtimeArn: arn,
    client: devboxDataClient(),
    onEvent: (ev) => appendEvent(box.id, ev),
    ...(lab ? { lab } : {}),
    onChanged: () => {
      void captureAndGate({
        client: devboxDataClient(), runtimeArn: arn, sessionId: input.sessionId,
        checkout, projectId: input.project.id, runId: run.id,
        prompt: input.prompt, model,
        ...(input.workItemId ? { workItemId: input.workItemId } : {}),
        requestedBy,
      }).catch((err) => console.warn('[sdlc] capture failed:', (err as Error).message));
    },
  }).finally(() => {
    releaseBox(box.id, holder);
    // The run is over: its concurrency slot frees now (DE-37).
    if (runHold) void import('../providers/run-limits.js').then((m) => m.releaseRunSlots(runHold)).catch(() => undefined);
  });

  return { ok: true, runId: run.id, checkout, briefId };
}

/** A concise change title from the task prompt — the first line, bounded. */
function titleFrom(prompt: string): string {
  const first = prompt.split('\n').find((l) => l.trim()) ?? 'Agent change';
  return first.trim().slice(0, 200);
}

/**
 * Capture the working-tree diff for a change request.
 *
 * `add -A -N` marks untracked files intent-to-add so `git diff` shows them as
 * new files with content — a change that adds a file is as real as one that
 * edits, and a diff that omitted new files would understate what the agent did.
 * The captured diff is the record the reviewer and the audit trail both read.
 */
async function captureDiff(input: CaptureInput): Promise<{ diff: string; files: string[] } | null> {
  const git = `git -c safe.directory='*' -C ${input.checkout}`;
  // `-uall`: list untracked files individually, not collapsed to their parent
  // directory. Without it a new file shows as `?? config/`, and a path-based
  // gate (protected_paths on **/*.secret, **/auth/**) never sees `config/app.secret`
  // — a sensitive file in a new directory would slip past governance entirely.
  const status = await runDevboxShell(input.client, input.runtimeArn, input.sessionId,
    `${git} status --porcelain -uall | head -400`);
  if (isGitFailure(status)) return null;
  const files = parsePorcelainFiles(status);
  if (files.length === 0) return null;

  const diff = await runDevboxShell(input.client, input.runtimeArn, input.sessionId,
    `${git} add -A -N && ${git} diff | head -c 400000`);
  return { diff, files };
}

/**
 * Commit-per-capture: commit the run's work on the workspace's work branch and
 * return the commit SHA.
 *
 * Committing at capture time is what makes the *next* run's diff clean (its
 * changes are the only thing uncommitted), so the reviewer sees one run's change
 * instead of a cumulative tree — and lets delivery push exactly this commit.
 * Best-effort: on failure it returns null and the change stays on the legacy
 * working-tree delivery path; the change itself is never lost (its diff is
 * already recorded in Aurora).
 */
async function commitCapture(input: CaptureInput, title: string): Promise<string | null> {
  const git = `git -c safe.directory='*' -c user.name='OrgIQ Agent' -c user.email='agent@orgiq.local' -C ${input.checkout}`;
  try {
    const key = input.workItemId ? (await getWorkItem(input.workItemId))?.key : null;
    const b64 = Buffer.from(workItemCommitMessage(title, key), 'utf8').toString('base64');
    const out = await runDevboxShell(input.client, input.runtimeArn, input.sessionId,
      `${git} add -A && ${git} commit -q -m "$(echo ${b64} | base64 -d)" && ${git} rev-parse HEAD`);
    const sha = out.trim().split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch (err) {
    console.warn(`[sdlc] commit-per-capture failed, using working-tree delivery: ${(err as Error).message}`);
    return null;
  }
}

/** Keep the permanent work reference in git even when the human title changes. */
export function workItemCommitMessage(title: string, key?: string | null): string {
  return `${key ?? 'work'}: ${title.replace(/[\r\n]+/g, ' ').slice(0, 200)}`;
}

/**
 * Roll the work branch back to before a refused change, so blocked work never
 * carries into a later change's delivery. Guarded: only resets when `sha` is
 * still HEAD (it is, immediately after capture) and has a parent — so it can
 * never discard a later change or leave an empty repo. Best-effort.
 */
async function resetToParentOf(input: CaptureInput, sha: string): Promise<void> {
  const git = `git -c safe.directory='*' -C ${input.checkout}`;
  await runDevboxShell(input.client, input.runtimeArn, input.sessionId,
    `if [ "$(${git} rev-parse HEAD)" = "${sha}" ] && ${git} rev-parse ${sha}~1 >/dev/null 2>&1; then ${git} reset -q --hard ${sha}~1; fi`)
    .catch((err) => console.warn(`[sdlc] reset-on-block failed: ${(err as Error).message}`));
}

/**
 * Run the full capture → review → gate pipeline for a finished run.
 *
 * Returns the change request id, or null when the run changed nothing (in
 * which case there is nothing to govern). Never throws — a pipeline failure is
 * recorded on the change, because a governance step that fails silently is a
 * governance step that has been bypassed.
 */
export async function captureAndGate(input: CaptureInput): Promise<string | null> {
  const captured = await captureDiff(input);
  if (!captured) {
    // The run reported changed files but the diff came back empty. Worth a line:
    // this is the difference between "governance saw nothing to do" and a silent
    // failure, and without it the change simply never appears with no trace why.
    console.warn(`[sdlc] run ${input.runId ?? '?'} reported changes but captureDiff found nothing in ${input.checkout}`);
    return null;
  }

  const change = await createChangeRequest({
    projectId: input.projectId,
    runId: input.runId ?? null,
    title: titleFrom(input.prompt),
    diff: captured.diff,
    files: captured.files,
    model: input.model ?? null,
    ...(input.workItemId ? { workItemId: input.workItemId } : {}),
    requestedBy: input.requestedBy ?? null,
  });
  console.warn(`[sdlc] captured change ${change.id} (${captured.files.length} file(s)) for project ${input.projectId}`);

  // Commit-per-capture: commit the run's work now. This clears the working tree
  // so the next run's diff is only its own changes (no cumulative pollution, so
  // the reviewer stops false-blocking on a prior run's files), and lets delivery
  // push exactly this commit. Best-effort — a null sha falls back to legacy
  // working-tree delivery. This supersedes the old `git add -A` staging hack: a
  // committed base makes a later in-place edit a real, detectable diff.
  const sha = await commitCapture(input, change.title);
  if (sha) {
    await setCommitSha(change.id, sha);
    console.warn(`[sdlc] change ${change.id} committed as ${sha.slice(0, 8)}`);
  }

  try {
    await markInReview(change.id);
    const review = await reviewDiff({
      title: change.title,
      diff: captured.diff,
      truncated: change.diffTruncated,
      taskPrompt: input.prompt,
    });
    await recordReview({
      changeId: change.id,
      model: review.model,
      verdict: review.verdict,
      summary: review.summary,
      findings: review.findings,
    });
    const evaluated = await evaluateChange(change.id);
    console.warn(`[sdlc] change ${change.id} reviewed=${review.verdict} decided=${evaluated?.status ?? '?'}`);
    // A hard-blocked change must not carry into a later change's delivery — roll
    // the work branch back to before it while its commit is still HEAD.
    if (sha && evaluated?.status === 'blocked') await resetToParentOf(input, sha);
  } catch (err) {
    // The change exists and is captured; only the review/gate errored. Record
    // it on the change rather than losing the diff.
    console.warn(`[sdlc] change ${change.id} review/gate errored:`, (err as Error).message);
    await markFailed(change.id, `pipeline error: ${(err as Error).message}`);
  }
  // Tell the computer's own tail that its change went for review (lab wire
  // contract §4), so whoever is watching the run sees where its work landed
  // instead of a run that simply ended. Only facts already recorded above.
  announceDelivery(input.sessionId, {
    title: change.title, captureId: change.id,
    ...(input.workItemId ? { workItemId: input.workItemId } : {}),
    ...(sha ? { commitSha: sha } : {}),
  });
  return change.id;
}

/** A `delivery` frame into the tail of the box working this session, if any. */
function announceDelivery(sessionId: string | null, frame: {
  title: string; captureId: string; workItemId?: string; commitSha?: string;
  branch?: string; prUrl?: string; prNumber?: number;
}): void {
  const box = sessionId ? getBoxBySession(sessionId) : null;
  if (!box) return;
  appendEvent(box.id, { type: 'delivery', ...frame, ts: new Date().toISOString() });
}

/**
 * Deliver an approved change.
 *
 * Guards the state transition itself: only an `approved` change may be
 * delivered, and the change is moved to `delivering` before the push so a
 * concurrent second call finds it already in flight rather than pushing twice.
 */
export async function deliverApprovedChange(input: {
  client: BedrockAgentCoreClient;
  runtimeArn: string;
  changeId: string;
  project: { sessionId: string | null; checkout: string; repoFullName: string; defaultBranch: string; connectionName: string | null };
}): Promise<{ ok: boolean; prUrl?: string; error?: string }> {
  const change = await getChangeRequest(input.changeId);
  const { sessionId } = input.project;
  // The latest-capture check hits the DB, so it is resolved here and handed to
  // the pure guard alongside the change and the session — see delivery-guard.ts
  // for why the ordering (and the newer-change refusal in particular) matters.
  const block = deliveryBlockReason({
    change,
    hasSession: Boolean(sessionId),
    hasNewer: change ? await hasNewerChangeForProject(input.changeId) : false,
  });
  // The `!change`/`!sessionId` arms are unreachable once `block` is null (the
  // guard returns a reason for each), but they narrow the types for the push.
  if (block || !change || !sessionId) return { ok: false, error: block ?? 'change not found' };

  // Preconditions that mean NOTHING was attempted must not consume the
  // change's approved state. The missing-credential case hit markFailed via
  // the generic path during a live TPM walk: a 409 "no GitHub connection"
  // flipped the change to failed, and the retry — after linking a credential —
  // was refused with "change is failed, not approved". Recovering took a
  // manual database edit. A change is failed when a delivery ATTEMPT failed,
  // not when we declined to start one.
  if (!input.project.connectionName) {
    return {
      ok: false,
      error: 'This project has no GitHub connection, so there is no credential to push with. Link one in Knowledge → Sources — the change stays approved and can be delivered once linked.',
    };
  }

  await markDelivering(input.changeId);
  const result = await deliverChange({
    client: input.client,
    runtimeArn: input.runtimeArn,
    sessionId,
    checkout: input.project.checkout,
    repoFullName: input.project.repoFullName,
    defaultBranch: input.project.defaultBranch,
    connectionName: input.project.connectionName,
    changeId: input.changeId,
    title: change.title,
    reviewSummary: change.reviews[0]?.summary ?? null,
    commitSha: change.commitSha,
  });

  if (result.ok && result.prUrl) {
    await markDelivered(input.changeId, result.branch ?? '', result.prUrl);
    const prNumber = Number(/\/pull\/(\d+)/.exec(result.prUrl)?.[1]);
    announceDelivery(sessionId, {
      title: change.title, captureId: change.id, prUrl: result.prUrl,
      ...(change.workItemId ? { workItemId: change.workItemId } : {}),
      ...(change.commitSha ? { commitSha: change.commitSha } : {}),
      ...(result.branch ? { branch: result.branch } : {}),
      ...(Number.isFinite(prNumber) ? { prNumber } : {}),
    });
    // Close the loop on the board: without the PR written back onto the work
    // item, the story sits in in_review with no link, the PR chip never
    // renders, and the merge-detection poller — which flips stories to done
    // when their PR merges — has nothing to watch. Delivery without this is a
    // PR the initiative cannot see.
    if (change.workItemId) {
      try {
        await updateWorkItem(change.workItemId, { prUrl: result.prUrl, prStatus: 'open' });
      } catch (err) {
        console.warn('[sdlc] PR delivered but work-item writeback failed:', (err as Error).message);
      }
    }
    return { ok: true, prUrl: result.prUrl };
  }
  await markFailed(input.changeId, result.error ?? 'delivery failed');
  return { ok: false, error: result.error };
}

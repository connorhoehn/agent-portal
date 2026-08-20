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

import { runDevboxShell, executeProjectRun } from './project-runner.js';
import { reviewDiff } from './change-reviewer.js';
import {
  createChangeRequest, recordReview, evaluateChange, getChangeRequest,
  markInReview, markDelivering, markDelivered, markFailed,
} from '../providers/sdlc.js';
import { startRun, checkoutPath, type AgentProject } from '../providers/agent-projects.js';
import { deliverChange } from './change-delivery.js';
import { resolveDevboxArn, devboxDataClient } from './devbox-arn.js';
import { registerBox, getBoxBySession, appendEvent } from './devbox-fleet.js';
import type { BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore';

export interface CaptureInput {
  client: BedrockAgentCoreClient;
  runtimeArn: string;
  sessionId: string;
  checkout: string;
  projectId: string;
  runId?: string | null;
  prompt: string;
  model?: string | null;
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
}): Promise<{ ok: true; runId: string; checkout: string } | { ok: false; error: string }> {
  const arn = await resolveDevboxArn();
  if (!arn) return { ok: false, error: 'the devbox runtime is not deployed' };

  const run = await startRun({
    projectId: input.project.id, prompt: input.prompt,
    model: input.model ?? null, sessionId: input.sessionId,
  });
  const checkout = checkoutPath(input.project);
  const box = getBoxBySession(input.sessionId) ?? registerBox({ sessionId: input.sessionId });

  void executeProjectRun({
    runId: run.id,
    sessionId: input.sessionId,
    checkout,
    prompt: input.prompt,
    model: input.model ?? null,
    runtimeArn: arn,
    client: devboxDataClient(),
    onEvent: (ev) => appendEvent(box.id, ev),
    onChanged: () => {
      void captureAndGate({
        client: devboxDataClient(), runtimeArn: arn, sessionId: input.sessionId,
        checkout, projectId: input.project.id, runId: run.id,
        prompt: input.prompt, model: input.model ?? null,
      }).catch((err) => console.warn('[sdlc] capture failed:', (err as Error).message));
    },
  });

  return { ok: true, runId: run.id, checkout };
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
  const status = await runDevboxShell(input.client, input.runtimeArn, input.sessionId,
    `${git} status --porcelain | head -200`);
  if (/^fatal:|^error:/m.test(status)) return null;
  const files = status.split('\n').map((l) => l.trim().replace(/^\S+\s+/, '')).filter(Boolean);
  if (files.length === 0) return null;

  const diff = await runDevboxShell(input.client, input.runtimeArn, input.sessionId,
    `${git} add -A -N && ${git} diff | head -c 400000`);
  return { diff, files };
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
  if (!captured) return null;

  const change = await createChangeRequest({
    projectId: input.projectId,
    runId: input.runId ?? null,
    title: titleFrom(input.prompt),
    diff: captured.diff,
    files: captured.files,
    model: input.model ?? null,
  });

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
    await evaluateChange(change.id);
  } catch (err) {
    // The change exists and is captured; only the review/gate errored. Record
    // it on the change rather than losing the diff.
    await markFailed(change.id, `pipeline error: ${(err as Error).message}`);
  }
  return change.id;
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
  if (!change) return { ok: false, error: 'change not found' };
  if (change.status !== 'approved') {
    return { ok: false, error: `change is ${change.status}, not approved` };
  }
  if (!input.project.sessionId) {
    return { ok: false, error: 'this project has no live workspace to deliver from — re-run the task first' };
  }

  await markDelivering(input.changeId);
  const result = await deliverChange({
    client: input.client,
    runtimeArn: input.runtimeArn,
    sessionId: input.project.sessionId,
    checkout: input.project.checkout,
    repoFullName: input.project.repoFullName,
    defaultBranch: input.project.defaultBranch,
    connectionName: input.project.connectionName,
    changeId: input.changeId,
    title: change.title,
    reviewSummary: change.reviews[0]?.summary ?? null,
  });

  if (result.ok && result.prUrl) {
    await markDelivered(input.changeId, result.branch ?? '', result.prUrl);
    return { ok: true, prUrl: result.prUrl };
  }
  await markFailed(input.changeId, result.error ?? 'delivery failed');
  return { ok: false, error: result.error };
}

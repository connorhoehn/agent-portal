// Running an agent against a codebase, and recording what it did to it.
//
// Starting a task was easy; knowing whether anything came of it was the gap.
// A run row was written as `running` and left that way forever, because the
// only thing watching the stream was a browser tab — so closing the tab, or
// the run simply finishing, left a permanent "in progress" that meant nothing.
//
// The whole thing happens here instead: invoke the task, wait for it, then ask
// the repository what changed. `git status --porcelain` is the honest answer —
// not what the agent said it did, which is a claim, but what is actually
// different on disk, which is a fact. Agents are wrong about their own work
// often enough that the difference matters.

import {
  BedrockAgentCoreClient,
  // Aliased for the same reason routes/devbox.ts aliases it: the wire name is
  // one "Command" away from InvokeAgentRuntimeCommand, which invokes an agent
  // rather than running a shell command.
  InvokeAgentRuntimeCommandCommand as RunRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { executeDevboxTask, type DevboxLabContext, type DevboxRunOptions } from './devbox-runner.js';
import type { RunMeter } from './run-meter.js';
import { finishRun } from '../providers/agent-projects.js';
import { recordAgentProjectRunSpend } from '../providers/spend-ledger.js';

/**
 * Run a shell command in a devbox and collect its output as text.
 *
 * The command is base64'd into the script rather than interpolated, the same
 * way the interactive console does it — a path or a message containing a quote
 * would otherwise terminate the wrapper early and run something else.
 */
export async function runDevboxShell(
  client: BedrockAgentCoreClient, arn: string, sessionId: string, command: string,
): Promise<string> {
  const b64 = Buffer.from(command, 'utf8').toString('base64');
  const script = [
    'export HOME=/mnt/workspace',
    'export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0=/mnt/workspace',
    `echo ${b64} | base64 -d > /tmp/.orgiq-probe`,
    '. /tmp/.orgiq-probe < /dev/null',
    // Removed once it has run (DE-45): a probe left behind is readable by the
    // agent in the same microVM, and a legacy clone or push probe carries a
    // token. The exit status is the probe's, not rm's.
    'rc=$?',
    'rm -f /tmp/.orgiq-probe',
    'exit $rc',
  ].join('; ');

  const resp = await client.send(new RunRuntimeCommand({
    agentRuntimeArn: arn,
    runtimeSessionId: sessionId,
    body: { command: `sh -c '${script}'`, timeout: 60 },
  }));

  let out = '';
  for await (const event of resp.stream ?? []) {
    const chunk = (event as { chunk?: Record<string, unknown> }).chunk;
    const delta = chunk?.['contentDelta'] as { stdout?: string; stderr?: string } | undefined;
    if (delta?.stdout) out += delta.stdout;
    if (delta?.stderr) out += delta.stderr;
  }
  return out;
}

export interface DiffSummary {
  filesChanged: number;
  summary: string;
}

/**
 * What actually changed in the checkout.
 *
 * Counts porcelain lines rather than parsing `--stat`, because porcelain is
 * stable output meant for machines and covers untracked files — an agent that
 * adds a new file has changed the repository just as much as one that edits.
 */
export async function readWorkingTree(
  client: BedrockAgentCoreClient, arn: string, sessionId: string, checkout: string,
  /** Porcelain lines seen before the run, so the result is this run's delta. */
  before: Set<string> = new Set(),
): Promise<DiffSummary> {
  // `safe.directory=*` because the checkout is owned by a different uid than
  // the one running the probe, and git refuses with "detected dubious
  // ownership" rather than reading it. Scoped to this invocation, not written
  // into any config.
  const git = `git -c safe.directory='*' -C ${checkout}`;
  // `-uall` lists untracked files individually rather than collapsing them to a
  // parent directory, so a run that adds files reports each one (and matches the
  // before-snapshot, which uses the same flag).
  const status = await runDevboxShell(client, arn, sessionId, `${git} status --porcelain -uall | head -400`);

  // Never discard git's stderr. The first version sent it to /dev/null, so the
  // ownership refusal above arrived as empty output and was recorded as "no
  // change to the working tree" — a confident, wrong answer about whether an
  // agent had done anything, which is the worst thing this function can say.
  if (/^fatal:|^error:/m.test(status)) {
    const firstLine = status.split('\n').find((l) => /^(fatal|error):/.test(l)) ?? 'git failed';
    return { filesChanged: 0, summary: `Could not read the working tree — ${firstLine}` };
  }

  const all = status.split('\n').map((l) => l.trim()).filter(Boolean);

  // Only what *this* run did. Reporting the whole working tree credited every
  // run with changes an earlier one had left uncommitted — a task told to
  // change nothing was recorded as changing a file, which is worse than saying
  // nothing at all.
  const lines = all.filter((l) => !before.has(l));
  if (lines.length === 0) {
    return {
      filesChanged: 0,
      summary: all.length > 0
        ? `No change from this run. ${all.length} uncommitted ${all.length === 1 ? 'file' : 'files'} remain from earlier runs.`
        : 'No change to the working tree.',
    };
  }

  const stat = await runDevboxShell(client, arn, sessionId, `${git} diff --stat | tail -1`);

  // Name the first few files: "12 files changed" tells you the size of the
  // change and nothing about whether it was the right one.
  const names = lines.slice(0, 5).map((l) => l.replace(/^\S+\s+/, '')).join(', ');
  const tail = lines.length > 5 ? `, +${lines.length - 5} more` : '';
  const statLine = stat.trim();
  return {
    filesChanged: lines.length,
    summary: `${names}${tail}${statLine ? ` · ${statLine}` : ''}`,
  };
}

/** Porcelain lines as they stand right now, for before/after comparison. */
export async function snapshotWorkingTree(
  client: BedrockAgentCoreClient, arn: string, sessionId: string, checkout: string,
): Promise<Set<string>> {
  try {
    const out = await runDevboxShell(client, arn, sessionId,
      `git -c safe.directory='*' -C ${checkout} status --porcelain -uall | head -400`);
    if (/^fatal:|^error:/m.test(out)) return new Set();
    return new Set(out.split('\n').map((l) => l.trim()).filter(Boolean));
  } catch {
    // A missing snapshot degrades to reporting the whole tree, which is the
    // old behaviour — imperfect, not wrong enough to fail the run over.
    return new Set();
  }
}

export interface ProjectRunRequest {
  runId: string;
  sessionId: string;
  checkout: string;
  prompt: string;
  model?: string | null;
  runtimeArn: string;
  client: BedrockAgentCoreClient;
  onEvent?: (event: Record<string, unknown>) => void;
  /**
   * Fired after a run that changed files, with the file count. The runner does
   * not know what governance does with that — a callback keeps the SDLC
   * pipeline importing the runner without the runner importing back into it.
   */
  onChanged?: (filesChanged: number) => void;
  /** The run's LAB_* context (lib/run-brief.ts); the box's `lab brief` reads it. */
  lab?: DevboxLabContext;
  /** DE-35: the run's hold as its ceiling, and the session stop after a cut. */
  meter?: RunMeter | null;
  cutoffBackstop?: DevboxRunOptions['cutoffBackstop'];
}

/**
 * Execute a run to completion and record its outcome.
 *
 * Never throws. A run that fails has to be *recorded* as failed — leaving the
 * row at `running` because the failure path threw would recreate exactly the
 * problem this exists to fix.
 */
/** How a governed run ended, for its run report (lib/run-reports/record.ts). */
export interface ProjectRunEnd {
  ok: boolean;
  error: string | null;
  cutoff: boolean;
  costUsd: number | null;
  model: string | null;
  filesChanged: number;
  /** The run's final message (its lab-report block) and the skills it was seen loading. */
  finalMessage: string;
  skillsLoaded: string[];
  /** The session the run ended in, when the runtime reported one (a debrief resumes it). */
  claudeSessionId: string | null;
}

export async function executeProjectRun(req: ProjectRunRequest): Promise<ProjectRunEnd> {
  try {
    const before = await snapshotWorkingTree(req.client, req.runtimeArn, req.sessionId, req.checkout);

    const outcome = await executeDevboxTask({
      sessionId: req.sessionId,
      // Scope the agent to the checkout, so "this repo" means the repo and not
      // the whole workspace.
      prompt: `Work in ${req.checkout}. ${req.prompt}`,
      resume: false,
      ...(req.model ? { model: req.model } : {}),
      runtimeArn: req.runtimeArn,
      client: req.client,
      ...(req.onEvent ? { onEvent: req.onEvent } : {}),
      ...(req.lab ? { lab: req.lab } : {}),
      // A governed run used to pass no signal at all; the meter's is its stop.
      ...(req.meter ? { meter: req.meter } : {}),
      ...(req.meter && req.cutoffBackstop ? { cutoffBackstop: req.cutoffBackstop } : {}),
    });

    // Measure the repository even when the agent reported failure — a run that
    // errored partway through can still have left changes behind, and that is
    // precisely when someone needs to know.
    let diff: DiffSummary = { filesChanged: 0, summary: '' };
    try {
      diff = await readWorkingTree(req.client, req.runtimeArn, req.sessionId, req.checkout, before);
    } catch (err) {
      diff = { filesChanged: 0, summary: `Could not read the working tree: ${(err as Error).message}` };
    }

    await finishRun(req.runId, {
      status: outcome.ok ? 'done' : 'failed',
      filesChanged: diff.filesChanged,
      diffSummary: diff.summary || null,
      error: outcome.ok ? null : (outcome.error ?? 'the agent reported a failure'),
      // Preserve reported versus estimated spend through later bot settlement.
      costUsd: outcome.costUsd,
      costBasis: outcome.costBasis,
      estimatedCostUsd: outcome.estimatedCostUsd,
      // This path is AgentCore Runtime by construction (it invokes one), so the
      // provenance is known and worth stating rather than left NULL. Stated at
      // the call site, never inferred inside the provider: the provider cannot
      // see which executor called it, and that is exactly the gap that let a
      // local run's self-reported first-party price look like Bedrock spend.
      modelProvider: 'bedrock',
      // DE-35: why the run stopped, when its ceiling cut it. The working tree
      // is kept and measured above; nothing is committed for it.
      ...(outcome.cutoff ? { cutoff: outcome.cutoff } : {}),
    });
    // The ledger entry (DE-30): this path writes no bot_runs row of its own.
    await recordAgentProjectRunSpend(req.runId);

    // Hand a changed run to governance. Fired only when the tree actually
    // moved — a run that changed nothing has nothing to review.
    if (diff.filesChanged > 0) {
      try { req.onChanged?.(diff.filesChanged); } catch { /* governance failures are the callback's to record, not the run's */ }
    }
    return {
      ok: outcome.ok, error: outcome.ok ? null : (outcome.error ?? 'the agent reported a failure'), cutoff: !!outcome.cutoff,
      costUsd: outcome.costUsd, model: outcome.model, filesChanged: diff.filesChanged,
      finalMessage: outcome.summary, skillsLoaded: outcome.skillsLoaded ?? [], claudeSessionId: outcome.claudeSessionId ?? null,
    };
  } catch (err) {
    await finishRun(req.runId, {
      status: 'failed',
      filesChanged: null,
      diffSummary: null,
      error: (err as Error).message,
    }).catch(() => { /* the run is lost either way; do not mask the original */ });
    return {
      ok: false, error: (err as Error).message, cutoff: false, costUsd: null, model: req.model ?? null, filesChanged: 0,
      finalMessage: '', skillsLoaded: [], claudeSessionId: null,
    };
  }
}

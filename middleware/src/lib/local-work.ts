// What a paired workstation is allowed to run, and how much of it at once.
//
// Pure, for the same reason `decideRunBudget`/`decideAllocation`/`decideEnvelope`
// in lib/bot-runner.ts are pure: these are refusals, and a refusal that can only
// be exercised by standing up a database and a laptop is a refusal nobody tests.
//
// The shape of the trust boundary matters here and is worth stating once. A node
// SELF-REPORTS its capabilities (providers/local-compute.ts
// `recordNodeCapabilities`), and that is safe only because every field can
// exclusively NARROW what it is offered: kinds are intersected with the server's
// own set, concurrency is capped by the server's own ceiling, and `accept_jobs`
// is not settable by the machine at all — it is the owner's switch, flipped from
// the portal by a person holding `ConnectLocalCompute`. A node that lies here
// gets LESS work. Nothing a worker asserts widens its own permissions, which is
// the property that makes a bearer token on somebody's laptop an acceptable
// credential for this surface.

import type { ComputeNode } from '../providers/local-compute.js';
import { LAB_REPORT_ASK } from './run-reports/self-report.js';

/**
 * The job kinds local execution is allowed at all.
 *
 * A server-side allowlist rather than "whatever the node says", because the queue
 * is shared: `claimNextJob` (the in-process dispatcher) takes the head of the
 * queue with no predicate at all, which is right for a worker that can run
 * anything it is handed and wrong for a laptop. The kinds here are the ones whose
 * contract a machine with no inbound path can actually satisfy — batch work whose
 * result is a report, not a stream someone is watching.
 *
 * ⚠️ `devbox:task` is deliberately absent, and it is the kind almost everything
 * enqueues today. Three separate reasons, any one of which is sufficient: its
 * payload assumes an AgentCore workspace that a laptop does not have; a person
 * may be tailing the box's event stream, and a local claim would leave them
 * waiting on a stream that never arrives; and `job-dispatcher.ts` runs it through
 * `runDevboxTask`, which is hard-wired to `InvokeRuntime`. Local work is enqueued
 * as `local:*` on purpose, so choosing local is an explicit act by whoever queued
 * it rather than a race between two executors polling the same rows.
 */
export const LOCAL_JOB_KINDS = [
  /** A repo task: clone or update the checkout, run the harness, report back. */
  'local:task',
  /** Distillation of the fleet's shared memory (docs/distillation.md). */
  'local:distill',
  /** Consolidation passes over already-distilled memory. */
  'local:consolidate',
] as const;

export type LocalJobKind = typeof LOCAL_JOB_KINDS[number];

/**
 * The most concurrent jobs any single machine may hold, whatever it advertises.
 *
 * Two, because that is what the reference workstation's inference server actually
 * serves: llama-server runs a fixed number of slots (`--parallel 2`, unified KV
 * cache), and a third concurrent request does not fail — it queues behind the
 * other two. That is the expensive failure mode, not a loud one: the queued run
 * still heartbeats, still holds its claim, and quietly blows past the stale window
 * while contributing nothing. Worse, concurrent requests evict each other's prompt
 * prefix, and prefix reuse is measured at ~30× on this setup — so oversubscribing
 * makes every run on the machine slower rather than getting more done.
 *
 * A ceiling, not a target: a node advertising 1 gets 1. Env-tunable for a machine
 * with more slots, and the floor is 1 so a bad value cannot silently park a
 * machine at zero.
 */
export const LOCAL_MAX_CONCURRENCY = Math.max(
  1,
  parseInt(process.env['LOCAL_COMPUTE_MAX_CONCURRENCY'] ?? '2', 10) || 1,
);

/** How often a worker should prove liveness while holding a claim, seconds. */
export const LOCAL_HEARTBEAT_INTERVAL_S = 30;

/**
 * What the server will let this node hold at once.
 *
 * `NaN`, missing and absurd values all land on 1 rather than on the ceiling: an
 * unparseable capability is a machine we know nothing about, and the conservative
 * reading of "unknown" is one job.
 */
export function capConcurrency(reported: unknown): number {
  const n = Math.floor(Number(reported));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, LOCAL_MAX_CONCURRENCY);
}

/**
 * The kinds this node may actually claim: what it advertised, intersected with
 * what local execution is allowed at all.
 *
 * An empty advertisement yields an empty result — NOT the full set. A worker that
 * has registered no capability has none, and defaulting to "everything" would
 * make the intersection decorative: the first thing a half-configured worker did
 * would be to claim work it cannot run.
 *
 * Deduplicated and ordered by the server's own list, so a node cannot influence
 * which kind it is offered first by reordering its advertisement.
 */
export function allowedKinds(advertised: readonly string[]): LocalJobKind[] {
  const asked = new Set(advertised);
  return LOCAL_JOB_KINDS.filter((k) => asked.has(k));
}

/**
 * Which brake stopped the claim.
 *
 * Named rather than left to the HTTP status, because two of these share a status
 * and one shares it with something else entirely: `accept_jobs` and `kinds` are
 * both 409, and `concurrency`'s 429 is the same status the per-IP rate limiter
 * returns. A worker printing one line to a terminal needs to know whether to
 * sleep and retry (`concurrency`), tell its owner to flip a switch
 * (`accept_jobs`), fix its own registration (`kinds`), or stop entirely
 * (`migration`) — and inferring that from a status code cannot be done.
 */
export type ClaimGate = 'migration' | 'accept_jobs' | 'kinds' | 'concurrency';

export type ClaimVerdict =
  | { kind: 'proceed'; kinds: LocalJobKind[]; limit: number }
  | { kind: 'deny'; status: number; gate: ClaimGate; reason: string };

/**
 * Whether this node may claim another job right now.
 *
 * Ordered cheapest-refusal-first, and each refusal says what to DO about it —
 * these are read by a worker process printing one line to a terminal, and "409"
 * on its own sends someone to the logs.
 *
 * `pullSideReady` is the schema probe (`hasPullSideColumns`). It refuses rather
 * than degrading to an unfenced claim: without `claim_token` a late completion
 * from this machine can overwrite a newer attempt's result, and both attempts
 * were run. A cluster missing the migration falls back to push-only, which is
 * exactly how it behaved before local compute existed.
 */
export function decideClaim(input: {
  node: Pick<ComputeNode, 'id' | 'acceptJobs' | 'jobKinds' | 'maxConcurrency'>;
  liveJobs: number;
  pullSideReady: boolean;
}): ClaimVerdict {
  if (!input.pullSideReady) {
    return {
      kind: 'deny', status: 503, gate: 'migration',
      reason: 'this cluster has not applied schema/local_compute_worker_schema.sql, '
        + 'so a claim could not be fenced — apply it and restart the middleware',
    };
  }
  if (!input.node.acceptJobs) {
    return {
      kind: 'deny', status: 409, gate: 'accept_jobs',
      reason: 'this machine is not accepting jobs — turn on "accept jobs" for it under Local compute',
    };
  }
  const kinds = allowedKinds(input.node.jobKinds);
  if (kinds.length === 0) {
    return {
      kind: 'deny', status: 409, gate: 'kinds',
      reason: `this machine has advertised no runnable job kinds — register with one of ${LOCAL_JOB_KINDS.join(', ')}`,
    };
  }
  const limit = capConcurrency(input.node.maxConcurrency);
  if (input.liveJobs >= limit) {
    return {
      kind: 'deny', status: 429, gate: 'concurrency',
      reason: `already holding ${input.liveJobs} of ${limit} job slot(s) — finish or release one first`,
    };
  }
  return { kind: 'proceed', kinds, limit };
}

/**
 * Tell a claimed run that it is not a conversation.
 *
 * WHY THIS EXISTS. A local job's prompt is the work item's title and
 * description and nothing else, and the worker hands it to `claude -p`, which
 * is non-interactive by construction. Given a bare task with an unresolved
 * decision inside it, a model does the sensible conversational thing: it asks.
 * The question goes to a closed stdin, the run ends in a couple of seconds
 * having written nothing, and the job parks in review carrying a request for
 * input that cannot be answered from where it is shown. Observed exactly that
 * on a real run: "the tenant cutover order is still unresolved ... Want me to
 * draft the runbook with the sequencing left as a TODO? Or should I wait?"
 *
 * So the framing states the two things the model cannot otherwise know: that
 * nobody is listening, and what to do with an ambiguity instead of asking.
 * Choosing and declaring an assumption beats stopping — a reviewer can correct
 * an assumption they can read, and can do nothing with a question asked into a
 * closed pipe.
 *
 * APPLIED AT CLAIM, NOT AT ENQUEUE. Six call sites create jobs and only one of
 * them is the local dispatch route; a bot-scheduled job can reach a paired
 * machine too. Claiming is the one chokepoint every locally-run job passes
 * through. It also leaves the stored payload alone, so the job row still shows
 * the task somebody actually asked for rather than this wrapper.
 *
 * `reviewed` moves only where the assumptions are addressed. A run nobody will
 * review still has to finish.
 */
export function frameLocalPrompt(task: string, reviewed: boolean, brief?: FramedBrief | null): string {
  return [
    'You are running non-interactively on a paired workstation. Nothing is reading your output as you write it, and there is nobody to answer a question: anything you ask ends the run without doing the work.',
    '',
    'Do the task. Where something is ambiguous or a decision is unresolved, choose the most reasonable option, say plainly which one you chose and why, and carry on. Never stop to ask.',
    reviewed
      ? 'Someone will read the result afterwards, so put every assumption you made where they will see it.'
      : 'Nobody will review this before it lands, so take the conservative option wherever you have to choose, and state what you assumed at the end.',
    // The run report's three lines (docs/learning-loop-design.md §1). A brief carries them in its
    // "How to report back"; a run with no brief gets them here, so every local run is asked once.
    ...(brief ? ['', ...briefBlock(brief)] : ['', ...LAB_REPORT_ASK]),
    '',
    'The task:',
    '',
    task,
  ].join('\n');
}

/** The frozen session brief, as the framing carries it. */
export interface FramedBrief {
  id: string;
  sha256: string;
  markdown: string;
  /**
   * R8: the skill library the brief points at, and where the worker was told to install it
   * (`dir` null: not on this machine). The worker compares this with what it actually installed
   * and tells the run when they differ, so the run is never told about skills it does not have.
   */
  skill_library?: { sha256: string; dir: string | null; skills: number } | null;
}

export const BRIEF_BEGIN = '----- BEGIN SESSION BRIEF -----';
export const BRIEF_END = '----- END SESSION BRIEF -----';

/**
 * The brief INSIDE the framing, between the instructions and the task: the
 * framing still opens the prompt (nobody is listening) and the task still
 * closes it, verbatim. The markdown between the markers is the frozen brief's
 * bytes exactly — the sha printed above it is the sha a person sees on the
 * run's Brief tab. There is no `lab` command on a workstation, so the report
 * lines the brief asks for go in the final message, where the reviewer reads
 * them.
 */
function briefBlock(b: FramedBrief): string[] {
  return [
    `Below is the session brief for this run (${b.id}, sha256 ${b.sha256}): the project context, the decisions that bind the work, and where the org's skills are. Follow a skill where it fits the task.`,
    'This machine has no `lab` command. Where the brief says to run one, write that line, as written, near the end of your final message instead, before the `lab-report` block.',
    '',
    BRIEF_BEGIN,
    b.markdown.replace(/\n$/, ''),
    BRIEF_END,
  ];
}

/**
 * Claim-time brief for a local job: freeze it (lib/run-brief.ts `freezeBrief`,
 * via freezeJobBrief, which also stamps brief_id + brief_sha on the job) and
 * return what the framing needs. A brief that cannot be assembled degrades to
 * the bare framing rather than refusing the claim.
 */
export async function briefForClaim(
  job: { id: string; title: string; payload: Record<string, unknown>; createdBy: string | null },
  opts: { projectSkills?: boolean } = {},
): Promise<FramedBrief | null> {
  const { freezeJobBrief } = await import('./run-brief.js');
  const { PROJECT_SKILLS_DIR } = await import('./runbooks/library.js');
  const frozen = await freezeJobBrief(job, 'local', { skillsDir: localSkillsDir(job, opts.projectSkills === true) ? PROJECT_SKILLS_DIR : null });
  if (!frozen) return null;
  const lib = frozen.brief.skill_library;
  return {
    id: frozen.brief.id, sha256: frozen.brief.sha256, markdown: frozen.brief.markdown,
    skill_library: lib ? { sha256: lib.sha256, dir: lib.dir, skills: lib.skills.length } : null,
  };
}

/**
 * R8: does this local run get the org's skills installed? Only when the worker said it installs
 * project skills (claim body `projectSkills: true`, tools/local-compute-skills.mjs) AND the job
 * names a repo: the worker installs into the checkout it owns under REPOS_DIR, never into the
 * directory it was started from (which may be the operator's home, where `.claude/skills` IS
 * their personal skills folder).
 */
export function localSkillsDir(job: { payload: Record<string, unknown> }, projectSkills: boolean): boolean {
  const repo = job.payload['repo'];
  return projectSkills && typeof repo === 'string' && repo.trim() !== '';
}

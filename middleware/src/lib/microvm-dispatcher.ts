// The microVM runner, dispatcher half (docs/microvm-runner-design.md §3, §6, §7, §9, §10, §11).
//
// A `runner = 'microvm'` job never touches a fleet box. Each attempt gets one
// fresh AgentCore session on the `orgiq_microvm` runtime, keyed by a derived
// id that carries the actor (lib/microvm-ids.ts), and runs exactly one work
// item across three invokes on that session:
//
//   claim → the ten checks (§10) → reserveSpend → freezeBrief → read token
//   → markRunning → boot → task (events teed to the run log, the meter
//   observes) → write token → push orgiq/<sub8>/<job8> → PR as the actor
//   → StopRuntimeSession → ledger (tokens + compute) → completeJob
//
// Every check failure is `held_back` with a named reason: the claim is undone
// (attempt un-burned), the reason logged once per job and counted
// (`microvm-held-back`). Nothing here falls back to the fleet: no runtime ARN
// means every microvm job waits with `no-microvm-runtime`.
//
// Which process holds which secret (§8): the read and write installation
// tokens ride the boot and push payloads (the box hands them to a git child
// only); the run token and the fleet secret ride boot (the box's lab broker
// holds them); the actor's GitHub user token is read here, at the PR step,
// and never leaves this process. Logs carry ids, shas, counts and reasons —
// never a prompt, a brief, a token or a presigned URL.
//
// Every collaborator is a dependency (`MicrovmDeps`) so the whole path is
// provable with fakes; `defaultMicrovmDeps()` wires the real ones lazily.

import type { AgentJob, ClaimedAgentJob } from '../providers/agent-jobs.js';
import type { JobAttempt } from './job-attempt.js';
import type { DevboxProfile } from './devbox-profile.js';
import { resolveTaskModel } from './devbox-profile.js';
import type { AgentProject } from '../providers/agent-projects.js';
import type { GithubUserGrant } from '../providers/github-user-grants.js';
import type {
  MicrovmSessionInsert, MicrovmSessionPatch, MicrovmSessionRow,
} from '../providers/microvm-sessions.js';
import type { SpendInput } from '../providers/spend-ledger.js';
import type { CredentialIssueInput } from '../providers/credential-issues.js';
import type { RepoPermissions, RepoToken, RepoTokenContext } from './repo-token-provider.js';
import { assertRepoFullName } from './repo-token-provider.js';
import type { ReserveSpendInput, ReserveSpendResult } from './spend-holds.js';
import type { AllocationForecast } from './bot-runner.js';
import type { RunMeter } from './run-meter.js';
import { anySignal } from './run-meter.js';
import type { SessionBrief } from './runbooks/index.js';
import type { LabRunContext } from './run-brief.js';
import type { FleetMetric } from './fleet-metrics.js';
import type { TokenUsage } from './pricing.js';
import {
  parseReportedCost, resultEventError, resultEventSucceeded, settleRunCost, type CostBasis,
} from './run-cost.js';
import { lifetimePolicy } from './devbox-lifetime.js';
import { loadMicrovmParameters, microvmConfig, type MicrovmConfig, type ParameterReader } from './microvm-config.js';
import { microvmBoxId, microvmBranch, microvmSessionId, transcriptKey } from './microvm-ids.js';
import { skillsLoadedByEvent } from './run-reports/use-detection.js';
import { failureCodeOf, outcomeOfJobStatus } from './run-reports/record.js';
import {
  invokeMicrovmJson, invokeMicrovmStream, PRESIGN_EXPIRES_S, type AgentCoreSend, type PresignInput,
} from './microvm-invoke.js';

// ─── Dependencies ─────────────────────────────────────────────────────────────

export interface MicrovmUser { id: string; grants: Record<string, readonly string[] | undefined> }

export interface MicrovmDeps {
  config: () => MicrovmConfig;
  now: () => number;
  /** JOB_STALE_MINUTES (the job reaper's window, which the claim heartbeat races). */
  staleMinutes: number;

  // The queue (providers/agent-jobs.ts).
  claimNext: (opts: { excludeIds: readonly string[]; skipInitiatives: readonly string[] }) => Promise<ClaimedAgentJob | null>;
  unclaim: (id: string, claimToken: string) => Promise<boolean>;
  stampPlacement: (id: string, claimToken: string, boxId: string, sessionId: string) => Promise<boolean>;
  markRunning: (id: string, claimToken: string) => Promise<boolean>;
  completeJob: (id: string, opts: { claimToken: string; status: 'awaiting_review' | 'done' | 'failed'; result?: Record<string, unknown>; error?: string }) => Promise<boolean>;
  /** The run report (lib/run-reports/record.ts recordRunEnd). Optional so a test's deps may leave it out. */
  recordRunEnd?: (input: import('./run-reports/record.js').RunEndInput) => Promise<unknown>;
  getJobFacts: (id: string) => Promise<AgentJob | null>;
  maintainAttempt: (id: string, claimToken: string, staleMs: number) => Promise<JobAttempt>;

  // Who and where (§10 items 2–5).
  getUser: (sub: string) => Promise<MicrovmUser | null>;
  stewardsInitiative: (sub: string, initiativeId: string) => Promise<boolean>;
  /** The initiative's profile, strictly: its own, else `default`; null when neither resolves. Throws on a store error. */
  profileFor: (initiativeId: string) => Promise<DevboxProfile | null>;
  listCodebases: () => Promise<AgentProject[]>;
  /** Whether a token can be minted for the codebase at all: the GitHub App is configured, or it names a connection. */
  repoCredentialAvailable: (project: AgentProject) => Promise<boolean>;
  githubGrant: (sub: string) => Promise<GithubUserGrant | null>;
  readUserToken: (secretArn: string) => Promise<string>;

  // Kill switches and limits (§10 item 6).
  fleetPaused: () => Promise<boolean>;
  saturatedInitiatives: () => Promise<string[]>;
  releaseRunSlots: (holder: string) => Promise<void>;

  // Sessions (providers/microvm-sessions.ts).
  insertSession: (row: MicrovmSessionInsert) => Promise<unknown>;
  updateSession: (sessionId: string, patch: MicrovmSessionPatch) => Promise<void>;
  latestSessionForJob: (jobId: string) => Promise<MicrovmSessionRow | null>;
  /** The head an earlier attempt of this job pushed (the next push's lease), or null. */
  pushedHeadForJob: (jobId: string, beforeAttempt: number) => Promise<string | null>;
  countLiveSessions: (actorSub: string) => Promise<number>;
  listLiveSessions: () => Promise<MicrovmSessionRow[]>;
  computeSecondsP75: (agentProjectId: string, model: string | null) => Promise<number | null>;

  // Money (lib/spend-holds.ts, providers/spend-*.ts).
  reserveSpend: (input: ReserveSpendInput) => Promise<ReserveSpendResult>;
  forecastP75ForModel: (model: string | null, agentProjectId: string | null) => Promise<AllocationForecast>;
  meterForHold: (input: Parameters<typeof import('./spend-holds.js')['meterForHold']>[0]) => Promise<RunMeter | null>;
  releaseHold: (holdId: string | null) => Promise<void>;
  recordSpend: (input: SpendInput) => Promise<void>;
  estimateCost: (model: string, usage: TokenUsage) => number | null;

  // The codebase's run history (agent_project_runs): one row per session, runner 'microvm'.
  startProjectRun: (input: { projectId: string; prompt: string; model: string; sessionId: string; workItemId: string | null }) => Promise<{ id: string }>;
  finishProjectRun: (id: string, outcome: { status: 'done' | 'failed'; error: string | null; costUsd: number | null; costBasis: CostBasis; estimatedCostUsd: number | null }) => Promise<void>;

  // The brief and the credentials.
  /** freezeJobBrief: the frozen brief and its run context (with the run token), or null. */
  freezeBrief: (job: Pick<AgentJob, 'id' | 'title' | 'payload' | 'createdBy'>) => Promise<{ brief: SessionBrief; run: LabRunContext } | null>;
  mintRepoToken: (repo: string, perms: RepoPermissions, ctx: RepoTokenContext) => Promise<RepoToken>;
  recordCredentialIssue: (input: CredentialIssueInput) => Promise<void>;
  presign: (input: PresignInput) => Promise<string>;

  // AgentCore.
  client: () => AgentCoreSend;
  stopSession: (runtimeArn: string, sessionId: string) => Promise<void>;

  // The tail UI (lib/devbox-fleet.ts) and the PR.
  registerBox: (opts: { id: string; sessionId: string; label: string; ownerId: string; projectId?: string; source: string; profile: { id: string; version: number } }) => void;
  appendEvent: (boxId: string, ev: Record<string, unknown>) => void;
  removeBox: (boxId: string) => void;
  openPullRequest: (token: string, input: { owner: string; repo: string; head: string; base: string; title: string; body: string }) => Promise<{ url: string; number: number }>;

  // Observability (§11).
  emitMetric: (type: FleetMetric, fields: Record<string, unknown>) => void;
  emitJob: (kind: string, jobId: string, extra: Record<string, unknown>) => void;
  log: (line: Record<string, unknown>) => void;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** lib/spend-holds.ts HOLD_GRACE_MS, restated so this module loads no provider. */
const HOLD_GRACE_MS = 5 * 60_000;
/** Boot, clone, push and the PR around the task (§7's 15 minutes, less the grace). */
export const BOOT_ALLOWANCE_MS = 10 * 60_000;

/**
 * How long a microVM hold lives (§6): the profile's whole task plus the boot
 * allowance plus the grace, and never less than the fleet's
 * `STALE_MINUTES + grace` default — so a profile near the 3,300 s cap is not
 * left running on an expired hold.
 */
export function microvmHoldExpiresInMs(staleMinutes: number, taskTimeoutS: number): number {
  const floor = staleMinutes * 60_000 + HOLD_GRACE_MS;
  const task = Number.isFinite(taskTimeoutS) && taskTimeoutS > 0 ? taskTimeoutS * 1000 : 0;
  return Math.max(floor, task + BOOT_ALLOWANCE_MS + HOLD_GRACE_MS);
}

/** The timeout a task is actually given: the profile's, capped by the lifetime policy. */
export function effectiveTaskTimeoutS(profileTimeoutS: number): number {
  return Math.min(profileTimeoutS, lifetimePolicy().taskMaxS);
}

/** Whether the task plus BOOT_ALLOWANCE_MS fits the runtime's maxLifetime (MICROVM_MAX_LIFETIME_S). */
export function fitsRuntimeLifetime(profileTimeoutS: number, maxLifetimeS: number): boolean {
  return effectiveTaskTimeoutS(profileTimeoutS) * 1000 + BOOT_ALLOWANCE_MS <= maxLifetimeS * 1000;
}

// ─── The box's workspace root, as the box reports it ──────────────────────────

/**
 * The root each runtime's boot reported (`workspace_root`), keyed by runtime
 * ARN. MICROVM_WORKSPACE_ROOT is only the default before the first boot.
 */
const learnedRoots = new Map<string, string>();

/** An absolute, normalised path the box may name as its root; anything else is ignored. */
function reportedRoot(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 1024 || !v.startsWith('/') || v === '/') return null;
  if (/[\0\r\n]/.test(v) || v.split('/').some((seg) => seg === '..' || seg === '.')) return null;
  return v.replace(/\/+$/, '') || null;
}

export function workspaceRootFor(runtimeArn: string, fallback: string): string {
  return learnedRoots.get(runtimeArn) ?? fallback;
}

/** Tests: forget what boots reported. */
export function _resetLearnedWorkspaceRoots(): void { learnedRoots.clear(); }
const TRANSCRIPT_MAX_ENTRIES = 200;
const DETAIL_MAX = 600;
const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;
const iso = (ms: number): string => new Date(ms).toISOString();

/** The reasons a job is held back, in §10's order (plus the config gates first). */
export type HeldBackReason =
  | 'no-microvm-runtime' | 'no-microvm-runs-bucket' | 'no-lab-callback-secret'
  | 'not-microvm-task' | 'payload-resume' | 'payload-box' | 'bot-owned-job'
  | 'no-actor' | 'actor-unknown' | 'actor-not-in-tenant' | 'no-initiative' | 'actor-not-on-initiative'
  | 'no-profile' | 'profile-not-egress-allowlist' | 'model-not-allowed' | 'profile-exceeds-runtime-lifetime'
  | 'no-codebase' | 'ambiguous-codebase' | 'bad-repo' | 'no-repo-credential'
  | 'no-github-identity'
  | 'fleet-paused' | 'initiative-saturated'
  | 'resume-not-found' | 'resume-cross-actor' | 'resume-other-project' | 'resume-not-finished' | 'resume-expired' | 'resume-no-session'
  | 'actor-session-limit'
  | 'session-id'
  | 'brief-unfrozen' | 'no-library-sha'
  | 'repo-token-unavailable';

const RESUMABLE = new Set(['failed', 'awaiting_review', 'cancelled']);

interface Plan {
  actorSub: string;
  initiativeId: string;
  profile: DevboxProfile;
  model: string;
  project: AgentProject;
  grant: GithubUserGrant;
  resume: { original: AgentJob; session: MicrovmSessionRow } | null;
  runtimeArn: string;
  runsBucket: string;
  callbackSecret: string;
}

type Verdict = { ok: true; plan: Plan } | { ok: false; reason: HeldBackReason };

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

// ─── §10: what is checked before a job is placed ──────────────────────────────

/**
 * The checks that need no money and no side effect: config, then §10 items
 * 1–6, then 9 (resume) and 10 (concurrency). Item 9 runs before item 7
 * (reserveSpend) on purpose — a cross-actor resume must be refused before any
 * money is held for it (§15) — and item 10 before 7 so a refusal holds nothing.
 * Items 7 and 8 follow in runAttempt.
 */
export async function judgeMicrovmJob(job: AgentJob, deps: MicrovmDeps, ctx: { saturated: readonly string[] }): Promise<Verdict> {
  const cfg = deps.config();
  if (!cfg.runtimeArn) return { ok: false, reason: 'no-microvm-runtime' };
  if (!cfg.runsBucket) return { ok: false, reason: 'no-microvm-runs-bucket' };
  if (!cfg.callbackSecret) return { ok: false, reason: 'no-lab-callback-secret' };

  // 1. A devbox task on this runner, with nothing the runner refuses.
  if (job.runner !== 'microvm' || job.kind !== 'devbox:task') return { ok: false, reason: 'not-microvm-task' };
  if ('resume' in job.payload) return { ok: false, reason: 'payload-resume' };
  if ('boxId' in job.payload) return { ok: false, reason: 'payload-box' };
  // A bot run holds its own money and has no person behind it to act as.
  if (job.botId) return { ok: false, reason: 'bot-owned-job' };

  // 2. The actor: set from the session at enqueue, a real user in this
  // tenant, on the initiative.
  const actorSub = str(job.actorSub);
  if (!actorSub) return { ok: false, reason: 'no-actor' };
  const user = await deps.getUser(actorSub);
  if (!user) return { ok: false, reason: 'actor-unknown' };
  if (!(user.grants[cfg.tenant]?.length)) return { ok: false, reason: 'actor-not-in-tenant' };
  const initiativeId = str(job.payload['initiativeId']);
  if (!initiativeId) return { ok: false, reason: 'no-initiative' };
  if (!await deps.stewardsInitiative(actorSub, initiativeId)) return { ok: false, reason: 'actor-not-on-initiative' };

  // 3. The profile resolves, is the allowlist class, and names the model.
  const profile = await deps.profileFor(initiativeId);
  if (!profile) return { ok: false, reason: 'no-profile' };
  if (profile.network_class !== 'egress-allowlist') return { ok: false, reason: 'profile-not-egress-allowlist' };
  const model = resolveTaskModel(profile, job.payload['model']);
  if (!model.ok) return { ok: false, reason: 'model-not-allowed' };
  // The task (as it will run) plus boot, clone, push and the PR must fit the
  // deployed runtime's maxLifetime, or AgentCore ends the session mid-run.
  if (!fitsRuntimeLifetime(profile.task_timeout_s, cfg.maxLifetimeS)) return { ok: false, reason: 'profile-exceeds-runtime-lifetime' };

  // 4. The codebase: one agent project serves the initiative (or the payload's repo picks one).
  const wanted = str(job.payload['repo']);
  const codebases = (await deps.listCodebases()).filter((p) => p.orgProjectId === initiativeId && (!wanted || p.repoFullName === wanted));
  if (codebases.length === 0) return { ok: false, reason: 'no-codebase' };
  if (codebases.length > 1) return { ok: false, reason: 'ambiguous-codebase' };
  const project = codebases[0]!;
  try { assertRepoFullName(project.repoFullName); } catch { return { ok: false, reason: 'bad-repo' }; }
  if (!await deps.repoCredentialAvailable(project)) return { ok: false, reason: 'no-repo-credential' };

  // 5. The actor's GitHub identity: the PR is theirs, so no grant, no run.
  const grant = await deps.githubGrant(actorSub);
  if (!grant) return { ok: false, reason: 'no-github-identity' };

  // 6. Kill switches and run limits.
  if (await deps.fleetPaused().catch(() => true)) return { ok: false, reason: 'fleet-paused' };
  if (ctx.saturated.includes(initiativeId)) return { ok: false, reason: 'initiative-saturated' };

  // 9. Resume (§9): same actor, same project, finished recently, with a branch and a transcript.
  let resume: Plan['resume'] = null;
  if (job.resumeOfJobId) {
    const original = await deps.getJobFacts(job.resumeOfJobId);
    if (!original) return { ok: false, reason: 'resume-not-found' };
    if (!original.actorSub || original.actorSub !== actorSub) return { ok: false, reason: 'resume-cross-actor' };
    const session = await deps.latestSessionForJob(original.id);
    if (!session || session.agent_project_id !== project.id) return { ok: false, reason: session ? 'resume-other-project' : 'resume-no-session' };
    if (!RESUMABLE.has(original.status)) return { ok: false, reason: 'resume-not-finished' };
    const finished = Date.parse(original.finishedAt ?? '');
    if (!Number.isFinite(finished) || deps.now() - finished > cfg.resumeWindowH * 3_600_000) return { ok: false, reason: 'resume-expired' };
    if (!session.branch || !session.transcript_s3_key || !session.claude_session_id) return { ok: false, reason: 'resume-no-session' };
    resume = { original, session };
  }

  // 10. Concurrency: the actor's live sessions (the global run limits are reserveSpend's).
  if (await deps.countLiveSessions(actorSub) >= cfg.maxSessionsPerActor) return { ok: false, reason: 'actor-session-limit' };

  return {
    ok: true,
    plan: {
      actorSub, initiativeId, profile, model: model.model, project, grant, resume,
      runtimeArn: cfg.runtimeArn, runsBucket: cfg.runsBucket, callbackSecret: cfg.callbackSecret,
    },
  };
}

// ─── The pass ─────────────────────────────────────────────────────────────────

/**
 * The last reason logged per job, so a job parked behind a check is said once
 * per reason. Bounded (sweep 4 Low 9): an entry goes when its job starts or
 * completes, and the oldest goes past HELD_BACK_MEMORY_MAX (a job the fleet
 * finished or someone deleted is never seen here again). Forgetting costs one
 * repeated log line, never a decision.
 */
const heldBackSaid = new Map<string, string>();
export const HELD_BACK_MEMORY_MAX = 1000;
let passing = false;

/** Tests: how many held-back jobs are remembered. */
export function _heldBackMemorySize(): number { return heldBackSaid.size; }

async function holdBack(job: ClaimedAgentJob, reason: string, deps: MicrovmDeps, metricReason: string = reason): Promise<void> {
  await deps.unclaim(job.id, job.claimToken).catch(() => false);
  if (heldBackSaid.get(job.id) !== reason) {
    heldBackSaid.delete(job.id); // re-insert at the young end
    heldBackSaid.set(job.id, reason);
    while (heldBackSaid.size > HELD_BACK_MEMORY_MAX) heldBackSaid.delete(heldBackSaid.keys().next().value!);
    deps.log({ event: 'held_back', jobId: job.id, attempt: job.attempts, reason });
    deps.emitMetric('microvm-held-back', { reason: metricReason, jobId: job.id });
  }
  deps.emitJob('held_back', job.id, { reason, runner: 'microvm' });
}

/**
 * One dispatch pass: claim up to `batch` microvm jobs, judge each, run the
 * ones that pass (fire and forget, like the fleet), hand the rest back. A job
 * judged this pass is not claimed again until the next one.
 */
export async function microvmDispatchPass(deps: MicrovmDeps): Promise<{ claimed: number; started: number; heldBack: number }> {
  if (passing) return { claimed: 0, started: 0, heldBack: 0 };
  passing = true;
  const seen: string[] = [];
  let started = 0;
  let held = 0;
  try {
    const cfg = deps.config();
    const saturated = await deps.saturatedInitiatives().catch(() => [] as string[]);
    for (let i = 0; i < cfg.batch; i++) {
      const job = await deps.claimNext({ excludeIds: seen, skipInitiatives: [] });
      if (!job) break;
      seen.push(job.id);
      deps.emitJob('claimed', job.id, { runner: 'microvm' });
      let verdict: Verdict;
      try {
        verdict = await judgeMicrovmJob(job, deps, { saturated });
      } catch (err) {
        // A check that cannot be answered is a no, never a pass.
        deps.log({ event: 'check_failed', jobId: job.id, error: (err as Error).message });
        await holdBack(job, 'check-unavailable', deps);
        held++;
        continue;
      }
      if (!verdict.ok) { await holdBack(job, verdict.reason, deps); held++; continue; }
      started++;
      void runMicrovmAttempt(job, verdict.plan, deps)
        .catch((err) => deps.log({ event: 'attempt_crashed', jobId: job.id, error: (err as Error).message }));
    }
  } finally {
    passing = false;
  }
  return { claimed: seen.length, started, heldBack: held };
}

// ─── One attempt (§3) ─────────────────────────────────────────────────────────

interface ActivityEntry { t: 'text' | 'tool' | 'error'; name?: string; detail: string; ts: string }

function clip(v: unknown): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v ?? '');
  return s.length > DETAIL_MAX ? `${s.slice(0, DETAIL_MAX)}…` : s;
}

function usageOf(v: unknown): TokenUsage | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const u = v as Record<string, unknown>;
  const n = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null);
  const input = n(u['inputTokens']); const output = n(u['outputTokens']);
  if (input === null || output === null) return null;
  return { inputTokens: input, outputTokens: output, cacheWriteTokens: n(u['cacheWriteTokens']) ?? 0, cacheReadTokens: n(u['cacheReadTokens']) ?? 0 };
}

/**
 * Token cost from `devbox_end` (§6): the reported figure, else `usage` priced
 * through the table, else unknown. No `devbox_end` at all is unknown, never 0.
 */
export function tokenCostFromEnd(end: Record<string, unknown> | null, model: string, estimate: MicrovmDeps['estimateCost']): {
  costUsd: number | null; costBasis: CostBasis; estimatedCostUsd: number | null; usage: TokenUsage | null;
} {
  if (!end) return { costUsd: null, costBasis: 'unknown', estimatedCostUsd: null, usage: null };
  const usage = usageOf(end['usage']);
  const estimated = usage ? estimate(model, usage) : null;
  const settled = settleRunCost(parseReportedCost({ total_cost_usd: end['reported_cost_usd'] }), estimated);
  return { ...settled, usage };
}

/** compute_seconds = stopped − booted, at least one second once a session was invoked. */
export function computeSeconds(bootedAtMs: number, stoppedAtMs: number): number {
  return Math.max(1, Math.ceil((stoppedAtMs - bootedAtMs) / 1000));
}

export async function runMicrovmAttempt(job: ClaimedAgentJob, plan: Plan, deps: MicrovmDeps): Promise<void> {
  const cfg = deps.config();
  const attemptN = job.attempts;
  const sourceId = `${job.id}:${attemptN}`;
  const repo = plan.project.repoFullName;
  const expiresInMs = microvmHoldExpiresInMs(deps.staleMinutes, plan.profile.task_timeout_s);

  let sessionId: string;
  try {
    sessionId = microvmSessionId({ tenant: cfg.tenant, actorSub: plan.actorSub, agentProjectId: plan.project.id, jobId: job.id, attempt: attemptN });
  } catch {
    await holdBack(job, 'session-id', deps);
    return;
  }
  const boxId = microvmBoxId(sessionId);
  const base = { jobId: job.id, attempt: attemptN, sessionId, actorSub: plan.actorSub, tenant: cfg.tenant, initiativeId: plan.initiativeId, repo };
  const say = (event: string, fields: Record<string, unknown> = {}): void => deps.log({ event, ...base, ...fields });

  // 7. The hold: p75 tokens for the model plus the compute term (§6).
  const tokenForecast = await deps.forecastP75ForModel(plan.model, plan.project.id);
  const p75Seconds = (await deps.computeSecondsP75(plan.project.id, plan.model).catch(() => null)) ?? plan.profile.task_timeout_s;
  const computeForecast = round4(cfg.computeUsdPerSecond * p75Seconds);
  const forecast: AllocationForecast = {
    ...tokenForecast,
    costUsdP75: round4(tokenForecast.costUsdP75 + computeForecast),
    ...(tokenForecast.costUsdP25 !== undefined ? { costUsdP25: round4(tokenForecast.costUsdP25 + computeForecast) } : {}),
  };
  const held = await deps.reserveSpend({
    initiativeId: plan.initiativeId, actorId: plan.actorSub, source: 'microvm', sourceId, forecast, expiresInMs,
  });
  if (held.kind !== 'held') { await holdBack(job, held.reason, deps, `spend-${held.kind}`); return; }
  const holdId = held.holdId;
  heldBackSaid.delete(job.id);
  let released = false;
  const release = async (): Promise<void> => { if (!released) { released = true; await deps.releaseHold(holdId).catch(() => undefined); } };

  // 8. The frozen brief, with the library sha the box will check (§10 item 8):
  // a microVM run never starts without one. A resume reads the original's.
  const frozen = await deps.freezeBrief(plan.resume ? { ...job, id: plan.resume.original.id } : job).catch(() => null);
  if (!frozen) { await release(); await holdBack(job, 'brief-unfrozen', deps); return; }
  const librarySha = frozen.brief.skill_library?.sha256 ?? '';
  if (!/^[0-9a-f]{64}$/.test(librarySha)) { await release(); await holdBack(job, 'no-library-sha', deps); return; }

  if (!await deps.stampPlacement(job.id, job.claimToken, boxId, sessionId)) { await release(); return; }

  const branch = plan.resume?.session.branch ?? microvmBranch(cfg.tenant, plan.actorSub, job.id);
  const ref = plan.resume?.session.branch ?? plan.project.defaultBranch;
  const author = { name: plan.grant.github_login, email: plan.grant.noreply_email };
  const putKey = transcriptKey(job.id, attemptN);

  // The claim's heartbeat (it renews a claimed job as well as a running one).
  // If ownership cannot be proven nothing has run and nothing was minted: give
  // the money back and leave the job to the stale sweep (as the fleet does).
  let attempt: JobAttempt;
  try {
    attempt = await deps.maintainAttempt(job.id, job.claimToken, deps.staleMinutes * 60_000);
  } catch (err) {
    say('attempt_unproven', { error: (err as Error).message });
    await release();
    return;
  }
  const guard = attempt;

  // The read token: contents:read, one repository, audited with the session.
  // Minted only once the claim is proven (sweep 4 Low 8), and while the job is
  // still `claimed`, so a refusal can still hand the attempt back.
  let readToken: RepoToken;
  try {
    readToken = await deps.mintRepoToken(repo, { contents: 'read' }, {
      runRef: job.id, callerSub: plan.actorSub, connectionName: plan.project.connectionName, sessionId,
    });
  } catch (err) {
    say('read_token_failed', { error: (err as Error).message });
    attempt.stop();
    await release();
    await holdBack(job, 'repo-token-unavailable', deps);
    return;
  }
  // The run token the broker will hold.
  await deps.recordCredentialIssue({
    runRef: job.id, repo, provider: 'lab', permissions: { lab: 'run' }, expiresAt: null,
    callerSub: plan.actorSub, sessionId, kind: 'run-token',
  }).catch(() => undefined);

  if (!await deps.markRunning(job.id, job.claimToken)) { attempt.stop(); await release(); return; }
  let invoked = false;
  let bootedAtMs = 0;
  let end: Record<string, unknown> | null = null;
  let resultEv: Record<string, unknown> | null = null;
  let refusal: string | null = null;
  let cutoff: RunMeter['cutoff'] = null;
  let error: string | null = null;
  let headSha: string | null = null;
  let baseSha: string | null = null;
  let prUrl: string | null = null;
  let pushed = false;
  let toolCalls = 0;
  let turns = 0;
  let summary = '';
  const skillsLoaded: string[] = [];
  const transcript: ActivityEntry[] = [];
  const record = (e: ActivityEntry): void => { if (transcript.length < TRANSCRIPT_MAX_ENTRIES) transcript.push(e); };
  let slotHolder: string | null = holdId;
  let projectRunId: string | null = null;

  try {
    await deps.insertSession({
      session_id: sessionId, job_id: job.id, attempt: attemptN, actor_sub: plan.actorSub, tenant: cfg.tenant,
      agent_project_id: plan.project.id, initiative_id: plan.initiativeId, runtime_arn: plan.runtimeArn,
      profile_id: plan.profile.id, profile_version: plan.profile.version, network_class: plan.profile.network_class,
      hold_id: holdId, brief_sha: frozen.brief.sha256, library_sha: librarySha, branch, task_timeout_s: plan.profile.task_timeout_s,
    });
    deps.registerBox({
      id: boxId, sessionId, label: `microvm ${job.id.replace(/^job-/, '').slice(0, 8)}`, ownerId: plan.actorSub,
      projectId: plan.initiativeId, source: 'microvm', profile: { id: plan.profile.id, version: plan.profile.version },
    });
    deps.emitJob('running', job.id, { boxId, runner: 'microvm' });
    deps.appendEvent(boxId, { type: 'job_started', jobId: job.id, title: job.title, kind: job.kind, ts: iso(deps.now()) });
    deps.appendEvent(boxId, { type: 'brief_frozen', jobId: job.id, brief_id: frozen.brief.id, brief_sha: frozen.brief.sha256, ts: iso(deps.now()) });
    say('step', { step: 'boot', phase: 'start', model: plan.model, profileId: plan.profile.id, profileVersion: plan.profile.version, briefSha: frozen.brief.sha256, librarySha, branch });

    // The codebase's run history: one agent_project_runs row per session,
    // runner 'microvm'. Best effort — a run is never refused for its history.
    try {
      projectRunId = (await deps.startProjectRun({
        projectId: plan.project.id, prompt: String(job.payload['prompt'] ?? ''), model: plan.model, sessionId,
        workItemId: str(job.payload['workItemId']),
      })).id;
    } catch (err) {
      say('project_run_unrecorded', { error: (err as Error).message });
    }

    // ── boot ──
    const client = deps.client();
    invoked = true;
    bootedAtMs = deps.now();
    await deps.updateSession(sessionId, { status: 'booting', booted_at: iso(bootedAtMs) });
    const bootOnce = (root: string): Promise<Record<string, unknown>> => guard.run(() => invokeMicrovmJson(client, plan.runtimeArn, sessionId, {
      op: 'boot', runner: 'microvm',
      repo: { full_name: repo, clone_url: `https://github.com/${repo}.git` },
      ref, target: `${root}/repo`, token: readToken.token,
      run_ref: frozen.run.run_ref, run_token: frozen.run.run_token, callback_secret: plan.callbackSecret,
      library_sha: librarySha, brief_ref: frozen.brief.id, lab_api_base: cfg.labApiBase, author,
    }, guard.signal));
    let root = workspaceRootFor(plan.runtimeArn, cfg.workspaceRoot);
    let boot = await bootOnce(root);
    guard.assertLive();
    // A box whose root is not the one we guessed refuses the target before it
    // deletes anything and says its real root: learn it, and boot again once
    // on the same session with a target under it.
    const told = reportedRoot(boot['workspace_root']);
    if (boot['ok'] !== true && boot['error'] === 'bad-target' && told && told !== root) {
      learnedRoots.set(plan.runtimeArn, told);
      say('step', { step: 'boot', phase: 'retry', reason: 'bad-target', workspaceRoot: told });
      root = told;
      boot = await bootOnce(root);
      guard.assertLive();
    }
    const bootSeconds = Math.round((deps.now() - bootedAtMs) / 100) / 10;
    if (boot['ok'] !== true) {
      error = `boot failed: ${String(boot['error'] ?? 'unknown')}`;
      say('step', { step: 'boot', phase: 'end', ok: false, reason: String(boot['error'] ?? 'unknown'), seconds: bootSeconds });
      await deps.updateSession(sessionId, { status: 'failed' });
      throw new StepFailed(error);
    }
    baseSha = typeof boot['head_sha'] === 'string' ? boot['head_sha'] : null;
    const bootRoot = reportedRoot(boot['workspace_root']);
    if (bootRoot) learnedRoots.set(plan.runtimeArn, bootRoot);
    deps.emitMetric('microvm-boot-seconds', { seconds: bootSeconds, jobId: job.id, sessionId });
    say('step', { step: 'boot', phase: 'end', ok: true, seconds: bootSeconds, baseSha });
    await deps.updateSession(sessionId, { status: 'ready', base_sha: baseSha });

    // ── the transcript URLs, one credential row each ──
    const putUrl = await deps.presign({ bucket: plan.runsBucket, key: putKey, method: 'PUT', region: cfg.region, expiresIn: PRESIGN_EXPIRES_S });
    await deps.recordCredentialIssue({
      runRef: job.id, repo, provider: 's3', permissions: { s3: 'put' }, expiresAt: iso(deps.now() + PRESIGN_EXPIRES_S * 1000),
      callerSub: plan.actorSub, sessionId, kind: 'presign',
    }).catch(() => undefined);
    let getUrl: string | null = null;
    if (plan.resume) {
      getUrl = await deps.presign({ bucket: plan.runsBucket, key: plan.resume.session.transcript_s3_key!, method: 'GET', region: cfg.region, expiresIn: PRESIGN_EXPIRES_S });
      await deps.recordCredentialIssue({
        runRef: job.id, repo, provider: 's3', permissions: { s3: 'get' }, expiresAt: iso(deps.now() + PRESIGN_EXPIRES_S * 1000),
        callerSub: plan.actorSub, sessionId, kind: 'presign',
      }).catch(() => undefined);
    }

    // ── task ──
    const prompt = String(job.payload['prompt'] ?? '').trim();
    if (!prompt) throw new StepFailed('payload.prompt is required for devbox:task');
    const meter = await deps.meterForHold({
      holdId, ...(held.amountUsd !== undefined ? { amountUsd: held.amountUsd } : {}), initiativeId: plan.initiativeId,
      actorId: plan.actorSub, source: 'microvm', sourceId, model: plan.model, agentProjectId: plan.project.id, expiresInMs,
    }).catch(() => null);
    if (!slotHolder && meter) slotHolder = meter.holdIds[0] ?? null;
    const budget = meter?.boxBudget(job.id) ?? null;
    const timeoutS = effectiveTaskTimeoutS(plan.profile.task_timeout_s);
    await deps.updateSession(sessionId, { status: 'running', started_at: iso(deps.now()) });
    say('step', { step: 'task', phase: 'start', timeoutS, resumeOf: plan.resume?.original.id ?? null });
    const signal = anySignal([guard.signal, meter?.signal]);
    try {
      const stream = invokeMicrovmStream(client, plan.runtimeArn, sessionId, {
        op: 'task', runner: 'microvm', prompt, model: plan.model,
        ...(budget ? { budget: { max_fresh_tokens: budget.max_fresh_tokens } } : {}),
        timeout_s: timeoutS, transcript_put_url: putUrl,
        resume_session_id: plan.resume?.session.claude_session_id ?? null,
        resume_transcript_get_url: getUrl,
        author,
      }, signal);
      for await (const ev of stream) {
        guard.assertLive();
        deps.appendEvent(boxId, ev);
        meter?.observe(ev);
        const type = ev['type'];
        const ts = iso(deps.now());
        if (ev['agent'] === 'devbox' && typeof ev['error'] === 'string') {
          refusal = ev['error'];
          record({ t: 'error', detail: clip(refusal), ts });
        } else if (type === 'assistant') {
          for (const name of skillsLoadedByEvent(ev)) if (!skillsLoaded.includes(name) && skillsLoaded.length < 50) skillsLoaded.push(name);
          const content = ((ev['message'] as { content?: unknown[] })?.content ?? []) as Record<string, unknown>[];
          for (const block of content) {
            if (block['type'] === 'tool_use') {
              toolCalls += 1;
              const input = block['input'] as Record<string, unknown> | undefined;
              const target = input?.['command'] ?? input?.['file_path'] ?? input?.['path'] ?? input?.['pattern'] ?? input;
              record({ t: 'tool', name: String(block['name'] ?? 'tool'), detail: clip(target), ts });
            } else if (block['type'] === 'text') {
              const text = String(block['text'] ?? '').trim();
              if (text) record({ t: 'text', detail: clip(text), ts });
            }
          }
        } else if (type === 'result') {
          resultEv = ev;
          turns = Number(ev['num_turns'] ?? 0);
          if (typeof ev['result'] === 'string') summary = ev['result'];
        } else if (type === 'devbox_end') {
          end = ev;
        }
        if (meter?.cutoff) break;
      }
    } catch (err) {
      if (!meter?.cutoff) throw err;
    }
    if (meter) await meter.settled();
    cutoff = meter?.cutoff ?? null;
    const endEv = end as Record<string, unknown> | null;
    if (!cutoff && endEv?.['killed_reason'] === 'budget') {
      cutoff = { reason: 'budget', ceilingUsd: meter?.ceilingUsd ?? 0, meteredUsd: meter?.meteredUsd ?? 0, holdIds: meter?.holdIds ?? [], at: iso(deps.now()) };
    }
    if (cutoff) {
      deps.emitMetric('microvm-run-cutoff', { jobId: job.id, sessionId, ceilingUsd: cutoff.ceilingUsd, meteredUsd: cutoff.meteredUsd });
      deps.appendEvent(boxId, { type: 'run_cutoff', ...cutoff, ts: iso(deps.now()) });
    }
    headSha = typeof endEv?.['head_sha'] === 'string' ? endEv['head_sha'] as string : null;
    const exitCode = typeof endEv?.['exit_code'] === 'number' ? endEv['exit_code'] as number : null;
    const resultOk = resultEv ? resultEventSucceeded(resultEv) : false;
    const taskOk = !refusal && !cutoff && !!endEv && exitCode === 0 && resultOk;
    if (!taskOk) {
      error = refusal ? `task refused: ${refusal}`
        : cutoff ? 'stopped at its spend ceiling'
          : !endEv ? 'the task ended without devbox_end'
            : exitCode !== 0 ? `devbox exited ${exitCode}`
              : (resultEv ? resultEventError(resultEv) : undefined) ?? 'the task reported no result';
      if (error) record({ t: 'error', detail: clip(error), ts: iso(deps.now()) });
    }
    const claudeSession = typeof endEv?.['claude_session_id'] === 'string' ? endEv['claude_session_id'] as string : null;
    await deps.updateSession(sessionId, {
      // head_sha is the PUSHED head (the next attempt's lease): written after the push, not here.
      ended_at: iso(deps.now()), exit_code: exitCode, claude_session_id: claudeSession,
      fresh_tokens: typeof endEv?.['fresh_tokens'] === 'number' ? endEv['fresh_tokens'] as number : null,
      ...(endEv?.['transcript_uploaded'] === true ? { transcript_s3_key: putKey } : {}),
    });
    say('step', {
      step: 'task', phase: 'end', ok: taskOk, exitCode, headSha, freshTokens: endEv?.['fresh_tokens'] ?? null,
      cutoff: !!cutoff, refused: refusal, transcriptUploaded: endEv?.['transcript_uploaded'] === true, toolCalls,
    });

    // ── push: the branch, whenever the run left a commit and was not cut (§9
    // resumes from it even when the run failed) ──
    if (!cutoff && !refusal && endEv && headSha && headSha !== baseSha) {
      await deps.updateSession(sessionId, { status: 'pushing' });
      const writeToken = await deps.mintRepoToken(repo, { contents: 'write', pull_requests: 'write' }, {
        runRef: job.id, callerSub: plan.actorSub, connectionName: plan.project.connectionName, sessionId,
      });
      // The lease. A resume cloned the branch itself, so the boot head is where
      // it is; otherwise the head an earlier attempt of this job pushed, else
      // null (the branch must not exist yet).
      const expectedHead = plan.resume ? baseSha : await deps.pushedHeadForJob(job.id, attemptN);
      say('step', { step: 'push', phase: 'start', branch, expectedHead });
      const push = await guard.run(() => invokeMicrovmJson(client, plan.runtimeArn, sessionId, {
        op: 'push', runner: 'microvm', branch, token: writeToken.token, author, expected_head: expectedHead,
      }, guard.signal));
      guard.assertLive();
      if (push['ok'] !== true) {
        say('step', { step: 'push', phase: 'end', ok: false, reason: String(push['error'] ?? 'unknown') });
        throw new StepFailed(`push failed: ${String(push['error'] ?? 'unknown')}`);
      }
      pushed = push['pushed'] === true;
      if (typeof push['head_sha'] === 'string') headSha = push['head_sha'];
      if (pushed && headSha) await deps.updateSession(sessionId, { head_sha: headSha });
      say('step', { step: 'push', phase: 'end', ok: true, headSha });
    }

    // ── the PR, as the actor (BFF only) ──
    if (taskOk && pushed) {
      await deps.updateSession(sessionId, { status: 'reporting' });
      const userToken = await deps.readUserToken(plan.grant.secret_arn);
      await deps.recordCredentialIssue({
        runRef: job.id, repo, provider: 'github-user', permissions: { pull_requests: 'write' }, expiresAt: null,
        callerSub: plan.actorSub, sessionId, kind: 'repo-user',
      }).catch(() => undefined);
      const [owner, name] = repo.split('/') as [string, string];
      const pr = await deps.openPullRequest(userToken, {
        owner, repo: name, head: branch, base: plan.project.defaultBranch, title: job.title,
        body: `Opened by OrgIQ for @${plan.grant.github_login}.\n\nRun \`${job.id}\` attempt ${attemptN}, session \`${sessionId}\`.`,
      });
      prUrl = pr.url || null;
      await deps.updateSession(sessionId, { pr_url: prUrl });
      deps.emitMetric('microvm-pr-opened', { jobId: job.id, sessionId, repo });
      say('step', { step: 'pr', phase: 'end', ok: true, prUrl });
    }
  } catch (err) {
    if (!error) error = (err as Error).message || 'microVM run failed';
    say('failed', { error });
  } finally {
    // A lost claim (the stale sweep took it back) still stops and still pays;
    // it only must not write the job's outcome over a newer attempt's.
    const lost = attempt.signal.aborted;
    // ── stop: the session, always, once it was invoked (§7) ──
    let stopReason = cutoff ? 'cutoff' : error ? 'failed' : 'completed';
    if (lost) stopReason = 'attempt-lost';
    let stopped = false;
    const stoppedAtMs = deps.now();
    if (invoked) {
      try {
        await deps.stopSession(plan.runtimeArn, sessionId);
        stopped = true;
      } catch (err) {
        stopped = (err as { name?: string }).name === 'ResourceNotFoundException';
        if (!stopped) say('stop_failed', { error: (err as Error).message });
      }
    }
    deps.removeBox(boxId);

    // ── settlement (§6): token cost from devbox_end, plus compute ──
    const cost = tokenCostFromEnd(end, plan.model, deps.estimateCost);
    if (cost.costBasis === 'unknown' && cutoff && cutoff.meteredUsd > 0 && !end) {
      cost.costUsd = cutoff.meteredUsd; cost.costBasis = 'estimated'; cost.estimatedCostUsd = cutoff.meteredUsd;
    }
    const seconds = invoked ? computeSeconds(bootedAtMs, stoppedAtMs) : null;
    const computeUsd = seconds !== null ? round4(seconds * cfg.computeUsdPerSecond) : null;
    // cost_usd is the run's whole price — tokens plus compute — when the
    // token cost is known; unknown tokens keep the entry unknown, never 0.
    const totalUsd = cost.costUsd !== null ? round4(cost.costUsd + (computeUsd ?? 0)) : null;
    const estimatedUsd = cost.estimatedCostUsd !== null ? round4(cost.estimatedCostUsd + (computeUsd ?? 0)) : null;
    await deps.updateSession(sessionId, {
      ...(stopped || !invoked ? { status: error ? 'failed' as const : 'stopped' as const, stopped_at: iso(stoppedAtMs), stop_reason: stopReason } : {}),
      cost_usd: totalUsd, cost_basis: cost.costBasis, compute_seconds: seconds, compute_usd: computeUsd,
    }).catch(() => undefined);
    say('stopped', { stopReason, stopped, computeSeconds: seconds, computeUsd, costUsd: totalUsd, costBasis: cost.costBasis, branch, prUrl });
    if (invoked) {
      await deps.recordSpend({
        source: 'microvm', sourceId, initiativeId: plan.initiativeId, boxId, actorId: plan.actorSub,
        model: plan.model, costUsd: totalUsd, costBasis: cost.costBasis, estimatedCostUsd: estimatedUsd,
        inputTokens: cost.usage?.inputTokens ?? null, outputTokens: cost.usage?.outputTokens ?? null, provider: 'bedrock',
        computeSeconds: seconds, computeUsd, sessionId,
      }).catch(() => undefined);
    } else {
      await release();
    }
    // The run history: token cost only, because forecastP75ForModel reads
    // these rows and the hold adds the compute term itself.
    if (projectRunId) {
      await deps.finishProjectRun(projectRunId, {
        status: error ? 'failed' : 'done', error, costUsd: cost.costUsd, costBasis: cost.costBasis, estimatedCostUsd: cost.estimatedCostUsd,
      }).catch((err) => say('project_run_unfinished', { error: (err as Error).message }));
    }

    // ── the job ──
    if (!lost) {
      const status = error ? 'failed' : job.payload['requiresReview'] !== false ? 'awaiting_review' : 'done';
      const committed = await deps.completeJob(job.id, {
        claimToken: job.claimToken, status,
        ...(error ? { error } : {}),
        result: {
          runner: 'microvm', summary, turns, toolCalls, transcript, sessionId, branch: pushed ? branch : null, headSha, prUrl,
          costUsd: totalUsd, costBasis: cost.costBasis, estimatedCostUsd: estimatedUsd, computeSeconds: seconds, computeUsd,
          ...(cutoff ? { cutoff } : {}),
        },
      }).catch(() => false);
      heldBackSaid.delete(job.id);
      if (committed) {
        await deps.recordRunEnd?.({
          runRef: job.id, executor: 'microvm', outcome: outcomeOfJobStatus(status),
          failureCode: error ? (cutoff ? 'budget' : failureCodeOf(error)) : null,
          model: plan.model, billedUsd: totalUsd,
          worker: invoked ? { block: summary, skillsLoaded } : null,
        }).catch(() => undefined);
        deps.appendEvent(boxId, { type: 'job_finished', jobId: job.id, ok: !error, ts: iso(deps.now()) });
        deps.emitJob(status, job.id, { boxId, runner: 'microvm' });
      }
    }
    attempt.stop();
    if (slotHolder) await deps.releaseRunSlots(slotHolder).catch(() => undefined);
  }
}

class StepFailed extends Error {}

// ─── The overrun sweep (§7) ───────────────────────────────────────────────────

/**
 * Stop every live session that has run past its task timeout plus grace and
 * record `stop_reason = 'overrun'`. The dispatcher's own stop is the first
 * line; this is the second (a process that died mid-run leaves its session
 * live). Measured from `started_at`, else `booted_at`, else the row's creation.
 */
export async function sweepMicrovmOverruns(deps: Pick<MicrovmDeps, 'config' | 'now' | 'listLiveSessions' | 'stopSession' | 'updateSession' | 'removeBox' | 'emitMetric' | 'log'>, graceMs = lifetimePolicy().graceMs): Promise<string[]> {
  const cfg = deps.config();
  const now = deps.now();
  const stopped: string[] = [];
  for (const s of await deps.listLiveSessions()) {
    const from = Date.parse(s.started_at ?? s.booted_at ?? s.created_at);
    const limitMs = (s.task_timeout_s ?? lifetimePolicy().taskDefaultS) * 1000 + graceMs;
    if (!Number.isFinite(from) || now - from <= limitMs) continue;
    const arn = s.runtime_arn ?? cfg.runtimeArn;
    if (!arn) continue;
    try {
      await deps.stopSession(arn, s.session_id);
    } catch (err) {
      if ((err as { name?: string }).name !== 'ResourceNotFoundException') {
        deps.emitMetric('devbox-reap-failed', { reason: 'overrun', runner: 'microvm', sessionId: s.session_id, error: (err as Error).message });
        continue;
      }
    }
    await deps.updateSession(s.session_id, { status: 'stopped', stop_reason: 'overrun', stopped_at: iso(now) });
    deps.removeBox(microvmBoxId(s.session_id));
    deps.emitMetric('devbox-reaped', { reason: 'overrun', runner: 'microvm', sessionId: s.session_id, jobId: s.job_id, minutes: Math.round((now - from) / 60_000) });
    deps.log({ event: 'reaped', reason: 'overrun', sessionId: s.session_id, jobId: s.job_id, attempt: s.attempt });
    stopped.push(s.session_id);
  }
  return stopped;
}

// ─── Start-up ─────────────────────────────────────────────────────────────────

let starting: Promise<void> | null = null;

/**
 * Once per process, before the first pass: fill an unset runtime ARN / runs
 * bucket from SSM (lib/microvm-config.ts `loadMicrovmParameters`) and say,
 * once, where each value came from — including which lab_api_base the boots
 * will carry. Idempotent; never throws.
 */
export function startMicrovmRunner(opts: { read?: ParameterReader; env?: NodeJS.ProcessEnv; log?: (line: Record<string, unknown>) => void } = {}): Promise<void> {
  if (starting) return starting;
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((line) => console.log(JSON.stringify({ msg: 'microvm', ...line })));
  starting = (async () => {
    const fromSsm = await loadMicrovmParameters(opts.read, env, (m) => log({ event: 'config_note', note: m })).catch(() => null);
    const cfg = microvmConfig(env);
    const source = (envName: string, ssm: string | null | undefined): 'env' | 'ssm' | 'none' =>
      (env[envName]?.trim() ? 'env' : ssm ? 'ssm' : 'none');
    log({
      event: 'config',
      runtimeArnSource: source('MICROVM_RUNTIME_ARN', fromSsm?.runtimeArn),
      runsBucketSource: source('MICROVM_RUNS_BUCKET', fromSsm?.runsBucket),
      labApiBase: cfg.labApiBase,
      labApiBaseSource: cfg.labApiBaseSource === 'env' ? 'env MICROVM_LAB_API_BASE' : 'default lab.<PROJECT_PREFIX>.internal',
      workspaceRootDefault: cfg.workspaceRoot,
      maxLifetimeS: cfg.maxLifetimeS,
      maxLifetimeSource: env['MICROVM_MAX_LIFETIME_S']?.trim() ? 'env MICROVM_MAX_LIFETIME_S' : 'default 3600',
    });
  })();
  return starting;
}

/** Tests: run the start-up again. */
export function _resetMicrovmStart(): void { starting = null; }

// ─── The real collaborators ───────────────────────────────────────────────────

let _client: AgentCoreSend | null = null;

/** Wires every dependency to the real module, loaded on first use. */
export async function defaultMicrovmDeps(): Promise<MicrovmDeps> {
  const jobs = await import('../providers/agent-jobs.js');
  const attempt = await import('./job-attempt.js');
  const identity = await import('../providers/identity.js');
  const scope = await import('./initiative-scope.js');
  const profiles = await import('../providers/devbox-profiles.js');
  const projects = await import('../providers/agent-projects.js');
  const grants = await import('../providers/github-user-grants.js');
  const sessions = await import('../providers/microvm-sessions.js');
  const holds = await import('./spend-holds.js');
  const holdStore = await import('../providers/spend-holds.js');
  const ledger = await import('../providers/spend-ledger.js');
  const prices = await import('./model-prices.js');
  const brief = await import('./run-brief.js');
  const tokens = await import('./repo-token-provider.js');
  const issues = await import('../providers/credential-issues.js');
  const invoke = await import('./microvm-invoke.js');
  const runner = await import('./devbox-runner.js');
  const fleet = await import('./devbox-fleet.js');
  const github = await import('./github-connector.js');
  const metrics = await import('./fleet-metrics.js');
  const switches = await import('./fleet-switches.js');
  const limits = await import('../providers/run-limits.js');
  const { BedrockAgentCoreClient } = await import('@aws-sdk/client-bedrock-agentcore');
  const dispatcher = await import('./job-dispatcher.js');
  const client = (): AgentCoreSend => {
    if (!_client) _client = new BedrockAgentCoreClient({ region: microvmConfig().region });
    return _client;
  };
  return {
    config: () => microvmConfig(),
    now: () => Date.now(),
    staleMinutes: Number(process.env['JOB_STALE_MINUTES'] ?? 30),
    claimNext: (opts) => jobs.claimNextMicrovmJob(opts),
    unclaim: (id, t) => jobs.unclaimJob(id, t),
    stampPlacement: (id, t, b, s) => jobs.stampJobPlacement(id, t, b, s),
    markRunning: (id, t) => jobs.markRunning(id, t),
    completeJob: (id, o) => jobs.completeJob(id, o),
    recordRunEnd: async (input) => (await import('./run-reports/record.js')).recordRunEnd(input),
    getJobFacts: (id) => jobs.getMicrovmJobFacts(id),
    maintainAttempt: (id, t, ms) => attempt.maintainJobAttempt(id, t, ms),
    getUser: async (sub) => {
      const u = await identity.getUser(sub, { authoritative: true });
      return u ? { id: u.id, grants: u.grants as MicrovmUser['grants'] } : null;
    },
    stewardsInitiative: (sub, id) => scope.userStewardsInitiative(sub, id),
    profileFor: async (initiativeId) => {
      const own = await profiles.initiativeProfileId(initiativeId);
      return (await profiles.latestProfile(own ?? 'default')) ?? null;
    },
    listCodebases: () => projects.listAgentProjects(),
    repoCredentialAvailable: async (project) => {
      const p = await tokens.repoTokenProvider();
      return p.kind !== 'pat' || !!project.connectionName;
    },
    githubGrant: (sub) => grants.liveGithubUserGrant(sub),
    readUserToken: (arn) => grants.readGithubUserToken(arn),
    fleetPaused: () => switches.fleetPaused(),
    saturatedInitiatives: () => limits.saturatedInitiatives(),
    releaseRunSlots: (h) => limits.releaseRunSlots(h),
    insertSession: (row) => sessions.insertMicrovmSession(row),
    updateSession: (id, patch) => sessions.updateMicrovmSession(id, patch),
    latestSessionForJob: (id) => sessions.latestSessionForJob(id),
    pushedHeadForJob: (id, before) => sessions.pushedHeadForJob(id, before),
    countLiveSessions: (sub) => sessions.countLiveSessionsForActor(sub),
    listLiveSessions: () => sessions.listLiveSessions(),
    computeSecondsP75: (ap, m) => sessions.computeSecondsP75(ap, m),
    reserveSpend: (i) => holds.reserveSpend(i),
    forecastP75ForModel: (m, ap) => holds.forecastP75ForModel(m, ap),
    meterForHold: (i) => holds.meterForHold(i),
    releaseHold: (id) => holdStore.releaseHold(id),
    recordSpend: (i) => ledger.recordSpend(i),
    estimateCost: (m, u) => prices.estimateUsageCost(m, u),
    startProjectRun: (i) => projects.startRun({ ...i, runner: 'microvm' }),
    finishProjectRun: (id, o) => projects.finishRun(id, o),
    freezeBrief: (job) => brief.freezeJobBrief(job, 'devbox'),
    mintRepoToken: (r, p, c) => tokens.mintAuditedRepoToken(r, p, c),
    recordCredentialIssue: (i) => issues.recordCredentialIssue(i),
    presign: (i) => invoke.presignS3(i),
    client,
    stopSession: (arn, sid) => runner.stopDevboxSession(client() as never, arn, sid),
    registerBox: (o) => { fleet.registerBox(o); },
    appendEvent: (id, ev) => fleet.appendEvent(id, ev),
    removeBox: (id) => { fleet.removeBox(id); },
    openPullRequest: (t, i) => github.openPullRequestWithToken(t, i),
    emitMetric: (type, fields) => metrics.emitFleetMetric(type, fields),
    emitJob: (kind, jobId, extra) => dispatcher.dispatcherEvents.emit('job', { kind, jobId, ...extra, ts: new Date().toISOString() }),
    log: (line) => console.log(JSON.stringify({ msg: 'microvm', ...line })),
  };
}

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

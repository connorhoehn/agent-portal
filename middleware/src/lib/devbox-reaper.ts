// Devbox reaper — stop paying for microVMs nobody is using.
//
// A devbox is an AgentCore runtime session: a live microVM that bills from the
// moment it starts. Nothing stopped one except someone remembering to press
// the button. The platform's own stop (1 h idle, 8 h maximum — the runtime's
// lifecycleConfiguration in infra/lib/devbox-stack.ts) is silent and
// reasonless; this reaper fires first and says why. (Fourteen days is the
// SESSION-STORAGE retention, a different thing: the workspace outlives the
// microVM.)
//
// Three reasons, because they catch different failures (DE-48):
//
//   idle          — nobody has touched this box in a while. The common case: a
//                   workspace opened to look at something, then forgotten.
//   max-lifetime  — a box that is NOT running has existed past its ceiling.
//                   Boxes are reused, so this bounds how long a checkout is
//                   kept around for the next dispatch.
//   task-overrun  — a RUNNING box whose task has outlived its own timeout plus
//                   grace. The uncommon and expensive case: an agent in a
//                   loop, which looks busy forever and is exactly what an idle
//                   timer will not catch. Measured from the TASK's start, not
//                   the box's creation — the old 60-minute box ceiling cut
//                   long tasks on old, reused boxes, whatever their timeout.
//
// Every number comes from lib/devbox-lifetime.ts (the deployment default) or,
// per box, from its policy profile (lib/devbox-profile.ts, DE-40). Nothing
// here owns a clock of its own.

import {
  BedrockAgentCoreClient,
  StopRuntimeSessionCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { listBoxes, markStopped, appendEvent, type FleetBox } from './devbox-fleet.js';
import { isLocalBoxId } from './local-compute-fleet.js';
import { lifetimePolicy, taskOverrunMs, type LifetimePolicy } from './devbox-lifetime.js';

const MINUTE = 60_000;

/** The deployment default's idle timer (env-overridable; see lib/devbox-lifetime.ts). */
export const IDLE_TIMEOUT_MS = lifetimePolicy().idleMs;

/** The deployment default's ceiling for a box that is not running. */
export const MAX_LIFETIME_MS = lifetimePolicy().boxCeilingMs;

const SWEEP_INTERVAL_MS =
  Number(process.env['DEVBOX_REAPER_INTERVAL_SECONDS'] ?? 60) * 1000;

export type ReapReason = 'idle' | 'max-lifetime' | 'task-overrun';

export interface ReapDecision {
  box: FleetBox;
  reason: ReapReason;
  /** Minutes the box had been idle / alive / running when the decision was taken. */
  minutes: number;
  /** The policy the decision was made under. */
  policy: LifetimePolicy;
}

/** Per-box policies; a box with none gets the deployment default. */
export type PolicyLookup = (box: FleetBox) => LifetimePolicy;

const defaultLookup: PolicyLookup = () => lifetimePolicy();

/**
 * Which boxes should stop, and why.
 *
 * Pure, so the policy can be tested without stopping anything real.
 *
 * A running box is judged by its task: it is reaped only once the task has
 * run past its own timeout plus grace (`task-overrun`). It is exempt from both
 * the idle rule (it is not idle, it is working) and the box ceiling (the
 * ceiling bounds how long an idle checkout is kept, not a task in flight — a
 * 50-minute-old idle box that starts a 55-minute task is allowed to finish
 * it). A running box with no recorded task start — hydrated from a row older
 * than DE-48 — is measured from its creation, which errs toward reaping.
 *
 * A LOCAL box is exempt from everything, and the reason is that every premise
 * above fails for it. This module's entire justification is "stop paying for
 * microVMs nobody is using" — a paired workstation is not billed, so there is
 * nothing to reap for cost; the ceiling exists to catch a runaway agent that an
 * idle timer cannot see, and a laptop's owner is sitting in front of it; and
 * the stop itself is a `StopRuntimeSessionCommand` against a session id that
 * never existed outside somebody's machine, which is an API call that cannot
 * succeed. Worse than useless: `markStopped` would then flip a live worker to
 * `stopped` in the registry on nothing but a failed call, and the idle rule
 * would fire on a machine that is simply between jobs.
 */
export function decideReaping(boxes: FleetBox[], now = Date.now(), policyFor: PolicyLookup = defaultLookup): ReapDecision[] {
  const out: ReapDecision[] = [];
  for (const box of boxes) {
    if (box.status === 'stopped') continue;
    if (isLocalBoxId(box.id)) continue;
    const policy = policyFor(box);

    if (box.status === 'running') {
      const started = new Date(box.taskStartedAt ?? box.createdAt).getTime();
      const running = now - started;
      if (Number.isFinite(running) && running >= taskOverrunMs(policy, null)) {
        out.push({ box, reason: 'task-overrun', minutes: Math.round(running / MINUTE), policy });
      }
      continue;
    }

    const age = now - new Date(box.createdAt).getTime();
    if (Number.isFinite(age) && age >= policy.boxCeilingMs) {
      out.push({ box, reason: 'max-lifetime', minutes: Math.round(age / MINUTE), policy });
      continue;
    }

    const idle = now - new Date(box.lastActivityAt).getTime();
    if (Number.isFinite(idle) && idle >= policy.idleMs) {
      out.push({ box, reason: 'idle', minutes: Math.round(idle / MINUTE), policy });
    }
  }
  return out;
}

function explain(d: ReapDecision): string {
  switch (d.reason) {
    case 'idle':
      return `Stopped after ${d.minutes} minutes idle. The workspace is gone; the repository and its run history are not — re-clone to carry on.`;
    case 'max-lifetime':
      return `Stopped at the ${Math.round(d.policy.boxCeilingMs / MINUTE)}-minute ceiling after ${d.minutes} minutes without a task running. A checkout this old is cheaper to re-clone than to keep.`;
    case 'task-overrun':
      return `Stopped after ${d.minutes} minutes on one task — past its ${d.policy.taskMaxS}-second limit plus ${Math.round(d.policy.graceMs / MINUTE)} minutes of grace. A task that runs this long is stuck.`;
  }
}

export interface ReaperDeps {
  client: () => BedrockAgentCoreClient;
  runtimeArn: () => Promise<string | null>;
  /**
   * Per-box lifetime policies for a sweep (DE-40). Defaults to the profile
   * resolver; tests inject a lookup. Resolved once per sweep, before the pure
   * decision, so `decideReaping` never awaits.
   */
  policies?: (boxes: FleetBox[]) => Promise<Map<string, LifetimePolicy>>;
}

let _timer: NodeJS.Timeout | null = null;

async function profilePolicies(boxes: FleetBox[]): Promise<Map<string, LifetimePolicy>> {
  // Lazy: lib/devbox-profile.ts reaches the provider, and the provider
  // imports config.ts, which the CommonJS test build of this module's
  // callers cannot load statically.
  const { lifetimePoliciesFor } = await import('./devbox-profile.js');
  return lifetimePoliciesFor(boxes);
}

/**
 * Run one sweep.
 *
 * Announces the stop into the box's own event stream before making the call,
 * so anyone watching sees a reason rather than a terminal that simply dies.
 */
export async function sweepOnce(deps: ReaperDeps, now = Date.now()): Promise<ReapDecision[]> {
  const boxes = listBoxes();
  if (boxes.length === 0) return [];
  let policies: Map<string, LifetimePolicy>;
  try {
    policies = await (deps.policies ?? profilePolicies)(boxes);
  } catch (err) {
    console.warn('[devbox-reaper] could not resolve box profiles — sweeping with the default lifetime:', (err as Error).message);
    policies = new Map();
  }
  const fallback = lifetimePolicy();
  const decisions = decideReaping(boxes, now, (box) => policies.get(box.id) ?? fallback);
  if (decisions.length === 0) return [];

  const arn = await deps.runtimeArn();
  if (!arn) return [];

  for (const d of decisions) {
    const detail = explain(d);
    try {
      appendEvent(d.box.id, {
        type: 'devbox_reaped', reason: d.reason, minutes: d.minutes, detail,
        ts: new Date(now).toISOString(),
      });
      await deps.client().send(new StopRuntimeSessionCommand({
        agentRuntimeArn: arn,
        runtimeSessionId: d.box.sessionId,
      }));
      markStopped(d.box.id);
      console.warn(`[devbox-reaper] stopped ${d.box.label} (${d.reason}, ${d.minutes}m)`);
    } catch (err) {
      // "Already gone" is the goal, not a failure. AgentCore stops a session
      // on its own (its 1 h idle / 8 h maximum, and every runtime version
      // update), so a box restored from the registry can easily outlive the
      // session it names. Treating that as an error left the reaper retrying
      // the same dead box on every sweep, forever, and — now that boxes
      // survive restarts — its row would never be pruned either, because
      // pruning keys off `stopped`. Settling it converges instead.
      if ((err as { name?: string }).name === 'ResourceNotFoundException') {
        markStopped(d.box.id);
        console.warn(`[devbox-reaper] ${d.box.label} was already gone — settled`);
        continue;
      }
      // A box that cannot be stopped is worth knowing about — it is the one
      // still costing money.
      console.warn(`[devbox-reaper] could not stop ${d.box.label}:`, (err as Error).message);
    }
  }
  return decisions;
}

export function startReaper(deps: ReaperDeps): void {
  if (_timer) return;
  _timer = setInterval(() => {
    void sweepOnce(deps).catch((err) => {
      console.warn('[devbox-reaper] sweep failed:', (err as Error).message);
    });
  }, SWEEP_INTERVAL_MS);
  // Never hold the process open for a sweep.
  _timer.unref?.();
  const p = lifetimePolicy();
  console.warn(
    `[devbox-reaper] active — idle ${Math.round(p.idleMs / MINUTE)}m, `
    + `box ceiling ${Math.round(p.boxCeilingMs / MINUTE)}m, task ${p.taskDefaultS}s/${p.taskMaxS}s + ${Math.round(p.graceMs / MINUTE)}m grace`,
  );
}

export function stopReaper(): void {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

/**
 * What a UI needs to show a box's remaining time without re-deriving policy.
 * `taskMsLeft` is how long a running task may still go before it counts as
 * stuck; it is the whole ceiling for a box with no task running.
 */
export function timeLeft(box: FleetBox, now = Date.now(), policy: LifetimePolicy = lifetimePolicy()): {
  idleMsLeft: number; lifetimeMsLeft: number; taskMsLeft: number; stopsInMs: number;
} {
  const idleMsLeft = Math.max(0, policy.idleMs - (now - new Date(box.lastActivityAt).getTime()));
  const lifetimeMsLeft = Math.max(0, policy.boxCeilingMs - (now - new Date(box.createdAt).getTime()));
  const overrun = taskOverrunMs(policy, null);
  const taskMsLeft = box.status === 'running'
    ? Math.max(0, overrun - (now - new Date(box.taskStartedAt ?? box.createdAt).getTime()))
    : overrun;
  // A running box is bounded by its task, not by idleness or the ceiling.
  const stopsInMs = box.status === 'running' ? taskMsLeft : Math.min(idleMsLeft, lifetimeMsLeft);
  return { idleMsLeft, lifetimeMsLeft, taskMsLeft, stopsInMs };
}

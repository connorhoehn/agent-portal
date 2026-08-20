// Devbox reaper — stop paying for microVMs nobody is using.
//
// A devbox is an AgentCore runtime session: a live microVM that bills from the
// moment it starts. Nothing stopped one except someone remembering to press
// the button, and the platform's own expiry is fourteen idle days — a fine
// backstop against losing a workspace, and useless as a cost control.
//
// Two limits, because they catch different failures:
//
//   idle    — nobody has touched this box in a while. The common case: a
//             workspace opened to look at something, then forgotten.
//   maximum — this box has existed too long regardless of activity. The
//             uncommon and expensive case: an agent in a loop, which looks
//             busy forever and is exactly what an idle timer will not catch.
//
// Both are deliberately blunt. A workspace is a cache — the durable things are
// the repository and the run history — so reaping one costs a re-clone, and
// the alternative is a bill for a machine nobody is using.

import {
  BedrockAgentCoreClient,
  StopRuntimeSessionCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { listBoxes, markStopped, appendEvent, type FleetBox } from './devbox-fleet.js';

const MINUTE = 60_000;

/** Nobody has touched it. */
export const IDLE_TIMEOUT_MS =
  Number(process.env['DEVBOX_IDLE_TIMEOUT_MINUTES'] ?? 20) * MINUTE;

/** It has existed this long, working or not. */
export const MAX_LIFETIME_MS =
  Number(process.env['DEVBOX_MAX_LIFETIME_MINUTES'] ?? 60) * MINUTE;

const SWEEP_INTERVAL_MS =
  Number(process.env['DEVBOX_REAPER_INTERVAL_SECONDS'] ?? 60) * 1000;

export type ReapReason = 'idle' | 'max-lifetime';

export interface ReapDecision {
  box: FleetBox;
  reason: ReapReason;
  /** Minutes the box had been idle / alive when the decision was taken. */
  minutes: number;
}

/**
 * Which boxes should stop, and why.
 *
 * Pure, so the policy can be tested without stopping anything real.
 *
 * A running box is exempt from the idle rule — it is not idle, it is working —
 * but not from the maximum. That asymmetry is the point: an agent stuck in a
 * loop keeps its box looking busy indefinitely, and a timer that defers to
 * "busy" would never fire on the one case that costs the most.
 */
export function decideReaping(boxes: FleetBox[], now = Date.now()): ReapDecision[] {
  const out: ReapDecision[] = [];
  for (const box of boxes) {
    if (box.status === 'stopped') continue;

    const age = now - new Date(box.createdAt).getTime();
    if (Number.isFinite(age) && age >= MAX_LIFETIME_MS) {
      out.push({ box, reason: 'max-lifetime', minutes: Math.round(age / MINUTE) });
      continue;
    }

    if (box.status === 'running') continue;

    const idle = now - new Date(box.lastActivityAt).getTime();
    if (Number.isFinite(idle) && idle >= IDLE_TIMEOUT_MS) {
      out.push({ box, reason: 'idle', minutes: Math.round(idle / MINUTE) });
    }
  }
  return out;
}

function explain(d: ReapDecision): string {
  return d.reason === 'idle'
    ? `Stopped after ${d.minutes} minutes idle. The workspace is gone; the repository and its run history are not — re-clone to carry on.`
    : `Stopped at the ${Math.round(MAX_LIFETIME_MS / MINUTE)}-minute ceiling after ${d.minutes} minutes, regardless of activity. A box that runs this long is usually stuck.`;
}

export interface ReaperDeps {
  client: () => BedrockAgentCoreClient;
  runtimeArn: () => Promise<string | null>;
}

let _timer: NodeJS.Timeout | null = null;

/**
 * Run one sweep.
 *
 * Announces the stop into the box's own event stream before making the call,
 * so anyone watching sees a reason rather than a terminal that simply dies.
 */
export async function sweepOnce(deps: ReaperDeps, now = Date.now()): Promise<ReapDecision[]> {
  const decisions = decideReaping(listBoxes(), now);
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
  console.warn(
    `[devbox-reaper] active — idle ${Math.round(IDLE_TIMEOUT_MS / MINUTE)}m, `
    + `ceiling ${Math.round(MAX_LIFETIME_MS / MINUTE)}m`,
  );
}

export function stopReaper(): void {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

/** What a UI needs to show a box's remaining time without re-deriving policy. */
export function timeLeft(box: FleetBox, now = Date.now()): {
  idleMsLeft: number; lifetimeMsLeft: number; stopsInMs: number;
} {
  const idleMsLeft = Math.max(0, IDLE_TIMEOUT_MS - (now - new Date(box.lastActivityAt).getTime()));
  const lifetimeMsLeft = Math.max(0, MAX_LIFETIME_MS - (now - new Date(box.createdAt).getTime()));
  // A running box will not be reaped for idleness, so its next stop is the
  // ceiling.
  const stopsInMs = box.status === 'running' ? lifetimeMsLeft : Math.min(idleMsLeft, lifetimeMsLeft);
  return { idleMsLeft, lifetimeMsLeft, stopsInMs };
}

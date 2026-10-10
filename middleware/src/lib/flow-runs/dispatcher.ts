// Executes flow runs from the durable store. Any node may run it: claim() is
// the single-executor guarantee, and a lapsed lease sends the run back to the
// queue (or fails it, visibly) the next time any node ticks.

import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { flowRunStore, type FlowRunRow, type FlowRunStep } from './store.js';

export const LEASE_MS = 60_000;
const HEARTBEAT_MS = 20_000;
const TICK_MS = 5_000;
const MAX_CLAIMS_PER_TICK = 3;

export interface FlowExecutionContext {
  run: FlowRunRow;
  /** Records progress (and extends the lease). Returns false once the lease is lost. */
  report(steps: FlowRunStep[]): Promise<boolean>;
}
/** Returns the run's result; a throw is the run's terminal failure (no retry). */
export type FlowExecutor = (ctx: FlowExecutionContext) => Promise<{ result: unknown; progress?: FlowRunStep[]; pause?: 'approval' }>;
/** A run paused for a human decision this long is ended by the dispatcher (the loop says so on its card). */
export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

const executors = new Map<string, FlowExecutor>();
export const registerFlowExecutor = (kind: string, executor: FlowExecutor): void => { executors.set(kind, executor); };

export const nodeId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

/** Settles when every run this process started has finished (tests await it; routes never do). */
export const pendingFlowRuns = new Set<Promise<void>>();

export async function executeClaimed(run: FlowRunRow, owner: string, leaseMs = LEASE_MS): Promise<void> {
  const executor = executors.get(run.kind);
  const beat = setInterval(() => { void flowRunStore.progress(run.id, owner, null, leaseMs).catch(() => undefined); },
    Math.min(HEARTBEAT_MS, Math.max(1_000, leaseMs / 3)));
  beat.unref();
  try {
    if (!executor) throw new Error(`No executor is registered for ${run.kind}`);
    const out = await executor({ run, report: (steps) => flowRunStore.progress(run.id, owner, steps, leaseMs) });
    if (out.pause) {
      // Paused for a decision: the lease is released and the cursor is the progress; nothing else runs.
      await flowRunStore.pause(run.id, owner, { result: out.result, progress: out.progress ?? run.progress });
      return;
    }
    await flowRunStore.finish(run.id, owner, { status: 'completed', result: out.result, ...(out.progress ? { progress: out.progress } : {}) });
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'The run failed.';
    const progress = run.progress.map(s => (s.status === 'running' ? { ...s, status: 'failed' as const } : s));
    await flowRunStore.finish(run.id, owner, { status: 'failed', error: reason, progress }).catch(() => undefined);
  } finally { clearInterval(beat); }
}

function track(p: Promise<void>): void {
  const done = p.finally(() => pendingFlowRuns.delete(done));
  pendingFlowRuns.add(done);
}

/** Run this specific run now if it is still free (the creating node's fast path). */
export function kickFlowRun(id: string, kind: string, owner = nodeId, leaseMs = LEASE_MS): void {
  track((async () => {
    const run = await flowRunStore.claim({ kinds: [kind], owner, leaseMs, id });
    if (run) await executeClaimed(run, owner, leaseMs);
  })().catch(error => console.warn('[flow-runs] kick failed:', error)));
}

/** One dispatcher pass: recover lapsed leases, then claim what is queued. */
export async function dispatchFlowRuns(owner = nodeId, leaseMs = LEASE_MS): Promise<void> {
  const { failed } = await flowRunStore.expireLeases();
  for (const run of failed) console.warn(`[flow-runs] ${run.kind} ${run.id} failed: lease expired`);
  await flowRunStore.expireWaiting(APPROVAL_TTL_MS);
  const kinds = [...executors.keys()];
  for (let i = 0; i < MAX_CLAIMS_PER_TICK; i++) {
    const run = await flowRunStore.claim({ kinds, owner, leaseMs });
    if (!run) break;
    track(executeClaimed(run, owner, leaseMs));
  }
}

let timer: ReturnType<typeof setInterval> | undefined;
/** Startup recovery (the first tick) plus a poll so another node's orphans are picked up. */
export function startFlowRunDispatcher(): void {
  if (timer) return;
  const tick = (): void => { void dispatchFlowRuns().catch(error => console.warn('[flow-runs] dispatch failed:', error)); };
  timer = setInterval(tick, TICK_MS);
  timer.unref();
  tick();
}

// Job dispatcher — assigns queued work to idle devbox workers and runs it.
//
// This is what turns the fleet from "boxes an operator drives by hand" into
// workers. Each tick:
//
//   1. reap stale jobs (a worker that died mid-flight goes back in the queue)
//   2. find idle boxes in the fleet registry
//   3. claim one job per idle box (atomic, SKIP LOCKED)
//   4. run it through the SAME devbox task path the portal uses, so every
//      event lands in the box's server-side event log — the existing tail UI
//      shows queue work streaming live with no extra plumbing
//   5. record the outcome; jobs that produce an artifact stop at
//      awaiting_review rather than silently completing
//
// Concurrency is bounded by the number of idle boxes, so the queue can never
// stampede the runtime.

import { EventEmitter } from 'node:events';
import {
  claimNextJob, markRunning, completeJob, reapStaleJobs, type AgentJob,
} from '../providers/agent-jobs.js';
import { listBoxes, appendEvent, getBox } from './devbox-fleet.js';
import { runDevboxTask } from '../routes/devbox.js';

const TICK_MS = Number(process.env['JOB_DISPATCH_INTERVAL_MS'] ?? 10_000);
const STALE_MINUTES = Number(process.env['JOB_STALE_MINUTES'] ?? 30);

/** Emits 'job' events so SSE consumers can watch the queue without polling. */
export const dispatcherEvents = new EventEmitter();

let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;
/** Boxes currently executing a dispatched job — never double-assign. */
const busy = new Set<string>();

function emit(kind: string, job: AgentJob | { id: string }, extra: Record<string, unknown> = {}): void {
  dispatcherEvents.emit('job', { kind, jobId: job.id, ...extra, ts: new Date().toISOString() });
}

async function runJob(job: AgentJob): Promise<void> {
  const boxId = job.boxId;
  const sessionId = job.sessionId;
  if (!boxId || !sessionId) {
    await completeJob(job.id, { status: 'failed', error: 'claimed without a box assignment' });
    return;
  }

  busy.add(boxId);
  try {
    await markRunning(job.id);
    emit('running', job, { boxId });

    // Announce the job in the box's own event stream so an operator tailing
    // the box sees why it suddenly started working.
    appendEvent(boxId, {
      type: 'job_started',
      jobId: job.id,
      title: job.title,
      kind: job.kind,
      ts: new Date().toISOString(),
    });

    const prompt = String(job.payload['prompt'] ?? '').trim();
    if (!prompt) {
      await completeJob(job.id, { status: 'failed', error: 'payload.prompt is required for devbox:task' });
      emit('failed', job, { boxId });
      return;
    }

    const outcome = await runDevboxTask({
      sessionId,
      prompt,
      resume: Boolean(job.payload['resume']),
      onEvent: (ev) => appendEvent(boxId, ev),
    });

    appendEvent(boxId, {
      type: 'job_finished',
      jobId: job.id,
      ok: outcome.ok,
      ts: new Date().toISOString(),
    });

    if (!outcome.ok) {
      await completeJob(job.id, { status: 'failed', error: outcome.error ?? 'task failed' });
      emit('failed', job, { boxId });
      return;
    }

    // A job that changed the workspace needs a human to accept the artifact;
    // a read-only job is simply done. `requiresReview` defaults to true for
    // devbox work because it can open PRs.
    const requiresReview = job.payload['requiresReview'] !== false;
    await completeJob(job.id, {
      status: requiresReview ? 'awaiting_review' : 'done',
      result: {
        summary: outcome.summary,
        turns: outcome.turns,
        durationMs: outcome.durationMs,
        costUsd: outcome.costUsd,
        toolCalls: outcome.toolCalls,
      },
    });
    emit(requiresReview ? 'awaiting_review' : 'done', job, { boxId });
  } catch (err) {
    await completeJob(job.id, { status: 'failed', error: (err as Error).message });
    emit('failed', job, { boxId });
  } finally {
    busy.delete(boxId);
  }
}

async function tick(): Promise<void> {
  if (ticking) return;          // a slow tick must not overlap the next one
  ticking = true;
  try {
    const reaped = await reapStaleJobs(STALE_MINUTES);
    if (reaped.requeued || reaped.failed) {
      console.log(`[dispatcher] reaped stale jobs: requeued ${reaped.requeued}, failed ${reaped.failed}`);
    }

    // Idle = registered, not stopped/error, and not already running a job.
    const idle = listBoxes().filter(
      (b) => (b.status === 'idle' || b.status === 'waiting') && !busy.has(b.id),
    );
    for (const box of idle) {
      const job = await claimNextJob(box.id, box.sessionId);
      if (!job) break;                        // queue empty — stop probing
      emit('claimed', job, { boxId: box.id });
      void runJob(job);                       // fire and forget; bounded by idle boxes
    }
  } catch (err) {
    console.warn('[dispatcher] tick failed:', (err as Error).message);
  } finally {
    ticking = false;
  }
}

export function startJobDispatcher(): void {
  if (timer) return;
  console.log(`[dispatcher] starting job dispatcher, interval ${TICK_MS / 1000}s`);
  timer = setInterval(() => void tick(), TICK_MS);
  void tick();
}

export function stopJobDispatcher(): void {
  if (timer) { clearInterval(timer); timer = null; }
}

/** Test/ops hook — run one dispatch pass immediately. */
export async function dispatchOnce(): Promise<void> {
  await tick();
}

/** Which boxes the dispatcher currently considers busy (for the Work UI). */
export function busyBoxes(): string[] {
  return [...busy].filter((id) => getBox(id) !== null);
}

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
  claimNextJob, markRunning, completeJob, reapStaleJobs, listJobs, type AgentJob,
} from '../providers/agent-jobs.js';
import { listBoxes, appendEvent, getBox, registerBox } from './devbox-fleet.js';
import { isLocalBoxId } from './local-compute-fleet.js';
import { runDevboxTask } from '../routes/devbox.js';

const TICK_MS = Number(process.env['JOB_DISPATCH_INTERVAL_MS'] ?? 10_000);
/**
 * How long a claim may go quiet before the reaper takes it back.
 *
 * Exported because a pull-side worker has to be TOLD this rather than guessing
 * it: the number is the deadline its heartbeat is racing, and a worker holding a
 * different figure from the reaper's would either heartbeat too slowly (its work
 * requeued and re-run while it is still running) or pointlessly often. One env
 * var, read once, quoted to the worker in the claim response.
 */
export const STALE_MINUTES = Number(process.env['JOB_STALE_MINUTES'] ?? 30);

/**
 * Emits 'job' events so SSE consumers can watch the queue without polling.
 *
 * One listener is added per open `GET /api/work/events` stream, and three
 * portal pages subscribe (Queue, Findings, Work home). Node's default ceiling
 * is 10 listeners, past which it prints a MaxListenersExceededWarning and
 * names this emitter as a probable leak — so a handful of people with the work
 * pages open is enough to fill the log with a warning about entirely correct
 * behaviour. Raised to a number no legitimate audience reaches, which keeps
 * the warning meaningful: if it ever does fire, it really is a leak.
 */
export const dispatcherEvents = new EventEmitter();
dispatcherEvents.setMaxListeners(256);

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
      // A queued job may ask for a bigger model; most should not need to.
      ...(typeof job.payload['model'] === 'string' ? { model: job.payload['model'] } : {}),
      onEvent: (ev) => appendEvent(boxId, ev),
    });

    appendEvent(boxId, {
      type: 'job_finished',
      jobId: job.id,
      ok: outcome.ok,
      ts: new Date().toISOString(),
    });

    if (!outcome.ok) {
      await completeJob(job.id, {
        status: 'failed',
        error: outcome.error ?? 'task failed',
        result: {
          summary: outcome.summary,
          turns: outcome.turns,
          durationMs: outcome.durationMs,
          costUsd: outcome.costUsd,
          toolCalls: outcome.toolCalls,
          transcript: outcome.transcript,
        },
      });
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
        // Stored so the job detail page can show what the worker did long
        // after the fleet ring buffer has rolled past this run.
        transcript: outcome.transcript,
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
    //
    // Local box ids are excluded belt-and-braces. Nothing should register one —
    // that was the bug in recoverOrphanedWork below — but if one ever appears
    // here the consequence is worse than a wasted tick: `runJob` would call
    // `runDevboxTask`, which is hard-wired to AgentCore `InvokeRuntime`, against
    // a session id that only ever existed on somebody's laptop. A paired machine
    // gets work by CLAIMING it (routes/local-compute.ts), never by being pushed.
    const idle = listBoxes().filter(
      (b) => (b.status === 'idle' || b.status === 'waiting') && !busy.has(b.id) && !isLocalBoxId(b.id),
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

/**
 * Recover from a middleware restart.
 *
 * The fleet registry is in-memory, so a restart leaves Aurora holding jobs
 * marked claimed/running whose runner died with the old process. Nothing is
 * driving them, their box is no longer registered (so tailing them 404s), and
 * the ordinary reaper would not touch them for a full stale window.
 *
 * Both halves are needed. Re-registering the boxes keeps their session ids
 * addressable so the fleet is not silently empty after every dev reload; then
 * reaping with a zero window requeues the orphans immediately, because in a
 * single-process middleware any job still marked live at boot is orphaned by
 * definition — there is no run left to wait for.
 *
 * ⚠️ That last sentence is the reason both halves now skip LOCAL work, and it is
 * the sharpest edge local compute cut into this file. A job claimed by a paired
 * workstation is running in a process the middleware does not own, so at boot it
 * is not orphaned — it is somebody else's, and still going. Unguarded, this
 * function did two damaging things to it on every restart, including every `tsx
 * watch` save in dev:
 *
 *   1. `registerBox({id: job.boxId, sessionId: job.sessionId})` minted a phantom
 *      devbox box for `local:<nodeId>`, which the dispatcher then read as idle
 *      and handed cloud work to, and which `devbox-reaper` then tried to stop
 *      through AgentCore — an API call against a session that never existed.
 *   2. `reapStaleJobs(0)` requeued the laptop's in-flight job with no window at
 *      all, so the work ran twice and the second copy was billed. The laptop's
 *      eventual completion then overwrote the newer attempt's result, which is
 *      the race `claim_token` fences.
 *
 * Local claims are left to the periodic sweep, which reaps them once their
 * heartbeat actually goes quiet — the honest test for a worker the middleware
 * cannot see.
 */
async function recoverOrphanedWork(): Promise<void> {
  try {
    const live = [
      ...(await listJobs({ status: 'running', limit: 100 })),
      ...(await listJobs({ status: 'claimed', limit: 100 })),
    ];
    let adopted = 0;
    let skippedLocal = 0;
    for (const job of live) {
      if (!job.boxId || !job.sessionId) continue;
      if (isLocalBoxId(job.boxId)) { skippedLocal++; continue; }
      if (getBox(job.boxId)) continue;
      registerBox({ id: job.boxId, sessionId: job.sessionId });
      adopted++;
    }

    const reaped = await reapStaleJobs(0, { includeFenced: false });
    if (adopted || skippedLocal || reaped.requeued || reaped.failed) {
      console.log(
        `[dispatcher] restart recovery: re-registered ${adopted} worker(s), ` +
        `requeued ${reaped.requeued}, failed ${reaped.failed}` +
        (skippedLocal ? `, left ${skippedLocal} local claim(s) alone` : ''),
      );
    }
  } catch (err) {
    console.warn('[dispatcher] restart recovery failed:', (err as Error).message);
  }
}

export function startJobDispatcher(): void {
  if (timer) return;
  console.log(`[dispatcher] starting job dispatcher, interval ${TICK_MS / 1000}s`);
  timer = setInterval(() => void tick(), TICK_MS);
  void recoverOrphanedWork().then(() => tick());
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

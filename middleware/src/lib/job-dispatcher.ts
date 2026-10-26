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
  claimNextJob, markRunning, completeJob, reapStaleJobs, listJobs, type AgentJob, type ClaimedAgentJob,
} from '../providers/agent-jobs.js';
import { listBoxes, appendEvent, getBox, registerBox, isReserved } from './devbox-fleet.js';
import { isLocalBoxId } from './local-compute-fleet.js';
import { replicaFleet } from './replica-fleet.js';
import { runDevboxTask } from '../routes/devbox.js';
import { freezeJobBrief } from './run-brief.js';
import { maintainJobAttempt, type JobAttempt } from './job-attempt.js';

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
if (!Number.isFinite(STALE_MINUTES) || STALE_MINUTES <= 0) throw new Error('JOB_STALE_MINUTES must be positive');

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

async function runJob(job: ClaimedAgentJob): Promise<void> {
  const { boxId, sessionId, claimToken } = job;
  if (!boxId || !sessionId) {
    await completeJob(job.id, { claimToken, status: 'failed', error: 'claimed without a box assignment' });
    return;
  }
  busy.add(boxId);
  let attempt: JobAttempt | undefined;
  try {
    if (!await markRunning(job.id, claimToken)) return;
    attempt = await maintainJobAttempt(job.id, claimToken, STALE_MINUTES * 60_000);
    emit('running', job, { boxId });
    appendEvent(boxId, { type: 'job_started', jobId: job.id, title: job.title, kind: job.kind, ts: new Date().toISOString() });
    const prompt = String(job.payload['prompt'] ?? '').trim();
    if (!prompt) throw new Error('payload.prompt is required for devbox:task');

    // The immutable brief is reused across retries; results remain attempt-fenced.
    const frozen = await attempt.run(() => freezeJobBrief(job, 'devbox'));
    attempt.assertLive();
    if (frozen) appendEvent(boxId, {
      type: 'brief_frozen', jobId: job.id, brief_id: frozen.brief.id, brief_sha: frozen.brief.sha256,
      tokens: frozen.brief.used_tokens, ts: new Date().toISOString(),
    });
    const guard = attempt;
    const outcome = await attempt.run(() => runDevboxTask({
      sessionId, prompt, signal: guard.signal,
      ...(frozen ? { lab: { ...frozen.run, session_id: sessionId, box_id: boxId } } : {}),
      resume: Boolean(job.payload['resume']),
      ...(typeof job.payload['model'] === 'string' ? { model: job.payload['model'] } : {}),
      onEvent: ev => { guard.assertLive(); appendEvent(boxId, ev); },
    }));
    attempt.assertLive();
    const status = !outcome.ok ? 'failed' : job.payload['requiresReview'] !== false ? 'awaiting_review' : 'done';
    const committed = await completeJob(job.id, {
      claimToken, status,
      ...(!outcome.ok ? { error: outcome.error ?? 'task failed' } : {}),
      result: {
        summary: outcome.summary, turns: outcome.turns, durationMs: outcome.durationMs,
        costUsd: outcome.costUsd, toolCalls: outcome.toolCalls, transcript: outcome.transcript,
      },
    });
    if (committed) {
      appendEvent(boxId, { type: 'job_finished', jobId: job.id, ok: outcome.ok, ts: new Date().toISOString() });
      emit(status, job, { boxId });
    }
  } catch (err) {
    // An uncertain/lost heartbeat is not a business failure. Leave recovery to
    // the authoritative stale sweep and never publish a stale terminal event.
    if (!attempt || attempt.signal.aborted) return;
    if (await completeJob(job.id, { claimToken, status: 'failed', error: (err as Error).message })) {
      emit('failed', job, { boxId });
    }
  } finally {
    attempt?.stop();
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
      (b) => (b.status === 'idle' || b.status === 'waiting') && !busy.has(b.id) && !isReserved(b.id) && !isLocalBoxId(b.id),
    );
    for (const box of idle) {
      const job = await claimNextJob(box.id, box.sessionId);
      if (!job) break;                        // queue empty — stop probing
      emit('claimed', job, { boxId: box.id });
      void runJob(job).catch(error => console.warn('[dispatcher] attempt failed:', (error as Error).message));                       // fire and forget; bounded by idle boxes
    }
  } catch (err) {
    console.warn('[dispatcher] tick failed:', (err as Error).message);
  } finally {
    ticking = false;
  }
}

/**
 * Recover addressable cloud boxes after a restart. Local boxes remain owned by
 * their workstation. The zero-window sweep is only for legacy tokenless rows,
 * only while no peer is known, and under a renewed fleet lease. All current
 * claims (push and pull) survive startup until their heartbeat goes stale.
 * Redis membership is a scheduling hint; SQL attempt tokens fence job writes.
 */
async function recoverOrphanedWork(): Promise<void> {
  try {
    const fleet = replicaFleet();
    const peers = await fleet.peers();
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

    if (peers.length > 0) {
      // Somebody else is executing. Say so loudly: the operator needs to know
      // that in-flight work was left alone deliberately, not missed.
      console.log(
        `[dispatcher] restart recovery: re-registered ${adopted} worker(s); ` +
        `${peers.length} sibling replica(s) live (${peers.join(', ')}), so the ` +
        `zero-window sweep is skipped — ${live.length} live job(s) left to the ` +
        'periodic sweep' + (skippedLocal ? `, ${skippedLocal} local claim(s) alone` : ''),
      );
      return;
    }
    const reaped = await fleet.withLock('dispatcher-boot-recovery', 30_000,
      (lease) => reapStaleJobs(0, { includeFenced: false, assertLive: lease?.assertLive }));
    if (!reaped) {
      console.log('[dispatcher] restart recovery: another replica holds the recovery lock; skipping the sweep');
      return;
    }
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

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
  claimNextJob, markRunning, completeJob, reapStaleJobs, listJobs, unclaimJob, type AgentJob, type ClaimedAgentJob,
} from '../providers/agent-jobs.js';
import {
  listBoxes, appendEvent, getBox, registerBox, isReserved, claimBox, releaseBox, refreshFromShared, allHolds,
  changesHands, setOccupant, isFleetOwnedBox,
} from './devbox-fleet.js';
import { isLocalBoxId } from './local-compute-fleet.js';
import { isMicrovmBoxId } from './microvm-ids.js';
import { replicaFleet, replicaId } from './replica-fleet.js';
import { runDevboxTask, wipeDevboxWorkspace } from '../routes/devbox.js';
import type { DevboxRunOutcome } from './devbox-runner.js';
import { freezeJobBrief } from './run-brief.js';
import { failureCodeOf, outcomeOfJobStatus, recordRunEnd } from './run-reports/record.js';
import { maintainJobAttempt, type JobAttempt } from './job-attempt.js';
import { recordSpend } from '../providers/spend-ledger.js';
import { reserveSpend, forecastP75ForModel, meterForHold, HOLD_GRACE_MS } from './spend-holds.js';
import { releaseHold, openHoldOwningJob } from '../providers/spend-holds.js';
// Run limits and kill switches (DE-37/50), loaded on first use: both read
// config, which this module's CommonJS test build must not load statically.
const runLimits = () => import('../providers/run-limits.js');
const switches = () => import('./fleet-switches.js');
import type { RunMeter } from './run-meter.js';
import { hasLifeFor, lifetimePolicy, type LifetimePolicy } from './devbox-lifetime.js';
import { lifetimePoliciesFor } from './devbox-profile.js';

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
/** Boxes this process is executing a dispatched job on (the Work UI's busy list). */
const running = new Set<string>();
/**
 * The claim this dispatcher takes on a box before pushing a job (DE-47). It
 * used to be the `running` set alone, which another replica cannot see; the
 * fleet's claim is shared when shared state is attached, so two dispatchers
 * over one fleet hand a box one job.
 */
const DISPATCH_HOLDER_PREFIX = 'dispatcher:';
const dispatchHolder = (): string => `${DISPATCH_HOLDER_PREFIX}${replicaId()}`;

function emit(kind: string, job: AgentJob | { id: string }, extra: Record<string, unknown> = {}): void {
  dispatcherEvents.emit('job', { kind, jobId: job.id, ...extra, ts: new Date().toISOString() });
}

/**
 * The ledger entry for one job attempt (DE-30). A job a bot run owns (a bot
 * firing or a marketplace dispatch) is skipped: its money lands on the
 * bot_run, and writing it here too would count the same dollar twice.
 */
async function recordJobSpend(
  job: ClaimedAgentJob,
  cost: Pick<DevboxRunOutcome, 'costUsd' | 'costBasis' | 'estimatedCostUsd'> & Partial<Pick<DevboxRunOutcome, 'model' | 'usage'>>,
): Promise<void> {
  if (job.botId) return;
  const initiative = job.payload['initiativeId'];
  const requested = job.payload['model'];
  await recordSpend({
    source: 'job',
    sourceId: `${job.id}:${job.attempts}`,
    initiativeId: typeof initiative === 'string' && initiative ? initiative : null,
    boxId: job.boxId,
    actorId: job.createdBy,
    model: cost.model ?? (typeof requested === 'string' && requested ? requested : null),
    costUsd: cost.costUsd ?? null,
    costBasis: cost.costBasis,
    estimatedCostUsd: cost.estimatedCostUsd ?? null,
    inputTokens: cost.usage?.inputTokens ?? null,
    outputTokens: cost.usage?.outputTokens ?? null,
    // The dispatcher only runs jobs on cloud boxes (InvokeRuntime); local
    // machines claim through routes/local-compute.ts, which books its own $0.
    provider: 'bedrock',
  }, { unlessBotRunOwnsJob: job.id });
}

/** The last money refusal logged per job, so a job parked behind a brake
 *  is said once per reason rather than every tick. */
const heldBack = new Map<string, string>();

/**
 * The spend hold for one job attempt (DE-34), between the claim and
 * markRunning. The initiative is the payload's (a promoted finding or a
 * work-item job carries one; a free-text job may not, and then takes no hold,
 * as before). A job a bot run owns is skipped: fireBot held its money and the
 * bot_run settles it. A refusal hands the job back to the queue without
 * burning an attempt; the next tick re-judges it once money frees.
 */
async function holdJobSpend(job: ClaimedAgentJob): Promise<{ ok: true; holdId: string | null; amountUsd?: number } | { ok: false; reason: string }> {
  if (job.botId) return { ok: true, holdId: null };
  const initiative = job.payload['initiativeId'];
  const model = typeof job.payload['model'] === 'string' ? job.payload['model'] : null;
  const held = await reserveSpend({
    initiativeId: typeof initiative === 'string' && initiative ? initiative : null,
    actorId: job.createdBy,
    source: 'job',
    sourceId: `${job.id}:${job.attempts}`,
    forecast: await forecastP75ForModel(model),
    expiresInMs: STALE_MINUTES * 60_000 + HOLD_GRACE_MS,
  });
  if (held.kind === 'held') { heldBack.delete(job.id); return { ok: true, holdId: held.holdId, amountUsd: held.amountUsd }; }
  return { ok: false, reason: held.reason };
}

/** A job a bot run owns takes no hold here, so its pause is checked here (DE-50). */
async function pausedFor(job: ClaimedAgentJob): Promise<string | null> {
  if (!job.botId) return null;
  const initiative = typeof job.payload['initiativeId'] === 'string' && job.payload['initiativeId'] ? job.payload['initiativeId'] : null;
  try {
    const hit = await (await switches()).pauseFor(initiative);
    return hit ? `paused (${hit.scope})${hit.reason ? `: ${hit.reason}` : ''}` : null;
  } catch {
    return null;
  }
}

/**
 * The job's mid-run meter (DE-35): its own hold, or — for a job a bot run
 * owns — the hold fireBot took and bound to that run. Null = unmetered.
 */
async function jobMeter(job: ClaimedAgentJob, money: { holdId: string | null; amountUsd?: number }): Promise<RunMeter | null> {
  const initiative = typeof job.payload['initiativeId'] === 'string' && job.payload['initiativeId'] ? job.payload['initiativeId'] : null;
  const model = typeof job.payload['model'] === 'string' ? job.payload['model'] : null;
  const expiresInMs = STALE_MINUTES * 60_000 + HOLD_GRACE_MS;
  try {
    if (job.botId) {
      const owner = await openHoldOwningJob(job.id);
      if (!owner) return null;
      return await meterForHold({
        holdId: owner.id, amountUsd: owner.amountUsd, initiativeId: owner.initiativeId, actorId: owner.actorId,
        source: owner.source, sourceId: owner.sourceId, model, essential: owner.essential, expiresInMs,
      });
    }
    return await meterForHold({
      holdId: money.holdId, ...(money.amountUsd !== undefined ? { amountUsd: money.amountUsd } : {}),
      initiativeId: initiative, actorId: job.createdBy, source: 'job', sourceId: `${job.id}:${job.attempts}`,
      model, expiresInMs,
    });
  } catch (err) {
    console.warn(`[dispatcher] job ${job.id} runs unmetered: ${(err as Error).message}`);
    return null;
  }
}

/** Whose work a queued job is, for FleetBox.lastOccupant: its creator (the same
 *  session sub the task route records), else its bot, else the fleet's. */
export function jobOccupant(job: Pick<AgentJob, 'createdBy' | 'botId'>): string {
  if (job.createdBy) return job.createdBy;
  if (job.botId) return `bot:${job.botId}`;
  return 'fleet';
}

async function runJob(job: ClaimedAgentJob, policy: LifetimePolicy = lifetimePolicy()): Promise<void> {
  const { boxId, sessionId, claimToken } = job;
  if (!boxId || !sessionId) {
    if (await completeJob(job.id, { claimToken, status: 'failed', error: 'claimed without a box assignment' })) {
      await recordRunEnd({ runRef: job.id, executor: 'fleet', outcome: 'failed', failureCode: 'no_box', billedUsd: 0, worker: null });
    }
    return;
  }
  running.add(boxId);
  let attempt: JobAttempt | undefined;
  let invoked = false;
  let holdId: string | null = null;
  let slotHolder: string | null = null;
  try {
    const pausedReason = await pausedFor(job);
    const money = pausedReason ? { ok: false as const, reason: pausedReason } : await holdJobSpend(job);
    if (!money.ok) {
      // Back to the queue, attempt un-burned; the box is free again.
      await unclaimJob(job.id, claimToken);
      if (heldBack.get(job.id) !== money.reason) {
        heldBack.set(job.id, money.reason);
        console.log(`[dispatcher] job ${job.id} held back: ${money.reason}`);
      }
      emit('held_back', job, { boxId, reason: money.reason });
      return;
    }
    holdId = money.holdId;
    slotHolder = holdId;
    if (!await markRunning(job.id, claimToken)) { await releaseHold(holdId); return; }
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
    // The box served whoever ran the last job on it. A job for someone else
    // never resumes the previous occupant's conversation. Only a box the fleet
    // made for itself (nobody's, on no initiative: isFleetOwnedBox, the task
    // route's rule) is wiped first; a personal or initiative computer keeps
    // its workspace, which is its owner's or its initiative's to share. An
    // unknown last occupant (a box from before the field) counts as someone
    // else's: a fleet box is wiped, a personal or initiative one is not.
    // A failed wipe fails the job rather than run it on their files.
    const occupant = jobOccupant(job);
    const box = getBox(boxId);
    let resume = Boolean(job.payload['resume']);
    if (box && changesHands(box, occupant)) {
      if (resume) {
        resume = false;
        appendEvent(boxId, { type: 'resume_refused', jobId: job.id, ts: new Date().toISOString() });
      }
      if (isFleetOwnedBox(box)) {
        const wiped = await attempt.run(() => wipeDevboxWorkspace(sessionId));
        attempt.assertLive();
        if (!wiped.ok) throw new Error(`workspace wipe before hand-over failed: ${wiped.error ?? 'unknown'}`);
        appendEvent(boxId, { type: 'workspace_wiped', jobId: job.id, removed: wiped.removed ?? 0, ts: new Date().toISOString() });
      }
    }
    setOccupant(boxId, occupant);
    const guard = attempt;
    const meter = await jobMeter(job, money);
    // A bot-owned job's slot is its bot run's hold (DE-37): freed when the job ends.
    if (!slotHolder && meter) slotHolder = meter.holdIds[0] ?? null;
    invoked = true;
    const outcome = await attempt.run(() => runDevboxTask({
      sessionId, prompt, signal: guard.signal, meter, boxId,
      ...(frozen ? { lab: { ...frozen.run, session_id: sessionId, box_id: boxId } } : {}),
      resume,
      // The box's profile default, stated rather than left to the image (DE-48).
      timeoutSeconds: policy.taskDefaultS,
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
        costUsd: outcome.costUsd, costBasis: outcome.costBasis, estimatedCostUsd: outcome.estimatedCostUsd,
        toolCalls: outcome.toolCalls, transcript: outcome.transcript,
        // DE-35: the run was stopped at its spend ceiling.
        ...(outcome.cutoff ? { cutoff: outcome.cutoff } : {}),
      },
    });
    if (committed) {
      await recordJobSpend(job, outcome);
      // The run report (docs/learning-loop-design.md §1): the runner's own stream carried the
      // final message (its lab-report block) and every skill load, so the server reads both here.
      await recordRunEnd({
        runRef: job.id, executor: 'fleet', outcome: outcomeOfJobStatus(status),
        failureCode: outcome.ok ? null : outcome.cutoff ? 'budget' : outcome.failureCode ?? failureCodeOf(outcome.error),
        model: outcome.model, billedUsd: outcome.costUsd,
        worker: { block: outcome.summary, skillsLoaded: outcome.skillsLoaded ?? [] },
      });
      appendEvent(boxId, { type: 'job_finished', jobId: job.id, ok: outcome.ok, ts: new Date().toISOString() });
      emit(status, job, { boxId });
    }
  } catch (err) {
    // An uncertain/lost heartbeat is not a business failure. Leave recovery to
    // the authoritative stale sweep and never publish a stale terminal event.
    if (!attempt || attempt.signal.aborted) return;
    if (await completeJob(job.id, { claimToken, status: 'failed', error: (err as Error).message })) {
      // The task may have spent before it threw; how much is unknown, not zero
      // — and an unknown-cost entry leaves the hold held until it expires.
      // A failure BEFORE the invoke spent nothing, so that hold is released.
      if (invoked) await recordJobSpend(job, { costUsd: null, costBasis: 'unknown', estimatedCostUsd: null });
      else await releaseHold(holdId);
      await recordRunEnd({ runRef: job.id, executor: 'fleet', outcome: 'failed', failureCode: failureCodeOf((err as Error).message), billedUsd: invoked ? null : 0, worker: null });
      emit('failed', job, { boxId });
    }
  } finally {
    attempt?.stop();
    running.delete(boxId);
    if (slotHolder) await (await runLimits()).releaseRunSlots(slotHolder).catch(() => undefined);
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
    // Other replicas' boxes, statuses and holds (a run in flight elsewhere
    // holds its box), fresh for this tick (DE-47). A no-op for one process; a
    // failed read leaves the last view, and claimBox below still fails closed.
    await refreshFromShared().catch((err) => {
      console.warn('[dispatcher] shared fleet state unreadable:', (err as Error).message);
    });
    const candidates = listBoxes().filter(
      (b) => (b.status === 'idle' || b.status === 'waiting') && !running.has(b.id) && !isLocalBoxId(b.id)
        // A microVM runner session's transient box is one job's, on another
        // runtime: never a fleet worker (docs/microvm-runner-design.md §7).
        && !isMicrovmBoxId(b.id),
    );
    const free = candidates.filter((b) => !isReserved(b.id));
    // A box without ceiling left for one default task plus grace is not handed
    // a job (DE-48 rule 3): the reaper would stop it mid-task. Each box is
    // judged by its own profile's policy (stamped version, tightened by a
    // newer one), one lookup per profile.
    const policies = free.length ? await lifetimePoliciesFor(free) : new Map<string, LifetimePolicy>();
    const idle = free.filter((b) => hasLifeFor(b, policies.get(b.id) ?? lifetimePolicy()));
    const holder = dispatchHolder();
    // A paused fleet claims nothing (DE-50); a saturated initiative's jobs
    // stay queued without holding the queue head (DE-37).
    if (idle.length && await switches().then((m) => m.fleetPaused()).catch(() => false)) return;
    const skipInitiatives = idle.length ? await runLimits().then((m) => m.saturatedInitiatives()).catch(() => [] as string[]) : [];
    for (const box of idle) {
      // The box first, then a job: another dispatcher may hold this box.
      if (!await claimBox(box.id, holder)) continue;
      let job: ClaimedAgentJob | null;
      try {
        job = await claimNextJob(box.id, box.sessionId, skipInitiatives.length ? { skipInitiatives } : undefined);
      } catch (err) {
        releaseBox(box.id, holder);
        throw err;
      }
      if (!job) { releaseBox(box.id, holder); break; }   // queue empty — stop probing
      emit('claimed', job, { boxId: box.id });
      void runJob(job, policies.get(box.id) ?? lifetimePolicy())
        .catch(error => console.warn('[dispatcher] attempt failed:', (error as Error).message))
        .finally(() => releaseBox(box.id, holder));     // fire and forget; bounded by idle boxes
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
      // A microVM job's session is not a fleet box; its attempt is fenced by
      // its claim and its session is stopped by the overrun sweep.
      if (isMicrovmBoxId(job.boxId)) continue;
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
  // The microVM runner's own pass (lib/microvm-dispatcher.ts): runner='microvm'
  // jobs never reach a fleet box, so they are claimed on a separate tick.
  microvmTimer = setInterval(() => void dispatchMicrovmOnce(), TICK_MS);
  // Once at start-up: the SSM fallback for an unset runtime ARN / runs bucket,
  // and one line saying where each value (and lab_api_base) came from.
  void import('./microvm-dispatcher.js').then((m) => m.startMicrovmRunner())
    .catch((err) => console.warn('[dispatcher] microVM start-up failed:', (err as Error).message));
}

export function stopJobDispatcher(): void {
  if (timer) { clearInterval(timer); timer = null; }
  if (microvmTimer) { clearInterval(microvmTimer); microvmTimer = null; }
}

let microvmTimer: ReturnType<typeof setInterval> | null = null;

/** One microVM dispatch pass (docs/microvm-runner-design.md §3, §10). Never throws. */
export async function dispatchMicrovmOnce(): Promise<void> {
  try {
    const m = await import('./microvm-dispatcher.js');
    await m.startMicrovmRunner();
    await m.microvmDispatchPass(await m.defaultMicrovmDeps());
  } catch (err) {
    console.warn('[dispatcher] microVM pass failed:', (err as Error).message);
  }
}

/** Test/ops hook — run one dispatch pass immediately. */
export async function dispatchOnce(): Promise<void> {
  await tick();
}

/** Which boxes the dispatcher currently considers busy (for the Work UI). */
export function busyBoxes(): string[] {
  const ids = new Set(running);
  for (const [id, holders] of allHolds()) {
    if (holders.some((h) => h.startsWith(DISPATCH_HOLDER_PREFIX))) ids.add(id);
  }
  return [...ids].filter((id) => getBox(id) !== null);
}

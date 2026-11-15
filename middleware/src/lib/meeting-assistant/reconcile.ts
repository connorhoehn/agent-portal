// After a restart (audit M5). Runs live in memory, so a process that dies leaves records saying `listening` with nothing listening:
// the listening clock keeps counting, the call's tap keeps posting audio to a sink that no longer knows the token, and what was spent is
// never booked. This is the one function that puts that right, called at boot, every two minutes after that, and at shutdown (after the runs are closed). A record is touched only once its heartbeat is older than 90 seconds.
//
// For every record in `listening` or `paused` with no live run in this process:
//   (a) the open listening period closes at the last moment the process is known to have been alive (`session.lastAliveAt`, written by
//       the orchestrator's tick; `invitedAt` when there is none), so `listeningSeconds` stops growing;
//   (b) spend is settled from the persisted figures, once (`settleFinished` guards on `session.settled`), and extension holds are released;
//   (c) the call's media taps that point at this server's sink are deleted when media is configured (a failure is logged and tried again
//       on the next pass; the channel stays on the record until it works);
//   (d) a `listening` record becomes `paused` by `system` with one notice in the call chat; a call that is already over becomes `left` and
//       its minutes are written through the existing service. A `paused` record keeps its state (only (a) to (c) apply).
// Also here: a dismiss or call end that finds no run settles from the record (`settleFromRecord`), and the retention sweep ends records abandoned past the hard maximum (`endAbandonedCall`). Idempotent: a second run finds nothing to do. The clock is injectable.
import { meetingAssistantEnabled } from './index.js';
import { mediaConfig, tapArmer, type TapArmer } from './media.js';
import { postNoticeQuietly } from './chat.js';
import { NOVA_NAME } from './chat-types.js';
import { assistantStore } from './store-select.js';
import { settleFinished } from './spend.js';
import { periodOf, sessionOf, type AssistantRecord } from './types.js';
import type { AssistantStore } from './store.js';
import { assistantIntake } from './intake-select.js';

export const RESTART_NOTICE = `${NOVA_NAME} stopped listening because the service restarted. Anyone here can resume ${NOVA_NAME}.`;
/** How many records one reconcile looks at; a deployment never has this many calls open at once. */
export const RECONCILE_LIMIT = 500;

export interface ReconcileDeps {
  store: () => AssistantStore;
  clock: () => number;
  /** Does this process hold a live run for the call? */
  isRunning: (callId: string) => boolean;
  /** Has the call itself ended (no active seat, or no call)? Unknown means not over. */
  callOver: (callId: string) => Promise<boolean>;
  notice: (callId: string, text: string) => Promise<void>;
  /** Move the record to `left` and write its minutes (the existing call-end service). */
  endCall: (callId: string) => Promise<void>;
  /** The tap deleter, or null when media is not configured (or the feature is off). */
  taps: () => Pick<TapArmer, 'deleteStale'> | null;
  settle: typeof settleFinished;
  /** A record is orphaned only when its last heartbeat (or, with none, its invitation) is older than this. Default 90 s: three missed 30 s heartbeats. */
  staleAfterMs?: number;
  /** Reconcile only these calls (shutdown: the runs this process held). */
  only?: ReadonlySet<string>;
}

/** Another process serving the call writes a heartbeat at least every 30 s; a record quieter than this is orphaned. */
export const ORPHAN_AFTER_MS = 90_000;

export interface ReconcileResult { paused: number; left: number; settled: number; tapsDeleted: number }

async function defaultCallOver(callId: string): Promise<boolean> {
  try {
    const { callChatRuntime } = await import('../call-chat.js');
    const rt = callChatRuntime();
    if (!(await rt.lobbyOf(callId))) return true;
    return !(await rt.seatedUsers(callId)).some((u) => u.active);
  } catch { return false; }
}

async function defaultEndCall(callId: string): Promise<void> {
  const { onCallEnded } = await import('./minutes-service.js');
  const { assistantRuntime } = await import('./orchestrator.js');
  await onCallEnded(callId, { stop: (id) => assistantRuntime().stop(id), stopIntake: (id) => assistantIntake().stop(id) });
}

async function defaultDeps(): Promise<ReconcileDeps> {
  const { peekAssistantRuntime } = await import('./orchestrator.js');
  return {
    store: assistantStore, clock: Date.now, isRunning: (id) => peekAssistantRuntime()?.isRunning(id) ?? false,
    callOver: defaultCallOver, notice: (id, text) => postNoticeQuietly(id, text), endCall: defaultEndCall,
    // Deleting taps needs the feature's media settings; without them there is no tap of ours to delete.
    taps: () => (meetingAssistantEnabled() && mediaConfig() ? tapArmer() : null), settle: settleFinished,
  };
}

/** (a): close the open listening period at the last moment the process was alive. Returns the record as it now stands. */
async function closePeriod(store: AssistantStore, record: AssistantRecord, now: number, period?: number): Promise<AssistantRecord> {
  const s = sessionOf(record);
  if (s.listeningSince == null) return record;
  const aliveAt = Math.min(now, Math.max(s.listeningSince, s.lastAliveAt ?? record.invitedAt));
  const closed = s.listeningSeconds + (aliveAt - s.listeningSince) / 1000;
  return (await store.patchSession(record.callId, { listeningSeconds: closed, listeningSince: null }, period !== undefined ? { period } : undefined)) ?? record;
}

export async function reconcileAfterRestart(overrides: Partial<ReconcileDeps> = {}): Promise<ReconcileResult> {
  const deps = { ...(await defaultDeps()), ...overrides };
  const store = deps.store();
  const result: ReconcileResult = { paused: 0, left: 0, settled: 0, tapsDeleted: 0 };
  for (const listed of await store.listByState(['listening', 'paused'], RECONCILE_LIMIT)) {
    if (deps.isRunning(listed.callId)) continue;
    if (deps.only && !deps.only.has(listed.callId)) continue;
    const callId = listed.callId;
    try {
      const now = deps.clock();
      // With two processes on one store, a record the other process is serving keeps a fresh heartbeat: leave it alone.
      if (now - (sessionOf(listed).lastAliveAt ?? listed.invitedAt) <= (deps.staleAfterMs ?? ORPHAN_AFTER_MS)) continue;
      let record = await closePeriod(store, listed, now);
      let s = sessionOf(record);
      if (!s.settled) {
        await deps.settle({ callId, usageSeconds: s.usageSeconds, tokens: { input: s.tokensIn, output: s.tokensOut, cached: s.tokensCached }, sessionKind: s.sessionKind ?? 'scripted' }, now);
        if (sessionOf((await store.get(callId)) ?? record).settled) result.settled += 1;
      }
      const taps = s.channelArn ? deps.taps() : null;
      if (taps && s.channelArn) {
        if (await taps.deleteStale(s.channelArn)) { await store.patchSession(callId, { channelArn: '' }); result.tapsDeleted += 1; }
        else console.warn('[meeting-assistant] a tap left by an earlier process could not be deleted; trying again next boot');
      }
      record = (await store.get(callId)) ?? record; s = sessionOf(record);
      if (record.state === 'listening' || record.state === 'paused') {
        if (await deps.callOver(callId)) {
          if (meetingAssistantEnabled()) await deps.endCall(callId);
          else await store.transition(callId, { from: ['invited', 'listening', 'paused'], to: 'left', by: 'system', at: now });
          result.left += 1;
        } else if (record.state === 'listening') {
          // Conditional: of two processes reconciling at once, only one moves the record and posts the notice.
          const moved = await store.transition(callId, { from: ['listening'], to: 'paused', by: 'system', at: now });
          if (moved) { await deps.notice(callId, RESTART_NOTICE); result.paused += 1; }
        }
      }
    } catch (e) { console.warn(`[meeting-assistant] reconcile of a call failed (it is tried again next boot): ${(e as Error).message}`); }
  }
  return result;
}

/**
 * A dismiss or a call end that finds no run in this process (the process that held it died): book the call's used minutes from the
 * record and release the hold, as the reconcile would. Safe to repeat: a settled record is left alone. Never throws.
 */
export async function settleFromRecord(callId: string, overrides: Partial<Pick<ReconcileDeps, 'store' | 'clock' | 'settle'>> & { period?: number } = {}): Promise<void> {
  try {
    const store = (overrides.store ?? assistantStore)();
    const settle = overrides.settle ?? settleFinished;
    const now = (overrides.clock ?? Date.now)();
    const found = await store.get(callId);
    if (!found) return;
    // `period`: the leave this settles (a dismissal's own follow-up). A record already in a newer period is left alone.
    if (overrides.period !== undefined && periodOf(found) !== overrides.period) return;
    const record = await closePeriod(store, found, now, overrides.period);
    const s = sessionOf(record);
    if (s.settled) return;
    await settle({ callId, usageSeconds: s.usageSeconds, tokens: { input: s.tokensIn, output: s.tokensOut, cached: s.tokensCached }, sessionKind: s.sessionKind ?? 'scripted',
      ...(overrides.period !== undefined ? { period: overrides.period } : {}) }, now);
  } catch (e) { console.warn('[meeting-assistant] settling a call from its record failed', (e as Error).message); }
}

/**
 * The retention sweep's end for a record nothing has served for longer than any call can last: settle it from the record, then move it to
 * `left` as of its last heartbeat, so the ordinary retention rule counts from when it really stopped. A record that could not be settled
 * stays as it is and the next sweep tries again. Returns whether the record now has `left`.
 */
export async function endAbandonedCall(callId: string, at: number, overrides: Partial<Pick<ReconcileDeps, 'store' | 'clock' | 'settle'>> = {}): Promise<boolean> {
  const store = (overrides.store ?? assistantStore)();
  await settleFromRecord(callId, overrides);
  const record = await store.get(callId);
  if (!record || !sessionOf(record).settled) return false;
  return !!(await store.transition(callId, { from: ['invited', 'listening', 'paused'], to: 'left', by: 'system', at }));
}

/** How often a running server looks for records no process is serving. */
export const RECONCILE_EVERY_MS = 120_000;

/** Reconcile on a timer, not only at boot: a crash and a restart inside the heartbeat window leaves a record the boot pass skipped. Unref'd; returns the stopper. */
export function startReconcileTimer(everyMs: number = RECONCILE_EVERY_MS, run: () => Promise<unknown> = () => reconcileAfterRestart()): () => void {
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    void run().catch((e: unknown) => console.warn('[meeting-assistant] periodic reconcile failed', (e as Error).message)).finally(() => { busy = false; });
  }, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** Shutdown: close the runs this process holds the way a restart would find them, then reconcile. Never throws. */
export async function settleAtShutdown(): Promise<void> {
  try {
    const { peekAssistantRuntime } = await import('./orchestrator.js');
    const rt = peekAssistantRuntime();
    if (!rt || !rt.hasRuns()) return;
    const mine = new Set(rt.callIds());
    await rt.heartbeatAll();
    await rt.dispose();
    // Only this process's own runs, and now: their heartbeat is fresh because we just wrote it, not because someone else serves them.
    await reconcileAfterRestart({ staleAfterMs: -1, only: mine });
  } catch (e) { console.warn('[meeting-assistant] settling at shutdown failed', (e as Error).message); }
}

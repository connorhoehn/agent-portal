// Retention (docs/meeting-assistant-design.md, decision 9; audit M3). Every table of the feature is swept, by the call's age: a call
// older than MEETING_TRANSCRIPT_RETENTION_DAYS (30 by default), counted from when it ended (`leftAt`, else `invitedAt`), loses its
// lines, minutes (or tombstone), turns, actions and its assistant record, and Milo's own chat messages for it are replaced with the
// fixed line (the call chat's own message store keeps its own age limit: the Dynamo adapter's 90-day TTL, none in memory; this sweep does not change it). A call that
// is still `listening` or `paused` is not swept, unless nothing has served it for longer than the hard maximum plus a margin (it is then
// ended first, as of its last heartbeat). No audio exists to delete. The same sweep expires proposals whose 72 hours after the
// call are up (meeting consent); that only ends them, it never runs one.
import { config } from '../../config.js';
import type { AssistantStore } from './store.js';
import { assistantLimits } from './limits.js';
import { sessionOf } from './types.js';
import { expireDueProposals } from './proposals.js';

const DAY_MS = 86_400_000;
/** How many expired calls one sweep removes; the next hourly sweep takes the rest. */
export const SWEEP_CALLS_PER_RUN = 200;
/** A listening or paused record this much past the hard maximum with no heartbeat is orphaned for good. */
export const ABANDONED_MARGIN_MS = 30 * 60_000;

export function retentionDays(): number { return config.meetingAssistant?.transcriptRetentionDays ?? 30; }

export interface SweepOptions {
  /** Replace Milo's chat messages for a call; defaults to chat.ts (loaded on demand, so the store tests never pull the chat stack in). */
  eraseChat?: (callId: string) => Promise<unknown>;
  /** End an abandoned listening or paused record as of `at`; defaults to the reconcile's (loaded on demand). */
  endAbandoned?: (callId: string, at: number) => Promise<unknown>;
}

const defaultEndAbandoned = async (callId: string, at: number): Promise<unknown> => (await import('./reconcile.js')).endAbandonedCall(callId, at);

const defaultEraseChat = async (callId: string): Promise<unknown> => (await import('./chat.js')).eraseAssistantMessages(callId);

/**
 * Delete every line and every set of minutes older than the retention window, then every call that ended before it, whole.
 * Returns how many LINES were removed by the line sweep. A call whose chat messages could not be replaced keeps its record (its stored words already cleared),
 * so the next sweep tries the chat again.
 */
export async function sweepTranscripts(store: AssistantStore, nowMs: number = Date.now(), days: number = retentionDays(), opts: SweepOptions = {}): Promise<number> {
  const cutoff = nowMs - days * DAY_MS;
  // First, end what nothing serves any more, so the age rules below can see it.
  const abandonedBefore = nowMs - assistantLimits().hardMaxSeconds * 1000 - ABANDONED_MARGIN_MS;
  const endAbandoned = opts.endAbandoned ?? defaultEndAbandoned;
  for (const record of await store.listByState(['listening', 'paused'], SWEEP_CALLS_PER_RUN)) {
    const heartbeat = sessionOf(record).lastAliveAt ?? record.invitedAt;
    if (heartbeat >= abandonedBefore) continue;
    try { await endAbandoned(record.callId, Math.max(heartbeat, record.invitedAt)); } catch (e) { console.warn('[meeting-assistant] retention could not end an abandoned call', (e as Error).message); }
  }
  const lines = await store.sweepLines(cutoff);
  await store.sweepMinutes(cutoff);
  const eraseChat = opts.eraseChat ?? defaultEraseChat;
  for (const call of await store.expiredCalls(cutoff, SWEEP_CALLS_PER_RUN)) {
    try {
      // The stored words (lines, requests, tool arguments, result text) go first and for certain; only then the chat step, which may be down.
      // A call whose chat step fails keeps its record, emptied, and the next sweep tries the chat again.
      if ((await store.tombstoneMinutes(call.callId, 'system', nowMs)) === null) continue; // Milo was invited back meanwhile: not expired
      await eraseChat(call.callId);
      await store.purgeCall(call.callId);
    } catch (e) { console.warn('[meeting-assistant] retention could not remove a call', (e as Error).message); }
  }
  // Proposals left open after a call end 72 hours after it (proposals.ts); nothing runs on this timer, it only ends them.
  await expireDueProposals(store, nowMs);
  return lines;
}

let lastGoodSweepAt: number | null = null;
/** When the hourly sweep last finished without an error (epoch ms), or null if it has not yet. A reader that sees this fall behind knows stored words may be outliving the period. */
export function lastGoodRetentionSweepAt(): number | null { return lastGoodSweepAt; }

/** A repeated failure is logged again when its message changes, or after this long. */
export const FAILURE_RELOG_MS = 24 * 3_600_000;

/** Hourly sweep for a running server; unref'd so it never holds the process open. Returns the stopper. */
export function startRetentionSweep(store: AssistantStore, everyMs = 3_600_000, clock: () => number = Date.now): () => void {
  let lastMessage: string | null = null;
  let lastLoggedAt = 0;
  const run = () => { void sweepTranscripts(store).then(() => { lastGoodSweepAt = clock(); lastMessage = null; }, (e: unknown) => {
    // A deployment that never ran the migration has no tables: say so once, and again only if the message changes or a day has passed.
    const message = (e as Error).message;
    const now = clock();
    if (message === lastMessage && now - lastLoggedAt < FAILURE_RELOG_MS) return;
    lastMessage = message; lastLoggedAt = now;
    console.warn('[meeting-assistant] retention sweep failed (will keep trying)', message);
  }); };
  const timer = setInterval(run, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

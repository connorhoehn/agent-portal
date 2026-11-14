// Retention (docs/meeting-assistant-design.md, decision 9; audit M3). Every table of the feature is swept, by the call's age: a call
// older than MEETING_TRANSCRIPT_RETENTION_DAYS (30 by default), counted from when it ended (`leftAt`, else `invitedAt`), loses its
// lines, minutes (or tombstone), turns, actions and its assistant record, and Nova's own chat messages for it are replaced with the
// fixed line (the call chat's own message store keeps its own age limit: the Dynamo adapter's 90-day TTL, none in memory; this sweep does not change it). A call that
// is still `listening` or `paused` is never swept. No audio exists to delete.
import { config } from '../../config.js';
import type { AssistantStore } from './store.js';

const DAY_MS = 86_400_000;
/** How many expired calls one sweep removes; the next hourly sweep takes the rest. */
export const SWEEP_CALLS_PER_RUN = 200;

export function retentionDays(): number { return config.meetingAssistant?.transcriptRetentionDays ?? 30; }

export interface SweepOptions {
  /** Replace Nova's chat messages for a call; defaults to chat.ts (loaded on demand, so the store tests never pull the chat stack in). */
  eraseChat?: (callId: string) => Promise<unknown>;
}

const defaultEraseChat = async (callId: string): Promise<unknown> => (await import('./chat.js')).eraseAssistantMessages(callId);

/**
 * Delete every line and every set of minutes older than the retention window, then every call that ended before it, whole.
 * Returns how many LINES were removed by the line sweep. A call whose chat messages could not be replaced keeps its record,
 * so the next sweep tries again.
 */
export async function sweepTranscripts(store: AssistantStore, nowMs: number = Date.now(), days: number = retentionDays(), opts: SweepOptions = {}): Promise<number> {
  const cutoff = nowMs - days * DAY_MS;
  const lines = await store.sweepLines(cutoff);
  await store.sweepMinutes(cutoff);
  const eraseChat = opts.eraseChat ?? defaultEraseChat;
  for (const call of await store.expiredCalls(cutoff, SWEEP_CALLS_PER_RUN)) {
    try {
      await eraseChat(call.callId);
      await store.purgeCall(call.callId);
    } catch (e) { console.warn('[meeting-assistant] retention could not remove a call', (e as Error).message); }
  }
  return lines;
}

/** Hourly sweep for a running server; unref'd so it never holds the process open. Returns the stopper. */
export function startRetentionSweep(store: AssistantStore, everyMs = 3_600_000): () => void {
  let missingLogged = false;
  const run = () => { void sweepTranscripts(store).catch((e: unknown) => {
    // A deployment that never ran the migration has no tables: say so once, not every hour.
    if (missingLogged) return;
    missingLogged = true;
    console.warn('[meeting-assistant] retention sweep failed (will keep trying quietly)', (e as Error).message);
  }); };
  const timer = setInterval(run, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

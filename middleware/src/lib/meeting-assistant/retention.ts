// Transcript retention (docs/meeting-assistant-design.md, decision 9): lines are kept
// MEETING_TRANSCRIPT_RETENTION_DAYS days (30 by default), then deleted. No audio exists to delete.
import { config } from '../../config.js';
import type { AssistantStore } from './store.js';

const DAY_MS = 86_400_000;

export function retentionDays(): number { return config.meetingAssistant?.transcriptRetentionDays ?? 30; }

/** Delete every line older than the retention window. Returns how many were removed. */
export async function sweepTranscripts(store: AssistantStore, nowMs: number = Date.now(), days: number = retentionDays()): Promise<number> {
  return store.sweepLines(nowMs - days * DAY_MS);
}

/** Hourly sweep for a running server; unref'd so it never holds the process open. Returns the stopper. */
export function startRetentionSweep(store: AssistantStore, everyMs = 3_600_000): () => void {
  const timer = setInterval(() => { void sweepTranscripts(store).catch((e: unknown) => console.warn('[meeting-assistant] retention sweep failed', e)); }, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

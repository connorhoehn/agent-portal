// The meeting assistant's background sweeps, started once at boot whether or not the feature flag is on (audit M4): retention (every
// table, by the call's age) and turn expiry. Turning the feature off must not keep stored words for ever, so neither is gated on the
// flag. A third tries failed minutes writes again, within the hard cap on writer runs (minutes-service.ts AUTO_ATTEMPTS).
// All are cheap no-ops on empty tables, and a deployment that never ran the migration (no tables) logs one line, not one per run.
import { startRetentionSweep } from './retention.js';
import { startTurnSweep } from './orchestrator.js';
import { startMinutesRetrySweep } from './minutes-service.js';
import { assistantStore } from './store-select.js';

export interface SweepStarters {
  retention: (store: ReturnType<typeof assistantStore>) => () => void;
  turns: () => () => void;
  minutes: () => () => void;
  store: () => ReturnType<typeof assistantStore>;
}

/** Start the sweeps; returns one stopper. Never throws. */
export function startMeetingAssistantSweeps(starters: Partial<SweepStarters> = {}): () => void {
  const retention = starters.retention ?? ((store) => startRetentionSweep(store));
  const turns = starters.turns ?? (() => startTurnSweep());
  const minutes = starters.minutes ?? (() => startMinutesRetrySweep());
  const stoppers: Array<() => void> = [];
  try { stoppers.push(retention((starters.store ?? assistantStore)())); } catch (e) { console.warn('[meeting-assistant] retention sweep not started', (e as Error).message); }
  try { stoppers.push(turns()); } catch (e) { console.warn('[meeting-assistant] turn sweep not started', (e as Error).message); }
  try { stoppers.push(minutes()); } catch (e) { console.warn('[meeting-assistant] minutes retry sweep not started', (e as Error).message); }
  return () => { for (const stop of stoppers) stop(); };
}

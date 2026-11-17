// "Starting soon" (docs/interviews-tenant-plan.md row I5.6): which rounds are inside the window before their start, and who has
// not yet been rung for that start. Pure: the clock and what has been rung are arguments; soon-sweep.ts owns the timer.
//
// A round rings its lead and its panel once each, SOON_MINUTES before it starts, while it is `accepted` or `ready`. A ring is
// keyed by the round, the person and the scheduled instant, so moving the time rings again for the new one, and a panel member
// added after the first ring is rung on the next tick for the same time.
import type { Interview } from './types.js';

/** How long before the start the bell rings. */
export const SOON_MINUTES = 15;

const RINGING_STATES: ReadonlySet<string> = new Set(['accepted', 'ready']);

export interface DueRing {
  interview: Interview;
  userId: string;
  /** Round + person + scheduled instant: the once-only key. */
  key: string;
}

export const ringKey = (interviewId: string, userId: string, scheduledAt: string): string => `${interviewId}|${userId}|${scheduledAt}`;

/** The rings due at `nowMs`: a start in the future and at most SOON_MINUTES away, not rung for before. */
export function dueRings(interviews: readonly Interview[], nowMs: number, rung: ReadonlySet<string>, windowMinutes = SOON_MINUTES): DueRing[] {
  const out: DueRing[] = [];
  for (const interview of interviews) {
    if (!interview.scheduledAt || !RINGING_STATES.has(interview.state)) continue;
    const start = Date.parse(interview.scheduledAt);
    if (!Number.isFinite(start)) continue;
    const ahead = start - nowMs;
    if (ahead <= 0 || ahead > windowMinutes * 60_000) continue;
    for (const userId of new Set([interview.leadId, ...interview.panelIds])) {
      const key = ringKey(interview.id, userId, interview.scheduledAt);
      if (!rung.has(key)) out.push({ interview, userId, key });
    }
  }
  return out;
}

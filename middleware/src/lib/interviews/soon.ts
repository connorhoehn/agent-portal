// "Starting soon" (docs/interviews-tenant-plan.md row I5.6): which rounds are inside the window before their start, and who has
// not yet been rung for that start. Pure: the clock and what has been rung are arguments; soon-sweep.ts owns the timer.
//
// A round rings its lead and its panel once each, the deployment's lead (soonMinutes, default SOON_MINUTES) before it starts, while it is `accepted` or `ready`. A ring is
// keyed by the round, the person and the scheduled instant, so moving the time rings again for the new one, and a panel member
// added after the first ring is rung on the next tick for the same time.
import type { Interview } from './types.js';

/** How long before the start the bell rings, when the deployment sets nothing (row I6.4). */
export const SOON_MINUTES = 15;

// INTERVIEWS_SOON_MINUTES (row I6.4, "notice lead time", read here as this bell's lead): a whole number of minutes from
// 5 to 120. Read on every sweep, the way retention/periods.ts reads its settings: a value that is not a whole number in
// range falls back to the default and says so once per value. Never throws.
export const SOON_MINUTES_SETTING = 'INTERVIEWS_SOON_MINUTES';
export const SOON_MINUTES_RANGE = Object.freeze({ min: 5, max: 120 });

const warned = new Set<string>();
/** Test seam: forget which fallbacks were already reported. */
export function resetSoonWarnings(): void { warned.clear(); }

/** The lead this deployment rings with now. */
export function soonMinutes(env: NodeJS.ProcessEnv = process.env, warn: (line: string) => void = (l) => console.warn(l)): number {
  const raw = env[SOON_MINUTES_SETTING]?.trim();
  if (!raw) return SOON_MINUTES;
  const n = Number(raw);
  const { min, max } = SOON_MINUTES_RANGE;
  if (/^\d+$/.test(raw) && Number.isSafeInteger(n) && n >= min && n <= max) return n;
  const once = `${SOON_MINUTES_SETTING}=${raw}`;
  if (!warned.has(once)) {
    warned.add(once);
    warn(`[interviews] ${SOON_MINUTES_SETTING} must be a whole number from ${min} to ${max}; using the default, ${SOON_MINUTES}.`);
  }
  return SOON_MINUTES;
}

const RINGING_STATES: ReadonlySet<string> = new Set(['accepted', 'ready']);

export interface DueRing {
  interview: Interview;
  userId: string;
  /** Round + person + scheduled instant: the once-only key. */
  key: string;
}

export const ringKey = (interviewId: string, userId: string, scheduledAt: string): string => `${interviewId}|${userId}|${scheduledAt}`;

/** The rings due at `nowMs`: a start in the future and at most `windowMinutes` away, not rung for before. */
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

// The overdue-scorecard reminder (gap audit 2026-11-20, "Thin scheduling"; ledger row C-17): a while after a round ended,
// each seat whose scorecard is still not in is rung once more. Pure: the clock and what has been rung are arguments;
// overdue-sweep.ts owns the timer, on the "starting soon" pattern (soon.ts, soon-sweep.ts).
//
// Only an `ended` round rings: a cancelled one never does, and one every seat has scored has moved on to `scored`. A seat
// that has submitted any version is not rung. A ring is keyed by the round, the person and the instant it ended, so it is
// rung once; the bell's own id carries the round and the person, so the inbox keeps it once across a restart.
import type { Interview, Scorecard } from './types.js';
import { seatedOf } from './scorecard.js';

/** How many hours after the end the reminder rings, when the deployment sets nothing. */
export const OVERDUE_HOURS = 24;

// INTERVIEWS_SCORECARD_OVERDUE_HOURS: a whole number of hours from 1 to 336 (two weeks). Read on every sweep, as
// soon.ts reads its lead: a value that is not a whole number in range falls back to the default and says so once per
// value. Never throws.
export const OVERDUE_HOURS_SETTING = 'INTERVIEWS_SCORECARD_OVERDUE_HOURS';
export const OVERDUE_HOURS_RANGE = Object.freeze({ min: 1, max: 336 });

const warned = new Set<string>();
/** Test seam: forget which fallbacks were already reported. */
export function resetOverdueWarnings(): void { warned.clear(); }

/** The delay this deployment reminds with now, in hours. */
export function overdueHours(env: NodeJS.ProcessEnv = process.env, warn: (line: string) => void = (l) => console.warn(l)): number {
  const raw = env[OVERDUE_HOURS_SETTING]?.trim();
  if (!raw) return OVERDUE_HOURS;
  const n = Number(raw);
  const { min, max } = OVERDUE_HOURS_RANGE;
  if (/^\d+$/.test(raw) && Number.isSafeInteger(n) && n >= min && n <= max) return n;
  const once = `${OVERDUE_HOURS_SETTING}=${raw}`;
  if (!warned.has(once)) {
    warned.add(once);
    warn(`[interviews] ${OVERDUE_HOURS_SETTING} must be a whole number from ${min} to ${max}; using the default, ${OVERDUE_HOURS}.`);
  }
  return OVERDUE_HOURS;
}

export interface OverdueRing {
  interview: Interview;
  userId: string;
  /** Round + person + the instant it ended: the once-only key. */
  key: string;
}

export const overdueKey = (interviewId: string, userId: string, endedAt: string): string => `${interviewId}|${userId}|${endedAt}`;

/** The reminders due at `nowMs`: an ended round at least `hours` past its end, each seat without a scorecard, not rung for before. */
export function dueOverdue(interviews: readonly Interview[], scorecards: readonly Pick<Scorecard, 'interviewId' | 'interviewerId'>[], nowMs: number, rung: ReadonlySet<string>, hours = OVERDUE_HOURS): OverdueRing[] {
  const out: OverdueRing[] = [];
  for (const interview of interviews) {
    if (interview.state !== 'ended' || !interview.endedAt) continue;
    const ended = Date.parse(interview.endedAt);
    if (!Number.isFinite(ended) || nowMs - ended < hours * 3_600_000) continue;
    const authors = new Set(scorecards.filter((s) => s.interviewId === interview.id).map((s) => s.interviewerId));
    for (const userId of new Set(seatedOf(interview))) {
      if (authors.has(userId)) continue;
      const key = overdueKey(interview.id, userId, interview.endedAt);
      if (!rung.has(key)) out.push({ interview, userId, key });
    }
  }
  return out;
}

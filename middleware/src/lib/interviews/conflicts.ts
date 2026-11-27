// Double-booking (gap audit 2026-11-20, "Thin scheduling"; ledger row C-17). A warning, never a refusal: assigning,
// re-seating or timing a round still succeeds, and its answer and its read carry the seats that are already booked
// elsewhere at that time, so the recruiter can choose to change it.
//
// A seat conflicts when the same person holds a seat (lead or panel) on another round whose scheduled window, its start
// to its start plus its minutes, overlaps this round's. Windows are half-open: a round from 14:00 to 15:00 and one from
// 15:00 to 16:00 do not conflict. Only rounds still to run or live count; a cancelled, declined, ended, scored or
// reviewed round holds nobody's time.
//
// Pure: the rounds come in as an argument (the caller's visible world, so nothing is named that the caller could not
// already read), and a conflict says nothing about the other round's candidate.

import type { Interview, InterviewState } from './types.js';

/** The states in which a round holds its seats' time. */
const HOLDING: ReadonlySet<InterviewState> = new Set(['assigned', 'accepted', 'ready', 'live']);

/** One seat already booked elsewhere: who, and the other round's id and window. No candidate. */
export interface SeatConflict {
  person: { id: string; name: string };
  interviewId: string;
  scheduledAt: string;
  minutes: number;
}

type Windowed = Pick<Interview, 'id' | 'leadId' | 'panelIds' | 'scheduledAt' | 'minutes' | 'state'>;

/** A round's window in epoch milliseconds, or null without a usable time. */
function windowOf(i: Pick<Interview, 'scheduledAt' | 'minutes'>): [number, number] | null {
  if (!i.scheduledAt) return null;
  const start = Date.parse(i.scheduledAt);
  if (!Number.isFinite(start)) return null;
  return [start, start + Math.max(i.minutes, 0) * 60_000];
}

/** Do the two windows share any time? Touching ends do not. */
export function windowsOverlap(a: Pick<Interview, 'scheduledAt' | 'minutes'>, b: Pick<Interview, 'scheduledAt' | 'minutes'>): boolean {
  const wa = windowOf(a);
  const wb = windowOf(b);
  if (!wa || !wb) return false;
  return wa[0] < wb[1] && wb[0] < wa[1];
}

/**
 * The seats of `round` already held on another round at an overlapping time, the lead's first, each other round once
 * per person, earliest first. Empty when the round has no time or no longer holds its seats' time.
 */
export function seatConflicts(round: Windowed, others: readonly Windowed[], nameOf: (id: string) => string): SeatConflict[] {
  if (!HOLDING.has(round.state) || !windowOf(round)) return [];
  const out: SeatConflict[] = [];
  for (const userId of new Set([round.leadId, ...round.panelIds])) {
    const clashes = others
      .filter((o) => o.id !== round.id && HOLDING.has(o.state) && (o.leadId === userId || o.panelIds.includes(userId)) && windowsOverlap(round, o))
      .sort((a, b) => a.scheduledAt!.localeCompare(b.scheduledAt!));
    for (const o of clashes) out.push({ person: { id: userId, name: nameOf(userId) }, interviewId: o.id, scheduledAt: o.scheduledAt!, minutes: o.minutes });
  }
  return out;
}

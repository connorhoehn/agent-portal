// The rows' models for My interviews and Upcoming (UI round 2, lane DESK-B): which tab or filter a round is in, what
// is counted, and the order. A round whose interview is live is shown first in its list with "Live now" and a way to
// join it (the owner's rule for every live call).
import { deskOrder, upcomingOrder, type InterviewRow } from './interviews.ts';

export const isLive = (row: Pick<InterviewRow, 'state'>): boolean => row.state === 'live';

/** Live rounds first, whatever else the order is. */
export const liveFirst = (a: Pick<InterviewRow, 'state'>, b: Pick<InterviewRow, 'state'>): number => Number(isLive(b)) - Number(isLive(a));

// ── My interviews: four tabs of the Pages table, and "Done" so a finished round stays reachable ───────────────────────────
export type DeskTab = 'to-accept' | 'to-prepare' | 'upcoming' | 'scorecard-due' | 'done';
export const DESK_TABS: ReadonlyArray<{ value: DeskTab; label: string }> = [
  { value: 'to-accept', label: 'To accept' },
  { value: 'to-prepare', label: 'To prepare' },
  { value: 'upcoming', label: 'Upcoming' },
  { value: 'scorecard-due', label: 'Scorecards due' },
  { value: 'done', label: 'Done' },
];

/** The one tab a round is in (a declined or cancelled round is in none). A live round is always in Upcoming, where it is first. */
export function deskTabOf(row: Pick<InterviewRow, 'bucket' | 'state'>): DeskTab | null {
  if (row.bucket === 'closed') return null;
  if (isLive(row) && row.bucket !== 'to-accept') return 'upcoming';
  return row.bucket === 'to-accept' || row.bucket === 'to-prepare' || row.bucket === 'upcoming' || row.bucket === 'scorecard-due' || row.bucket === 'done' ? row.bucket : null;
}

export function deskTabCounts(rows: readonly InterviewRow[]): Record<DeskTab, number> {
  const counts: Record<DeskTab, number> = { 'to-accept': 0, 'to-prepare': 0, upcoming: 0, 'scorecard-due': 0, done: 0 };
  for (const r of rows) { const t = deskTabOf(r); if (t) counts[t] += 1; }
  return counts;
}

/** The tab shown first: Upcoming while a round is live (it is first there), else the first with rows, else Upcoming. */
export function firstDeskTab(counts: Record<DeskTab, number>, hasLive = false): DeskTab {
  if (hasLive && counts.upcoming > 0) return 'upcoming';
  return DESK_TABS.find((t) => counts[t.value] > 0)?.value ?? 'upcoming';
}

export const deskTabRows = (rows: readonly InterviewRow[], tab: DeskTab): InterviewRow[] =>
  rows.filter((r) => deskTabOf(r) === tab).sort((a, b) => liveFirst(a, b) || deskOrder(a, b));

// ── Upcoming: rounds that have not finished, soonest first; the finished ones are one choice away ─────────────────────────
export type UpcomingShow = 'not-finished' | 'finished';
export const isFinishedRound = (row: Pick<InterviewRow, 'state'>): boolean => row.state === 'ended' || row.state === 'scored' || row.state === 'reviewed';

export function upcomingRows(rows: readonly InterviewRow[], show: UpcomingShow): InterviewRow[] {
  return rows
    .filter((r) => r.state !== 'declined' && r.state !== 'cancelled' && isFinishedRound(r) === (show === 'finished'))
    .sort((a, b) => liveFirst(a, b) || (show === 'finished' ? (b.scheduledAt ?? '').localeCompare(a.scheduledAt ?? '') : upcomingOrder(a, b)));
}

export const finishedCount = (rows: readonly InterviewRow[]): number => upcomingRows(rows, 'finished').length;

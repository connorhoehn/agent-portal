// Pure status filter for the Findings page. No React — testable under
// node:test like queueMath/rediscoveryFormat.
//
// The list already asks the server to filter by `status` (the query param on
// GET /api/work/findings), but that leaves the rendered list at the mercy of
// whatever the last resolved fetch returned — a stale response landing after
// a fast filter click would silently show the wrong bucket with no code path
// that would ever catch it. Filtering the fetched page again, client-side,
// with a function pure enough to unit-test means the status pill's pressed
// state and the rows on screen can never disagree.

export type FindingStatus = 'open' | 'promoted' | 'resolved' | 'dismissed';

export interface FindingLike {
  status: string;
}

/** Keep only findings whose status matches the selected filter. */
export function filterFindings<T extends FindingLike>(findings: T[], status: FindingStatus): T[] {
  return findings.filter((f) => f.status === status);
}

/** Sweep id → the human title an operator reads. Kept alongside the human
 *  names the SWEEP_LABELS table in workShared.tsx already carries — this is
 *  the pure half (no React), so it can be unit-tested and reused by any
 *  group heading that only has a raw sweep id, not a Finding object. */
const SWEEP_TITLES: Record<string, string> = {
  'bus_factor': 'Bus factor',
  'stale_docs': 'Stale docs',
  'orphan_decisions': 'Orphan decisions',
  'lab-signal': 'Lab signals',
};

/** Title-case a raw sweep id ("new_sweep_kind" / "new-sweep-kind" →
 *  "New sweep kind") — the fallback for any sweep the table above doesn't
 *  yet name, so a group heading never prints a raw snake/kebab id. */
function titleCaseSweepId(id: string): string {
  const words = id.split(/[_-]+/).filter(Boolean);
  if (words.length === 0) return id;
  return words.map((w, i) => (i === 0 ? w[0]!.toUpperCase() + w.slice(1) : w)).join(' ');
}

/** The human label for a sweep group heading — a named sweep, or a
 *  title-cased fallback so an unrecognised id still reads as words. */
export function sweepLabel(sweep: string): string {
  return SWEEP_TITLES[sweep] ?? titleCaseSweepId(sweep);
}

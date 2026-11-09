// The Graph updates status chips (UX walk, 9 November 2026: "all" read as a
// chip that does nothing). Every chip says what it shows: "all" carries the
// total, a status its count, the selected chip its state as the hover title,
// and a status with nothing in it is off with why — counts are only known
// while every update is loaded, so a filtered view leaves the others on.
// Clicking the selected status goes back to all. No React — node:test runs it.

export type GraphUpdatesFilter = 'all' | 'applied' | 'pending' | 'rejected' | 'failed';
export const GRAPH_UPDATES_FILTERS: readonly GraphUpdatesFilter[] = ['all', 'applied', 'pending', 'rejected', 'failed'];

export interface StatusChip { label: string; title: string; disabled: boolean; next: GraphUpdatesFilter }

export function statusChip(f: GraphUpdatesFilter, active: GraphUpdatesFilter, counts: Readonly<Record<string, number>> | null): StatusChip {
  const known = active === 'all' && counts != null;
  const total = known ? Object.values(counts).reduce((a, b) => a + b, 0) : null;
  const n = f === 'all' ? total : known ? counts[f] ?? 0 : null;
  const label = n == null ? f : `${f} (${n})`;
  if (f === active) {
    return { label, title: f === 'all' ? 'Showing every graph update' : `Showing ${f} updates; click to show all`, disabled: false, next: 'all' };
  }
  if (n === 0 && f !== 'all') return { label, title: `No ${f} graph updates`, disabled: true, next: f };
  return { label, title: f === 'all' ? 'Show every graph update' : `Show only ${f} updates`, disabled: false, next: f };
}

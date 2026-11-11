// Who would receive a proposal: the reach block of GET /api/runbooks/proposals/:pid, in words.
// Pure, so the sentences are testable without a render.

export interface ReachItem {
  id: string;
  key: string | null;
  title: string;
  initiative: { id: string; name: string };
  /** `chosen`: given to a run of the item. `passed_over`: matched, but lost on the two-runbook limit. */
  outcome: 'chosen' | 'passed_over';
}

export interface ProposalReach {
  mode: 'receive' | 'lose' | 'gain';
  items: ReachItem[];
  total: number;
  scanned: number;
  capped: boolean;
}

export const REACH_EMPTY = 'No open work item would be given this runbook today.';
const REACH_EMPTY_LOSE = 'No open work item is given this runbook today, so retiring it takes it from none.';

export function reachEmpty(r: ProposalReach): string {
  return r.mode === 'lose' ? REACH_EMPTY_LOSE : REACH_EMPTY;
}

export function reachTitle(r: ProposalReach): string {
  return r.mode === 'lose' ? 'Would lose it' : r.mode === 'gain' ? 'Would gain it' : 'Would be given to';
}

/** The line under the table: how many there are, whether the list is cut, whether the scan was. */
export function reachNote(r: ProposalReach): string | null {
  const parts: string[] = [];
  if (r.total > r.items.length) parts.push(`Showing ${r.items.length} of ${r.total} open work items.`);
  if (r.capped) parts.push(`Only the ${r.scanned} most recently updated open work items were checked, so there may be more.`);
  return parts.length ? parts.join(' ') : null;
}

export function outcomeLabel(o: ReachItem['outcome']): string {
  return o === 'chosen' ? 'Given' : 'Passed over, two others rank higher';
}

export function reachItemName(i: ReachItem): string {
  return i.key ? `${i.key} ${i.title}` : i.title;
}

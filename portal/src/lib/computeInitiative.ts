// Pure helpers for showing an initiative's charged computers on
// ProjectDetailPage. Split out from the rail component so the filtering and
// truncation logic can be unit-tested without a ComputeProvider or DOM.

import type { Computer } from '@connorhoehnslalom/ui-components/compute';

/** Computers charged to this initiative, in a stable, readable order:
 *  running first (that's the thing you'd click through to watch), then
 *  everything else newest-active first. */
export function computersForInitiative(computers: Computer[], initiativeId: string | undefined): Computer[] {
  if (!initiativeId) return [];
  return computers
    .filter((c) => c.projectId === initiativeId)
    .slice()
    .sort((a, b) => {
      const aRunning = a.status === 'running' ? 0 : 1;
      const bRunning = b.status === 'running' ? 0 : 1;
      if (aRunning !== bRunning) return aRunning - bRunning;
      return (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? '');
    });
}

/** One-line, ellipsis-truncated task text for a fixed-width row. */
export function truncateTask(text: string | undefined, max = 60): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

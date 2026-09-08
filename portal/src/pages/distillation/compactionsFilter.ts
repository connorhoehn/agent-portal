// Pure filter for the Compactions table — split out of CompactionsPage.tsx
// so the table's Merge/Status facets can narrow the row list WITHOUT also
// narrowing what `<CompactionFlow>` sees (defect #15, org-leader/DEFECTS.md
// #15): the ladder's `latestJobFor(level, jobs)` needs the full job history
// to find each level's most recent run, so the page now fetches jobs
// unfiltered once and applies this helper only to the table's own data,
// while the flow keeps the full list.
import type { CompactionJob } from './types';

export function filterCompactionJobs(
  jobs: CompactionJob[],
  levelFilter: string,
  statusFilter: string,
): CompactionJob[] {
  return jobs.filter((j) => (levelFilter === 'all' || j.level === levelFilter)
    && (statusFilter === 'all' || j.status === statusFilter));
}

import type { CollectionGrammar } from '../../components/collections/collectionCommands.ts';

export const RUN_REPORT_FILTER_KEYS = ['executor', 'initiative', 'outcome', 'debrief'] as const;

// These are the same values as the Runs toolbar and /api/run-reports. The
// pipeline ledger's status/kind grammar describes a different collection.
const FILTERS = {
  failed: ['outcome', 'failed'], done: ['outcome', 'done'], cancelled: ['outcome', 'cancelled'],
  'needs review': ['outcome', 'needs-review'],
  queue: ['executor', 'fleet'], local: ['executor', 'local'], bot: ['executor', 'governed,mock'],
  microvm: ['executor', 'microvm'],
  'filed a runbook': ['debrief', 'filed'], 'debrief skipped': ['debrief', 'skipped'],
  'debrief not asked': ['debrief', 'none'],
} as const;

export const RUN_REPORT_GRAMMAR: CollectionGrammar = {
  noun: 'runs', filters: Object.fromEntries(Object.keys(FILTERS).map(phrase => [phrase, phrase])),
};

/** One URL update preserves the other toolbar filters; reset clears the title
 * search as well, without relying on queued React Router updates. */
export function runReportCommandFilter(previous: URLSearchParams, filter: string): URLSearchParams {
  const next = new URLSearchParams(previous);
  if (!filter) {
    for (const key of [...RUN_REPORT_FILTER_KEYS, 'q']) next.delete(key);
    return next;
  }
  if (!Object.hasOwn(FILTERS, filter)) throw new Error('Unknown run filter. No filters were changed.');
  const [key, value] = FILTERS[filter as keyof typeof FILTERS];
  next.set(key, value);
  return next;
}

// The bounded command grammars for the Automate collections (Inbox's recent
// runs, the Runs queue, Findings and Graph updates) and the pure row filters
// their composers share with the visible search boxes. No React — testable
// under node:test. Every phrase maps to a control the page already shows; none
// requeues, promotes, dismisses or decides anything.
import type { CollectionGrammar } from '../../components/collections/collectionCommands.ts';
import type { Job } from './workShared';

/** Inbox → Recent runs: search and open only (the section has no filter). */
export const INBOX_RUNS_GRAMMAR: CollectionGrammar = { noun: 'runs' };

/** Runs → the queue table; phrases are the State chips (All is `reset`). */
export const QUEUE_GRAMMAR: CollectionGrammar = {
  noun: 'runs',
  filters: { queued: 'queued', running: 'running', 'awaiting review': 'awaiting_review', failed: 'failed', done: 'done' },
};

/** Findings → the status chips (open is the default, so `reset` returns there). */
export const FINDINGS_GRAMMAR: CollectionGrammar = {
  noun: 'findings',
  filters: { open: 'open', promoted: 'promoted', resolved: 'resolved', dismissed: 'dismissed' },
};

/** Graph updates → the status chips (All is `reset`). */
export const GRAPH_UPDATES_GRAMMAR: CollectionGrammar = {
  noun: 'graph updates',
  filters: { applied: 'applied', pending: 'pending', rejected: 'rejected', failed: 'failed' },
};

/** Case-insensitive substring match across the given fields; an empty query matches. */
export function matchesText(fields: ReadonlyArray<string | null | undefined>, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || fields.some((field) => !!field && field.toLowerCase().includes(q));
}

/** What a run's search box (and `search runs for …`) reads. */
export function matchesJob(job: Job, query: string): boolean {
  return matchesText([job.id, job.title, job.botName, job.payload?.workItemTitle, job.payload?.initiativeName], query);
}

/** Inbox's Recent runs: the newest finished runs among the loaded page that match the search. */
export function recentFinishedRuns(jobs: readonly Job[], query: string, limit = 4): Job[] {
  return jobs.filter((job) => job.finishedAt && matchesJob(job, query))
    .sort((a, b) => b.finishedAt!.localeCompare(a.finishedAt!))
    .slice(0, limit);
}

/** The adapter's `reset` passes '' — each page's own "no restriction" value. */
export const queueFilterValue = (value: string): string => value || 'all';
export const findingStatusValue = (value: string): string => value || 'open';
export const graphUpdatesFilterValue = (value: string): string => value || 'all';

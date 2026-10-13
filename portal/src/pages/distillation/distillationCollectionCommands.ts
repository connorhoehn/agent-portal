// The distillation list rails' command composers. Each speaks the shared
// bounded grammar over the rail's own controlled state (its search, one
// filter from its filter popover, refresh, reset) and opens one row of the
// CURRENT list by exact ID or title. Nothing here compacts, reviews,
// promotes, dismisses or asks an agent anything; the record's own explain
// composer stays the only composer while a record is open.
import type { CollectionCommandAdapter } from '../../components/collections/CollectionCommandHost.tsx';
import { collectionCommandAdapter, resolveCollectionTarget } from '../../components/collections/collectionCommands.ts';

type Row = { id: string; title: string };

/** Lifecycle phrases of the guides view's filter (LIFECYCLE_OPTIONS). */
export const KNOWLEDGE_LIFECYCLE_FILTERS: Record<string, string> = { draft: 'draft', published: 'published', retired: 'retired' };

export function knowledgeCommandAdapter(view: 'guides' | 'patterns' | 'notes', noun: string, rows: readonly Row[], controls: {
  setQuery(value: string): void;
  /** Lifecycle on the guides view; '' clears every rail filter. */
  setFilter(value: string): void;
  refresh(): void;
  openItem(id: string): void;
}): CollectionCommandAdapter {
  return collectionCommandAdapter({ noun, ...(view === 'guides' ? { filters: KNOWLEDGE_LIFECYCLE_FILTERS } : {}) }, {
    id: 'distillation-knowledge-commands',
    label: 'Knowledge',
    setQuery: controls.setQuery,
    setFilter: controls.setFilter,
    refresh: controls.refresh,
    scopeNote: `Search runs the explorer's ${noun} search${view === 'guides' ? '; lifecycle filters the loaded rows' : ''}. Open uses one exact listed ID or title. Commands never publish, retire or edit knowledge.`,
    open(target) {
      const row = resolveCollectionTarget(target, rows);
      controls.openItem(row.id);
      return `Opened ${row.title}.`;
    },
  });
}

/** Status phrases of the runs rail's filter (STATUS_FILTERS). */
export const RUN_STATUS_FILTERS: Record<string, string> = { queued: 'queued', running: 'running', completed: 'succeeded', failed: 'failed' };

export function activityRunsCommandAdapter(rows: readonly Row[], controls: {
  setQuery(value: string): void;
  setStatus(value: string | null): void;
  refresh(): void;
  openRun(id: string): void;
}): CollectionCommandAdapter {
  return collectionCommandAdapter({ noun: 'runs', filters: RUN_STATUS_FILTERS }, {
    id: 'distillation-runs-commands',
    label: 'Compaction runs',
    setQuery: controls.setQuery,
    setFilter: (value) => controls.setStatus(value || null),
    refresh: controls.refresh,
    scopeNote: 'Search matches loaded run titles, inputs and outputs; status filters the list. Open uses one exact run ID (titles repeat, so most need the ID). Commands never start or cancel a compaction.',
    open(target) {
      const row = resolveCollectionTarget(target, rows);
      controls.openRun(row.id);
      return `Opened run ${row.id}.`;
    },
  });
}

/** Text a runs-rail search matches: the row's title, inputs/outputs and age. */
export function runMatches(row: { id: string; title: string; meta?: string; subline?: string }, query: string): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const hay = `${row.id} ${row.title} ${row.meta ?? ''} ${row.subline ?? ''}`.toLowerCase();
  return terms.every((t) => hay.includes(t));
}

/** Status phrases of the promotions rail's filter (FILTERS minus "all"). */
export const PROMOTION_STATUS_FILTERS: Record<string, string> = { candidate: 'candidate', approved: 'approved', promoted: 'promoted', dismissed: 'dismissed' };

export function promotionsCommandAdapter(rows: readonly Row[], controls: {
  setQuery(value: string): void;
  setStatus(value: string): void;
  refresh(): void;
  openCandidate(id: string): void;
}): CollectionCommandAdapter {
  return collectionCommandAdapter({ noun: 'candidates', filters: PROMOTION_STATUS_FILTERS }, {
    id: 'distillation-promotions-commands',
    label: 'Asset promotions',
    setQuery: controls.setQuery,
    setFilter: (value) => controls.setStatus(value || 'all'),
    refresh: controls.refresh,
    scopeNote: 'Search matches loaded candidate titles and rationales; status filters the list. The repository scope stays as the module sets it. Open uses one exact listed ID or title. Commands never approve, promote or dismiss a candidate.',
    open(target) {
      const row = resolveCollectionTarget(target, rows);
      controls.openCandidate(row.id);
      return `Opened ${row.title}.`;
    },
  });
}

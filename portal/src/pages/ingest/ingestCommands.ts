// The bounded table commands for the Knowledge → ingest pages. Each page maps
// the shared collection grammar onto the toolbar state it already has: search,
// at most one existing filter, refresh, and (Runs only) opening one run's
// record page. Nothing here starts, cancels, syncs, edits or deletes anything.
import type { CollectionCommandAdapter } from '../../components/collections/CollectionCommandHost.tsx';
import { collectionCommandAdapter, resolveCollectionTarget, type CollectionControls } from '../../components/collections/collectionCommands.ts';
import type { CrawlSession, CrawlStatus, CrawlTarget } from '../../components/ingest/types.ts';

type Base = Pick<CollectionControls, 'setQuery' | 'refresh'>;

/** A crawl run's record page (docs/layout-cascade.md: records open as pages). */
export function crawlRunHref(id: string): string { return `/admin/ingest/history/${encodeURIComponent(id)}`; }
/** A crawl target's record page. */
export function crawlTargetHref(id: string): string { return `/admin/ingest/crawl/${encodeURIComponent(id)}`; }

function has(query: string, ...fields: Array<string | null | undefined>): boolean {
  const q = query.trim().toLowerCase();
  return !q || fields.some(f => (f ?? '').toLowerCase().includes(q));
}

// ── Crawl targets (/admin/ingest/crawl) ──────────────────────────────────
export function matchesTarget(t: CrawlTarget, query: string): boolean {
  return has(query, t.label, t.id, t.startUrl, t.mode, t.cronExpr, t.lastStatus);
}
export function crawlTargetsAdapter(controls: Base): CollectionCommandAdapter {
  return collectionCommandAdapter({ noun: 'targets' }, {
    ...controls, label: 'Crawl targets', id: 'ingest-crawl-targets-commands',
    scopeNote: 'Search filters the loaded crawl targets by label, ID, URL, mode or schedule. Commands never run, edit, enable or delete a target.',
  });
}

// ── Crawl runs (/admin/ingest/history) ───────────────────────────────────
export type RunStatusFilter = 'all' | CrawlStatus;
export const RUN_STATUS_FILTERS = { completed: 'completed', running: 'running', failed: 'failed', cancelled: 'cancelled' } as const;

export function runTitle(s: CrawlSession, targetsById: ReadonlyMap<string, CrawlTarget>): string {
  return (s.targetId ? targetsById.get(s.targetId)?.label : undefined) ?? s.startUrl;
}
export function filterRuns(sessions: readonly CrawlSession[], targetsById: ReadonlyMap<string, CrawlTarget>, status: RunStatusFilter, query: string): CrawlSession[] {
  return sessions.filter(s => (status === 'all' || s.status === status)
    && has(query, s.id, runTitle(s, targetsById), s.startUrl, s.mode, s.status));
}
export function crawlRunsAdapter(controls: Base & {
  setStatus(value: RunStatusFilter): void;
  /** The currently filtered rows, so `open` never reaches a hidden run. */
  rows(): readonly CrawlSession[];
  targetsById: ReadonlyMap<string, CrawlTarget>;
  openRun(id: string): void;
}): CollectionCommandAdapter {
  return collectionCommandAdapter({ noun: 'runs', filters: RUN_STATUS_FILTERS }, {
    setQuery: controls.setQuery, refresh: controls.refresh, label: 'Crawl runs', id: 'ingest-crawl-runs-commands',
    setFilter: value => controls.setStatus(value ? value as CrawlStatus : 'all'),
    scopeNote: 'Search and status filter the loaded crawl runs; open shows one run\'s details. Commands never start, cancel or re-run a crawl.',
    open(target) {
      const rows = controls.rows().map(s => ({ id: s.id, title: runTitle(s, controls.targetsById) }));
      const row = resolveCollectionTarget(target, rows);
      controls.openRun(row.id);
      return `Opened run ${row.title}.`;
    },
  });
}

// ── Storage (/admin/ingest/storage) ──────────────────────────────────────
export function storageAdapter(controls: Base): CollectionCommandAdapter {
  return collectionCommandAdapter({ noun: 'storage rows' }, {
    ...controls, label: 'Storage', id: 'ingest-storage-commands',
    scopeNote: 'Search filters the loaded file-type and prefix breakdowns; totals stay whole-bucket. Commands never read, move or delete S3 objects.',
  });
}
export function matchesStorageKey(key: string, query: string): boolean { return has(query, key || '(none)'); }

// ── KB sync (/admin/ingest/sources) ──────────────────────────────────────
export function kbSyncAdapter(controls: Base): CollectionCommandAdapter {
  return collectionCommandAdapter({ noun: 'sources and jobs' }, {
    ...controls, label: 'KB sync', id: 'ingest-kb-sync-commands',
    scopeNote: 'Search filters the loaded data sources and ingestion jobs by name, ID, type or status. Commands never start a sync.',
  });
}
export function matchesDataSource(ds: { id: string; name: string; type: string; sourceUri: string; status: string }, query: string): boolean {
  return has(query, ds.id, ds.name, ds.type, ds.sourceUri, ds.status);
}
export function matchesJob(j: { jobId: string; dataSourceId: string; status: string }, query: string): boolean {
  return has(query, j.jobId, j.dataSourceId, j.status);
}

// ── Schedules (/admin/ingest/schedules) ──────────────────────────────────
export function schedulesAdapter(controls: Base): CollectionCommandAdapter {
  return collectionCommandAdapter({ noun: 'schedules' }, {
    ...controls, label: 'Schedules', id: 'ingest-schedules-commands',
    scopeNote: 'Search filters the loaded sync schedules by label, cron, data source or last status. Commands never create, enable, disable or remove a schedule.',
  });
}
export function matchesSchedule(s: { label: string; cronExpr: string; dataSourceName: string; dataSourceId: string; lastStatus: string | null }, query: string): boolean {
  return has(query, s.label, s.cronExpr, s.dataSourceName, s.dataSourceId, s.lastStatus);
}

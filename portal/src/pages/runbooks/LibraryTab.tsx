// Runbooks → Library: the list rail grouped by scope (Org / Initiatives / Repositories / Tools) and the
// runbook beside it as a page (/iq/runbooks/:id). The composer docks under the column.
import { useMemo, useState } from 'react';
import { useNavigate, useOutletContext, useParams } from 'react-router';
import { WorkListFilters } from '@connorhoehn/ui-components';
import { EmptyState, FilterPopover, Stack } from '@connorhoehn/ui-components/shared';
import { RunbookRecord } from './RunbookRecord';
import { RunbooksListFrame } from './RunbooksListFrame';
import type { RunbooksOutletContext } from './RunbooksModule';
import { STATUS_FILTERS, libraryCommandAdapter, libraryGroups, libraryRows, runbookHref } from './runbooksModel';
import type { RunbookRow } from './types';
import { useFetch } from '../../hooks/useFetch';
import { useRunbookNames } from './useRunbookNames';

export default function LibraryTab() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { breadcrumbs } = useOutletContext<RunbooksOutletContext>();
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const feed = useFetch<{ runbooks: RunbookRow[] }>('/api/runbooks?status=draft,published,retired&limit=200', 0);
  const all = feed.data?.runbooks ?? [];
  const names = useRunbookNames();
  const rows = useMemo(() => libraryRows(all, query, status, names), [all, query, status, names]);
  const byId = new Map(all.map((r) => [r.id, r]));

  const commands = libraryCommandAdapter(rows, {
    setQuery, setStatus, refresh: feed.refresh, open: (rid) => navigate(runbookHref(rid)),
  });

  return (
    <RunbooksListFrame
      breadcrumbs={breadcrumbs}
      title="Library"
      description="The procedures the fleet follows: read one start to finish, see how it changed, and what happened when runs used it."
      listTitle="Runbooks"
      {...(feed.data ? { count: all.length } : {})}
      listLabel="runbooks"
      query={query}
      onQuery={setQuery}
      searchLabel="Search runbooks"
      filter={(
        <FilterPopover trigger="icon" size="sm" label="Filter" activeCount={status ? 1 : 0} onClear={() => setStatus(null)} panelLabel="Filter runbooks">
          <WorkListFilters
            data-testid="runbooks-filters"
            facets={[{
              id: 'status', label: 'Status',
              options: Object.keys(STATUS_FILTERS).map((v) => ({ value: v, label: v.charAt(0).toUpperCase() + v.slice(1) })),
              selected: status ? [status] : [],
              onChange: (sel) => setStatus(sel.length ? sel[sel.length - 1]! : null),
            }]}
          />
        </FilterPopover>
      )}
      loading={feed.isLoading && !feed.data}
      error={feed.error}
      onRetry={feed.refresh}
      errorWhat="the runbook library"
      errorSource="Runbooks are read from the runbook store"
      groups={libraryGroups(rows)}
      rows={rows.map((r) => ({ id: r.id, groupId: r.groupId, title: r.title, subline: r.subline }))}
      currentId={id ?? null}
      onOpen={(rid) => navigate(runbookHref(rid))}
      emptyTitle="No runbooks yet"
      emptyDescription="Runbooks arrive as accepted proposals: a run or a person suggests one, a reviewer accepts it."
      onClear={() => setQuery('')}
      storageKey="runbooks.library.groups"
      footerNote={feed.data ? `${rows.length} of ${all.length} runbooks` : 'Loading…'}
      commands={commands}
      data-testid="runbooks-library"
    >
      {id ? (
        <RunbookRecord key={id} id={id} summary={byId.get(id) ?? null} onChanged={feed.refresh} onOpen={(href) => navigate(href)} />
      ) : (
        <Stack gap="md" className="w-full max-w-3xl px-6 pb-6">
          <EmptyState
            title={feed.isLoading ? 'Loading…' : 'Choose a runbook'}
            description="Pick one from the list to read it. Reviewers decide proposals under Proposals; each run’s frozen brief is under Briefs."
          />
        </Stack>
      )}
    </RunbooksListFrame>
  );
}

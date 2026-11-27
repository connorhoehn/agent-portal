// /pipelines/decks — every run report deck, table first (as Assessment's review decks list is): one search row,
// the table above the fold, New run report (a page) in the header. A run's own decks stay on its page too.

import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Button, CollectionPage } from '@connorhoehn/ui-components/shared';
import { useFlushTrailItems } from '../../../components/shell/FlushPage';
import { useFetch } from '../../../hooks/useFetch';
import { useCapabilities } from '../../../lib/capabilities';
import { relativeTime } from '../../../lib/relativeTime';
import { runDeckPaths, type RunDeckSummary } from './pipelineDecksApi';

export const filterRunDecks = (rows: readonly RunDeckSummary[], q: string): RunDeckSummary[] => {
  const words = q.trim().toLowerCase();
  return words ? rows.filter((d) => `${d.title} ${d.runId} ${d.id}`.toLowerCase().includes(words)) : [...rows];
};

export default function RunReportsListPage() {
  const navigate = useNavigate();
  const { can } = useCapabilities();
  const breadcrumbs = useFlushTrailItems();
  const [query, setQuery] = useState('');
  const { data, error, isLoading, refresh } = useFetch<RunDeckSummary[]>(runDeckPaths.list());
  const rows = filterRunDecks(data ?? [], query);
  return (
    <CollectionPage<RunDeckSummary>
      title="Run reports" description="Report decks built from pipeline runs." breadcrumbs={breadcrumbs} data-testid="pipelines-run-reports"
      headerActions={can('RunPipeline') ? <Button size="sm" variant="primary" onClick={() => navigate(runDeckPaths.newPage())} data-testid="run-deck-new-open">New run report</Button> : undefined}
      toolbar={{ label: 'Run report filters', search: { value: query, onChange: setQuery, placeholder: 'Search run reports', 'aria-label': 'Search run reports' }, onRefresh: refresh, refreshing: isLoading }}
      loading={isLoading && !data} error={error ? 'The run reports could not be loaded.' : undefined} onRetry={refresh}
      table={{
        data: rows, keyField: (d) => d.id, pageSize: 25, 'data-testid': 'pipelines-run-reports-table',
        onRowClick: (d) => navigate(runDeckPaths.page(d.id)),
        emptyMessage: query ? 'No run reports match.' : 'No run reports yet. Open a run and build one, or choose New run report.',
        columns: [
          { key: 'title', header: 'Deck', render: (d) => d.title },
          { key: 'run', header: 'Run', render: (d) => d.runId },
          { key: 'version', header: 'Latest', render: (d) => d.latestRevision?.label ?? '—' },
          { key: 'updated', header: 'Updated', numeric: true, render: (d) => (d.updatedAt ? relativeTime(d.updatedAt) : '—') },
        ],
      }}
    />
  );
}

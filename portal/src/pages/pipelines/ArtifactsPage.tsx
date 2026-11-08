// /pipelines/artifacts — what runs produced: changes (a commit per capture),
// documents, scoring logs, job transcripts (docs/pipelines-tenant-goal.md
// §Pages). Read from GET /api/pipelines/artifacts; a row opens its run.

import {
  CollectionToolbar,
  Stack,
  Banner,
  Chip,
  DataTable,
  T,
  type DataTableColumn,
} from '@connorhoehn/ui-components/shared';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { CollectionCommandPage } from '../../components/collections/CollectionCommandPage';
import { CollectionCommandHost } from '../../components/collections/CollectionCommandHost';
import { pipelineCollectionAdapter, filterArtifacts } from './pipelineCollectionCommands';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { PipelineRunStatusChip } from '../../components/runs/PipelineRunParts';
import { useFetch } from '../../hooks/useFetch';
import { showingLabel } from '../../lib/format';
import { artifactKindLabel, runHref, type PipelineArtifact } from '../../lib/pipelineRuns';
import { relativeTime } from '../../lib/relativeTime';

const KIND_OPTIONS = [
  { value: '', label: 'Any kind' },
  ...(['change', 'document', 'scores', 'transcript', 'trace'] as const).map((k) => ({ value: k, label: artifactKindLabel(k) })),
];

const COLUMNS: DataTableColumn<PipelineArtifact>[] = [
  { key: 'kind', header: 'Kind', render: (a) => <Chip tone="neutral" size="xs">{artifactKindLabel(a.kind)}</Chip> },
  { key: 'title', header: 'Artifact', render: (a) => <T size="sm" title={a.title} className="block max-w-[24rem] truncate">{a.title}</T>, sortable: true, compare: (x, y) => x.title.localeCompare(y.title) },
  { key: 'runId', header: 'Run', render: (a) => (a.runId ? <T size="xs" tone="secondary" title={a.runTitle ?? a.runId} className="block max-w-[24rem] truncate">{a.runTitle ?? a.runId}</T> : 'no run') },
  { key: 'runStatus', header: 'Run status', width: '128px', render: (a) => (a.runStatus ? <PipelineRunStatusChip status={a.runStatus} /> : '—') },
  { key: 'contextTenant', header: 'Workspace', render: (a) => a.contextTenant ?? '—' },
  {
    key: 'createdAt', header: 'Created', numeric: true, sortable: true,
    compare: (x, y) => (x.createdAt ?? '').localeCompare(y.createdAt ?? ''),
    render: (a) => (a.createdAt ? relativeTime(a.createdAt) : '—'),
  },
];

interface ArtifactsResponse {
  artifacts: PipelineArtifact[];
  total: number;
  unavailable: Array<{ table: string; error: string }>;
}

export default function ArtifactsPage() {
  const navigate = useNavigate();
  const [kind, setKind] = useState('');
  const [query, setQuery] = useState('');
  const { data, error, isLoading, refresh } = useFetch<ArtifactsResponse>(
    `/api/pipelines/artifacts?limit=500${kind ? `&kind=${encodeURIComponent(kind)}` : ''}`, 60_000,
  );
  const all = data?.artifacts ?? [];
  const rows = filterArtifacts(all, query);
  const adapter = pipelineCollectionAdapter('artifacts', { setQuery, setFilter: setKind, refresh,
    scopeNote: 'Search matches loaded artifact titles, IDs, run IDs and workspaces, limited to the latest 500 returned artifacts. Kind changes refetch that server filter. Commands do not change artifacts or start runs.' });

  return (
    <CollectionCommandPage data-testid="pipelines-artifacts" title="Artifacts" description="What runs produced — changes, documents, scores and transcripts.">
      <Stack gap="none" className="min-h-0 min-w-0 flex-1">
      <Stack gap="md" className="min-h-0 flex-1 overflow-auto px-[var(--ui-page-gutter)]">
      <CollectionToolbar {...{ label: 'Artifact filters', search: { value: query, onChange: setQuery, placeholder: 'Search artifacts', 'aria-label': 'Search artifacts' }, filters: [{ id: 'kind', label: 'Artifact kind', value: kind, onChange: setKind, options: KIND_OPTIONS }],
        summary: data ? showingLabel(rows.length, data.total, 'artifacts') : undefined,
        onRefresh: refresh, refreshing: isLoading,
      }} />

      {data && data.unavailable.length > 0 && (
        <Banner variant="warning">
          {`Not every source could be read — ${data.unavailable.map((u) => u.table).join(', ')}. Their artifacts are missing below, not absent.`}
        </Banner>
      )}
      {error ? (
        <UnavailableNotice error={error} what="artifacts" source="Artifacts are projected from each run's source rows" onRetry={refresh} />
      ) : (
        <DataTable
          data-testid="pipelines-artifacts-table"
          data={rows}
          columns={COLUMNS}
          keyField={(a) => a.id}
          loading={isLoading && !data}
          pageSize={25}
          onRowClick={(a) => { if (a.runId) navigate(runHref('/pipelines/runs', a.runId)); }}
          emptyMessage={kind || query ? 'No artifacts match these filters.' : 'No artifacts recorded yet.'}
        />
      )}
    </Stack>
      <CollectionCommandHost adapter={adapter} />
      </Stack>
    </CollectionCommandPage>
  );
}

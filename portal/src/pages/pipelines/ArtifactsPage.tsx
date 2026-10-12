// /pipelines/artifacts — what runs produced: changes (a commit per capture),
// documents, scoring logs, job transcripts (docs/pipelines-tenant-goal.md
// §Pages). Read from GET /api/pipelines/artifacts; a row opens its run.

import {
  CollectionPage,
  Banner,
  Chip,
  DataTable,
  MetaLine,
  type DataTableColumn,
} from '@connorhoehnslalom/ui-components/shared';
import { useState } from 'react';
import { useNavigate } from 'react-router';
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
  { key: 'title', header: 'Artifact', render: (a) => a.title, sortable: true, compare: (x, y) => x.title.localeCompare(y.title) },
  { key: 'runId', header: 'Run', render: (a) => (a.runId ? <MetaLine size="xs" tone="secondary" items={[a.runId]} /> : 'no run') },
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
  const { data, error, isLoading, refresh } = useFetch<ArtifactsResponse>(
    `/api/pipelines/artifacts?limit=500${kind ? `&kind=${encodeURIComponent(kind)}` : ''}`, 60_000,
  );
  const rows = data?.artifacts ?? [];

  return (
    <CollectionPage data-testid="pipelines-artifacts" title="Artifacts" description="What runs produced — changes, documents, scores and transcripts."
      toolbar={{ label: 'Artifact filters', filters: [{ id: 'kind', label: 'Artifact kind', value: kind, onChange: setKind, options: KIND_OPTIONS }],
        summary: data ? showingLabel(rows.length, data.total, 'artifacts') : undefined,
        onRefresh: refresh, refreshing: isLoading,
      }}>

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
          emptyMessage={kind ? 'No artifact of this kind.' : 'No artifacts recorded yet.'}
        />
      )}
    </CollectionPage>
  );
}

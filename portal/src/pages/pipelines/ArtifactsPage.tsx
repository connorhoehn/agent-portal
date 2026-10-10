// /pipelines/artifacts — what runs produced: changes (a commit per capture),
// documents, scoring logs, job transcripts (docs/pipelines-tenant-goal.md
// §Pages). Read from GET /api/pipelines/artifacts; a row opens its run.

import { useState } from 'react';
import { useNavigate } from 'react-router';
import {
  Banner, Chip, DataTable, Inline, MetaLine, PageHeader, Select, Stack,
  type DataTableColumn,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { relativeTime } from '../../lib/relativeTime';
import { showingLabel } from '../../lib/format';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { PipelineRunStatusChip } from '../../components/runs/PipelineRunParts';
import { artifactKindLabel, runHref, type PipelineArtifact } from '../../lib/pipelineRuns';

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
    <Stack gap="md" data-testid="pipelines-artifacts">
      <PageHeader title="Artifacts" description="What runs produced — changes, documents, scores and transcripts." />
      <Inline gap="sm" wrap align="center">
        <Select aria-label="Artifact kind" size="sm" className="w-44" value={kind} onChange={(e) => setKind(e.target.value)} options={KIND_OPTIONS} />
        {data && <MetaLine size="xs" tone="tertiary" items={[showingLabel(rows.length, data.total, 'artifacts')]} />}
      </Inline>
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
          size="sm"
          data={rows}
          columns={COLUMNS}
          keyField={(a) => a.id}
          loading={isLoading && !data}
          pageSize={25}
          onRowClick={(a) => { if (a.runId) navigate(runHref('/pipelines/runs', a.runId)); }}
          emptyMessage={kind ? 'No artifact of this kind.' : 'No artifacts recorded yet.'}
        />
      )}
    </Stack>
  );
}

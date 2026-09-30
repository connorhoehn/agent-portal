// /pipelines/runs — every run the tenant records, from every workspace
// (docs/pipelines-tenant-goal.md §Pages). The projection over the jobs, bot
// firings, governed runs, assessment commands and compaction passes that
// already exist (middleware lib/pipeline-runs.ts), read from
// GET /api/pipelines/runs.
//
// Table-first: one compact filter row (status · kind · workspace), then the
// DataTable above the fold. A source table that could not be read is named in
// a banner — an unreadable ledger never renders as an empty one.

import { useState } from 'react';
import { useNavigate } from 'react-router';
import {
  Banner, Chip, DataTable, Inline, MetaLine, PageHeader, Select, Stack,
  type DataTableColumn,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { relativeTime } from '../../lib/relativeTime';
import { usd, showingLabel } from '../../lib/format';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { PipelineRunStatusChip } from '../../components/runs/PipelineRunParts';
import {
  KIND_FILTER_OPTIONS, STATUS_FILTER_OPTIONS, TENANT_FILTER_OPTIONS, kindLabel, runHref, runsQuery, sourceStatusNote,
  type PipelineRun, type RunListResponse,
} from '../../lib/pipelineRuns';

const COLUMNS: DataTableColumn<PipelineRun>[] = [
  { key: 'title', header: 'Run', render: (r) => r.context.title, sortable: true, compare: (a, b) => a.context.title.localeCompare(b.context.title) },
  {
    key: 'status', header: 'Status', sortable: true,
    render: (r) => (
      <Inline gap="xs" align="center">
        <PipelineRunStatusChip status={r.status} />
        {sourceStatusNote(r) && <MetaLine size="xs" tone="tertiary" items={[sourceStatusNote(r)]} />}
      </Inline>
    ),
  },
  { key: 'kind', header: 'Kind', render: (r) => kindLabel(r.context.kind) },
  { key: 'tenant', header: 'Workspace', render: (r) => <Chip tone="neutral" size="xs">{r.context.tenant}</Chip> },
  { key: 'triggerType', header: 'Trigger', render: (r) => r.context.trigger ?? r.triggerType },
  { key: 'costUsd', header: 'Cost', align: 'right', render: (r) => (r.costUsd != null ? usd(r.costUsd, { precision: 4 }) : '—') },
  {
    key: 'startedAt', header: 'Started', sortable: true,
    compare: (a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? ''),
    render: (r) => (r.startedAt ? relativeTime(r.startedAt) : '—'),
  },
];

export default function RunsPage() {
  const navigate = useNavigate();
  const [status, setStatus] = useState('');
  const [kind, setKind] = useState('');
  const [contextTenant, setContextTenant] = useState('');
  const { data, error, isLoading, refresh } = useFetch<RunListResponse>(
    `/api/pipelines/runs${runsQuery({ status, kind, contextTenant, limit: 200 })}`, 30_000,
  );
  const runs = data?.runs ?? [];
  const filtered = Boolean(status || kind || contextTenant);

  return (
    <Stack gap="md" data-testid="pipelines-runs">
      <PageHeader title="Runs" description="Every run, what it acted for, and where it stands." />
      <Inline gap="sm" wrap align="center">
        <Select aria-label="Status" size="sm" className="w-44" value={status} onChange={(e) => setStatus(e.target.value)} options={STATUS_FILTER_OPTIONS} />
        <Select aria-label="Kind" size="sm" className="w-44" value={kind} onChange={(e) => setKind(e.target.value)} options={KIND_FILTER_OPTIONS} />
        <Select aria-label="Workspace" size="sm" className="w-44" value={contextTenant} onChange={(e) => setContextTenant(e.target.value)} options={TENANT_FILTER_OPTIONS} />
        {data && <MetaLine size="xs" tone="tertiary" items={[showingLabel(runs.length, data.total, 'runs')]} />}
      </Inline>
      {data && data.unavailable.length > 0 && (
        <Banner variant="warning">
          {`Not every source could be read — ${data.unavailable.map((u) => `${u.table}: ${u.error}`).join('; ')}. Runs from ${data.unavailable.length === 1 ? 'that table are' : 'those tables are'} missing below, not absent.`}
        </Banner>
      )}
      {error ? (
        <UnavailableNotice error={error} what="the run ledger" source="Runs are projected from the jobs, bot runs and commands tables" onRetry={refresh} />
      ) : (
        <DataTable
          data-testid="pipelines-runs-table"
          data={runs}
          columns={COLUMNS}
          keyField={(r) => r.id}
          loading={isLoading && !data}
          pageSize={25}
          onRowClick={(r) => navigate(runHref('/pipelines/runs', r.id))}
          emptyMessage={filtered ? 'No run matches these filters.' : 'No runs recorded yet.'}
        />
      )}
    </Stack>
  );
}

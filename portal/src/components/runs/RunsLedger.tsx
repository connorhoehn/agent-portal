// One run ledger for Pipeline, Work and Assessment. Tenant endpoints own authority;
// columns, filtering, loading and row navigation are shared here.

import {
  Banner,
  Chip,
  CollectionToolbar,
  DataTable,
  Stack,
  T,
  type CollectionAction,
  type DataTableColumn,
} from '@connorhoehnslalom/ui-components/shared';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useFetch } from '../../hooks/useFetch';
import { showingLabel, usd } from '../../lib/format';
import {
  KIND_FILTER_OPTIONS,
  STATUS_FILTER_OPTIONS,
  TENANT_FILTER_OPTIONS,
  kindLabel,
  runHref,
  runsQuery,
  sourceStatusNote,
  unlinkedNote,
  type PipelineRun,
  type RunListResponse,
} from '../../lib/pipelineRuns';
import { relativeTime } from '../../lib/relativeTime';
import { UnavailableNotice } from '../UnavailableNotice';
import { PipelineRunStatusChip } from './PipelineRunParts';

function columns(showWorkspace: boolean): DataTableColumn<PipelineRun>[] {
  return [
    { key: 'title', header: 'Run', render: (r) => <T size="sm" title={r.context.title} className="block max-w-[32rem] truncate">{r.context.title}</T>, sortable: true, compare: (a, b) => a.context.title.localeCompare(b.context.title) },
    {
      key: 'status', header: 'Status', width: '128px', sortable: true,
      render: (r) => (
        <PipelineRunStatusChip status={r.status} title={sourceStatusNote(r) ?? undefined} />
      ),
    },
    { key: 'kind', header: 'Kind', render: (r) => kindLabel(r.context.kind) },
    ...(showWorkspace ? [{ key: 'tenant', header: 'Workspace', render: (r: PipelineRun) => <Chip tone="neutral" size="xs">{r.context.tenant}</Chip> }] : []),
    { key: 'triggerType', header: 'Trigger', render: (r) => r.context.trigger ?? r.triggerType },
    { key: 'costUsd', header: 'Cost', numeric: true, render: (r) => (r.costUsd != null ? usd(r.costUsd, { precision: 4 }) : '—') },
    {
      key: 'startedAt', header: 'Started', numeric: true, sortable: true,
      compare: (a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? ''),
      render: (r) => (r.startedAt ? relativeTime(r.startedAt) : '—'),
    },
  ];
}

export interface RunsLedgerProps {
  /** The list endpoint: /api/pipelines/runs, /api/runs or /api/assessment/pipeline-runs. */
  endpoint: string;
  actions?: CollectionAction[];
  /** Where a row opens (`<detailBase>/<id>`); null — rows do not open. */
  detailBase: string | null;
  /** The ledger spans workspaces (the pipelines tenant): show the Workspace column and filter. */
  showWorkspace?: boolean;
  pageSize?: number;
  'data-testid': string;
}

export function RunsLedger({ actions, endpoint, detailBase, showWorkspace = false, pageSize = 25, 'data-testid': testId }: RunsLedgerProps) {
  const navigate = useNavigate();
  const [status, setStatus] = useState('');
  const [kind, setKind] = useState('');
  const [contextTenant, setContextTenant] = useState('');
  const { data, error, isLoading, refresh } = useFetch<RunListResponse>(
    `${endpoint}${runsQuery({ status, kind, contextTenant: showWorkspace ? contextTenant : '', limit: 200 })}`, 30_000,
  );
  const runs = data?.runs ?? [];
  const filtered = Boolean(status || kind || (showWorkspace && contextTenant));

  return (
    <Stack gap="none" className="min-w-0 gap-[var(--ui-section-gap)]">
      <CollectionToolbar label="Run filters" filters={[
        { id: 'status', label: 'Status', value: status, onChange: setStatus, options: STATUS_FILTER_OPTIONS },
        { id: 'kind', label: 'Kind', value: kind, onChange: setKind, options: KIND_FILTER_OPTIONS },
        ...(showWorkspace ? [{ id: 'workspace', label: 'Workspace', value: contextTenant, onChange: setContextTenant, options: TENANT_FILTER_OPTIONS }] : []),
      ]} summary={data ? showingLabel(runs.length, data.total, 'runs') : undefined}
        notices={data && unlinkedNote(data.unlinked) ? [unlinkedNote(data.unlinked)] : []}
        actions={actions} onRefresh={refresh} refreshing={isLoading} />
      {data && data.unavailable.length > 0 && (
        <Banner variant="warning">
          {`Not every source could be read — ${data.unavailable.map((u) => `${u.table}: ${u.error}`).join('; ')}. Runs from ${data.unavailable.length === 1 ? 'that table are' : 'those tables are'} missing below, not absent.`}
        </Banner>
      )}
      {error ? (
        <UnavailableNotice error={error} what="the run ledger" source="Runs are projected from the jobs, bot runs and commands tables" onRetry={refresh} />
      ) : (
        <DataTable
          data-testid={testId}
          data={runs}
          columns={columns(showWorkspace)}
          keyField={(r) => r.id}
          loading={isLoading && !data}
          pageSize={pageSize}
          {...(detailBase ? { onRowClick: (r: PipelineRun) => navigate(runHref(detailBase, r.id)) } : {})}
          emptyMessage={filtered ? 'No run matches these filters.' : 'No runs recorded yet.'}
        />
      )}
    </Stack>
  );
}

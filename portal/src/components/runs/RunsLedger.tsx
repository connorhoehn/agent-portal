// The run ledger as a table, for the Runs sections embedded in the other
// tenants (docs/social-tenant-design.md §5.1, lane E): /iq/runs over the orgiq
// façade /api/runs (context.tenant = orgiq) and the assessment Activity page
// over /api/assessment/pipeline-runs (context.tenant = assessment). It is the
// pipelines tenant's own Runs page composition (pages/pipelines/RunsPage.tsx:
// the same columns, filter row, banner and DataTable), lifted so the façades
// draw runs the same way; that page keeps its inline copy for now, because its
// judge pins a DataTable in the page file itself. The façade decides which runs
// exist; this draws them.
//
// Table-first: one compact filter row (status · kind · workspace when the
// ledger spans workspaces), then the DataTable. A source table that could not
// be read is named in a banner — an unreadable ledger never renders as an
// empty one.

import { useState } from 'react';
import { useNavigate } from 'react-router';
import {
  Banner, Chip, DataTable, Inline, MetaLine, Select, Stack, T,
  type DataTableColumn,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { relativeTime } from '../../lib/relativeTime';
import { usd, showingLabel } from '../../lib/format';
import { UnavailableNotice } from '../UnavailableNotice';
import { PipelineRunStatusChip } from './PipelineRunParts';
import {
  KIND_FILTER_OPTIONS, STATUS_FILTER_OPTIONS, TENANT_FILTER_OPTIONS, kindLabel, runHref, runsQuery, sourceStatusNote, unlinkedNote,
  type PipelineRun, type RunListResponse,
} from '../../lib/pipelineRuns';

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
  /** Where a row opens (`<detailBase>/<id>`); null — rows do not open. */
  detailBase: string | null;
  /** The ledger spans workspaces (the pipelines tenant): show the Workspace column and filter. */
  showWorkspace?: boolean;
  pageSize?: number;
  'data-testid': string;
}

export function RunsLedger({ endpoint, detailBase, showWorkspace = false, pageSize = 25, 'data-testid': testId }: RunsLedgerProps) {
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
    <Stack gap="md">
      <Inline gap="sm" wrap align="center">
        <Select aria-label="Status" size="sm" className="w-44" value={status} onChange={(e) => setStatus(e.target.value)} options={STATUS_FILTER_OPTIONS} />
        <Select aria-label="Kind" size="sm" className="w-44" value={kind} onChange={(e) => setKind(e.target.value)} options={KIND_FILTER_OPTIONS} />
        {showWorkspace && (
          <Select aria-label="Workspace" size="sm" className="w-44" value={contextTenant} onChange={(e) => setContextTenant(e.target.value)} options={TENANT_FILTER_OPTIONS} />
        )}
        {data && <MetaLine size="xs" tone="tertiary" items={[showingLabel(runs.length, data.total, 'runs'), unlinkedNote(data.unlinked)]} />}
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
          data-testid={testId}
          size="sm"
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

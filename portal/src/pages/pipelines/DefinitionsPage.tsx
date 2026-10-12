// /pipelines/definitions — what can run (docs/social-tenant-design.md §5.3,
// docs/pipelines-tenant-goal.md §P2). Every bot, assessment command, runbook
// and agent is one definition, derived from what exists and read from
// GET /api/pipelines/definitions; `?open=<id>` opens one in the drawer
// (steps, triggers, source, recent runs, and Dry-run for a runbook).
//
// Table-first: one compact filter row, then the DataTable above the fold.

import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { Toolbar, IconButton, Tooltip, RepeatIcon,
  Banner, Chip, DataTable, MetaLine, PageHeader, SearchInput, Select, Stack, T, type DataTableColumn,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { relativeTime } from '../../lib/relativeTime';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { PipelineRunStatusChip } from '../../components/runs/PipelineRunParts';
import { kindLabel } from '../../lib/pipelineRuns';
import {
  DEFINITION_KIND_OPTIONS, approverSummary, matchesDefinition, triggerSummary, type DefinitionsResponse, type PipelineDefinition,
} from '../../lib/pipelineDefinitions';
import { DefinitionDrawer } from './DefinitionDrawer';

const COLUMNS: DataTableColumn<PipelineDefinition>[] = [
  {
    key: 'title', header: 'Definition', sortable: true, compare: (a, b) => a.title.localeCompare(b.title),
    render: (d) => <T size="sm" title={d.title} className="block max-w-[26rem] truncate">{d.title}</T>,
  },
  {
    key: 'state', header: 'State', width: '96px',
    render: (d) => (d.enabled ? <Chip tone="success" size="xs">active</Chip> : <Chip tone="neutral" size="xs">{d.orphaned ? 'orphaned' : 'inactive'}</Chip>),
  },
  { key: 'kind', header: 'Kind', render: (d) => kindLabel(d.kind) },
  { key: 'contextTenant', header: 'Workspace', render: (d) => <Chip tone="neutral" size="xs">{d.contextTenant}</Chip> },
  { key: 'triggers', header: 'Triggers', render: (d) => triggerSummary(d.triggers) },
  { key: 'approvers', header: 'Approved by', render: (d) => approverSummary(d.effectiveApproverRoles, d.approversDefaulted) },
  { key: 'runCount', header: 'Runs', numeric: true, sortable: true, compare: (a, b) => a.runCount - b.runCount, render: (d) => d.runCount },
  {
    key: 'lastRunStatus', header: 'Last run', width: '112px',
    render: (d) => (d.lastRun ? <PipelineRunStatusChip status={d.lastRun.status} /> : '—'),
  },
  {
    key: 'lastRun', header: 'Last run at', numeric: true, sortable: true,
    compare: (a, b) => (a.lastRun?.startedAt ?? '').localeCompare(b.lastRun?.startedAt ?? ''),
    render: (d) => (d.lastRun?.startedAt ? relativeTime(d.lastRun.startedAt) : '—'),
  },
  { key: 'version', header: 'Version', numeric: true, render: (d) => `v${d.version}` },
];

export default function DefinitionsPage() {
  const [params, setParams] = useSearchParams();
  const openId = params.get('open');
  const [kind, setKind] = useState('');
  const [query, setQuery] = useState('');
  const { data, error, isLoading, refresh } = useFetch<DefinitionsResponse>(
    `/api/pipelines/definitions${kind ? `?kind=${encodeURIComponent(kind)}` : ''}`, 60_000,
  );
  const all = data?.definitions ?? [];
  const rows = all.filter((d) => matchesDefinition(d, query));

  const open = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set('open', id); else next.delete('open');
    setParams(next, { replace: false });
  };

  return (
    <Stack gap="md" className="min-w-0" data-testid="pipelines-definitions">
      <PageHeader density="compact" title="Definitions" description="What can run: every bot, assessment command, runbook and agent, with its triggers, steps and runs." />
      <Toolbar aria-label="Definition filters" wrap className="px-0" end={<Tooltip content="Refresh"><IconButton size="sm" aria-label="Refresh" icon={<RepeatIcon />} onClick={refresh} disabled={isLoading} /></Tooltip>}>
        <SearchInput size="sm" className="w-full max-w-64" aria-label="Search definitions" placeholder="Search definitions" value={query} onChange={setQuery} onClear={() => setQuery('')} />
        <Select aria-label="Kind" size="sm" className="w-full max-w-48" value={kind} onChange={(e) => setKind(e.target.value)} options={DEFINITION_KIND_OPTIONS} />
        {data && <MetaLine size="xs" tone="tertiary" items={[rows.length === all.length ? `${all.length} definitions` : `${rows.length} of ${all.length} definitions`, `unnamed approvers default to ${data.defaultApproverRole}`]} />}
      </Toolbar>
      {data && data.unavailable.length > 0 && (
        <Banner variant="warning">
          {`Not every source could be read — ${data.unavailable.map((u) => `${u.source}: ${u.error}`).join('; ')}. Definitions from ${data.unavailable.length === 1 ? 'that source are' : 'those sources are'} missing below, not absent.`}
        </Banner>
      )}
      {error ? (
        <UnavailableNotice error={error} what="the definition catalog" source="Definitions are derived from bots, commands, runbooks and agents" onRetry={refresh} />
      ) : (
        <DataTable
          data-testid="pipelines-definitions-table"
          size="sm"
          data={rows}
          columns={COLUMNS}
          keyField={(d) => d.id}
          loading={isLoading && !data}
          pageSize={25}
          onRowClick={(d) => open(d.id)}
          emptyMessage={query.trim() || kind ? 'No definition matches this search and kind.' : 'No definitions — nothing is registered to run yet.'}
        />
      )}
      <DefinitionDrawer id={openId} onClose={() => open(null)} onChanged={refresh} />
    </Stack>
  );
}

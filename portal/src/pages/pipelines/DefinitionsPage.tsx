// /pipelines/definitions — what can run (docs/social-tenant-design.md §5.3,
// docs/pipelines-tenant-goal.md §P2). Every bot, assessment command, runbook
// and agent is one definition, derived from what exists and read from
// GET /api/pipelines/definitions; a row opens the definition as a page,
// `/pipelines/definitions/:definitionId` (`definitionHref`), the catalog as
// the list rail beside it (steps, triggers, source, recent runs, and Dry-run
// for a runbook). A legacy `?open=<id>` link redirects there.
//
// Table-first: one compact filter row, then the DataTable above the fold.

import { ofTotal, plural } from '../../lib/plural';
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
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router';
import { CollectionRecordFrame } from '../../components/collections/CollectionRecordFrame';
import { useCrumbLabel } from '../../lib/crumbLabels';
import { CollectionCommandPage } from '../../components/collections/CollectionCommandPage';
import { CollectionCommandHost } from '../../components/collections/CollectionCommandHost';
import { pipelineCollectionAdapter } from './pipelineCollectionCommands';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { PipelineRunStatusChip } from '../../components/runs/PipelineRunParts';
import { useFetch } from '../../hooks/useFetch';
import {
  DEFINITION_KIND_OPTIONS,
  approverSummary,
  definitionHref,
  matchesDefinition,
  triggerSummary,
  type DefinitionsResponse,
  type PipelineDefinition,
} from '../../lib/pipelineDefinitions';
import { contextTenantLabel, kindLabel } from '../../lib/pipelineRuns';
import { relativeTime } from '../../lib/relativeTime';
import { DefinitionDiscussion, DefinitionRecord } from './DefinitionRecord';

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
  { key: 'owner', header: 'Owner', render: (d) => d.ownerName ?? d.owner ?? <T size="xs" tone="tertiary">—</T> },
  { key: 'contextTenant', header: 'Acts for', render: (d) => <Chip tone="neutral" size="xs">{contextTenantLabel(d.contextTenant)}</Chip> },
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
  const [params] = useSearchParams();
  const legacyOpen = params.get('open');
  const { definitionId } = useParams<{ definitionId?: string }>();
  const openId = definitionId ?? null;
  const navigate = useNavigate();
  const [kind, setKind] = useState('');
  const [query, setQuery] = useState('');
  const { data, error, isLoading, refresh } = useFetch<DefinitionsResponse>(
    `/api/pipelines/definitions${kind ? `?kind=${encodeURIComponent(kind)}` : ''}`, 60_000,
  );
  const all = data?.definitions ?? [];
  const rows = all.filter((d) => matchesDefinition(d, query));
  const adapter = pipelineCollectionAdapter('definitions', { setQuery, setFilter: setKind, refresh,
    scopeNote: 'Search the catalog by name, owner or kind. Commands never run or change a definition.' });

  const open = (id: string) => navigate(definitionHref(id));
  useCrumbLabel(openId ?? undefined, all.find((d) => d.id === openId)?.title ?? null);

  if (legacyOpen && !openId) return <Navigate to={definitionHref(legacyOpen)} replace />;
  if (openId) {
    const kinds = [...new Set(rows.map((d) => d.kind))];
    return (
      <CollectionRecordFrame
        title="Definitions"
        listTitle="Definitions"
        listLabel="definitions"
        {...(data ? { count: rows.length } : {})}
        search={{ value: query, onChange: setQuery, placeholder: 'Find a definition' }}
        groups={kinds.map((k) => ({ id: k, title: kindLabel(k), count: rows.filter((d) => d.kind === k).length }))}
        rows={rows.map((d) => ({ id: d.id, groupId: d.kind, title: d.title, subline: `${d.enabled ? 'active' : d.orphaned ? 'orphaned' : 'inactive'} · ${plural(d.runCount, 'run')}` }))}
        currentId={openId}
        onOpen={open}
        loading={isLoading && !data}
        error={error}
        onRetry={refresh}
        footer={<CollectionCommandHost adapter={adapter} />}
        data-testid="pipelines-definition-explorer"
        conversation={<DefinitionDiscussion key={openId} id={openId} />}
      >
        <DefinitionRecord key={openId} id={openId} onChanged={refresh} />
      </CollectionRecordFrame>
    );
  }

  return (
    <CollectionCommandPage data-testid="pipelines-definitions" title="Definitions" description="What can run: every bot, assessment command, runbook and agent, with its triggers, steps and runs.">
      <Stack gap="none" className="min-h-0 min-w-0 flex-1">
      <Stack gap="md" className="min-h-0 flex-1 overflow-auto px-[var(--ui-page-gutter)]">
      <CollectionToolbar {...{ label: 'Definition filters', search: { value: query, onChange: setQuery, placeholder: 'Search definitions', 'aria-label': 'Search definitions' },
        filters: [{ id: 'kind', label: 'Kind', value: kind, onChange: setKind, options: DEFINITION_KIND_OPTIONS }],
        summary: data ? `${ofTotal(rows.length, all.length, 'definition')}` : undefined,
        notices: data ? [`Unnamed approvers default to ${data.defaultApproverRole}.`] : [],
        onRefresh: refresh, refreshing: isLoading,
      }} />

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
          data={rows}
          columns={COLUMNS}
          keyField={(d) => d.id}
          loading={isLoading && !data}
          pageSize={25}
          onRowClick={(d) => open(d.id)}
          emptyMessage={query.trim() || kind ? 'No definition matches this search and kind.' : 'No definitions — nothing is registered to run yet.'}
        />
      )}
    </Stack>
      <CollectionCommandHost adapter={adapter} />
      </Stack>
    </CollectionCommandPage>
  );
}

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
import { useRef, useState } from 'react';
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
import { useCapabilities } from '../../lib/capabilities';
import { useSession } from '../../lib/auth';
import { writeJson } from '../../lib/writeJson';
import { CollectionCommandHost, type CollectionCommandAdapter } from './CollectionCommandHost';
import { EMPTY_RUN_FILTERS, parseRunCommand, resolveRunCommand, runCommandExamples, type RunFilters } from './runCommands';

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
  /** Full-page ledgers keep their shared command input below the scrolling rows. */
  fill?: boolean;
  'data-testid': string;
}

export function RunsLedger({ actions, endpoint, detailBase, showWorkspace = false, pageSize = 25, fill = false, 'data-testid': testId }: RunsLedgerProps) {
  const navigate = useNavigate();
  const { can } = useCapabilities();
  const { session } = useSession();
  const [filters, setFilters] = useState<RunFilters>({ ...EMPTY_RUN_FILTERS });
  const { status, kind, contextTenant, title } = filters;
  const setFilter = (key: keyof RunFilters, value: string) => setFilters(current => ({ ...current, [key]: value }));
  const { data, error, isLoading, refresh } = useFetch<RunListResponse>(
    `${endpoint}${runsQuery({ status, kind, contextTenant: showWorkspace ? contextTenant : '', limit: 200 })}`, 30_000,
  );
  const runs = (data?.runs ?? []).filter(run => !title || run.context.title.toLowerCase().includes(title.toLowerCase()));
  const filtered = Boolean(status || kind || title || (showWorkspace && contextTenant));
  const scope = { runs, endpoint, detailBase, showWorkspace, canCancel: session?.tenant === 'pipelines' && can('CancelRun') };
  const identity = `${session?.sub}:${session?.tenant}:${session?.role}`;
  const latest = useRef({ scope, identity, error, isLoading });
  latest.current = { scope, identity, error, isLoading };
  const scopeNote = `Commands address the currently loaded table (up to 200 rows, across table pages). Title search is local to those rows; status, kind and workspace filters query the server. Updating one filter keeps the others. Reset clears filters only; sorting stays unchanged. Unsupported requests make no changes.`;
  const examples = runCommandExamples(scope);
  const adapter: CollectionCommandAdapter = {
    id: `${testId}-commands`, label: 'Runs', examples, scopeNote,
    placeholder: 'Show failed runs, search titles, or refresh…',
    execute: text => {
      const command = parseRunCommand(text);
      if (command.kind === 'help') return { message: `Supported: ${examples.join('; ')}. ${scopeNote}` };
      if (command.kind === 'refresh') { refresh(); return { message: 'Refreshing the run table.' }; }
      if (command.kind === 'reset') { setFilters({ ...EMPTY_RUN_FILTERS }); return { message: 'Run filters and title search cleared. Sorting is unchanged.' }; }
      if ((command.kind === 'open' || command.kind === 'cancel') && (isLoading || error || !data)) {
        throw new Error('Wait for the run table to finish loading successfully before choosing a run.');
      }
      const resolved = resolveRunCommand(command, scope);
      if (resolved.kind === 'filter') {
        setFilters(current => ({ ...current, ...resolved.filters }));
        return { message: `Applied ${Object.entries(resolved.filters).map(([key, value]) => `${key === 'contextTenant' ? 'workspace' : key}: ${value}`).join(', ')}. Other filters and sorting are unchanged.${resolved.filters.title ? ' Title search covers loaded rows only.' : ''}` };
      }
      if (resolved.kind === 'open') {
        navigate(runHref(detailBase!, resolved.run.id));
        return { message: `Opened ${resolved.run.context.title}.` };
      }
      if (resolved.kind === 'cancel') {
        const run = resolved.run;
        return { message: `Review cancellation of ${run.context.title}. Nothing has been changed.`, confirmation: {
          title: 'Cancel this run?', label: 'Cancel run',
          body: `${run.context.title} (${run.id}) will be cancelled through its source. The server checks your current permission and whether the run can still be cancelled.`,
          confirm: async () => {
            const current = latest.current;
            if (current.identity !== identity || current.isLoading || current.error) throw new Error('The session or table changed. Refresh and choose the run again.');
            resolveRunCommand({ kind: 'cancel', target: run.id }, current.scope);
            const result = await writeJson<{ status: string }>(`${endpoint}/${encodeURIComponent(run.id)}/cancel`, 'POST');
            if (!result.ok) throw new Error(result.error ?? 'The run could not be cancelled.');
            refresh(); return `Cancellation recorded for ${run.context.title}. Refreshing its status.`;
          },
        } };
      }
      throw new Error('This command is not available here.');
    },
  };

  return (
    <Stack gap="none" className={fill ? 'min-w-0 min-h-0 flex-1' : 'min-w-0'} data-collection-command-boundary={fill ? undefined : 'embedded'}>
      <Stack gap="none" className={`min-w-0 gap-[var(--ui-section-gap)] ${fill ? 'min-h-0 flex-1 overflow-auto px-[var(--ui-page-gutter)]' : ''}`}>
      <CollectionToolbar label="Run filters" filters={[
        { id: 'status', label: 'Status', value: status, onChange: value => setFilter('status', value), options: STATUS_FILTER_OPTIONS },
        { id: 'kind', label: 'Kind', value: kind, onChange: value => setFilter('kind', value), options: KIND_FILTER_OPTIONS },
        ...(showWorkspace ? [{ id: 'workspace', label: 'Workspace', value: contextTenant, onChange: (value: string) => setFilter('contextTenant', value), options: TENANT_FILTER_OPTIONS }] : []),
      ]} summary={data ? showingLabel(runs.length, data.total, 'runs') : undefined}
        search={{ value: title, onChange: value => setFilter('title', value), placeholder: 'Search loaded run titles', 'aria-label': 'Search loaded run titles' }}
        notices={[scopeNote, ...(data && unlinkedNote(data.unlinked) ? [unlinkedNote(data.unlinked)] : [])]}
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
      <CollectionCommandHost key={`${endpoint}:${identity}`} adapter={adapter} />
    </Stack>
  );
}

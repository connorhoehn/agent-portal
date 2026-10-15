// /pipelines/agents, /pipelines/bots, /pipelines/commands — the three
// producers, read-only (docs/social-tenant-design.md §5.3: "read-only views
// of what each tenant registered"). Each lists that kind of definition from
// GET /api/pipelines/definitions?kind=… — the fleet registry's agents, the
// org's bots, the assessment worker's commands — with how often each ran; a
// row opens its definition. Nothing here writes: bots are managed in the org
// workspace, commands in assessment, agents by deployment.

import {
  CollectionToolbar,
  Stack,
  Banner,
  Chip,
  DataTable,
  T,
  type DataTableColumn,
} from '@connorhoehnslalom/ui-components/shared';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { PipelineRunStatusChip } from '../../components/runs/PipelineRunParts';
import { useFetch } from '../../hooks/useFetch';
import { useSession } from '../../lib/auth';
import { CollectionCommandPage } from '../../components/collections/CollectionCommandPage';
import { CollectionCommandHost } from '../../components/collections/CollectionCommandHost';
import {
  SOURCE_KINDS,
  definitionHref,
  matchesDefinition,
  triggerSummary,
  type DefinitionsResponse,
  type PipelineDefinition,
  type SourcePageId,
} from '../../lib/pipelineDefinitions';
import { pipelineCollectionAdapter, resolvePipelineCollectionTarget } from './pipelineCollectionCommands';
import { relativeTime } from '../../lib/relativeTime';

const str = (v: unknown): string => (typeof v === 'string' && v ? v : '—');

const RUNS: DataTableColumn<PipelineDefinition>[] = [
  { key: 'runCount', header: 'Runs', numeric: true, sortable: true, compare: (a, b) => a.runCount - b.runCount, render: (d) => d.runCount },
  {
    key: 'lastRunStatus', header: 'Last run', width: '112px',
    render: (d) => (d.lastRun ? <PipelineRunStatusChip status={d.lastRun.status} /> : 'never'),
  },
  {
    key: 'lastRun', header: 'Last run at', numeric: true,
    render: (d) => (d.lastRun?.startedAt ? relativeTime(d.lastRun.startedAt) : '—'),
  },
];

const PAGES: Record<SourcePageId, { title: string; description: string; noun: string; empty: string; columns: DataTableColumn<PipelineDefinition>[] }> = {
  agents: {
    title: 'Agents',
    description: 'The agent fleet — every deployed agent is a definition, and each invocation that carried a run id is one of its runs.',
    noun: 'agents',
    empty: 'No agents in the fleet registry.',
    columns: [
      { key: 'title', header: 'Agent', sortable: true, compare: (a, b) => a.title.localeCompare(b.title), render: (d) => d.title },
      { key: 'id', header: 'Runtime', render: (d) => <T size="xs" tone="tertiary">{d.source.id}</T> },
      { key: 'workspace', header: 'Workspace', render: (d) => <Chip tone="neutral" size="xs">{d.contextTenant}</Chip> },
      { key: 'model', header: 'Model', render: (d) => str(d.meta['model']) },
      { key: 'tools', header: 'Tools', numeric: true, render: (d) => (Array.isArray(d.meta['tools']) ? (d.meta['tools'] as unknown[]).length : 0) },
      { key: 'status', header: 'Status', width: '112px', render: (d) => <Chip tone={d.meta['status'] === 'healthy' ? 'success' : d.meta['status'] === 'degraded' ? 'warning' : 'neutral'} size="xs">{str(d.meta['status'])}</Chip> },
      ...RUNS,
    ],
  },
  bots: {
    title: 'Bots',
    description: 'Standing missions from the org workspace — each bot is a definition, each firing one of its runs.',
    noun: 'bots',
    empty: 'No bots are registered.',
    columns: [
      {
        key: 'title', header: 'Bot', sortable: true, compare: (a, b) => a.title.localeCompare(b.title),
        render: (d) => d.title,
      },
      { key: 'state', header: 'State', width: '96px', render: (d) => (d.enabled ? <Chip tone="success" size="xs">active</Chip> : <Chip tone="neutral" size="xs">paused</Chip>) },
      { key: 'trigger', header: 'Trigger', render: (d) => (d.meta['cronExpr'] ? `${triggerSummary(d.triggers)} · ${String(d.meta['cronExpr'])}` : triggerSummary(d.triggers)) },
      { key: 'initiative', header: 'Initiative', render: (d) => str(d.meta['initiativeName'] ?? d.meta['initiativeId'] ?? d.meta['repo']) },
      { key: 'model', header: 'Model', render: (d) => str(d.meta['model']) },
      ...RUNS,
    ],
  },
  commands: {
    title: 'Commands',
    description: 'The assessment worker\'s commands — each is a definition, each launch one of its runs.',
    noun: 'commands',
    empty: 'No assessment commands are registered.',
    columns: [
      { key: 'title', header: 'Command', sortable: true, compare: (a, b) => a.title.localeCompare(b.title), render: (d) => d.title },
      { key: 'summary', header: 'What it does', render: (d) => d.description ?? '—' },
      { key: 'owner', header: 'Runs as', render: (d) => <T size="xs" tone="tertiary">{d.ownerName ?? d.owner ?? '—'}</T> },
      ...RUNS,
    ],
  },
};

export default function SourcesPage({ source }: { source: SourcePageId }) {
  const { session } = useSession();
  return <SourcesWorkspace source={source} key={`${source}:${session?.sub}:${session?.tenant}:${session?.role}`} />;
}

function SourcesWorkspace({ source }: { source: SourcePageId }) {
  const navigate = useNavigate();
  const page = PAGES[source];
  const { data, error, isLoading, refresh } = useFetch<DefinitionsResponse>(
    `/api/pipelines/definitions?kind=${encodeURIComponent(SOURCE_KINDS[source])}`, 60_000,
  );
  const [query, setQuery] = useState('');
  const all = data?.definitions ?? [];
  const rows = all.filter((d) => matchesDefinition(d, query));

  const adapter = pipelineCollectionAdapter(source, {
    setQuery, refresh,
    scopeNote: 'Search uses loaded registry names, IDs, descriptions and owners across table pages. Open uses one exact visible title or ID. This registry is read-only; launching, editing and pausing definitions are not commands.',
    open(target) {
      if (!data || isLoading || error) throw new Error('Wait for the registry to load successfully before opening a record.');
      const row = resolvePipelineCollectionTarget(target, rows);
      navigate(definitionHref(row.id));
      return `Opened ${row.title}.`;
    },
  });

  return (
    <CollectionCommandPage data-testid={`pipelines-source-${source}`} title={page.title} description={page.description}>
      <Stack gap="none" className="min-h-0 min-w-0 flex-1">
      <Stack gap="md" className="min-h-0 flex-1 overflow-auto px-[var(--ui-page-gutter)]">
      <CollectionToolbar {...{ label: `${page.title} filters`, search: { value: query, onChange: setQuery, placeholder: `Search ${page.noun}`, 'aria-label': `Search ${page.noun}` },
        summary: data ? `${rows.length} ${page.noun} · ${all.reduce((n, d) => n + d.runCount, 0)} recorded runs` : undefined,
        notices: ['This source registry is read-only.'],
        onRefresh: refresh, refreshing: isLoading,
      }} />

      {data && data.unavailable.length > 0 && (
        <Banner variant="warning">
          {`Not every source could be read — ${data.unavailable.map((u) => `${u.source}: ${u.error}`).join('; ')}.`}
        </Banner>
      )}
      {error ? (
        <UnavailableNotice error={error} what={page.noun} source="Listed from the definition registry" onRetry={refresh} />
      ) : (
        <DataTable
          data-testid={`pipelines-source-${source}-table`}
          data={rows}
          columns={page.columns}
          keyField={(d) => d.id}
          loading={isLoading && !data}
          pageSize={25}
          onRowClick={(d) => navigate(definitionHref(d.id))}
          emptyMessage={query.trim() ? `No ${page.noun} match "${query.trim()}".` : page.empty}
        />
      )}
      </Stack>
      <CollectionCommandHost adapter={adapter} />
      </Stack>
    </CollectionCommandPage>
  );
}

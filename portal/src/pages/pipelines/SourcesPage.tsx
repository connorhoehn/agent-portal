// /pipelines/agents, /pipelines/bots, /pipelines/commands — the three
// producers, read-only (docs/social-tenant-design.md §5.3: "read-only views
// of what each tenant registered"). Each lists that kind of definition from
// GET /api/pipelines/definitions?kind=… — the fleet registry's agents, the
// org's bots, the assessment worker's commands — with how often each ran; a
// row opens its definition. Nothing here writes: bots are managed in the org
// workspace, commands in assessment, agents by deployment.

import { useState } from 'react';
import { useNavigate } from 'react-router';
import {
  Banner, Chip, DataTable, Inline, MetaLine, PageHeader, SearchInput, Stack, type DataTableColumn,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { relativeTime } from '../../lib/relativeTime';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { PipelineRunStatusChip } from '../../components/runs/PipelineRunParts';
import {
  SOURCE_KINDS, definitionHref, matchesDefinition, triggerSummary, type DefinitionsResponse, type PipelineDefinition, type SourcePageId,
} from '../../lib/pipelineDefinitions';

const str = (v: unknown): string => (typeof v === 'string' && v ? v : '—');

const RUNS: DataTableColumn<PipelineDefinition>[] = [
  { key: 'runCount', header: 'Runs', align: 'right', sortable: true, compare: (a, b) => a.runCount - b.runCount, render: (d) => d.runCount },
  {
    key: 'lastRun', header: 'Last run',
    render: (d) => (d.lastRun ? (
      <Inline gap="xs" align="center">
        <PipelineRunStatusChip status={d.lastRun.status} />
        <MetaLine size="xs" tone="tertiary" items={[d.lastRun.startedAt ? relativeTime(d.lastRun.startedAt) : null]} />
      </Inline>
    ) : 'never'),
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
      { key: 'id', header: 'Runtime', render: (d) => <MetaLine size="xs" tone="secondary" items={[d.source.id]} /> },
      { key: 'workspace', header: 'Workspace', render: (d) => <Chip tone="neutral" size="xs">{d.contextTenant}</Chip> },
      { key: 'model', header: 'Model', render: (d) => str(d.meta['model']) },
      { key: 'tools', header: 'Tools', align: 'right', render: (d) => (Array.isArray(d.meta['tools']) ? (d.meta['tools'] as unknown[]).length : 0) },
      { key: 'status', header: 'Status', render: (d) => <Chip tone={d.meta['status'] === 'healthy' ? 'success' : d.meta['status'] === 'degraded' ? 'warning' : 'neutral'} size="xs">{str(d.meta['status'])}</Chip> },
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
        render: (d) => (
          <Inline gap="xs" align="center">
            {d.title}
            {!d.enabled && <Chip tone="neutral" size="xs">paused</Chip>}
          </Inline>
        ),
      },
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
      { key: 'owner', header: 'Runs as', render: (d) => <MetaLine size="xs" tone="secondary" items={[d.owner ?? '—']} /> },
      ...RUNS,
    ],
  },
};

export default function SourcesPage({ source }: { source: SourcePageId }) {
  const navigate = useNavigate();
  const page = PAGES[source];
  const { data, error, isLoading, refresh } = useFetch<DefinitionsResponse>(
    `/api/pipelines/definitions?kind=${encodeURIComponent(SOURCE_KINDS[source])}`, 60_000,
  );
  const [query, setQuery] = useState('');
  const all = data?.definitions ?? [];
  const rows = all.filter((d) => matchesDefinition(d, query));

  return (
    <Stack gap="md" data-testid={`pipelines-source-${source}`}>
      <PageHeader title={page.title} description={page.description} badge={<Chip tone="neutral" size="xs">Read-only</Chip>} />
      <Inline gap="sm" wrap align="center">
        <SearchInput size="sm" className="w-64" aria-label={`Search ${page.noun}`} placeholder={`Search ${page.noun}`} value={query} onChange={setQuery} onClear={() => setQuery('')} />
        {data && (
          <MetaLine size="xs" tone="tertiary" items={[
            rows.length === all.length ? `${all.length} ${page.noun}` : `${rows.length} of ${all.length} ${page.noun}`,
            `${all.reduce((n, d) => n + d.runCount, 0)} recorded runs`,
          ]} />
        )}
      </Inline>
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
  );
}

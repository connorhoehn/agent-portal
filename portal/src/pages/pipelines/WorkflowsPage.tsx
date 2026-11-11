// /pipelines/workflows — the pipelines tenant's workflow definitions, each
// with its last dry-run and what rule 1 says about promoting it
// (docs/social-tenant-design.md §5.2: a workflow is promoted only on a
// completed run of its own definition). Dry-run (RunPipeline holders only)
// queues a governed run on the existing queue; a row opens the definition.
//
// Renamed from "Runbooks" in the learning loop (lane E7): the Runbooks area is
// now the orgiq catalogue of run-authored procedures, and these are a
// different thing. Behaviour is unchanged. The API path stays
// GET /api/pipelines/runbooks (and the `runbook` definition kind, the
// `runbook:<id>` definition ids): renaming them would move wire data and
// stored ids for no gain, so only the page, its URL and its copy changed.
// /pipelines/runbooks redirects here (App.tsx).

import { ofTotal } from '../../lib/plural';
import {
  CollectionToolbar,
  Stack,
  Banner,
  Chip,
  ConfirmDialog,
  DataTable,
  IconButton,
  MetaLine,
  PlayCircleIcon,
  type DataTableColumn,
} from '@connorhoehn/ui-components/shared';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { RecordLink } from '../decisions/RecordLink';
import { CollectionCommandPage } from '../../components/collections/CollectionCommandPage';
import { CollectionCommandHost } from '../../components/collections/CollectionCommandHost';
import { pipelineCollectionAdapter, filterRunbooks } from './pipelineCollectionCommands';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { PipelineRunStatusChip } from '../../components/runs/PipelineRunParts';
import { useFetch } from '../../hooks/useFetch';
import { useCapabilities } from '../../lib/capabilities';
import {
  canDryRun,
  definitionHref,
  promotionVerdict,
  rungLabel,
  type RunbookRow,
} from '../../lib/pipelineDefinitions';
import { relativeTime } from '../../lib/relativeTime';
import { useDryRun } from './useDryRun';

interface WorkflowsResponse { runbooks: RunbookRow[]; total: number; unavailable: Array<{ source: string; error: string }> }

const BASE_COLUMNS: DataTableColumn<RunbookRow>[] = [
  { key: 'title', header: 'Workflow', sortable: true, compare: (a, b) => a.title.localeCompare(b.title), render: (r) => <RecordLink to={definitionHref(r.id)}>{r.title}</RecordLink> },
  { key: 'rung', header: 'Rung', render: (r) => rungLabel(r.runbook) },
  { key: 'steps', header: 'Steps', numeric: true, render: (r) => r.steps.length },
  {
    key: 'lastDryRunStatus', header: 'Last dry-run', width: '128px',
    render: (r) => (r.runbook.lastDryRun ? <PipelineRunStatusChip status={r.runbook.lastDryRun.status} /> : 'never'),
  },
  {
    key: 'lastDryRun', header: 'Dry-run at', numeric: true,
    render: (r) => (r.runbook.lastDryRun ? relativeTime(r.runbook.lastDryRun.startedAt) : '—'),
  },
  {
    key: 'promotion', header: 'Promotion',
    render: (r) => {
      const v = promotionVerdict(r.runbook);
      return <Chip tone={v.tone} size="xs" title={v.detail}>{v.label}</Chip>;
    },
  },
];

export default function WorkflowsPage() {
  const navigate = useNavigate();
  const { can, ready } = useCapabilities();
  const { data, error, isLoading, refresh } = useFetch<WorkflowsResponse>('/api/pipelines/runbooks', 30_000);
  const dryRun = useDryRun(() => refresh());
  const canRun = ready && can('RunPipeline');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('');
  const all = data?.runbooks ?? [];
  const rows = filterRunbooks(all, query, filter);
  const adapter = pipelineCollectionAdapter('workflows', { setQuery, setFilter, refresh,
    scopeNote: 'Search and filter the workflows shown. Passed means a completed dry-run. Commands never start a dry-run or promote a workflow.' });

  return (
    <CollectionCommandPage data-testid="pipelines-workflows" title="Workflows" description="Workflow definitions and their dry-runs. A workflow is promoted only after a completed dry-run of its own definition.">
      <Stack gap="none" className="min-h-0 min-w-0 flex-1">
      <Stack gap="md" className="min-h-0 flex-1 overflow-auto px-[var(--ui-page-gutter)]">
      <CollectionToolbar {...{ label: 'Workflow filters', search: { value: query, onChange: setQuery, placeholder: 'Search workflows', 'aria-label': 'Search workflows' },
        filters: [{ id: 'promotion', label: 'Promotion', value: filter, onChange: setFilter, options: [
          { value: '', label: 'All workflows' }, { value: 'passed', label: 'Dry-run passed' },
          { value: 'needs-dry-run', label: 'Needs dry-run' }, { value: 'promoted', label: 'Promoted' },
        ] }], summary: data ? `${ofTotal(rows.length, all.length, 'workflow')} · ${rows.filter(r => r.runbook.promotionToSkill.ok).length} with a completed dry-run` : undefined,
        onRefresh: refresh, refreshing: isLoading,
      }} />

      {data && !canRun && <MetaLine size="xs" tone="tertiary" items={['dry-runs are started by authors and operators']} />}
      {data && data.unavailable.length > 0 && (
        <Banner variant="warning">
          {`Not every source could be read — ${data.unavailable.map((u) => `${u.source}: ${u.error}`).join('; ')}.`}
        </Banner>
      )}
      {error ? (
        <UnavailableNotice error={error} what="workflows" source="Workflows are the seeded promotion candidates (mock/promotions.ts)" onRetry={refresh} />
      ) : (
        <DataTable narrow
          data-testid="pipelines-workflows-table"
          data={rows}
          columns={BASE_COLUMNS}
          keyField={(r) => r.id}
          loading={isLoading && !data}
          pageSize={25}
          onRowClick={(r) => navigate(definitionHref(r.id))}
          rowActions={canRun ? (r) => (canDryRun(r) ? (
            <IconButton
              size="sm"
              icon={<PlayCircleIcon />}
              aria-label={`Dry-run ${r.title}`}
              title={dryRun.busy === r.id ? 'Starting…' : 'Dry-run'}
              disabled={dryRun.busy === r.id || r.runbook.lastDryRun?.status === 'pending' || r.runbook.lastDryRun?.status === 'running'}
              onClick={(e) => { e.stopPropagation(); dryRun.start(r.id, r.title); }}
              data-testid="pipelines-workflow-dry-run"
            />
          ) : null) : undefined}
          emptyMessage={query || filter ? 'No workflows match these filters.' : 'No workflows.'}
        />
      )}
      <ConfirmDialog
        open={dryRun.confirm !== null}
        title="Start the dry-run anyway?"
        body={dryRun.confirm?.message}
        confirmLabel="Start anyway"
        tone="caution"
        onConfirm={dryRun.confirmNow}
        onCancel={dryRun.dismiss}
      />
    </Stack>
      <CollectionCommandHost adapter={adapter} />
      </Stack>
    </CollectionCommandPage>
  );
}

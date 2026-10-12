// /pipelines/runbooks — the runbooks on the promotion ladder, each with its
// last dry-run and what rule 1 says about making it a skill
// (docs/social-tenant-design.md §5.2: a RUNBOOK becomes a SKILL only on a
// completed run of its own definition). Read from GET /api/pipelines/runbooks;
// Dry-run (RunPipeline holders only) queues a governed run on the existing
// queue; a row opens the runbook's definition.

import { useNavigate } from 'react-router';
import { Toolbar, Tooltip, RepeatIcon,
  Banner, Chip, ConfirmDialog, DataTable, IconButton, MetaLine, PageHeader, PlayCircleIcon, Stack, StatStrip, type DataTableColumn,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { useCapabilities } from '../../lib/capabilities';
import { relativeTime } from '../../lib/relativeTime';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { PipelineRunStatusChip } from '../../components/runs/PipelineRunParts';
import {
  canDryRun, definitionHref, promotionVerdict, rungLabel, type RunbookRow,
} from '../../lib/pipelineDefinitions';
import { useDryRun } from './useDryRun';

interface RunbooksResponse { runbooks: RunbookRow[]; total: number; unavailable: Array<{ source: string; error: string }> }

const BASE_COLUMNS: DataTableColumn<RunbookRow>[] = [
  { key: 'title', header: 'Runbook', sortable: true, compare: (a, b) => a.title.localeCompare(b.title), render: (r) => r.title },
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
    key: 'promotion', header: 'Promotion to skill',
    render: (r) => {
      const v = promotionVerdict(r.runbook);
      return <Chip tone={v.tone} size="xs" title={v.detail}>{v.label}</Chip>;
    },
  },
];

export default function RunbooksPage() {
  const navigate = useNavigate();
  const { can, ready } = useCapabilities();
  const { data, error, isLoading, refresh } = useFetch<RunbooksResponse>('/api/pipelines/runbooks', 30_000);
  const dryRun = useDryRun(() => refresh());
  const canRun = ready && can('RunPipeline');
  const rows = data?.runbooks ?? [];

  return (
    <Stack gap="md" className="min-w-0" data-testid="pipelines-runbooks">
      <PageHeader density="compact"
        title="Runbooks"
        description="Runbooks on their way to becoming skills. A runbook becomes a skill only after a completed dry-run of its own definition."
      />
      <Toolbar aria-label="Runbooks summary" wrap className="px-0" end={<Tooltip content="Refresh"><IconButton size="sm" aria-label="Refresh" icon={<RepeatIcon />} onClick={refresh} disabled={isLoading} /></Tooltip>}>
      {data && (
        <StatStrip
          aria-label="Runbook summary"
          variant="line"
          size="sm"
          items={[
            { label: rows.length === 1 ? 'runbook' : 'runbooks', value: rows.length },
            { label: 'with a completed dry-run', value: rows.filter((r) => r.runbook.promotionToSkill.ok).length },
          ]}
        />
      )}
      </Toolbar>
      {data && !canRun && <MetaLine size="xs" tone="tertiary" items={['dry-runs are started by authors and operators']} />}
      {data && data.unavailable.length > 0 && (
        <Banner variant="warning">
          {`Not every source could be read — ${data.unavailable.map((u) => `${u.source}: ${u.error}`).join('; ')}.`}
        </Banner>
      )}
      {error ? (
        <UnavailableNotice error={error} what="runbooks" source="Runbooks are the promotion ladder's RUNBOOK rung" onRetry={refresh} />
      ) : (
        <DataTable
          data-testid="pipelines-runbooks-table"
          size="sm"
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
              data-testid="pipelines-runbook-dry-run"
            />
          ) : null) : undefined}
          emptyMessage="No runbooks — nothing on the promotion ladder has reached the runbook rung."
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
  );
}

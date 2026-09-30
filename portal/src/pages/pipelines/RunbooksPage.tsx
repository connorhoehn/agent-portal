// /pipelines/runbooks — the runbooks on the promotion ladder, each with its
// last dry-run and what rule 1 says about making it a skill
// (docs/social-tenant-design.md §5.2: a RUNBOOK becomes a SKILL only on a
// completed run of its own definition). Read from GET /api/pipelines/runbooks;
// Dry-run (RunPipeline holders only) queues a governed run on the existing
// queue; a row opens the runbook's definition.

import { useNavigate } from 'react-router';
import {
  Banner, Button, Chip, ConfirmDialog, DataTable, Inline, MetaLine, PageHeader, Stack, type DataTableColumn,
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
  { key: 'steps', header: 'Steps', align: 'right', render: (r) => r.steps.length },
  {
    key: 'lastDryRun', header: 'Last dry-run',
    render: (r) => (r.runbook.lastDryRun ? (
      <Inline gap="xs" align="center">
        <PipelineRunStatusChip status={r.runbook.lastDryRun.status} />
        <MetaLine size="xs" tone="tertiary" items={[relativeTime(r.runbook.lastDryRun.startedAt)]} />
      </Inline>
    ) : 'never'),
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
    <Stack gap="md" data-testid="pipelines-runbooks">
      <PageHeader
        title="Runbooks"
        description="Runbooks on their way to becoming skills. A runbook becomes a skill only after a completed dry-run of its own definition."
      />
      {data && (
        <MetaLine size="xs" tone="tertiary" items={[
          `${rows.length} runbooks`,
          `${rows.filter((r) => r.runbook.promotionToSkill.ok).length} with a completed dry-run`,
          canRun ? null : 'dry-runs are started by authors and operators',
        ]} />
      )}
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
          data={rows}
          columns={BASE_COLUMNS}
          keyField={(r) => r.id}
          loading={isLoading && !data}
          pageSize={25}
          onRowClick={(r) => navigate(definitionHref(r.id))}
          rowActions={canRun ? (r) => (canDryRun(r) ? (
            <Button
              size="sm"
              variant="secondary"
              disabled={dryRun.busy === r.id || r.runbook.lastDryRun?.status === 'pending' || r.runbook.lastDryRun?.status === 'running'}
              onClick={(e) => { e.stopPropagation(); dryRun.start(r.id, r.title); }}
              data-testid="pipelines-runbook-dry-run"
            >
              {dryRun.busy === r.id ? 'Starting…' : 'Dry-run'}
            </Button>
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

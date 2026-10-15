// One definition, opened as a page (`/pipelines/definitions/:definitionId`,
// GET /api/pipelines/definitions/:id) beside the catalog's list rail: its source,
// triggers, ordered steps and recent runs; for a runbook, its dry-runs and
// what rule 1 says about promoting it. The Dry-run action is shown only to
// RunPipeline holders, the approver editor only to AuthorDefinition holders
// — absent from the DOM for everyone else, not disabled.

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { IconButton, Tooltip, PlayCircleIcon, CheckIcon,
  Button, ConfirmDialog, DataTable, DetailHeader, DetailSection, EmptyState, Inline, InlineAlert, KeyValue, LoadingState,
  MetaLine, Select, Stack, type DataTableColumn,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { useCapabilities } from '../../lib/capabilities';
import { relativeTime } from '../../lib/relativeTime';
import { usd } from '../../lib/format';
import { writeJson } from '../../lib/writeJson';
import { toastError, toastSuccess } from '../../lib/toastStore';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { PipelineRunStatusChip } from '../../components/runs/PipelineRunParts';
import { kindLabel, runHref, type PipelineRun } from '../../lib/pipelineRuns';
import {
  approverSummary, canDryRun, promotionVerdict, roleLabel, rungLabel, triggerSummary,
  type DefinitionStep, type DryRunRecord, type PipelineDefinition, type RunbookState,
} from '../../lib/pipelineDefinitions';
import { useDryRun } from './useDryRun';
import { PipelineDiscussion, PipelinePresence } from './PipelineRealtime';
import { defChannel } from './pipelinesRealtime';

/** The definition's discussion, at the record frame's full width (CollectionRecordFrame `conversation`). */
export function DefinitionDiscussion({ id }: { id: string }) {
  return <Stack gap="none" data-testid="pipelines-definition-discussion"><PipelineDiscussion channel={defChannel(id)} /></Stack>;
}

interface DefinitionDetail {
  definition: PipelineDefinition;
  runs: PipelineRun[];
  dryRuns: DryRunRecord[];
  runbook?: RunbookState;
  approverRoleOptions: string[];
  unavailable?: Array<{ source: string; error: string }>;
}

const STEP_COLUMNS: DataTableColumn<DefinitionStep & { n: number }>[] = [
  { key: 'n', header: '#', width: '3rem', numeric: true, render: (s) => s.n },
  { key: 'label', header: 'Step', render: (s) => s.label },
  { key: 'detail', header: 'Detail', render: (s) => s.detail ?? '—' },
];

const RUN_COLUMNS: DataTableColumn<PipelineRun>[] = [
  { key: 'status', header: 'Status', width: '112px', render: (r) => <PipelineRunStatusChip status={r.status} /> },
  { key: 'title', header: 'Run', render: (r) => r.context.title },
  { key: 'startedAt', header: 'Started', numeric: true, render: (r) => (r.startedAt ? relativeTime(r.startedAt) : '—') },
];

const DRY_RUN_COLUMNS: DataTableColumn<DryRunRecord>[] = [
  { key: 'status', header: 'Status', width: '112px', render: (r) => <PipelineRunStatusChip status={r.status} /> },
  { key: 'id', header: 'Run', render: (r) => <MetaLine size="xs" tone="secondary" items={[r.id]} /> },
  { key: 'by', header: 'Started by', render: (r) => r.triggeredBy ?? '—' },
  { key: 'cost', header: 'Cost', numeric: true, render: (r) => (r.costUsd != null ? usd(r.costUsd, { precision: 4 }) : r.estimateUsd != null ? `est. ${usd(r.estimateUsd, { precision: 4 })}` : '—') },
  { key: 'startedAt', header: 'Started', numeric: true, render: (r) => relativeTime(r.startedAt) },
];

export function DefinitionRecord({ id, onChanged }: { id: string; onChanged: () => void }) {
  const navigate = useNavigate();
  const { can, ready } = useCapabilities();
  const { data, error, isLoading, refresh } = useFetch<DefinitionDetail>(
    id ? `/api/pipelines/definitions/${encodeURIComponent(id)}` : null, 15_000,
  );
  const dryRun = useDryRun(() => { refresh(); onChanged(); });
  const [approver, setApprover] = useState('');
  const [saving, setSaving] = useState(false);
  const def = data?.definition.id === id ? data.definition : null;

  useEffect(() => { setApprover(def?.approverRoles[0] ?? ''); }, [def?.id, def?.version]); // eslint-disable-line react-hooks/exhaustive-deps

  async function saveApprovers() {
    if (!def) return;
    setSaving(true);
    const res = await writeJson<{ definition: PipelineDefinition }>(
      `/api/pipelines/definitions/${encodeURIComponent(def.id)}/approvers`, 'PUT', { roles: approver ? [approver] : [] },
    );
    setSaving(false);
    if (res.ok && res.data) {
      toastSuccess(null, 'Approvers recorded', `${def.title} is now version ${res.data.definition.version}.`);
      refresh(); onChanged();
    } else toastError(null, 'Could not record the approvers', res.error ?? undefined);
  }

  const canRun = ready && can('RunPipeline');
  const canAuthor = ready && can('AuthorDefinition');
  const notFound = error && /404|not found|No definition/i.test(error);

  return (
    <Stack gap="md" data-testid="pipelines-definition-record">
      <DetailHeader
        title={def?.title ?? 'Definition'}
        description={def ? `${kindLabel(def.kind)} · ${def.id}` : id}
        {...(def ? {
          aside: (
            <Inline gap="sm" align="center" justify="end">
              <PipelinePresence channel={defChannel(def.id)} />
              {canRun && canDryRun(def) && (
                <Tooltip content="Dry-run"><IconButton size="sm" aria-label="Dry-run" icon={<PlayCircleIcon />} disabled={dryRun.busy === def.id} onClick={() => dryRun.start(def.id, def.title)} data-testid="pipelines-dry-run" /></Tooltip>
              )}
            </Inline>
          ),
          asideWidth: 160,
        } : {})}
      />
      {notFound ? (
        <EmptyState align="start" title="Definition not found" description={`No definition with id ${id ?? ''} — its source may have been removed.`} />
      ) : error && !def ? (
        <UnavailableNotice error={error} what="this definition" source="Definitions are derived from bots, commands, runbooks and agents" onRetry={refresh} />
      ) : !def ? (
        <LoadingState label={isLoading ? 'Loading definition…' : 'Loading…'} />
      ) : (
        <Stack gap="md">
          {def.description && <MetaLine size="sm" tone="secondary" items={[def.description]} />}
          {(data?.unavailable?.length ?? 0) > 0 && (
            <InlineAlert tone="warning">{`Not every source could be read — ${data!.unavailable!.map((u) => `${u.source}: ${u.error}`).join('; ')}. Its dry-runs are missing below, not absent.`}</InlineAlert>
          )}
          {def.orphaned && <InlineAlert tone="warning">Recorded, but the source it described no longer exists.</InlineAlert>}
          {!def.enabled && !def.orphaned && <InlineAlert tone="info">Listed, but it will not run as things stand (paused, dismissed or offline).</InlineAlert>}
          <KeyValue
            layout="row"
            items={[
              { label: 'Workspace', value: def.contextTenant === 'assessment' ? 'Assessment' : 'Work' },
              { label: 'Owner', value: def.ownerName ?? def.owner ?? 'Not recorded', muted: !def.owner },
              { label: 'Version', value: `v${def.version}${def.recorded ? ' (recorded)' : ' (derived)'}` },
              { label: 'Source', value: `${def.source.table} · ${def.source.id}`, mono: true },
              { label: 'Triggers', value: def.triggers.map((t) => `${triggerSummary([t])} — ${t.detail}`).join('; ') || 'none' },
              { label: 'Approved by', value: approverSummary(def.effectiveApproverRoles, def.approversDefaulted) },
              { label: 'Runs', value: String(def.runCount) },
            ]}
          />
          {canAuthor && (
            <DetailSection title="Approvers" hint="Author" description="Who approves this definition's steps. Nobody named means the tenant default." data-testid="pipelines-approver-editor">
              <Stack gap="sm">
                <Select
                  aria-label="Approver role"
                  size="sm"
                  value={approver}
                  onChange={(e) => setApprover(e.target.value)}
                  options={[{ value: '', label: 'Tenant default' }, ...(data?.approverRoleOptions ?? []).map((r) => ({ value: r, label: roleLabel(r) }))]}
                />
                <Button size="sm" variant="primary" className="self-start" disabled={saving || approver === (def.approverRoles[0] ?? '')} onClick={() => void saveApprovers()}>
                  <CheckIcon />{saving ? 'Saving…' : 'Record approvers'}
                </Button>
              </Stack>
            </DetailSection>
          )}
          {data?.runbook && (
            <DetailSection title="Promotion to skill" hint={rungLabel(data.runbook)} data-testid="pipelines-runbook-verdict">
              {(() => {
                const v = promotionVerdict(data.runbook);
                return <InlineAlert tone={v.tone === 'success' ? 'success' : v.tone === 'warning' ? 'warning' : 'info'}>{`${v.label} — ${v.detail}`}</InlineAlert>;
              })()}
            </DetailSection>
          )}
          <DetailSection title="Steps" hint={`${def.steps.length}`}>
            <DataTable
              frameless
              data={def.steps.map((s, i) => ({ ...s, n: i + 1 }))}
              columns={STEP_COLUMNS}
              keyField={(s) => s.id}
              staticRows="Steps are this definition's ordered recipe; a step runs only as part of a run, which opens from Recent runs."
              emptyMessage="This definition records no steps."
            />
          </DetailSection>
          {data?.runbook && (
            <DetailSection title="Dry-runs" hint={`${data.dryRuns.length}`} data-testid="pipelines-dry-runs">
              <DataTable
                frameless
                data={data.dryRuns}
                columns={DRY_RUN_COLUMNS}
                keyField={(r) => r.id}
                onRowClick={(r) => navigate(runHref('/pipelines/runs', r.id))}
                emptyMessage={canRun ? 'No dry-run yet — start one with Dry-run.' : 'No dry-run yet. An author or operator starts one.'}
              />
            </DetailSection>
          )}
          <DetailSection title="Recent runs" hint={`${data?.runs.length ?? 0}`}>
            <DataTable
              frameless
              data={data?.runs ?? []}
              columns={RUN_COLUMNS}
              keyField={(r) => r.id}
              onRowClick={(r) => navigate(runHref('/pipelines/runs', r.id))}
              emptyMessage="No run of this definition is recorded."
            />
          </DetailSection>
        </Stack>
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

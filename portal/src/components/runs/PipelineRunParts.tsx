// One pipeline Run, in four parts — Run → Steps → Artifacts → Events
// (docs/pipelines-tenant-goal.md §"The vertical slice"). Shared by the
// pipelines tenant's run detail page (reading /api/pipelines/runs) and the
// orgiq bot detail page (reading the /api/runs façade): the same projection,
// the same rendering, two doors. Each caller wraps the parts in its own
// sections, which is where the `pipeline-*` test ids live.
//
// Composed from the library only: DetailHeader + KeyValue for the run,
// WorkflowStepper (its active step carries aria-current="step") + DataTable
// for the steps, DataTable for the artifacts, RunTimeline tailing the run's
// SSE stream for the events.

import {
  Chip, DataTable, DetailHeader, Inline, KeyValue, MetaLine, Stack, WorkflowStepper,
  type DataTableColumn,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { relativeTime } from '../../lib/relativeTime';
import { usd } from '../../lib/format';
import {
  artifactKindLabel, attemptItems, kindLabel, runHref, runStatusChip, sourceLabel, sourceStatusNote, stepperSteps, stepStatusChip,
  type PipelineArtifact, type PipelineRun, type PipelineStep,
} from '../../lib/pipelineRuns';
import { RunTimeline } from './RunTimeline';

/** Read one run and its steps from a run API base (`/api/runs` or `/api/pipelines/runs`). */
export function usePipelineRun(base: string, runId: string | null) {
  const url = runId ? runHref(base, runId) : null;
  const one = useFetch<{ run: PipelineRun; artifacts: PipelineArtifact[] }>(url);
  const steps = useFetch<{ steps: PipelineStep[] }>(url ? `${url}/steps` : null);
  return {
    run: one.data?.run ?? null,
    artifacts: one.data?.artifacts ?? [],
    steps: steps.data?.steps ?? [],
    error: one.error ?? steps.error,
    loading: one.isLoading || steps.isLoading,
    eventsUrl: url ? `${url}/events` : null,
    refresh: () => { one.refresh(); steps.refresh(); },
  };
}

export function PipelineRunStatusChip({ status, title }: { status: string; title?: string }) {
  const c = runStatusChip(status);
  return <Chip tone={c.tone} size="xs" dot={status === 'running' ? 'pulse' : undefined} {...(title ? { title } : {})}>{c.label}</Chip>;
}

/** The run's header and its context — tenant, kind, the source rows it folds. */
export function PipelineRunSummary({ run }: { run: PipelineRun }) {
  const note = sourceStatusNote(run);
  return (
    <Stack gap="sm">
      <DetailHeader
        as="h2"
        title={run.context.title}
        badge={<PipelineRunStatusChip status={run.status} />}
        meta={<MetaLine size="xs" tone="tertiary" items={[
          kindLabel(run.context.kind),
          `${run.triggerType} trigger`,
          run.startedAt ? `started ${relativeTime(run.startedAt)}` : null,
          note,
        ]} />}
      />
      <KeyValue
        layout="grid"
        aria-label="Run context"
        items={[
          // The title says which run this is; the id is one hover away for an operator who needs to quote it.
          { label: 'Run', value: run.context.title, title: run.id },
          { label: 'Definition', value: run.definitionId, mono: true, title: run.definitionId },
          { label: 'Workspace', value: run.context.tenant },
          { label: 'Source', value: sourceLabel(run.context.table), title: run.context.id },
          { label: 'Source status', value: run.context.sourceStatus.replace(/_/g, ' ') },
          { label: 'Triggered by', value: run.triggeredByName ?? run.triggeredBy ?? 'not recorded', muted: run.triggeredBy == null },
          { label: 'Cost', value: run.costUsd != null ? usd(run.costUsd, { precision: 4 }) : 'not recorded', muted: run.costUsd == null },
          {
            label: 'Folds',
            // A relayed agent run has no row yet: its trace closes it later.
            value: run.context.sources.length
              ? run.context.sources.map((s) => `${sourceLabel(s.table)} (${s.role})`).join(' · ')
              : 'no trace filed yet — relayed live',
            muted: run.context.sources.length === 0,
          },
        ]}
      />
      {run.context.error && <MetaLine size="xs" tone="secondary" items={[`error: ${run.context.error}`]} />}
    </Stack>
  );
}

const STEP_COLUMNS: DataTableColumn<PipelineStep>[] = [
  { key: 'label', header: 'Step', render: (s) => s.label },
  {
    key: 'status', header: 'Status', width: '112px',
    render: (s) => { const c = stepStatusChip(s.status); return <Chip tone={c.tone} size="xs">{c.label}</Chip>; },
  },
  { key: 'startedAt', header: 'Started', numeric: true, render: (s) => (s.startedAt ? relativeTime(s.startedAt) : '—') },
  {
    key: 'attempts', header: 'Attempts',
    // An agent run's attempts are its tool calls (TOOL_CALL_START…RESULT) —
    // named, each with its own outcome; any other run's are numbered retries.
    render: (s) => {
      const items = attemptItems(s);
      if (items.length === 0) return '—';
      return (
        <Inline gap="xs" wrap={false}>
          {items.map((a) => { const c = stepStatusChip(a.status); return <Chip key={a.key} tone={c.tone} size="xs" title={c.label}>{a.label}</Chip>; })}
        </Inline>
      );
    },
  },
  { key: 'detail', header: 'Detail', render: (s) => s.detail ?? '—' },
];

export function PipelineRunSteps({ steps }: { steps: PipelineStep[] }) {
  if (steps.length === 0) return <MetaLine size="sm" tone="tertiary" items={['No steps recorded for this run.']} />;
  return (
    <Stack gap="sm">
      <WorkflowStepper steps={stepperSteps(steps)} data-testid="pipeline-stepper" />
      <DataTable data={steps} columns={STEP_COLUMNS} keyField={(s) => s.stepId}
        staticRows="Steps are this run's timeline, read in place; the run itself is the record." />
    </Stack>
  );
}

const ARTIFACT_COLUMNS: DataTableColumn<PipelineArtifact>[] = [
  { key: 'kind', header: 'Kind', render: (a) => <Chip tone="neutral" size="xs">{artifactKindLabel(a.kind)}</Chip> },
  { key: 'title', header: 'Artifact', render: (a) => a.title },
  { key: 'stepId', header: 'Step', render: (a) => a.stepId ?? '—' },
  { key: 'uri', header: 'Where', render: (a) => <MetaLine size="xs" tone="tertiary" items={[a.uri]} /> },
];

export function PipelineRunArtifacts({ artifacts }: { artifacts: PipelineArtifact[] }) {
  return (
    <DataTable
      data={artifacts}
      columns={ARTIFACT_COLUMNS}
      keyField={(a) => a.id}
      staticRows="An artifact is listed with the run that produced it; the Artifacts catalog is where one opens."
      emptyMessage="This run recorded no artifact."
    />
  );
}

/** The run's event stream — recorded history replayed, then live frames. */
export function PipelineRunEvents({ eventsUrl, title = 'EVENT STREAM' }: { eventsUrl: string | null; title?: string }) {
  return (
    <RunTimeline
      boxId={null}
      src={eventsUrl}
      title={title}
      maxHeightClass="max-h-[360px]"
      emptyHint="Event-catalog frames (pipeline:run:*, pipeline:step:*) stream here as the run moves."
    />
  );
}

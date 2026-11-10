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
  Chip, CopyIdButton, DataTable, DetailHeader, Inline, KeyValue, MetaLine, Stack, T, WorkflowStepper,
  type DataTableColumn,
} from '@connorhoehn/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { relativeTime } from '../../lib/relativeTime';
import { usd } from '../../lib/format';
import {
  artifactKindLabel, artifactPlace, artifactStepLabel, attemptItems, contextTenantLabel, definitionLabel, kindLabel, runHref, runStatusChip, sourceLabel, sourceStatusNote, stepperSteps, stepStatusChip, workItemName,
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

/** The run's header and its context — tenant, kind, the source rows it folds. `definitionName`: what the caller knows the definition as (the bot's name). */
export function PipelineRunSummary({ run, definitionName }: { run: PipelineRun; definitionName?: string | null }) {
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
          // What ran, by name; its id is behind the copy control, never the text.
          { label: 'Definition', value: (
            <Inline gap="xs" wrap={false}>
              <T size="sm">{definitionLabel(run.definitionId, definitionName)}</T>
              {run.definitionId && <CopyIdButton value={run.definitionId} label="Copy the definition's id" />}
            </Inline>
          ) },
          // The work item it answers, by name; its id behind the copy control, never the text (UX leftovers, 10 November).
          ...(run.context.workItemId ? [{ label: 'Work item', value: (
            <Inline gap="xs" wrap={false}>
              <T size="sm" tone={workItemName(run) === 'Name not found' ? 'tertiary' : 'primary'}>{workItemName(run)}</T>
              <CopyIdButton value={run.context.workItemId} label="Copy the work item's id" />
            </Inline>
          ) }] : []),
          { label: 'Acts for', value: contextTenantLabel(run.context.tenant) },
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
      <DataTable narrow data={steps} columns={STEP_COLUMNS} keyField={(s) => s.stepId}
        staticRows="Steps are this run's timeline, read in place; the run itself is the record." />
    </Stack>
  );
}

// The step by its name and the place in words: ids ("route-2", an invocation
// uuid) stay one hover away (walk, 9 November).
const artifactColumns = (steps: readonly PipelineStep[]): DataTableColumn<PipelineArtifact>[] => [
  { key: 'kind', header: 'Kind', render: (a) => <Chip tone="neutral" size="xs">{artifactKindLabel(a.kind)}</Chip> },
  { key: 'title', header: 'Artifact', render: (a) => a.title },
  { key: 'stepId', header: 'Step', render: (a) => <T size="sm" {...(a.stepId ? { title: a.stepId } : {})}>{artifactStepLabel(a, steps)}</T> },
  { key: 'uri', header: 'Where', render: (a) => { const place = artifactPlace(a); return <T size="xs" tone="tertiary" {...(place.title ? { title: place.title } : {})}>{place.label}</T>; } },
];

export function PipelineRunArtifacts({ artifacts, steps = [] }: { artifacts: PipelineArtifact[]; steps?: readonly PipelineStep[] }) {
  return (
    <DataTable narrow
      data={artifacts}
      columns={artifactColumns(steps)}
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

// /pipelines/runs/:id — one Run: its context, its Steps, its Artifacts and
// its Events (docs/pipelines-tenant-goal.md §Pages). Reads
// /api/pipelines/runs/:id(/steps|/events); the parts are shared with the orgiq
// bot detail page (components/runs/PipelineRunParts.tsx), which reads the same
// run through the /api/runs façade.
//
// The same page serves /iq/runs/:id (lane E) with `apiBase="/api/runs"` — the
// orgiq façade — and no Cancel: cancelling is the pipelines tenant's verb
// (POST /api/pipelines/runs/:id/cancel, CancelRun — operator and
// pipeline-admin; author is forbidden it by the separation of duties).

import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { Button, ConfirmDialog, DetailSection, EmptyState, InlineAlert, LoadingState, PageHeader, Stack } from '@connorhoehnslalom/ui-components/shared';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { useCapabilities } from '../../lib/capabilities';
import { writeJson } from '../../lib/writeJson';
import { isTerminalRun } from './runActions';
import { useCrumbLabel } from '../../lib/crumbLabels';
import { RunTimeline } from '../../components/runs/RunTimeline';
import {
  PipelineRunArtifacts, PipelineRunSteps, PipelineRunSummary, usePipelineRun,
} from '../../components/runs/PipelineRunParts';

export interface RunDetailPageProps {
  /** Where the run is read: the pipelines tenant's own routes, or a tenant façade. */
  apiBase?: string;
  /** The list this run belongs to (the Back link). */
  listPath?: string;
  /** Offer Cancel to CancelRun holders — only on the pipelines tenant's own door. */
  cancelable?: boolean;
}

export default function RunDetailPage({ apiBase = '/api/pipelines/runs', listPath = '/pipelines/runs', cancelable = true }: RunDetailPageProps) {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useCapabilities();
  const [confirming, setConfirming] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const back = { label: 'Runs', to: listPath, onClick: (e: { preventDefault: () => void }) => { e.preventDefault(); navigate(listPath); } };
  const runId = id ?? null;
  const { run, artifacts, steps, error, loading, eventsUrl, refresh } = usePipelineRun(apiBase, runId);
  // The trail reads the run's title once it loads, not "Runs › Runs".
  useCrumbLabel(id, run?.context.title);

  if (error && !run) {
    const notFound = /404|not found|No run/i.test(error);
    return (
      <Stack gap="md" data-testid="pipeline-run-missing">
        <PageHeader title="Run" back={back} />
        {notFound ? (
          <EmptyState align="start" title="Run not found" description={`No run with id ${runId ?? ''} — it may belong to a source that was pruned.`} />
        ) : (
          <UnavailableNotice error={error} what="this run" source="Runs are projected from the jobs, bot runs and commands tables" onRetry={refresh} />
        )}
      </Stack>
    );
  }
  if (!run) return <LoadingState label={loading ? 'Loading run…' : 'Loading…'} />;

  // Absent (not disabled) for a role without CancelRun, and for a finished run.
  const canCancel = cancelable && can('CancelRun') && !isTerminalRun(run.status);
  const cancel = async () => {
    setConfirming(false);
    setCancelling(true);
    setCancelError(null);
    const res = await writeJson<{ status: string }>(`${apiBase}/${encodeURIComponent(run.id)}/cancel`, 'POST');
    setCancelling(false);
    if (!res.ok) { setCancelError(res.error); return; }
    refresh();
  };

  return (
    <Stack gap="md">
      <PageHeader
        title="Run"
        description="One run: its context, its steps, what it produced and its events."
        back={back}
        {...(canCancel ? {
          actions: (
            <Button size="sm" variant="secondary" data-testid="pipeline-run-cancel" disabled={cancelling} onClick={() => setConfirming(true)}>
              {cancelling ? 'Cancelling…' : 'Cancel run'}
            </Button>
          ),
        } : {})}
      />
      {cancelError && <InlineAlert tone="error" onDismiss={() => setCancelError(null)}>{cancelError}</InlineAlert>}
      <ConfirmDialog
        open={confirming}
        title="Cancel this run?"
        body={`${run.context.title} is cancelled through its source — a queued or claimed job, or a running assessment command. Anything else is stopped where it runs, and the ledger will say so.`}
        confirmLabel="Cancel run"
        cancelLabel="Keep it"
        tone="destructive"
        onConfirm={() => { void cancel(); }}
        onCancel={() => setConfirming(false)}
      />
      <DetailSection first title="Run" data-testid="pipeline-run">
        <PipelineRunSummary run={run} />
      </DetailSection>
      <DetailSection title="Steps" hint={`${steps.length}`} data-testid="pipeline-steps">
        <PipelineRunSteps steps={steps} />
      </DetailSection>
      <DetailSection title="Artifacts" hint={`${artifacts.length}`} data-testid="pipeline-artifacts">
        <PipelineRunArtifacts artifacts={artifacts} />
      </DetailSection>
      <DetailSection title="Events" data-testid="pipeline-events">
        {/* The run's SSE stream: recorded history replayed as event-catalog
            frames, then live dispatcher and box-tail frames. */}
        <RunTimeline
          boxId={null}
          src={eventsUrl}
          title="EVENT STREAM"
          maxHeightClass="max-h-[360px]"
          emptyHint="Event-catalog frames (pipeline:run:*, pipeline:step:*) stream here as the run moves."
        />
      </DetailSection>
    </Stack>
  );
}

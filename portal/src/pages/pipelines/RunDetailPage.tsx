// /pipelines/runs/:id — one Run: its context, its Steps, its Artifacts and
// its Events (docs/pipelines-tenant-goal.md §Pages). Reads
// /api/pipelines/runs/:id(/steps|/events); the parts are shared with the orgiq
// bot detail page (components/runs/PipelineRunParts.tsx), which reads the same
// run through the /api/runs façade.

import { useNavigate, useParams } from 'react-router';
import { DetailSection, EmptyState, LoadingState, PageHeader, Stack } from '@connorhoehnslalom/ui-components/shared';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { useCrumbLabel } from '../../lib/crumbLabels';
import { RunTimeline } from '../../components/runs/RunTimeline';
import {
  PipelineRunArtifacts, PipelineRunSteps, PipelineRunSummary, usePipelineRun,
} from '../../components/runs/PipelineRunParts';

export default function RunDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const back = { label: 'Runs', to: '/pipelines/runs', onClick: (e: { preventDefault: () => void }) => { e.preventDefault(); navigate('/pipelines/runs'); } };
  const runId = id ?? null;
  const { run, artifacts, steps, error, loading, eventsUrl, refresh } = usePipelineRun('/api/pipelines/runs', runId);
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

  return (
    <Stack gap="md">
      <PageHeader title="Run" description="One run: its context, its steps, what it produced and its events." back={back} />
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

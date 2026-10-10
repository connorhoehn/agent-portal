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
//
// On the pipelines door the run is a realtime context (realtime-parity gap 3):
// `pipelines:run:<id>` carries its discussion and its huddle lobby, admitted by
// the BFF gateway with this page's REST read authority (ViewPipelines in the
// active pipelines tenant, and the run existing now). The footer reads
// "<run> huddle"; Huddle opens the run's call, Message focuses the Discussion.

import { useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { Button, ConfirmDialog, DetailSection, EmptyState, Inline, InlineAlert, LoadingState, PageHeader, Stack, Tabs, useHeaderDensity } from '@connorhoehnslalom/ui-components/shared';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { useCapabilities } from '../../lib/capabilities';
import { writeJson } from '../../lib/writeJson';
import { isTerminalRun } from './runActions';
import { useGatewayOptional } from '@connorhoehnslalom/realtime-modules/client';
import { PipelineDiscussion, PipelinePresence } from './PipelineRealtime';
import { useCallBlock } from '../../lib/conversationCall';
import { PipelineRunLive } from './PipelineRunLive';
import { RunReportDecks } from './decks/RunReportDecks';
import { ChannelActivity } from '../../components/ChannelActivity';
import { WorkGraphActivity } from '../../components/work-graph/WorkGraphActivity';
import { recordedRunActivity } from './recordedEvents';
import { eventsSource, runChannel } from './pipelinesRealtime';
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
  /** Presence and the run discussion — pipelines tenant only: the gateway admits `pipelines:*` channels to its grant holders. */
  realtime?: boolean;
}

export default function RunDetailPage({ apiBase = '/api/pipelines/runs', listPath = '/pipelines/runs', cancelable = true, realtime = cancelable }: RunDetailPageProps) {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useCapabilities();
  const [searchParams, setSearchParams] = useSearchParams();
  const onActivity = searchParams.get('tab') === 'activity' && realtime;
  const setRunTab = (next: string) => setSearchParams(prev => { const p = new URLSearchParams(prev); if (next === 'activity') p.set('tab', 'activity'); else p.delete('tab'); return p; });
  const [confirming, setConfirming] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const back = { label: 'Runs', to: listPath, onClick: (e: { preventDefault: () => void }) => { e.preventDefault(); navigate(listPath); } };
  const runId = id ?? null;
  const { run, artifacts, steps, error, loading, eventsUrl, refresh } = usePipelineRun(apiBase, runId);
  // The event stream is the gateway's while it is connected; the BFF's SSE is the offline fallback only.
  const live = eventsSource(useGatewayOptional()?.connectionState) === 'gateway';
  const recorded = useMemo(() => (run ? recordedRunActivity(run, steps) : []), [run, steps]);
  // The header's density (library useHeaderDensity): the Activity graph is rich
  // content — the one-row compact header; the run view keeps the full one.
  const headerDensity = useHeaderDensity({ contentKind: onActivity ? 'graph' : 'detail', headerId: 'pipelines-run' });
  // The trail reads the run's title once it loads, not "Runs › Runs".
  useCrumbLabel(id, run?.context.title);
  // The run's huddle: its lobby is the run's channel; the footer's Huddle walks into it.
  useCallBlock(realtime && run ? runChannel(run.id) : null, { enabled: false,
    bind: { title: `${run?.context.title ?? 'Run'} huddle`, ...(can('ViewPipelines') ? {} : { blockedReason: 'Your current role cannot read this run' }) } });

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
    <Stack gap="md" className="h-full min-h-0">
      <PageHeader
        {...headerDensity.headerProps}
        title="Run"
        description="One run: its context, its steps, what it produced and its events."
        back={back}
        {...((canCancel || realtime) ? {
          actions: (
            <Inline gap="sm" align="center">
              {realtime && <PipelinePresence channel={runChannel(run.id)} />}
              {canCancel && (
                <Button size="sm" variant="secondary" data-testid="pipeline-run-cancel" disabled={cancelling} onClick={() => setConfirming(true)}>
                  {cancelling ? 'Cancelling…' : 'Cancel run'}
                </Button>
              )}
            </Inline>
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
      {realtime && (
        <Tabs idPrefix="run" aria-label="Run views" size="sm" value={onActivity ? 'activity' : 'run'} onValueChange={setRunTab}
          items={[{ id: 'run', label: 'Run' }, { id: 'activity', label: 'Activity' }]} />
      )}
      {/* The run's own activity graph (steps, approvals you may decide, decks, your agent flows):
          the same projection and stream as /pipelines/activity, scoped to this run. Pipelines door only.
          Its own tab, full height — the same pattern as the initiative and the team scorecard. */}
      {onActivity && (
        <Stack gap="none" className="flex-1 min-h-0" data-testid="pipeline-run-activity">
          <WorkGraphActivity subject={{ kind: 'run', id: run.id }} cursorChannel={runChannel(run.id)} title={run.context.title} mode="full" className="h-full min-h-0 w-full" />
        </Stack>
      )}
      {!onActivity && (
        <Stack gap="md">
        <DetailSection first title="Run" data-testid="pipeline-run">
          <PipelineRunSummary run={run} />
        </DetailSection>
        <DetailSection title="Steps" hint={`${steps.length}`} data-testid="pipeline-steps">
          <PipelineRunSteps steps={steps} />
        </DetailSection>
        <DetailSection title="Artifacts" hint={`${artifacts.length}`} data-testid="pipeline-artifacts">
          <PipelineRunArtifacts artifacts={artifacts} />
        </DetailSection>
        {cancelable && <RunReportDecks runId={run.id} runTitle={run.context.title} />}
        {realtime && (
          <DetailSection title="Discussion" data-testid="pipeline-run-discussion">
            <PipelineDiscussion channel={runChannel(run.id)} focusTarget />
          </DetailSection>
        )}
        {realtime && live && <PipelineRunLive key={run.id} runId={run.id} pipelineId={run.definitionId ?? ''} recordedStatus={run.status} onMoved={refresh} />}
        {realtime && live ? (
          <ChannelActivity channel={runChannel(run.id)} title="Events" recorded={recorded} visibleCount={8} data-testid="pipeline-events" />
        ) : (
          <DetailSection title="Events" data-testid="pipeline-events">
            {/* Gateway offline (or a tenant façade with no gateway channel): the
                run's SSE stream, recorded history replayed then live frames. */}
            <RunTimeline
              boxId={null}
              src={eventsUrl}
              title="EVENT STREAM"
              maxHeightClass="max-h-[360px]"
              emptyHint="Event-catalog frames (pipeline:run:*, pipeline:step:*) stream here as the run moves."
            />
          </DetailSection>
        )}
        </Stack>
      )}
    </Stack>
  );
}

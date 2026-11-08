// A run's live frames, through the library's `client/pipelines` hook. The BFF
// gateway maps the hook's `pipeline:run:<id>` onto the `pipelines:run:<id>`
// family and emits a `pipeline:event` for every status move of the run's
// record (middleware lib/gateway-run-feed.ts). The hook reads no snapshot here
// (`idToken: null`: this page's durable read is `usePipelineRun`); a phase
// change — or a phase the record has not caught up with — tells the page to
// re-read it.

import { useEffect, useRef } from 'react';
import { usePipelineRunStatus } from '@connorhoehn/realtime-modules/client/pipelines';
import { Chip, Inline, MetaLine } from '@connorhoehn/ui-components/shared';
import { phaseMoved, recordBehind } from './pipelinesRealtime';

export function PipelineRunLive({ runId, pipelineId, recordedStatus, onMoved }: { runId: string; pipelineId: string; recordedStatus?: string; onMoved: () => void }) {
  const runs = useRef([{ runId, pipelineId }]).current;
  const status = usePipelineRunStatus(runs, { apiBaseUrl: '', idToken: null, subscribeFirehose: false })(runId);
  const phase = status?.phase;
  const last = useRef<string | undefined>(undefined);
  // The record the header reads can be older than the first frame (a status
  // move between the page's read and its subscribe): re-read once per phase
  // whenever the record disagrees, not only when the phase changes under us.
  const reread = useRef<string | undefined>(undefined);
  useEffect(() => {
    const moved = phaseMoved(last.current, phase);
    const behind = recordBehind(recordedStatus, phase) && reread.current !== phase;
    if (moved || behind) onMoved();
    if (behind && phase) reread.current = phase;
    if (phase) last.current = phase;
  }, [phase, recordedStatus, onMoved]);
  if (!status) return null;
  return (
    <Inline gap="sm" align="center" data-testid="pipeline-run-live">
      <Chip tone="info" size="xs" dot="pulse">Live</Chip>
      <MetaLine size="xs" tone="secondary" items={[status.stepLabel ?? status.detail ?? status.phase]} />
    </Inline>
  );
}

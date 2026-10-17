// One implementation of "follow a run to its end" for every agentic flow
// (social /summarize, assessment evidence drafts, assessment decks, later
// tenants). An adapter in the shape of realtime-examples' useAgentRunStatus:
// the library's `usePipelineRunStatus` (realtime-modules /client/pipelines)
// owns the run subscription and the frame stream; this hook merges those
// frames with the durable snapshot `getRun` returns (flowRunFollower.ts):
//
//   - gateway connected and the run's subscribe acknowledged: every frame
//     re-reads the snapshot, a reconnect re-reads it, and a 30 s safety read
//     covers a lost frame;
//   - otherwise (no gateway, socket down, subscribe refused, or a run kind
//     with no live channel such as deck runs in `assessment_runs`): the old
//     polling cadence, paused in hidden tabs.
//
// The BFF maps `pipeline:run:<id>` for a flow run onto its requester-private
// `<tenant>:flowrun:<id>` (middleware lib/flow-runs/channel.ts), so only the
// requester's socket is ever admitted. `onFinished` fires once per run id.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useGatewayOptional } from '@connorhoehn/realtime-modules/client';
import { usePipelineRunStatus, type PipelineRunTransport } from '@connorhoehn/realtime-modules/client/pipelines';
import { isDocumentHidden } from './pollSchedule';
import { createFlowRunFollower, isFlowRunAck, isFlowRunRefusal, isLiveFlowRunId, type FlowRunFollower } from './flowRunFollower';

export interface UseFlowRunOptions<T> {
  isFinished: (run: T) => boolean;
  /** Base delay before the next offline poll. */
  delayMs?: (attempt: number) => number;
  /** Stop after this many reads, or the offline wall time they would take. */
  maxPolls?: number;
  onFinished?: (run: T) => void;
}

export interface FlowRunState<T> {
  run: T | null;
  /** The latest read failure; cleared by the next success. */
  error: string | null;
  /** maxPolls reached without a finished run. */
  timedOut: boolean;
  /** Frames are arriving over the gateway (false: polling). */
  live: boolean;
}

/** The library hook's identifier for these runs; the BFF route is the snapshot, so no pipeline definition is read. */
const FLOW_PIPELINE_ID = 'flow-run';
const NO_RUNS: readonly { runId: string; pipelineId: string }[] = [];

function whenVisible(fn: () => void): () => void {
  const onChange = (): void => { if (!isDocumentHidden()) { document.removeEventListener('visibilitychange', onChange); fn(); } };
  document.addEventListener('visibilitychange', onChange);
  return () => document.removeEventListener('visibilitychange', onChange);
}

export function useFlowRun<T>(
  runId: string | null,
  getRun: (runId: string, signal: AbortSignal) => Promise<T>,
  options: UseFlowRunOptions<T>,
): FlowRunState<T> {
  const [state, setState] = useState<Omit<FlowRunState<T>, 'live'>>({ run: null, error: null, timedOut: false });
  const latest = useRef({ getRun, options });
  latest.current = { getRun, options };

  // Live transport: only while connected, and only for a run kind with a private channel.
  const gateway = useGatewayOptional();
  const connected = gateway?.connectionState === 'connected';
  const liveKind = !!runId && isLiveFlowRunId(runId);
  const send = gateway?.sendMessage;
  const onMessage = gateway?.onMessage;
  const transport = useMemo<PipelineRunTransport | null>(
    () => (liveKind && connected && send && onMessage
      ? { send: send as PipelineRunTransport['send'], onMessage: onMessage as PipelineRunTransport['onMessage'] }
      : null),
    [liveKind, connected, send, onMessage],
  );
  const runs = useMemo(() => (runId && liveKind ? [{ runId, pipelineId: FLOW_PIPELINE_ID }] : NO_RUNS), [runId, liveKind]);
  // idToken null: the library reads no snapshot of its own; `getRun` is the snapshot.
  const frameStatus = usePipelineRunStatus(runs, { apiBaseUrl: '', idToken: null, transport, subscribeFirehose: false })(runId ?? '');

  // Acknowledged = live. A refusal or a dropped socket is polling again.
  const [acked, setAcked] = useState<string | null>(null);
  useEffect(() => {
    setAcked(null);
    if (!transport || !runId) return undefined;
    return transport.onMessage((msg) => {
      if (isFlowRunAck(msg, runId)) setAcked(runId);
      else if (isFlowRunRefusal(msg, runId)) setAcked(null);
    });
  }, [transport, runId]);
  const live = !!transport && acked === runId;

  const follower = useRef<FlowRunFollower | null>(null);
  useEffect(() => {
    setState({ run: null, error: null, timedOut: false });
    if (!runId) return undefined;
    const { options: opt } = latest.current;
    const f = createFlowRunFollower<T>(runId, {
      getRun: (id, signal) => latest.current.getRun(id, signal),
      isFinished: (r) => latest.current.options.isFinished(r),
      ...(opt.delayMs ? { delayMs: opt.delayMs } : {}),
      ...(opt.maxPolls !== undefined ? { maxPolls: opt.maxPolls } : {}),
      isHidden: isDocumentHidden,
      whenVisible,
      onUpdate: (run) => setState({ run, error: null, timedOut: false }),
      onError: (error) => setState((s) => ({ ...s, error })),
      onDone: (outcome) => {
        if (outcome.status === 'timed-out') setState((s) => ({ ...s, timedOut: true }));
        else latest.current.options.onFinished?.(outcome.run);
      },
    });
    follower.current = f;
    return () => { f.stop(); if (follower.current === f) follower.current = null; };
  }, [runId]);

  useEffect(() => { follower.current?.setLive(live); }, [live, runId]);
  // Each frame the library folds in is a new status object: the record moved.
  useEffect(() => { if (frameStatus) follower.current?.frame(); }, [frameStatus]);

  return { ...state, live };
}

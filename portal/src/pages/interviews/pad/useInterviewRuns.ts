// The interview's runs on either side (row I4.4; contract U4). `base` is the side's path: the panel's
// `/api/interviews/interviews/:id`, the candidate's `/api/interview-invite` (lib/interviewsPad.ts `staffPadBase`,
// `GUEST_PAD_BASE`). Both people read the interview's ONE event stream, so a run either starts shows for both as it
// happens; the runs so far are read once when the pad opens, so someone who joins late sees the last one. The
// stream reconnects on its own with `Last-Event-ID`; when the server ends it for good (not live, not let in), a
// few bounded retries resume after the last event seen, then it stops. Each run's view (who, and the result once
// it ends) is read when the stream first names it and again when it ends, a bounded number of times.
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import {
  EMPTY_RUNS, cancelRun, cancellableRun, entryStatus, latestRun, newRunId, parseRunEvent, readRun, readRunsAndRunner, runNeedsRead,
  runOutputModel, runRequest, runsEventsUrl, runsReducer, startRun, type RunEntry, type RunnerKind, type RunOutputModel,
} from '../../../lib/interviewsPad';
import type { PadLanguage } from '../../../lib/interviewsKit';

const STREAM_RETRIES = 5;
const STREAM_RETRY_MS = 2_000;
const READS_PER_STATUS = 4;
const READ_RETRY_MS = 600;

export interface InterviewRuns {
  /** Which runner this pad has, once the runs read has said; null before that. */
  runner: RunnerKind | null;
  latest: RunEntry | null;
  output: RunOutputModel;
  /** A run of this interview is queued, compiling or running: Cancel stops the newest. */
  canCancel: boolean;
  starting: boolean;
  cancelling: boolean;
  /** The server's sentence for the last refused Run or Cancel. */
  refusal: string | null;
  start(language: PadLanguage, text: string): Promise<void>;
  cancel(): Promise<void>;
}

export function useInterviewRuns(base: string | null, selfId: string | null): InterviewRuns {
  const [state, dispatch] = useReducer(runsReducer, EMPTY_RUNS);
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [runner, setRunner] = useState<RunnerKind | null>(null);

  // The stream, and the runs so far.
  useEffect(() => {
    if (!base || typeof EventSource === 'undefined') return;
    let stopped = false;
    let source: EventSource | null = null;
    let retries = 0;
    let lastId: string | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const open = () => {
      if (stopped) return;
      const url = runsEventsUrl(base) + (lastId ? `?lastEventId=${encodeURIComponent(lastId)}` : '');
      const es = new EventSource(url, { withCredentials: true });
      source = es;
      es.onopen = () => { retries = 0; };
      es.onmessage = (m) => {
        if (m.lastEventId) lastId = m.lastEventId;
        const event = parseRunEvent(String(m.data));
        if (event) dispatch({ type: 'event', event });
      };
      es.onerror = () => {
        if (es.readyState !== EventSource.CLOSED) return; // the browser reconnects on its own, with Last-Event-ID
        es.close();
        if (stopped || retries >= STREAM_RETRIES) return;
        retries += 1;
        timer = setTimeout(open, STREAM_RETRY_MS * retries);
      };
    };
    open();
    void readRunsAndRunner(base).then((read) => { if (stopped || !read) return; setRunner(read.runner); dispatch({ type: 'list', runs: read.runs }); });
    return () => { stopped = true; if (timer) clearTimeout(timer); source?.close(); };
  }, [base]);

  // Each run's view: when first named, and again when it ends (bounded per run and status). A read in flight is
  // never cut short by the next event; only leaving (or a new base) drops its answer.
  const reads = useRef(new Map<string, number>());
  const inflight = useRef(new Set<string>());
  const current = useRef(base);
  current.current = base;
  useEffect(() => {
    if (!base) return;
    for (const entry of Object.values(state.runs)) {
      if (!runNeedsRead(entry) || inflight.current.has(entry.runId)) continue;
      const key = `${entry.runId}:${entryStatus(entry)}`;
      const n = reads.current.get(key) ?? 0;
      if (n >= READS_PER_STATUS) continue;
      reads.current.set(key, n + 1);
      inflight.current.add(entry.runId);
      const runId = entry.runId;
      setTimeout(() => {
        void readRun(base, runId).then((run) => {
          inflight.current.delete(runId);
          if (current.current === base && run) dispatch({ type: 'view', run });
        });
      }, n === 0 ? 0 : READ_RETRY_MS * n);
    }
  }, [base, state.runs]);

  const start = useCallback(async (language: PadLanguage, text: string) => {
    if (!base) return;
    setRefusal(null);
    setStarting(true);
    const r = await startRun(base, runRequest(newRunId(), language, text));
    setStarting(false);
    if (r.ok) dispatch({ type: 'view', run: r.run });
    else setRefusal(r.error);
  }, [base]);

  const target = cancellableRun(state);
  const targetId = target?.runId ?? null;
  const cancel = useCallback(async () => {
    if (!base || !targetId) return;
    setRefusal(null);
    setCancelling(true);
    const r = await cancelRun(base, targetId);
    setCancelling(false);
    if (r.ok) dispatch({ type: 'view', run: r.run });
    else setRefusal(r.error);
  }, [base, targetId]);

  const latest = latestRun(state);
  return { runner, latest, output: runOutputModel(latest, selfId), canCancel: !!target, starting, cancelling, refusal, start, cancel };
}

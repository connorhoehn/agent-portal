// The pure half of useFlowRun: follow one durable run record to its end,
// merging the gateway's live frames with the REST snapshot. Split out so
// node:test drives it without React, a socket or a DOM.
//
// The snapshot (getRun) is the only source of what a caller renders — a
// frame is a HINT that the record moved. That keeps every caller's typed
// record (DraftView, SummarizeRunStatus, …) exactly what the REST read says,
// and keeps the frame free of the private result:
//
//   live (gateway connected AND the run channel's subscribe acknowledged)
//     - every frame re-reads the snapshot (coalesced: one read in flight,
//       at most one queued behind it);
//     - becoming live re-reads it (catch-up after a reconnect: frames sent
//       while the socket was down are gone, the record is not);
//     - a slow safety re-read (livePollMs) covers a lost frame.
//   offline (no gateway, socket down, subscribe refused or not yet acked)
//     - the old cadence: delayMs per attempt, failures back off, paused
//       while the tab is hidden.
//
// The timeout keeps its offline meaning in both modes: `maxPolls` reads, or
// the wall time those reads would have taken offline, whichever comes first.

import { nextPollDelay } from './pollSchedule.ts';

export const FLOW_RUN_POLL_MS = 1500;
export const FLOW_RUN_LIVE_POLL_MS = 30_000;

/**
 * Runs whose status the BFF gateway pushes: the durable flow runs whose id
 * prefix names a flow with a private run channel (middleware
 * lib/flow-runs/channel.ts — `sum-` Social /summarize, `sdk-` Social /deck, `adr-` assessment
 * evidence drafts, `osm-`/`asm-`/`psm-` /summarize on orgiq, assessment and
 * pipelines conversations, `sag-`/`oag-`/`aag-`/`pag-` /agent plan runs, `pdr-` pipelines run report deck revises). Anything else (assessment deck runs in `assessment_runs`)
 * stays on polling.
 */
const LIVE_RUN_ID = /^(sum|sdk|adr|osm|asm|psm|sdg|sdc|odg|odc|adg|adc|pdg|pdc|sag|oag|aag|pag|pdr)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isLiveFlowRunId = (runId: string): boolean => LIVE_RUN_ID.test(runId);

/** The wire channel the library's pipeline() feature maps onto the run's private channel. */
export const flowRunWireChannel = (runId: string): string => `pipeline:run:${runId}`;

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The pipeline feature's `{ type: 'pipeline', action: 'subscribed', channel }` ack for this run. */
export function isFlowRunAck(msg: unknown, runId: string): boolean {
  return isRecord(msg) && msg.type === 'pipeline' && msg.action === 'subscribed' && msg.channel === flowRunWireChannel(runId);
}

/** A refusal of this run's subscribe: PIPELINE_CHANNEL_REFUSED names the wire channel, the router's AUTHZ_CHANNEL_DENIED the private one. */
export function isFlowRunRefusal(msg: unknown, runId: string): boolean {
  if (!isRecord(msg) || msg.type !== 'error' || typeof msg.channel !== 'string') return false;
  return msg.channel === flowRunWireChannel(runId) || msg.channel.endsWith(`:flowrun:${runId}`);
}

/** A `pipeline:event` frame about this run. */
export function isFlowRunFrame(msg: unknown, runId: string): boolean {
  return isRecord(msg) && msg.type === 'pipeline:event' && isRecord(msg.payload) && msg.payload.runId === runId;
}

export type FlowRunOutcome<T> = { status: 'finished'; run: T } | { status: 'timed-out' };

export interface FlowRunFollowerOptions<T> {
  getRun: (runId: string, signal: AbortSignal) => Promise<T>;
  isFinished: (run: T) => boolean;
  /** Base delay before the next offline poll; default fixed FLOW_RUN_POLL_MS. */
  delayMs?: (attempt: number) => number;
  /** Stop after this many snapshot reads (default unbounded). */
  maxPolls?: number;
  livePollMs?: number;
  onUpdate?: (run: T) => void;
  onError?: (message: string) => void;
  /** Once: the finished record, or the timeout. Never after stop(). */
  onDone?: (outcome: FlowRunOutcome<T>) => void;
  /** Injected for tests. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  now?: () => number;
  isHidden?: () => boolean;
  /** Calls `fn` once when the tab is visible again; returns the cancel. */
  whenVisible?: (fn: () => void) => () => void;
}

export interface FlowRunFollower {
  /** Live = connected and this run's subscribe acknowledged. */
  setLive(live: boolean): void;
  /** A frame about this run arrived. */
  frame(): void;
  stop(): void;
}

export function createFlowRunFollower<T>(runId: string, o: FlowRunFollowerOptions<T>): FlowRunFollower {
  const setTimer = o.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = o.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const now = o.now ?? (() => Date.now());
  const hidden = o.isHidden ?? (() => false);
  const whenVisible = o.whenVisible ?? ((fn: () => void) => { fn(); return () => undefined; });
  const base = o.delayMs ?? (() => FLOW_RUN_POLL_MS);
  const livePollMs = o.livePollMs ?? FLOW_RUN_LIVE_POLL_MS;
  const started = now();
  // The wall time maxPolls offline reads would take: the live-mode deadline.
  let budgetMs = Infinity;
  if (o.maxPolls !== undefined) { budgetMs = 0; for (let i = 0; i < o.maxPolls; i += 1) budgetMs += base(i); }

  let done = false;
  let live = false;
  let reads = 0;
  let failures = 0;
  let inFlight: AbortController | null = null;
  let dirty = false;
  let timer: unknown = null;
  let cancelVisible: (() => void) | null = null;

  const clear = (): void => {
    if (timer !== null) { clearTimer(timer); timer = null; }
    cancelVisible?.(); cancelVisible = null;
  };
  const finish = (outcome: FlowRunOutcome<T>): void => {
    if (done) return;
    done = true; clear(); inFlight?.abort(); inFlight = null;
    o.onDone?.(outcome);
  };
  const outOfBudget = (): boolean => (o.maxPolls !== undefined && reads >= o.maxPolls) || now() - started >= budgetMs;

  const schedule = (): void => {
    if (done || inFlight) return;
    clear();
    if (outOfBudget()) { finish({ status: 'timed-out' }); return; }
    const wait = live
      ? Math.max(0, Math.min(livePollMs, budgetMs - (now() - started)))
      : nextPollDelay(failures, base(Math.max(0, reads - 1)));
    timer = setTimer(() => {
      timer = null;
      // Offline polling pauses while the tab is hidden; a frame still reads.
      if (!live && hidden()) { cancelVisible = whenVisible(() => { cancelVisible = null; read(); }); return; }
      read();
    }, wait);
  };

  const read = (): void => {
    if (done) return;
    if (inFlight) { dirty = true; return; }
    clear();
    reads += 1;
    const ctl = new AbortController();
    inFlight = ctl;
    void o.getRun(runId, ctl.signal).then(
      (run) => {
        if (done || ctl.signal.aborted) return;
        failures = 0;
        o.onUpdate?.(run);
        if (o.isFinished(run)) finish({ status: 'finished', run });
      },
      (cause: unknown) => {
        if (done || ctl.signal.aborted) return;
        failures += 1;
        o.onError?.(cause instanceof Error ? cause.message : 'The run could not be read.');
      },
    ).finally(() => {
      if (inFlight !== ctl) return;
      inFlight = null;
      if (done) return;
      if (dirty) { dirty = false; if (!outOfBudget()) { read(); return; } }
      schedule();
    });
  };

  read();
  return {
    setLive(next: boolean): void {
      if (done || next === live) return;
      live = next;
      if (live) read();          // catch up: anything sent while down is only in the record
      else if (!inFlight) schedule(); // back to the offline cadence now, not after the live wait
    },
    frame(): void { read(); },
    stop(): void {
      done = true; clear(); inFlight?.abort(); inFlight = null;
    },
  };
}

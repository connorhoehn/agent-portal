// Local-compute run logs — the stdout/stderr a paired machine ships while it
// runs a claimed job, so the fleet view can tail a local run the same way it
// tails a devbox one.
//
// Sibling of local-compute-fleet.ts and in-memory for the same reason: a log is
// live output, not a record. The machine ALSO writes an authoritative copy to a
// file under ~/.claude-mem/orgiq-worker-logs (tail -f), so what lives here is a
// best-effort mirror for the browser — losing it on a middleware restart costs
// a scrollback, not data. Durable run OUTPUT is the job's `result` summary in
// Aurora (providers/agent-jobs.ts), written once at completion; this is the
// noisy in-flight stream that precedes it.
//
// NOT a mock fixture, unlike presence rows. Presence went into a fixture
// because an auditor who ends a session or heartbeats a node has MUTATED shared
// seeded state and the next viewer must be able to reset it. A log has no seed
// and no human writer — a machine appends, a browser only reads — so there is
// nothing to corrupt and nothing to reset to but empty. It follows the
// `subscribers` Set's rationale, not the fixture's: live data keyed by a live
// connection.
//
// Bounded on two axes so a chatty run or a long-lived process cannot grow it
// without limit: MAX_BYTES_PER_JOB trims the oldest chunks of one job, and
// MAX_JOBS evicts the least-recently-written job entirely (LRU).

import { clock } from '../mock/core/index.js';

/** One shipped chunk. `seq` is the worker's monotonic counter for the job, so a
 *  polling reader can ask for `?since=<seq>` and a duplicate POST is a no-op. */
export interface LogEntry {
  seq: number;
  text: string;
}

export interface JobLog {
  jobId: string;
  entries: LogEntry[];
  /** Highest seq stored, or -1 when empty — the cursor a poller advances. */
  lastSeq: number;
  bytes: number;
  updatedAt: string | null;
  /** Set once the job reaches a terminal state, so a tailing reader knows to
   *  stop polling rather than waiting on a stream that will never append. */
  done: boolean;
}

const MAX_BYTES_PER_JOB = 256 * 1024;
const MAX_JOBS = 200;
/** A single shipped chunk, clamped — the machine is trusted to stream output,
 *  not to size one write. */
export const MAX_LOG_CHUNK = 64 * 1024;

interface LogRow {
  entries: LogEntry[];
  bytes: number;
  updatedAt: string;
  done: boolean;
}

const logs = new Map<string, LogRow>();
const subscribers = new Map<string, Set<(entry: LogEntry) => void>>();

function now(): string {
  return clock.nowIso();
}

function notify(jobId: string, entry: LogEntry): void {
  const set = subscribers.get(jobId);
  if (!set) return;
  for (const cb of set) {
    try { cb(entry); } catch { /* one bad subscriber must not break the fan-out */ }
  }
}

/** Evict the least-recently-written job when over the ceiling. Iteration order
 *  of a Map is insertion order, and every append re-inserts (delete+set) so the
 *  oldest key is genuinely the least-recently-touched. */
function evictIfNeeded(): void {
  while (logs.size > MAX_JOBS) {
    const oldest = logs.keys().next().value;
    if (oldest === undefined) break;
    logs.delete(oldest);
  }
}

/**
 * Append a chunk shipped by the machine. Idempotent on `seq`: a re-sent chunk
 * (the worker's ship is fire-and-forget and may retry) is dropped rather than
 * duplicated. Chunks are stored in ARRIVAL order, not sorted by seq — the
 * transport can reorder two in-flight POSTs, and re-sorting a live tail every
 * append would cost more than the rare out-of-order line is worth; the seq is
 * there for the poller's cursor, not to guarantee a total order on screen.
 */
export function appendLog(jobId: string, seq: number, text: string): void {
  if (!text) return;
  let row = logs.get(jobId);
  if (row) {
    // Re-insert to mark most-recently-written for the LRU.
    logs.delete(jobId);
  } else {
    row = { entries: [], bytes: 0, updatedAt: now(), done: false };
  }
  logs.set(jobId, row);

  if (row.entries.some((e) => e.seq === seq)) {
    return; // duplicate seq — no-op, but the re-insert above still refreshed LRU
  }

  const entry: LogEntry = { seq, text };
  row.entries.push(entry);
  row.bytes += text.length;
  row.updatedAt = now();

  // Trim oldest chunks until under the per-job byte ceiling. Never drop the one
  // just added, even if a single chunk exceeds the ceiling — better a too-big
  // tail than an empty one.
  while (row.bytes > MAX_BYTES_PER_JOB && row.entries.length > 1) {
    const dropped = row.entries.shift();
    if (dropped) row.bytes -= dropped.text.length;
  }

  evictIfNeeded();
  notify(jobId, entry);
}

/** Mark a job's log terminal so a tailing reader stops polling. Best-effort:
 *  a log with no chunks (a run that emitted nothing) is created so the reader
 *  still sees `done: true` rather than a 404 forever. */
export function markLogDone(jobId: string): void {
  let row = logs.get(jobId);
  if (!row) {
    row = { entries: [], bytes: 0, updatedAt: now(), done: true };
    logs.set(jobId, row);
    evictIfNeeded();
    return;
  }
  row.done = true;
  row.updatedAt = now();
}

/** Snapshot, optionally only entries after `since` (a poller's cursor). Returns
 *  null for a job that has shipped nothing and is not marked done. */
export function getLog(jobId: string, since = -1): JobLog | null {
  const row = logs.get(jobId);
  if (!row) return null;
  const entries = since >= 0 ? row.entries.filter((e) => e.seq > since) : row.entries.slice();
  const lastSeq = row.entries.reduce((m, e) => Math.max(m, e.seq), -1);
  return {
    jobId,
    entries,
    lastSeq,
    bytes: row.bytes,
    updatedAt: row.updatedAt,
    done: row.done,
  };
}

/** Live tail. The callback receives each newly appended entry; the caller
 *  reads getLog() first for the backlog. */
export function subscribeLog(jobId: string, cb: (entry: LogEntry) => void): () => void {
  let set = subscribers.get(jobId);
  if (!set) {
    set = new Set();
    subscribers.set(jobId, set);
  }
  set.add(cb);
  return () => {
    const s = subscribers.get(jobId);
    if (!s) return;
    s.delete(cb);
    if (s.size === 0) subscribers.delete(jobId);
  };
}

/** Test hook — drop every stored log and detach every tail. */
export function _resetLocalComputeLogs(): void {
  logs.clear();
  subscribers.clear();
}

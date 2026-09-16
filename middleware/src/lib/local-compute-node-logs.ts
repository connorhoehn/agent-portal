// Local-compute NODE operational logs — the worker's own scrollback (emit()
// lines: registered, claimed, presence acknowledged, heartbeats, warnings),
// as opposed to `jobs/:jobId/log`, which carries one claimed run's stdout.
//
// This is the log for "what has this machine been doing between jobs" — the
// exact gap docs/local-compute-presence.md's 2026-09-16 pairing story names:
// someone paired a laptop, walked away, and had no way to see it working (or
// stuck, or erroring) short of being at its terminal. Sibling of
// local-compute-logs.ts (the per-job log) and local-compute-fleet.ts
// (presence): same in-memory, best-effort, bounded posture, because this is
// live output a machine reports, not a durable record — the worker's own
// terminal scrollback, and now a bounded local file under WORKER_LOG_DIR
// (tools/local-compute-worker.mjs), is the thing this mirrors, not authors.
//
// PRIVACY. A node's log is that person's own machine talking about its own
// work — the same posture as job output and a session's `intent`/`touching`:
// it stays with the OWNER of the node, never a fleet-wide role. Enforced at
// the route (routes/local-compute.ts, the `ownedNodeForLog` helper), not
// here — this module has no notion of ownership at all, only bytes keyed by
// node id.
//
// Bounded on three axes so a laptop that runs for months cannot grow this
// without limit: MAX_LINES_PER_NODE caps entry COUNT (many short lines cost
// little in bytes but each still carries object/array overhead),
// MAX_BYTES_PER_NODE caps total text, and MAX_NODES evicts the
// least-recently-written node entirely (LRU) once more machines are logging
// than any owner realistically runs at once.

import { clock } from '../mock/core/index.js';

export interface NodeLogEntry {
  seq: number;
  text: string;
}

export interface NodeLog {
  nodeId: string;
  entries: NodeLogEntry[];
  /** Highest seq stored, or -1 when empty — the cursor a poller advances. */
  lastSeq: number;
  bytes: number;
  updatedAt: string | null;
}

/**
 * One node's ring, by line count. ~500 lines is a comfortable scrollback —
 * about what the worker's own terminal shows without scrolling — and small
 * enough that a browser tail never has to render a wall of history it did
 * not ask for.
 */
const MAX_LINES_PER_NODE = 500;
/**
 * Byte ceiling alongside the line-count ceiling — a handful of unusually
 * long lines (a warn() carrying a stack trace) must not out-run the count
 * cap before the byte cap catches them. 256KB matches local-compute-logs.ts's
 * MAX_BYTES_PER_JOB: a node's operational log is chattier over its lifetime
 * (weeks, not one run) but each line here is far shorter than a job's raw
 * stdout ever is.
 */
const MAX_BYTES_PER_NODE = 256 * 1024;
/** How many machines' logs this process holds before evicting the
 *  least-recently-written one. Mirrors local-compute-logs.ts's MAX_JOBS. */
const MAX_NODES = 200;
/** One shipped line, clamped. The worker is trusted to emit one fact per
 *  line (its own lines run well under 200 chars), not to size a batch
 *  element — generous headroom for a legitimate long line, a hard stop for
 *  anything that isn't. */
export const MAX_NODE_LOG_LINE = 4_000;
/** Lines per POST /log batch. Mirrors MAX_SESSIONS_PER_ANNOUNCE's shape in
 *  routes/local-compute.ts: small batches, sent often, never one giant one. */
export const MAX_NODE_LOG_BATCH = 50;

interface NodeLogRow {
  entries: NodeLogEntry[];
  bytes: number;
  updatedAt: string;
}

const logs = new Map<string, NodeLogRow>();
const subscribers = new Map<string, Set<(entry: NodeLogEntry) => void>>();

function now(): string {
  return clock.nowIso();
}

function notify(nodeId: string, entry: NodeLogEntry): void {
  const set = subscribers.get(nodeId);
  if (!set) return;
  for (const cb of set) {
    try { cb(entry); } catch { /* one bad subscriber must not break the fan-out */ }
  }
}

/** Evict the least-recently-written node when over the ceiling. Map
 *  iteration order is insertion order, and every append re-inserts
 *  (delete+set), so the oldest key really is the least-recently-touched. */
function evictIfNeeded(): void {
  while (logs.size > MAX_NODES) {
    const oldest = logs.keys().next().value;
    if (oldest === undefined) break;
    logs.delete(oldest);
  }
}

/**
 * Append a line the machine shipped. Idempotent on `seq`: the worker's ship
 * is best-effort and may re-send a batch after a failed flush, and a
 * re-sent line is dropped rather than duplicated. Stored in ARRIVAL order,
 * not sorted by seq — same tradeoff as the per-job log: the transport can
 * reorder two in-flight POSTs, and re-sorting a live tail on every append
 * costs more than the rare out-of-order line is worth.
 */
export function appendNodeLog(nodeId: string, seq: number, text: string): void {
  if (!text) return;
  let row = logs.get(nodeId);
  if (row) {
    logs.delete(nodeId); // re-insert to mark most-recently-written for the LRU
  } else {
    row = { entries: [], bytes: 0, updatedAt: now() };
  }
  logs.set(nodeId, row);

  const clamped = text.slice(0, MAX_NODE_LOG_LINE);
  if (row.entries.some((e) => e.seq === seq)) {
    return; // duplicate seq — no-op, but the re-insert above still refreshed LRU
  }

  const entry: NodeLogEntry = { seq, text: clamped };
  row.entries.push(entry);
  row.bytes += clamped.length;
  row.updatedAt = now();

  // Trim oldest entries until under BOTH ceilings. Never drop the one just
  // added, even if it alone exceeds a ceiling — a too-big tail beats an
  // empty one.
  while ((row.bytes > MAX_BYTES_PER_NODE || row.entries.length > MAX_LINES_PER_NODE) && row.entries.length > 1) {
    const dropped = row.entries.shift();
    if (dropped) row.bytes -= dropped.text.length;
  }

  evictIfNeeded();
  notify(nodeId, entry);
}

/** Snapshot, optionally only entries after `since` (a poller's cursor).
 *  Returns null for a node that has shipped nothing this process has seen —
 *  a real state (an older worker, or one whose first flush hasn't fired
 *  yet), not an error. */
export function getNodeLog(nodeId: string, since = -1): NodeLog | null {
  const row = logs.get(nodeId);
  if (!row) return null;
  const entries = since >= 0 ? row.entries.filter((e) => e.seq > since) : row.entries.slice();
  const lastSeq = row.entries.reduce((m, e) => Math.max(m, e.seq), -1);
  return {
    nodeId,
    entries,
    lastSeq,
    bytes: row.bytes,
    updatedAt: row.updatedAt,
  };
}

/** Live tail. The callback receives each newly appended entry; the caller
 *  reads getNodeLog() first for the backlog. */
export function subscribeNodeLog(nodeId: string, cb: (entry: NodeLogEntry) => void): () => void {
  let set = subscribers.get(nodeId);
  if (!set) {
    set = new Set();
    subscribers.set(nodeId, set);
  }
  set.add(cb);
  return () => {
    const s = subscribers.get(nodeId);
    if (!s) return;
    s.delete(cb);
    if (s.size === 0) subscribers.delete(nodeId);
  };
}

/** Test hook — drop every stored log and detach every tail. */
export function _resetLocalComputeNodeLogs(): void {
  logs.clear();
  subscribers.clear();
}

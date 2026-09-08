// Local-compute presence registry — the live sessions running on developers'
// OWN machines, as announced by the local claude-mem plugin.
//
// Sibling of devbox-fleet.ts and deliberately in-memory like it: a session is
// presence, not a record. The durable half (the paired machine, its token) is
// compute_nodes in Aurora (providers/local-compute.ts); the plugin re-announces
// within one heartbeat after a middleware restart, so persisting sessions would
// only produce rows that lie about liveness.
//
// EPHEMERAL, AND STILL RESETTABLE. That argument is about durability and it is
// intact — nothing here reaches a database, and the store still dies with the
// process. It is not an argument for being unresettable: an auditor who ends a
// session or heartbeats a node back from `stale` has changed the world for
// whoever looks next, and the only way back used to be restarting the
// middleware. So the rows live in the `local-presence` fixture
// (mock/local-compute.ts), which is in-memory too and costs nothing at run
// time, and `POST /api/__mock/reset` puts the world back.
//
// `subscribers` below stays a module-level `Set` deliberately. It holds live
// SSE callbacks — open HTTP responses, not data — and a reset that cleared
// them would silently detach every `/api/local-compute/stream` with no error
// and no reconnect. Data is resettable; connections are not data.
//
// Status is DERIVED from last_seen, never claimed by the client:
//   ≤ 90s    connected
//   ≤ 5min   stale       (missed heartbeats; machine may be asleep)
//   beyond   offline     (sessions dropped from listings)
// The 5-minute horizon matches the announce protocol's idle heartbeat.

import { clock } from '../mock/core/index.js';
import { localPresence, presenceRowFor, upsertPresenceRow } from '../mock/local-compute.js';

export type NodePresenceStatus = 'connected' | 'stale' | 'offline';

/** The local memory sidecar's own account of how synced it is. Computed on the
 *  machine (outbox depth, hub cursor age), relayed verbatim — the middleware
 *  has no better source of truth about a laptop's SQLite than the laptop. */
export interface LocalMemoryState {
  mode: 'synced' | 'pending' | 'offline' | 'disabled';
  /** Rows in the sidecar's outbox still awaiting upload (synced_at IS NULL). */
  pendingOps?: number;
  lastPushAt?: number;
  /** How stale the machine's read replica is, seconds. */
  pullCursorAgeS?: number;
  importedPacks?: string[];
}

export interface LocalSession {
  sessionId: string;
  /** Which harness is running: claude-code | cursor | other. Informational. */
  harness: string;
  projectId?: string;
  repo?: string;
  branch?: string;
  worktree?: string;
  /** One distilled line of what the session is doing — never raw prompt text. */
  intent?: string;
  touching?: string[];
  /** bedrock | anthropic | ollama | vllm | lmstudio | ... */
  modelProvider?: string;
  model?: string;
  /** Fraction (0-1) of the model's context window in use, if the harness knows. */
  contextUsed?: number;
  memory?: LocalMemoryState;
  startedAt?: number;
  lastSeenAt: string;
}

export interface NodePresence {
  nodeId: string;
  status: NodePresenceStatus;
  lastSeenAt: string | null;
  sessions: LocalSession[];
}

const CONNECTED_HORIZON_MS = 90_000;
const STALE_HORIZON_MS = 5 * 60_000;
const INTENT_MAX = 200;
const TOUCHING_MAX = 20;

const subscribers = new Set<(nodeId: string) => void>();

/** Presence reads the same clock its fixture writes with, so a test can freeze
 *  one instant and assert the derived status exactly. Unfrozen it is
 *  `Date.now()`. */
function now(): string {
  return clock.nowIso();
}

function notify(nodeId: string): void {
  for (const cb of subscribers) {
    try { cb(nodeId); } catch { /* one bad subscriber must not break the fan-out */ }
  }
}

/** Clamp caller-supplied presence fields — the plugin is trusted to write
 *  presence, not to size it. */
function sanitize(s: LocalSession): LocalSession {
  return {
    ...s,
    intent: s.intent?.slice(0, INTENT_MAX),
    touching: s.touching?.slice(0, TOUCHING_MAX),
    lastSeenAt: now(),
  };
}

/**
 * An announce is an authoritative SNAPSHOT of the node's live sessions — the
 * plugin owns the truth about what is running on its machine, so sessions
 * absent from the snapshot are dropped rather than lingered. (A crash between
 * announces is covered by the staleness horizon, not by tombstones.)
 */
export function recordAnnounce(nodeId: string, sessions: LocalSession[]): NodePresence {
  // Deduplicated by sessionId, last write winning at the first position the id
  // appeared — what the `Map` this replaced did, kept because an announce
  // carrying one id twice must not produce two rows for one session.
  const deduped: LocalSession[] = [];
  const seen = new Map<string, number>();
  for (const s of sessions) {
    if (!s.sessionId) continue;
    const at = seen.get(s.sessionId);
    if (at === undefined) {
      seen.set(s.sessionId, deduped.length);
      deduped.push(sanitize(s));
    } else {
      deduped[at] = sanitize(s);
    }
  }
  upsertPresenceRow({ nodeId, lastSeenAt: now(), sessions: deduped });
  notify(nodeId);
  return presenceOf(nodeId);
}

/** A heartbeat with no session changes — just proof of life. */
export function recordHeartbeat(nodeId: string): void {
  const row = presenceRowFor(nodeId);
  if (!row) return;
  row.lastSeenAt = now();
  notify(nodeId);
}

export function endSession(nodeId: string, sessionId: string): boolean {
  const row = presenceRowFor(nodeId);
  if (!row) return false;
  const i = row.sessions.findIndex((s) => s.sessionId === sessionId);
  if (i < 0) return false;
  row.sessions.splice(i, 1);
  row.lastSeenAt = now();
  notify(nodeId);
  return true;
}

export function statusOfNode(lastSeenAt: string | null): NodePresenceStatus {
  if (!lastSeenAt) return 'offline';
  const age = clock.now().getTime() - Date.parse(lastSeenAt);
  if (age <= CONNECTED_HORIZON_MS) return 'connected';
  if (age <= STALE_HORIZON_MS) return 'stale';
  return 'offline';
}

export function presenceOf(nodeId: string): NodePresence {
  const row = presenceRowFor(nodeId);
  if (!row) return { nodeId, status: 'offline', lastSeenAt: null, sessions: [] };
  const status = statusOfNode(row.lastSeenAt);
  return {
    nodeId,
    status,
    lastSeenAt: row.lastSeenAt,
    // An offline node's sessions are gone as far as anyone watching is
    // concerned — reporting them would offer presence the machine can't back.
    sessions: status === 'offline' ? [] : row.sessions.map(copySession),
  };
}

/** Rows are the live fixture array now, so a reader that got the stored object
 *  could edit presence by reference — and a `touching` array by reference
 *  survives even a shallow copy. */
function copySession(s: LocalSession): LocalSession {
  return { ...s, ...(s.touching ? { touching: [...s.touching] } : {}) };
}

/** Presence change feed. The callback receives the nodeId that changed; the
 *  subscriber re-reads presenceOf() for the current truth. */
export function subscribePresence(cb: (nodeId: string) => void): () => void {
  subscribers.add(cb);
  return () => { subscribers.delete(cb); };
}

/**
 * Test hook — put the seeded presence back and drop every subscriber.
 *
 * `POST /api/__mock/reset` does the first half only: it resets the fixture and
 * leaves open SSE streams attached, which is the difference between a test
 * tearing down a process-shaped world and an auditor restoring a data-shaped
 * one.
 */
export function _resetLocalFleet(): void {
  localPresence.reset();
  subscribers.clear();
}

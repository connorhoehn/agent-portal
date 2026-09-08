// Local-compute presence registry — the live sessions running on developers'
// OWN machines, as announced by the local claude-mem plugin.
//
// Sibling of devbox-fleet.ts and deliberately in-memory like it: a session is
// presence, not a record. The durable half (the paired machine, its token) is
// compute_nodes in Aurora (providers/local-compute.ts); the plugin re-announces
// within one heartbeat after a middleware restart, so persisting sessions would
// only produce rows that lie about liveness.
//
// Status is DERIVED from last_seen, never claimed by the client:
//   ≤ 90s    connected
//   ≤ 5min   stale       (missed heartbeats; machine may be asleep)
//   beyond   offline     (sessions dropped from listings)
// The 5-minute horizon matches the announce protocol's idle heartbeat.

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

interface NodeState {
  lastSeenAt: string;
  sessions: Map<string, LocalSession>;
}

const nodes = new Map<string, NodeState>();
const subscribers = new Set<(nodeId: string) => void>();

function now(): string {
  return new Date().toISOString();
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
  const state: NodeState = { lastSeenAt: now(), sessions: new Map() };
  for (const s of sessions) {
    if (!s.sessionId) continue;
    state.sessions.set(s.sessionId, sanitize(s));
  }
  nodes.set(nodeId, state);
  notify(nodeId);
  return presenceOf(nodeId);
}

/** A heartbeat with no session changes — just proof of life. */
export function recordHeartbeat(nodeId: string): void {
  const state = nodes.get(nodeId);
  if (!state) return;
  state.lastSeenAt = now();
  notify(nodeId);
}

export function endSession(nodeId: string, sessionId: string): boolean {
  const state = nodes.get(nodeId);
  if (!state) return false;
  const removed = state.sessions.delete(sessionId);
  if (removed) {
    state.lastSeenAt = now();
    notify(nodeId);
  }
  return removed;
}

export function statusOfNode(lastSeenAt: string | null): NodePresenceStatus {
  if (!lastSeenAt) return 'offline';
  const age = Date.now() - Date.parse(lastSeenAt);
  if (age <= CONNECTED_HORIZON_MS) return 'connected';
  if (age <= STALE_HORIZON_MS) return 'stale';
  return 'offline';
}

export function presenceOf(nodeId: string): NodePresence {
  const state = nodes.get(nodeId);
  if (!state) return { nodeId, status: 'offline', lastSeenAt: null, sessions: [] };
  const status = statusOfNode(state.lastSeenAt);
  return {
    nodeId,
    status,
    lastSeenAt: state.lastSeenAt,
    // An offline node's sessions are gone as far as anyone watching is
    // concerned — reporting them would offer presence the machine can't back.
    sessions: status === 'offline' ? [] : [...state.sessions.values()],
  };
}

/** Presence change feed. The callback receives the nodeId that changed; the
 *  subscriber re-reads presenceOf() for the current truth. */
export function subscribePresence(cb: (nodeId: string) => void): () => void {
  subscribers.add(cb);
  return () => { subscribers.delete(cb); };
}

/** Test hook — wipe all presence state. */
export function _resetLocalFleet(): void {
  nodes.clear();
  subscribers.clear();
}

// Devbox fleet registry — the server-side source of truth for boxes.
//
// Before this module, box state lived in browser localStorage and task streams
// existed only in the tab that started them. The herd/queue vision (boxes as
// workers pulling queued jobs, operators tailing any box read-only) needs the
// middleware to own three things:
//
//   1. The registry — which boxes exist, labels, session ids.
//   2. Status — idle | running | waiting | stopped | error, derived from the
//      task event flow (not client claims). `waiting` = the last run ended by
//      asking the operator a question.
//   3. The event log — every task event teed into a per-box ring buffer with
//      live subscribers, so ANY client can tail ANY box (SSE replay + live).
//
// In-memory (mirrors canary-broker.ts). The portal keeps a localStorage mirror
// and re-adopts boxes if the middleware restarts, so dev-loop restarts don't
// strand sessions. Promote to Aurora when fleets need to survive deploys.

export type BoxStatus = 'idle' | 'running' | 'waiting' | 'stopped' | 'error';

export interface FleetBox {
  id: string;
  label: string;
  sessionId: string;
  createdAt: string;
  status: BoxStatus;
  lastActivityAt: string;
  /** Prompt of the current/last task (truncated). */
  currentTask?: string;
  lastResult?: { subtype: string; turns: number; durationMs: number; costUsd: number };
}

export type FleetEvent = Record<string, unknown>;

const EVENT_BUFFER_CAP = 500;
const TASK_SNIPPET_LEN = 140;

interface BoxState {
  box: FleetBox;
  events: FleetEvent[];
  subscribers: Set<(ev: FleetEvent) => void>;
  /** Final assistant text of the last run — drives the `waiting` heuristic. */
  lastResultText: string;
}

const boxes = new Map<string, BoxState>();
const bySession = new Map<string, string>(); // sessionId → boxId

function now(): string {
  return new Date().toISOString();
}

export function registerBox(opts: { sessionId: string; label?: string; id?: string; createdAt?: string }): FleetBox {
  const id = opts.id ?? opts.sessionId.slice(-8);
  const existing = boxes.get(id);
  if (existing) return existing.box;
  const box: FleetBox = {
    id,
    label: opts.label ?? `devbox-${boxes.size + 1}`,
    sessionId: opts.sessionId,
    createdAt: opts.createdAt ?? now(),
    status: 'idle',
    lastActivityAt: now(),
  };
  boxes.set(id, { box, events: [], subscribers: new Set(), lastResultText: '' });
  bySession.set(opts.sessionId, id);
  return box;
}

export function listBoxes(): FleetBox[] {
  return [...boxes.values()].map((s) => s.box)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function getBox(id: string): FleetBox | null {
  return boxes.get(id)?.box ?? null;
}

export function getBoxBySession(sessionId: string): FleetBox | null {
  const id = bySession.get(sessionId);
  return id ? getBox(id) : null;
}

export function renameBox(id: string, label: string): FleetBox | null {
  const s = boxes.get(id);
  if (!s) return null;
  s.box.label = label;
  return s.box;
}

export function markStopped(id: string): void {
  const s = boxes.get(id);
  if (s) { s.box.status = 'stopped'; s.box.lastActivityAt = now(); }
}

export function removeBox(id: string): boolean {
  const s = boxes.get(id);
  if (!s) return false;
  bySession.delete(s.box.sessionId);
  boxes.delete(id);
  return true;
}

/** Snapshot of a box's event buffer (oldest-first). */
export function replayEvents(id: string): FleetEvent[] {
  return [...(boxes.get(id)?.events ?? [])];
}

export function subscribe(id: string, cb: (ev: FleetEvent) => void): () => void {
  const s = boxes.get(id);
  if (!s) return () => {};
  s.subscribers.add(cb);
  return () => { s.subscribers.delete(cb); };
}

/**
 * Tee a task event into the box's log and drive the status machine.
 * Synthetic `task_started` events (emitted by the route before invoking the
 * runtime) flip the box to running; `devbox_end` settles it back to idle — or
 * `waiting` when the run's final answer ends with a question for the operator.
 */
export function appendEvent(id: string, ev: FleetEvent): void {
  const s = boxes.get(id);
  if (!s) return;

  s.events.push(ev);
  if (s.events.length > EVENT_BUFFER_CAP) s.events.shift();
  s.box.lastActivityAt = now();

  const type = ev['type'];
  if (type === 'task_started') {
    s.box.status = 'running';
    s.box.currentTask = String(ev['prompt'] ?? '').slice(0, TASK_SNIPPET_LEN);
    s.lastResultText = '';
  } else if (type === 'result') {
    s.box.lastResult = {
      subtype: String(ev['subtype'] ?? ''),
      turns: Number(ev['num_turns'] ?? 0),
      durationMs: Number(ev['duration_ms'] ?? 0),
      costUsd: Number(ev['total_cost_usd'] ?? 0),
    };
    if (typeof ev['result'] === 'string') s.lastResultText = ev['result'];
  } else if (type === 'devbox_end') {
    if (s.box.status === 'running') {
      s.box.status = s.lastResultText.trimEnd().endsWith('?') ? 'waiting' : 'idle';
    }
  } else if (type === 'devbox_error') {
    s.box.status = 'error';
  }

  for (const cb of s.subscribers) {
    try { cb(ev); } catch { /* one bad subscriber must not break the fan-out */ }
  }
}

/** Test hook — wipe all fleet state. */
export function _resetFleet(): void {
  boxes.clear();
  bySession.clear();
}

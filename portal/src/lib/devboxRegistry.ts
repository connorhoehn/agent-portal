// Devbox registry — server-backed fleet client.
//
// The middleware owns the fleet now (GET/POST/PATCH/DELETE /api/devbox/boxes):
// statuses, labels, and the per-box event log all live server-side so any
// browser can see the herd and tail any box. localStorage keeps a mirror for
// two jobs only: instant first paint, and re-adopting boxes if the middleware
// restarted and lost its in-memory registry (dev loop).

export type BoxStatus = 'idle' | 'running' | 'waiting' | 'stopped' | 'error';

export interface DevboxBox {
  id: string;          // registry id (short)
  label: string;       // user-facing name
  sessionId: string;   // AgentCore runtimeSessionId (≥33 chars)
  createdAt: string;   // ISO
  status?: BoxStatus;
  lastActivityAt?: string;
  /** Milliseconds until the reaper stops this box, from the server's policy. */
  stopsInMs?: number;
  currentTask?: string;
  lastResult?: { subtype: string; turns: number; durationMs: number; costUsd: number };
}

const KEY = 'devbox.boxes.v1';
const LEGACY_SESSION_KEY = 'devbox.sessionId';
const CHANGE_EVENT = 'devbox-registry-changed';

function readMirror(): DevboxBox[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as DevboxBox[];
  } catch { /* corrupted mirror — treat as empty */ }
  const legacy = localStorage.getItem(LEGACY_SESSION_KEY);
  if (legacy) {
    return [{ id: legacy.slice(-8), label: 'devbox-1', sessionId: legacy, createdAt: new Date().toISOString() }];
  }
  return [];
}

function writeMirror(boxes: DevboxBox[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(boxes)); } catch { /* quota — mirror is best-effort */ }
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

/** Instant, synchronous snapshot (mirror) for first render. */
export function loadBoxes(): DevboxBox[] {
  return readMirror();
}

/** Subscribe to registry changes (same-tab custom event + cross-tab storage). */
export function onBoxesChanged(cb: () => void): () => void {
  const storageCb = (e: StorageEvent) => { if (e.key === KEY) cb(); };
  window.addEventListener(CHANGE_EVENT, cb);
  window.addEventListener('storage', storageCb);
  return () => {
    window.removeEventListener(CHANGE_EVENT, cb);
    window.removeEventListener('storage', storageCb);
  };
}

/**
 * Reconcile with the server fleet (the source of truth) and return it.
 * If the server registry is empty but the mirror has boxes (middleware
 * restarted), re-adopt them so their sessions/workspaces aren't stranded.
 */
export async function syncBoxes(): Promise<DevboxBox[]> {
  const res = await fetch('/api/devbox/boxes', { credentials: 'include' });
  if (!res.ok) throw new Error(`fleet list failed: HTTP ${res.status}`);
  let { boxes } = (await res.json()) as { boxes: DevboxBox[] };

  const mirror = readMirror();
  if (boxes.length === 0 && mirror.length > 0) {
    for (const b of mirror) {
      await fetch('/api/devbox/boxes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ sessionId: b.sessionId, label: b.label, createdAt: b.createdAt }),
      }).catch(() => { /* best-effort adoption */ });
    }
    const again = await fetch('/api/devbox/boxes', { credentials: 'include' });
    if (again.ok) boxes = ((await again.json()) as { boxes: DevboxBox[] }).boxes;
  }

  writeMirror(boxes);
  return boxes;
}

export async function createBox(label?: string): Promise<DevboxBox> {
  const res = await fetch('/api/devbox/boxes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(label ? { label } : {}),
  });
  if (!res.ok) throw new Error(`box create failed: HTTP ${res.status}`);
  const box = (await res.json()) as DevboxBox;
  writeMirror([...readMirror().filter((b) => b.id !== box.id), box]);
  return box;
}

export async function removeBox(id: string): Promise<void> {
  await fetch(`/api/devbox/boxes/${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'include' })
    .catch(() => { /* best-effort — mirror updated regardless */ });
  writeMirror(readMirror().filter((b) => b.id !== id));
}

export async function renameBox(id: string, label: string): Promise<void> {
  await fetch(`/api/devbox/boxes/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ label }),
  });
  writeMirror(readMirror().map((b) => (b.id === id ? { ...b, label } : b)));
}

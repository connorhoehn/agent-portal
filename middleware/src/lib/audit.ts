// Structured audit log for authorization decisions. Three sinks:
//   1. stdout (JSON lines) — Docker / ECS picks them up for log shipping
//   2. in-memory ring buffer — last N events, queried via /api/observability/authz
//   3. live subscribers — SSE consumers receive each event as it happens
//
// The buffer is intentionally process-local — we don't ship the demo with a
// shared event store. If you scale middleware horizontally, swap the buffer
// for Redis or CloudWatch Logs Insights queries.

import type { Session } from './session.js';

export interface AuthzEvent {
  decision: 'ALLOW' | 'DENY';
  action: string;
  sub: string;
  role: string;
  reason?: string;
  path?: string;
  ts?: string;
}

const BUFFER_CAPACITY = 1000;
const buffer: Required<Pick<AuthzEvent, 'ts'>> & AuthzEvent[] = [] as unknown as Required<Pick<AuthzEvent, 'ts'>> & AuthzEvent[];
const events: AuthzEvent[] = [];
type Subscriber = (ev: AuthzEvent) => void;
const subscribers = new Set<Subscriber>();

export function logAuthz(ev: AuthzEvent): void {
  const stamped: AuthzEvent = {
    ...ev,
    ts: ev.ts ?? new Date().toISOString(),
  };
  process.stdout.write(JSON.stringify({ type: 'authz', ...stamped }) + '\n');

  events.push(stamped);
  if (events.length > BUFFER_CAPACITY) events.shift();

  for (const sub of subscribers) {
    try { sub(stamped); } catch { /* don't let a bad subscriber kill the emit */ }
  }
}

export function eventFromSession(session: Session, action: string, decision: 'ALLOW' | 'DENY', extra?: Partial<AuthzEvent>): AuthzEvent {
  return {
    decision,
    action,
    sub: session.sub,
    role: session.role,
    ...extra,
  };
}

export interface AuthzQuery {
  decision?: 'ALLOW' | 'DENY';
  role?: string;
  action?: string;
  sinceMs?: number;
  limit?: number;
}

/** Snapshot of the buffer, newest-first, with optional filters. */
export function recentAuthzEvents(q: AuthzQuery = {}): AuthzEvent[] {
  const now = Date.now();
  const sinceMs = q.sinceMs ?? Infinity;
  const limit = q.limit ?? 200;
  const filtered: AuthzEvent[] = [];
  for (let i = events.length - 1; i >= 0 && filtered.length < limit; i--) {
    const e = events[i]!;
    if (q.decision && e.decision !== q.decision) continue;
    if (q.role && e.role !== q.role) continue;
    if (q.action && !e.action.toLowerCase().includes(q.action.toLowerCase())) continue;
    if (sinceMs !== Infinity && e.ts) {
      const eMs = Date.parse(e.ts);
      if (now - eMs > sinceMs) continue;
    }
    filtered.push(e);
  }
  return filtered;
}

export function subscribeAuthz(sub: Subscriber): () => void {
  subscribers.add(sub);
  return () => subscribers.delete(sub);
}

// Silence the unused buffer variable until/if we split history sinks.
void buffer;

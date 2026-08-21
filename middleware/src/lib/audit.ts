// Structured audit log for authorization decisions. Four sinks:
//   1. stdout (JSON lines) — Docker / ECS picks them up for log shipping
//   2. in-memory ring buffer — last N events, queried via /api/observability/authz
//   3. live subscribers — SSE consumers receive each event as it happens
//   4. Aurora (observability.authz_events) — durable trail, batched write-behind
//
// The ring buffer is process-local (live view only); Aurora is the permanent
// record. The Aurora sink degrades to a no-op when the cluster isn't
// configured and drops batches on persistent failure rather than backing up
// memory — the stdout line is the always-works fallback.

import {
  RDSDataClient,
  BatchExecuteStatementCommand,
  type SqlParameter,
} from '@aws-sdk/client-rds-data';
import { config } from '../config.js';
import type { Session } from './session.js';

export interface AuthzEvent {
  decision: 'ALLOW' | 'DENY';
  action: string;
  sub: string;
  role: string;
  tenant?: string;
  /** Real identity when the event was produced under masquerade. */
  actor?: string;
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

  enqueuePersist(stamped);
}

// ── Aurora write-behind sink ─────────────────────────────────────────────────

const FLUSH_INTERVAL_MS = 5_000;
const FLUSH_BATCH_MAX = 100;   // RDS Data API parameterSets ceiling is 1000; stay modest
const PENDING_MAX = 5_000;     // hard cap so an Aurora outage can't grow memory unbounded

let pending: AuthzEvent[] = [];
let flushTimer: NodeJS.Timeout | null = null;
let rds: RDSDataClient | null = null;
let sinkWarned = false;

function auroraConfigured(): boolean {
  return !!(config.aurora?.clusterArn && config.aurora?.secretArn);
}

function enqueuePersist(ev: AuthzEvent): void {
  if (!auroraConfigured()) return;
  pending.push(ev);
  if (pending.length > PENDING_MAX) pending = pending.slice(-PENDING_MAX);
  if (!flushTimer) {
    flushTimer = setTimeout(() => { void flushAuthzEvents(); }, FLUSH_INTERVAL_MS);
    flushTimer.unref?.();
  }
}

function s(name: string, value: string | undefined | null): SqlParameter {
  return value == null
    ? { name, value: { isNull: true } }
    : { name, value: { stringValue: value } };
}

/** Flush the pending queue to Aurora. Exposed for tests and shutdown hooks. */
export async function flushAuthzEvents(): Promise<void> {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (pending.length === 0 || !auroraConfigured()) return;
  const batch = pending.slice(0, FLUSH_BATCH_MAX);
  pending = pending.slice(batch.length);
  try {
    rds ??= new RDSDataClient({ region: config.region });
    await rds.send(new BatchExecuteStatementCommand({
      resourceArn: config.aurora.clusterArn,
      secretArn: config.aurora.secretArn,
      database: config.aurora.database,
      sql: `INSERT INTO observability.authz_events
              (ts, decision, action, sub, role, tenant, actor, path, reason)
            VALUES (CAST(:ts AS timestamptz), :decision, :action, :sub, :role, :tenant, :actor, :path, :reason)`,
      parameterSets: batch.map(e => [
        s('ts', e.ts ?? new Date().toISOString()),
        s('decision', e.decision),
        s('action', e.action),
        s('sub', e.sub),
        s('role', e.role),
        s('tenant', e.tenant),
        s('actor', e.actor),
        s('path', e.path),
        s('reason', e.reason),
      ]),
    }));
    sinkWarned = false;
  } catch (err) {
    // Dropped batch: stdout still has every event. Warn once per outage.
    if (!sinkWarned) {
      console.warn(`[audit] Aurora sink failed, dropping batch of ${batch.length}: ${(err as Error).message}`);
      sinkWarned = true;
    }
  }
  if (pending.length > 0 && !flushTimer) {
    flushTimer = setTimeout(() => { void flushAuthzEvents(); }, FLUSH_INTERVAL_MS);
    flushTimer.unref?.();
  }
}

export function eventFromSession(session: Session, action: string, decision: 'ALLOW' | 'DENY', extra?: Partial<AuthzEvent>): AuthzEvent {
  return {
    decision,
    action,
    sub: session.sub,
    role: session.role,
    tenant: session.tenant,
    ...(session.act ? { actor: session.act.sub } : {}),
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

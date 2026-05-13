// In-process event broker for human-in-the-loop approval events. Three sinks:
//   1. stdout (JSON lines) — Docker / ECS picks them up for log shipping
//   2. in-memory ring buffer — last N events, queried for catch-up replay
//   3. live subscribers — SSE consumers receive each event as it happens
//
// Mirrors the design of `audit.ts` exactly. The buffer is process-local — if
// middleware is scaled horizontally, swap for Redis pub/sub or DynamoDB Streams.

export type ApprovalEventType = 'approval' | 'decision';

export interface ApprovalCreatedEvent {
  type: 'approval';
  id: string;
  txId: string;
  agentId: string;
  payload: Record<string, unknown>;
  reason: string | null;
  requestedAt: string;
}

export interface ApprovalDecisionEvent {
  type: 'decision';
  id: string;
  status: 'APPROVED' | 'REJECTED' | 'EXPIRED';
  decidedBy: string;
  decidedAt: string;
  note?: string | null;
}

export type ApprovalEvent = ApprovalCreatedEvent | ApprovalDecisionEvent;

const BUFFER_CAPACITY = 1000;
const events: ApprovalEvent[] = [];
type Subscriber = (ev: ApprovalEvent) => void;
const subscribers = new Set<Subscriber>();

export function publishApprovalEvent(ev: ApprovalEvent): void {
  process.stdout.write(JSON.stringify(ev) + '\n');

  events.push(ev);
  if (events.length > BUFFER_CAPACITY) events.shift();

  for (const sub of subscribers) {
    try { sub(ev); } catch { /* don't let a bad subscriber kill the emit */ }
  }
}

/** Snapshot of the buffer, newest-first, up to `limit` events. */
export function recentApprovalEvents(limit = 100): ApprovalEvent[] {
  const cap = Math.max(1, Math.min(limit, BUFFER_CAPACITY));
  const out: ApprovalEvent[] = [];
  for (let i = events.length - 1; i >= 0 && out.length < cap; i--) {
    const e = events[i];
    if (e) out.push(e);
  }
  return out;
}

export function subscribeApprovals(sub: Subscriber): () => void {
  subscribers.add(sub);
  return () => subscribers.delete(sub);
}

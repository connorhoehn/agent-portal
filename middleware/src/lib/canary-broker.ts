// In-process event broker for canary deployment events. Mirrors the design of
// `approval-broker.ts` exactly. Three sinks:
//   1. stdout (JSON lines) — Docker / ECS picks them up for log shipping
//   2. in-memory ring buffer — last 500 events, queried for SSE catch-up replay
//   3. live subscribers — SSE consumers receive each event as it happens
//
// The buffer is process-local — if middleware is scaled horizontally, swap for
// Redis pub/sub or DynamoDB Streams.

import type { CanaryEvent } from './canary-types.js';

const BUFFER_CAPACITY = 500;

type Subscriber = (ev: CanaryEvent) => void;

class CanaryBroker {
  private readonly buffer: CanaryEvent[] = [];
  private readonly subscribers = new Set<Subscriber>();

  publish(event: CanaryEvent): void {
    // 1. stdout JSON line — picked up by log shippers.
    process.stdout.write(JSON.stringify(event) + '\n');

    // 2. ring buffer.
    this.buffer.push(event);
    if (this.buffer.length > BUFFER_CAPACITY) this.buffer.shift();

    // 3. fan out to live subscribers; don't let a bad subscriber kill the emit.
    for (const sub of this.subscribers) {
      try {
        sub(event);
      } catch {
        // swallow
      }
    }
  }

  subscribe(cb: Subscriber): () => void {
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
    };
  }

  /** Snapshot of the buffer in insertion order (oldest-first). */
  replay(): CanaryEvent[] {
    return [...this.buffer];
  }
}

export const canaryBroker = new CanaryBroker();

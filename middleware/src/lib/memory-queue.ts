// The in-process queue behind `MOCK_QUEUE=true` — same interface as the
// message-queue HTTP client (lib/mq-client.ts), same semantics the consumer
// depends on:
//
//   - FIFO per message group: a group with a message in flight delivers
//     nothing else until that message is acked or its lease expires.
//   - Visibility timeout: a received message is invisible until the lease
//     expires; unacked, it comes back with `approximate_receive_count + 1`.
//   - Deduplication: a second send with the same deduplication id inside the
//     window returns the first message id and enqueues nothing.
//   - Redrive: a message about to be delivered for the (max+1)th time moves to
//     the dead-letter queue instead — the SQS rule message-queue follows.
//
// The message rows are not owned here. The caller hands in the live array
// (`rows()`), which in this repo is a registered mock fixture
// (mock/distillation-queue.ts), so `POST /api/__mock/reset` empties the queue
// with every other fixture instead of leaving leases behind a reset.
// Time comes in through `now()` for the same reason every fixture reads the
// mock clock: a test freezes it and advances past a lease deliberately.

import { randomUUID } from 'node:crypto';
import { MessageQueueError, type MessageQueue, type QueueDefinition, type QueueMessage, type ReceiveOptions, type SendOptions, type RequestOptions } from './mq-client.js';

/** One stored message. Times are epoch ms from the injected clock. */
export interface MemoryQueueRow {
  queue: string;
  message_id: string;
  body: string;
  group_id: string | null;
  dedup_id: string | null;
  sent_at_ms: number;
  /** When the message is next deliverable (a lease sets this into the future). */
  visible_at_ms: number;
  receive_count: number;
  /** The live lease's handle; null when nobody holds it. */
  receipt_handle: string | null;
  /** Set when this row was moved to a DLQ: the queue it came from. */
  dead_lettered_from: string | null;
}

/** SQS's FIFO deduplication window. */
const DEDUP_WINDOW_MS = 5 * 60_000;

export interface MemoryMessageQueueOptions {
  rows: () => MemoryQueueRow[];
  now: () => number;
}

export class MemoryMessageQueue implements MessageQueue {
  readonly backend = 'memory' as const;
  private readonly defs = new Map<string, QueueDefinition>();
  private readonly listeners = new Set<(queue: string) => void>();

  constructor(private readonly opts: MemoryMessageQueueOptions) {}

  /** Fires after every send — the in-process stand-in for a long poll, so a
   *  consumer wakes on work instead of spinning on an interval. */
  onSend(listener: (queue: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async inspect(queue: string, options?: RequestOptions) {
    this.checkCancelled(options);
    const def = this.defs.get(queue);
    if (!def) return null;
    const now = this.opts.now(), rows = this.opts.rows().filter(row => row.queue === queue);
    return { ready: rows.filter(row => row.visible_at_ms <= now).length,
      inFlight: rows.filter(row => row.receipt_handle && row.visible_at_ms > now).length,
      delayed: rows.filter(row => !row.receipt_handle && row.visible_at_ms > now).length,
      fifo: def.fifo, visibilityTimeoutSeconds: def.visibilityTimeoutSeconds };
  }

  async ensureQueue(def: QueueDefinition, options?: RequestOptions): Promise<void> {
    this.checkCancelled(options);
    const existing = this.defs.get(def.name);
    if (existing && (existing.fifo !== def.fifo || existing.visibilityTimeoutSeconds !== def.visibilityTimeoutSeconds
      || existing.redrive?.deadLetterQueue !== def.redrive?.deadLetterQueue || existing.redrive?.maxReceiveCount !== def.redrive?.maxReceiveCount)) {
      throw new MessageQueueError('Queue configuration conflicts', 409, 'ConfigurationConflict');
    }
    this.defs.set(def.name, structuredClone(def));
  }

  definition(queue: string): QueueDefinition | undefined {
    return this.defs.get(queue);
  }

  private requireQueue(queue: string): QueueDefinition {
    const def = this.defs.get(queue);
    if (!def) throw new MessageQueueError(`memory queue ${queue} does not exist — ensureQueue first`, 404, 'QueueDoesNotExist');
    return def;
  }

  private checkCancelled(options?: RequestOptions): void {
    if (options?.signal?.aborted) throw new MessageQueueError('Queue request Aborted', 0, 'Aborted');
  }

  private seconds(value: number, maximum: number): number {
    if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
      throw new MessageQueueError('Queue duration is invalid', 400, 'ValidationException');
    }
    return value * 1000;
  }

  async send(queue: string, body: string, opts: SendOptions = {}): Promise<{ message_id: string }> {
    this.checkCancelled(opts);
    const def = this.requireQueue(queue);
    if (def.fifo && !opts.groupId) throw new MessageQueueError('FIFO send requires a group', 400, 'ValidationException');
    const delayMs = this.seconds(opts.delaySeconds ?? 0, 900);
    const now = this.opts.now();
    const rows = this.opts.rows();
    if (opts.deduplicationId) {
      const dup = rows.find((r) => r.queue === queue && r.dedup_id === opts.deduplicationId
        && now - r.sent_at_ms < DEDUP_WINDOW_MS);
      if (dup) return { message_id: dup.message_id };
    }
    const row: MemoryQueueRow = {
      queue,
      message_id: randomUUID(),
      body,
      group_id: opts.groupId ?? null,
      dedup_id: opts.deduplicationId ?? null,
      sent_at_ms: now,
      visible_at_ms: now + delayMs,
      receive_count: 0,
      receipt_handle: null,
      dead_lettered_from: null,
    };
    rows.push(row);
    for (const listener of this.listeners) listener(queue);
    return { message_id: row.message_id };
  }

  async receive(queue: string, opts: ReceiveOptions = {}): Promise<QueueMessage[]> {
    this.checkCancelled(opts);
    const def = this.requireQueue(queue);
    if (opts.consumerGroupId !== undefined) throw new MessageQueueError('The local memory fixture does not support consumer-group subscriptions', 400, 'UnsupportedOperation');
    if (opts.subscription !== undefined) throw new MessageQueueError('The local memory fixture does not support durable subscriptions', 400, 'UnsupportedOperation');
    const now = this.opts.now();
    const max = Math.max(1, opts.max ?? 1);
    const visibilityMs = this.seconds(opts.visibilityTimeoutSeconds ?? def.visibilityTimeoutSeconds, 43_200);
    const rows = this.opts.rows();

    // An expired lease is released lazily: its handle stops being valid the
    // moment the message is visible again, whoever asks first.
    for (const r of rows) {
      if (r.queue === queue && r.receipt_handle && r.visible_at_ms <= now) r.receipt_handle = null;
    }
    const busyGroups = new Set(rows
      .filter((r) => r.queue === queue && r.receipt_handle && r.group_id !== null)
      .map((r) => r.group_id));

    const out: QueueMessage[] = [];
    const seenGroups = new Set<string>();
    for (const r of rows.slice().sort((a, b) => a.sent_at_ms - b.sent_at_ms)) {
      if (out.length >= max) break;
      if (r.queue !== queue) continue;
      if (def.fifo && r.group_id !== null) {
        // Strict per-group order: only the group's head is deliverable, and
        // not while any of the group is leased.
        if (busyGroups.has(r.group_id) || seenGroups.has(r.group_id)) { seenGroups.add(r.group_id); continue; }
        seenGroups.add(r.group_id);
      }
      if (r.receipt_handle || r.visible_at_ms > now) continue;
      if (def.redrive && r.receive_count >= def.redrive.maxReceiveCount) {
        this.requireQueue(def.redrive.deadLetterQueue);
        r.dead_lettered_from = queue;
        r.queue = def.redrive.deadLetterQueue;
        r.receive_count = 0;
        r.visible_at_ms = now;
        continue;
      }
      r.receive_count += 1;
      r.receipt_handle = randomUUID();
      r.visible_at_ms = now + visibilityMs;
      out.push({
        message_id: r.message_id,
        receipt_handle: r.receipt_handle,
        body: r.body,
        approximate_receive_count: r.receive_count,
        ...(r.group_id !== null ? { message_group_id: r.group_id } : {}),
      });
    }
    return out;
  }

  async ack(queue: string, receiptHandle: string, options?: RequestOptions): Promise<boolean> {
    this.checkCancelled(options);
    this.requireQueue(queue);
    const rows = this.opts.rows();
    const now = this.opts.now();
    const idx = rows.findIndex((r) => r.queue === queue && r.receipt_handle === receiptHandle && r.visible_at_ms > now);
    if (idx < 0) return false;
    rows.splice(idx, 1);
    return true;
  }

  async extend(queue: string, receiptHandle: string, visibilityTimeoutSeconds: number, options?: RequestOptions) {
    this.checkCancelled(options);
    this.requireQueue(queue);
    const durationMs = this.seconds(visibilityTimeoutSeconds, 43_200);
    const now = this.opts.now();
    const row = this.opts.rows().find(r => r.queue === queue && r.receipt_handle === receiptHandle && r.visible_at_ms > now);
    if (!row) return { success: false };
    row.receipt_handle = randomUUID();
    row.visible_at_ms = now + durationMs;
    return { success: true, new_receipt_handle: row.receipt_handle };
  }

  /** What is sitting in a queue right now — the depth an operator reads. */
  depth(queue: string): { visible: number; inflight: number } {
    const now = this.opts.now();
    let visible = 0;
    let inflight = 0;
    for (const r of this.opts.rows()) {
      if (r.queue !== queue) continue;
      if (r.receipt_handle && r.visible_at_ms > now) inflight += 1;
      else visible += 1;
    }
    return { visible, inflight };
  }
}

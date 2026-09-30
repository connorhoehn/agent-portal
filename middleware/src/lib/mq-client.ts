// A small client for the message-queue service (~/projects/message-queue),
// plus the one interface both it and the in-process queue satisfy.
//
// Why an interface and not the HTTP client everywhere: the distillation
// compaction jobs ride this queue, and `dev:mock` has no message-queue
// process to talk to. `MOCK_QUEUE=true` swaps in `lib/memory-queue.ts`, which
// implements the same send/receive/ack/visibility/redrive semantics in
// process, so the consumer loop that runs offline is the same loop that runs
// against the real service — only the transport differs (the same argument
// docs/mock-floor.md makes for the devbox shell).
//
// Wire contract (message-queue `src/api/routes.ts`, v0.2.x):
//   PUT    /api/v1/queues/{name}                          ensure (201 created, 200 noop, 409 conflict)
//   POST   /api/v1/queues/{name}/messages                 send
//   POST   /api/v1/queues/{name}/messages/receive         receive (lease)
//   DELETE /api/v1/queues/{name}/messages/{receipt}       ack
// `MESSAGE_QUEUE_URL` is the bare origin; `/api/v1` lives here, per the
// message-queue CLAUDE.md URL convention.
//
// Auth: message-queue verifies `X-Service-Auth` with service-runtime's
// `verifyServiceRequest`, an HMAC envelope bound to the request's audience,
// method, target and exact body. `signServiceRequest` (service-runtime 0.4.0)
// is the signing half of that same pair, so the payload shape is owned by the
// library that defines it rather than restated here — a restatement is exactly
// the thing that can drift out of step with the verifier and fail closed.

import { SERVICE_AUTH_HEADER, signServiceRequest } from '@connorhoehn/service-runtime';

/** A leased message, as both backends hand it back. */
export interface QueueMessage {
  message_id: string;
  receipt_handle: string;
  body: string;
  /** 1 on first delivery; a redelivery (visibility expired, never acked) is 2+. */
  approximate_receive_count: number;
  message_group_id?: string;
}

export interface QueueDefinition {
  name: string;
  fifo: boolean;
  visibilityTimeoutSeconds: number;
  /** Redrive: after `maxReceiveCount` deliveries without an ack, the message
   *  moves to `deadLetterQueue` instead of being delivered again. */
  redrive?: { deadLetterQueue: string; maxReceiveCount: number };
}

export interface SendOptions {
  /** FIFO ordering key: one in-flight message per group at a time. */
  groupId?: string;
  /** A second send with the same id inside the dedup window is a no-op that
   *  returns the first message's id. */
  deduplicationId?: string;
}

export interface ReceiveOptions {
  max?: number;
  visibilityTimeoutSeconds?: number;
  /** Long-poll seconds (HTTP backend only; the memory queue answers at once). */
  waitSeconds?: number;
}

export interface MessageQueue {
  readonly backend: 'memory' | 'http';
  ensureQueue(def: QueueDefinition): Promise<void>;
  send(queue: string, body: string, opts?: SendOptions): Promise<{ message_id: string }>;
  receive(queue: string, opts?: ReceiveOptions): Promise<QueueMessage[]>;
  /** Delete a leased message. False when the receipt is stale (the lease
   *  expired and someone else holds it now) — the caller's work still ran. */
  ack(queue: string, receiptHandle: string): Promise<boolean>;
}

export interface HttpMessageQueueOptions {
  /** Bare origin, e.g. http://127.0.0.1:3000 — no /api/v1. */
  baseUrl: string;
  serviceId: string;
  /** Unset = send no X-Service-Auth header (message-queue is open outside
   *  production when its own secret is unset). */
  secret?: string;
  fetchImpl?: typeof fetch;
  /** The audience message-queue verifies against. */
  audience?: string;
}

export class MessageQueueError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'MessageQueueError';
  }
}

const API = '/api/v1';

export class HttpMessageQueue implements MessageQueue {
  readonly backend = 'http' as const;
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly audience: string;

  constructor(private readonly opts: HttpMessageQueueOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.audience = opts.audience ?? 'message-queue';
  }

  /** The `X-Service-Auth` value for one request, or none when unsigned. */
  authHeaders(method: string, target: string, body: string): Record<string, string> {
    if (!this.opts.secret) return {};
    return {
      [SERVICE_AUTH_HEADER]: signServiceRequest({ method, target, body },
        { secret: this.opts.secret, serviceId: this.opts.serviceId, audience: this.audience }),
    };
  }

  private async call<T>(method: string, path: string, payload?: unknown, okStatuses: number[] = []): Promise<{ status: number; body: T }> {
    const target = `${API}${path}`;
    const body = payload === undefined ? '' : JSON.stringify(payload);
    const res = await this.fetchImpl(`${this.base}${target}`, {
      method,
      headers: {
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
        ...this.authHeaders(method, target, body),
      },
      ...(payload === undefined ? {} : { body }),
    });
    const text = await res.text();
    const parsed = text ? (JSON.parse(text) as T) : ({} as T);
    if (!res.ok && !okStatuses.includes(res.status)) {
      throw new MessageQueueError(`message-queue ${method} ${target} → ${res.status} ${text.slice(0, 200)}`, res.status);
    }
    return { status: res.status, body: parsed };
  }

  async ensureQueue(def: QueueDefinition): Promise<void> {
    const configuration: Record<string, unknown> = {
      fifo_queue: def.fifo,
      visibility_timeout_seconds: def.visibilityTimeoutSeconds,
    };
    if (def.redrive) {
      configuration['redrive_policy'] = {
        dead_letter_target_arn: `arn:message-queue:queue:${def.redrive.deadLetterQueue}`,
        max_receive_count: def.redrive.maxReceiveCount,
      };
    }
    // 409 = the queue exists with a different config. That is an operator
    // decision, not a reason to refuse to run — the queue still works.
    const { status } = await this.call('PUT', `/queues/${encodeURIComponent(def.name)}`, { configuration }, [409]);
    if (status === 409) console.warn(`[mq] queue ${def.name} exists with a different configuration; using it as is`);
  }

  async send(queue: string, body: string, opts: SendOptions = {}): Promise<{ message_id: string }> {
    const { body: out } = await this.call<{ message_id: string }>('POST', `/queues/${encodeURIComponent(queue)}/messages`, {
      message_body: body,
      ...(opts.groupId ? { message_group_id: opts.groupId } : {}),
      ...(opts.deduplicationId ? { message_deduplication_id: opts.deduplicationId } : {}),
    });
    return { message_id: out.message_id };
  }

  async receive(queue: string, opts: ReceiveOptions = {}): Promise<QueueMessage[]> {
    const { body } = await this.call<{ messages?: Array<QueueMessage & Record<string, unknown>> }>(
      'POST', `/queues/${encodeURIComponent(queue)}/messages/receive`, {
        max_number_of_messages: opts.max ?? 1,
        ...(opts.visibilityTimeoutSeconds !== undefined ? { visibility_timeout: opts.visibilityTimeoutSeconds } : {}),
        ...(opts.waitSeconds !== undefined ? { wait_time_seconds: opts.waitSeconds } : {}),
      });
    return (body.messages ?? []).map((m) => ({
      message_id: m.message_id,
      receipt_handle: m.receipt_handle,
      body: m.body,
      approximate_receive_count: m.approximate_receive_count,
      ...(m.message_group_id ? { message_group_id: m.message_group_id } : {}),
    }));
  }

  async ack(queue: string, receiptHandle: string): Promise<boolean> {
    try {
      await this.call('DELETE', `/queues/${encodeURIComponent(queue)}/messages/${encodeURIComponent(receiptHandle)}`);
      return true;
    } catch (err) {
      if (err instanceof MessageQueueError && (err.status === 404 || err.status === 400)) return false;
      throw err;
    }
  }
}

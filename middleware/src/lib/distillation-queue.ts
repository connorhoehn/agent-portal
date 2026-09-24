// The two compaction queues and which backend carries them.
//
//   distill-compact-l1  L0 → L1 passes     FIFO, message_group_id = repo
//   distill-compact-l2  L1 → L2 passes     FIFO, message_group_id = repo
//   *-dlq               where a pass lands after MAX_RECEIVES failed deliveries
//
// FIFO by repo means two passes over the same repo never run at once (the
// second waits for the first's ack), while different repos proceed in
// parallel. A whole-store pass (no repo) groups under ALL_REPOS_GROUP.
//
// Backend: message-queue over HTTP when MESSAGE_QUEUE_URL is set and
// MOCK_QUEUE is not; otherwise the in-process queue (lib/memory-queue.ts),
// whose rows are a registered mock fixture so a reset empties it. The
// in-process fallback for an unset URL is announced once at boot, because a
// silent fallback is how an operator ends up believing jobs are durable.

import { config } from '../config.js';
import { clock } from '../mock/core/index.js';
import { distillationQueueMessages } from '../mock/distillation-queue.js';
import { HttpMessageQueue, type MessageQueue, type QueueDefinition } from './mq-client.js';
import { MemoryMessageQueue } from './memory-queue.js';

export type CompactionTarget = 'L1' | 'L2';

export const COMPACTION_QUEUES: Record<CompactionTarget, string> = {
  L1: 'distill-compact-l1',
  L2: 'distill-compact-l2',
};
export const COMPACTION_DLQS: Record<CompactionTarget, string> = {
  L1: 'distill-compact-l1-dlq',
  L2: 'distill-compact-l2-dlq',
};
/** Deliveries before a pass is dead-lettered. */
export const MAX_RECEIVES = 3;
/** A lease must outlive the longest pass, or a slow pass is redelivered while
 *  it is still running (the job-id idempotency check would no-op it, but the
 *  lease would still be wasted). */
export const VISIBILITY_TIMEOUT_S = 60;
export const ALL_REPOS_GROUP = 'all-repos';

export function compactionQueueDefinitions(): QueueDefinition[] {
  return (['L1', 'L2'] as const).flatMap((level) => [
    { name: COMPACTION_DLQS[level], fifo: true, visibilityTimeoutSeconds: VISIBILITY_TIMEOUT_S },
    {
      name: COMPACTION_QUEUES[level],
      fifo: true,
      visibilityTimeoutSeconds: VISIBILITY_TIMEOUT_S,
      redrive: { deadLetterQueue: COMPACTION_DLQS[level], maxReceiveCount: MAX_RECEIVES },
    },
  ]);
}

type MqConfig = { url: string; serviceId: string; secret: string; mock: boolean };

/** Read defensively: route and provider suites mock `config` with only the
 *  fields they touch, and an absent block means "no queue service". */
function mqConfig(): MqConfig {
  const c = (config as { messageQueue?: Partial<MqConfig> }).messageQueue ?? {};
  return { url: c.url ?? '', serviceId: c.serviceId ?? 'orgiq-middleware', secret: c.secret ?? '', mock: c.mock ?? false };
}

/**
 * The offline decision: MOCK_QUEUE, or no MESSAGE_QUEUE_URL, means the
 * in-process queue. Named — rather than inlined — for the same reason
 * providers/identity.ts names `auroraConfigured`: the rule-4 write scan
 * (mock/core/wire/mock-branches.ts GUARD_TOKENS) recognises a function that
 * consults it as having a real offline path, so `POST /compact` is not
 * reported as reaching a backend dev:mock cannot answer.
 */
export function inProcessQueue(): boolean {
  const mq = mqConfig();
  return mq.mock || !mq.url;
}

let queue: MessageQueue | null = null;
let ensured: Promise<void> | null = null;

/** Which transport compaction rides, decided once. */
export function compactionQueue(): MessageQueue {
  if (queue) return queue;
  const mq = mqConfig();
  if (!inProcessQueue()) {
    queue = new HttpMessageQueue({ baseUrl: mq.url, serviceId: mq.serviceId, ...(mq.secret ? { secret: mq.secret } : {}) });
  } else {
    if (!mq.mock && process.env['JEST_WORKER_ID'] === undefined) {
      console.warn('[distill] MESSAGE_QUEUE_URL is unset — compaction jobs ride the in-process queue and do not survive a restart');
    }
    queue = new MemoryMessageQueue({
      rows: () => distillationQueueMessages.rows(),
      now: () => clock.now().getTime(),
    });
  }
  return queue;
}

/** Create the four queues (idempotent PUT against message-queue). Memoized;
 *  a failure clears the memo so the next send retries it. */
export function ensureCompactionQueues(): Promise<void> {
  if (!ensured) {
    const q = compactionQueue();
    ensured = (async () => {
      for (const def of compactionQueueDefinitions()) await q.ensureQueue(def);
    })().catch((err: unknown) => {
      ensured = null;
      throw err;
    });
  }
  return ensured;
}

/** Put one pass on its level's queue: FIFO group = repo (or ALL_REPOS_GROUP),
 *  deduplicated by job id so a retried send cannot enqueue the pass twice. */
export async function enqueueCompaction(
  level: CompactionTarget, payload: { job_id: string; level: CompactionTarget; repo: string | null },
): Promise<{ message_id: string }> {
  await ensureCompactionQueues();
  return compactionQueue().send(COMPACTION_QUEUES[level], JSON.stringify(payload), {
    groupId: payload.repo ?? ALL_REPOS_GROUP,
    deduplicationId: payload.job_id,
  });
}

/** Test seam: swap the transport (and forget the ensure memo). */
export function __setCompactionQueue(q: MessageQueue | null): void {
  queue = q;
  ensured = null;
}

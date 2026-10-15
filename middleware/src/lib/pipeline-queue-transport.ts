// Which transport the pipelines tenant's queues are read through.
//
// Backend: message-queue over HTTP when MESSAGE_QUEUE_URL is set and MOCK_QUEUE
// is not; otherwise the in-process queue (lib/memory-queue.ts), whose rows are a
// registered mock fixture (mock/pipeline-queue.ts) so a reset empties it.

import { config } from '../config.js';
import { clock } from '../mock/core/index.js';
import { pipelineQueueMessages } from '../mock/pipeline-queue.js';
import { HttpMessageQueue, type MessageQueue } from './mq-client.js';
import { MemoryMessageQueue } from './memory-queue.js';
import { pipelineQueueDefinitions } from './pipeline-queue-defs.js';

type MqConfig = { url: string; serviceId: string; secret: string; mock: boolean };

/** Read defensively: route and provider suites mock `config` with only the
 *  fields they touch, and an absent block means "no queue service". */
function mqConfig(): MqConfig {
  const c = (config as { messageQueue?: Partial<MqConfig> }).messageQueue ?? {};
  return { url: c.url ?? '', serviceId: c.serviceId ?? 'orgiq-middleware', secret: c.secret ?? '', mock: c.mock ?? false };
}

/**
 * The offline decision: MOCK_QUEUE, or no MESSAGE_QUEUE_URL, means the
 * in-process queue. Named — rather than inlined — so the rule-4 write scan
 * (mock/core/wire/mock-branches.ts GUARD_TOKENS) recognises a function that
 * consults it as having a real offline path.
 */
export function inProcessQueue(): boolean {
  const mq = mqConfig();
  return mq.mock || !mq.url;
}

let queue: MessageQueue | null = null;

/** Which transport the pipeline queues ride, decided once. */
export function pipelineQueue(): MessageQueue {
  if (queue) return queue;
  const mq = mqConfig();
  if (!inProcessQueue()) {
    queue = new HttpMessageQueue({ baseUrl: mq.url, serviceId: mq.serviceId, ...(mq.secret ? { secret: mq.secret } : {}) });
  } else {
    const memory = new MemoryMessageQueue({
      rows: () => pipelineQueueMessages.rows(),
      now: () => clock.now().getTime(),
    });
    for (const def of pipelineQueueDefinitions()) void memory.ensureQueue(def);
    queue = memory;
  }
  return queue;
}

/** Test seam: replace (or clear) the memoized transport. */
export function __setPipelineQueue(q: MessageQueue | null): void { queue = q; }

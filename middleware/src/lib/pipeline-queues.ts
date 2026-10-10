import { config } from '../config.js';
import { compactionQueue, compactionQueueDefinitions } from './distillation-queue.js';
import { MessageQueueError, type MessageQueue, type QueueSnapshot } from './mq-client.js';

export interface PipelineQueueRow {
  name: string; purpose: string; deadLetter: boolean; redriveTo: string | null; maxReceives: number | null;
  state: 'available' | 'missing' | 'unavailable'; snapshot: QueueSnapshot | null; reason: string | null;
}

/** An explicit inventory, never an unrestricted list of another service's queues. */
export function pipelineQueueInventory(extra = '') {
  const owned = compactionQueueDefinitions().map(def => ({ name: def.name,
    purpose: def.name.endsWith('-dlq') ? 'Failed distillation deliveries' : def.name.endsWith('-l1') ? 'L0 → L1 compaction' : 'L1 → L2 compaction',
    deadLetter: def.name.endsWith('-dlq'), redriveTo: def.redrive?.deadLetterQueue ?? null, maxReceives: def.redrive?.maxReceiveCount ?? null }));
  const names = new Set(owned.map(row => row.name));
  for (const name of extra.split(',').map(name => name.trim())) {
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(name) || names.has(name) || names.size >= 32) continue;
    names.add(name); owned.push({ name, purpose: 'Configured queue', deadLetter: false, redriveTo: null, maxReceives: null });
  }
  return owned;
}

/** Reads actual transport metadata; missing/failed reads never become zero backlog. */
export async function readPipelineQueues(queue: MessageQueue = compactionQueue(), extra = config.messageQueue?.observedQueues ?? '') {
  const queues: PipelineQueueRow[] = await Promise.all(pipelineQueueInventory(extra).map(async row => {
    try {
      if (!queue.inspect) return { ...row, state: 'unavailable' as const, snapshot: null, reason: 'This transport does not expose queue attributes.' };
      const snapshot = await queue.inspect(row.name);
      return { ...row, state: snapshot ? 'available' as const : 'missing' as const, snapshot,
        reason: snapshot ? null : 'Queue has not been created on this transport.' };
    } catch (error) {
      // Do not expose upstream response bodies, credentials, or internal URLs.
      const reason = error instanceof MessageQueueError && [401, 403].includes(error.status)
        ? 'Queue service refused the metadata read.' : 'Queue attributes could not be read. Retry to refresh.';
      return { ...row, state: 'unavailable' as const, snapshot: null, reason };
    }
  }));
  return { observedAt: new Date().toISOString(), backend: queue.backend, queues };
}

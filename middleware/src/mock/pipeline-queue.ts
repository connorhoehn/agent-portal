// The in-process pipeline queues' message store (lib/memory-queue.ts under
// `MOCK_QUEUE=true`). A registered fixture rather than a private array so
// `POST /api/__mock/reset` takes a queued or leased message back with everything
// else. The backlog below is on queues no consumer reads, so nothing runs at boot.

import { clock, defineFixture } from './core/index.js';
import type { MemoryQueueRow } from '../lib/memory-queue.js';
import { BACKFILL_QUEUE, INGEST_DLQ, INGEST_QUEUE } from '../lib/pipeline-queue-defs.js';

/**
 * The pipelines tenant's data-pipeline queues (lib/pipeline-queue-defs.ts) hold
 * a believable backlog, because the Queues page is read with something on it.
 * Nothing consumes these queues. Depth is the rows; no count is stored.
 */
function pipelineBacklog(): MemoryQueueRow[] {
  const now = clock.now().getTime();
  const row = (queue: string, n: number, minutesAgo: number, body: Record<string, unknown>, over: Partial<MemoryQueueRow> = {}): MemoryQueueRow => ({
    queue, message_id: `${queue}-${n}`, body: JSON.stringify(body), group_id: null, dedup_id: null,
    sent_at_ms: now - minutesAgo * 60_000, visible_at_ms: now - minutesAgo * 60_000, receive_count: 0, receipt_handle: null, dead_lettered_from: null, ...over,
  });
  const files = ['orders', 'refunds', 'inventory', 'partner-events', 'customers', 'shipments'];
  return [
    ...files.map((f, i) => row(INGEST_QUEUE, i, 4 + i * 3, { file: `${f}-nightly.csv` })),
    // One file a box is loading right now (leased for the next few minutes).
    row(INGEST_QUEUE, 9, 2, { file: 'ledger-adjustments.csv' }, { receive_count: 1, receipt_handle: 'lease-ingest-9', visible_at_ms: now + 4 * 60_000 }),
    row(INGEST_DLQ, 0, 540, { file: 'partner-events-oct.csv', reason: 'malformed header' }, { dead_lettered_from: INGEST_QUEUE }),
    row(INGEST_DLQ, 1, 410, { file: 'refunds-oct-12.csv', reason: 'schema version mismatch' }, { dead_lettered_from: INGEST_QUEUE }),
    row(BACKFILL_QUEUE, 0, 95, { window: 'last month of events' }, { group_id: 'events' }),
  ];
}

export const pipelineQueueMessages = defineFixture<MemoryQueueRow>({
  key: 'pipeline-queue-messages',
  scenarios: {
    default: pipelineBacklog,
    empty: () => [],
  },
});

// The data-pipeline queues the pipelines tenant observes (docs/demo-content-audit.md P5).
//
// What a data team's pipelines wait on: source files landed and not yet loaded,
// the files that failed three loads, and backfills someone asked for. The
// distillation compaction queues are that feature's own and are read on its
// pages. Definitions only: no transport here, so the in-process queue
// (lib/distillation-queue.ts under MOCK_QUEUE) and the observer
// (lib/pipeline-queues.ts) share one spelling of the names.

import type { QueueDefinition } from './mq-client.js';
import type { PipelineQueueRow } from './pipeline-queues.js';

export const INGEST_QUEUE = 'ingest-landing';
export const INGEST_DLQ = 'ingest-landing-dlq';
export const BACKFILL_QUEUE = 'backfill-requests';
/** Deliveries before a file is dead-lettered. */
export const INGEST_MAX_RECEIVES = 3;

export function pipelineQueueDefinitions(): QueueDefinition[] {
  return [
    { name: INGEST_DLQ, fifo: false, visibilityTimeoutSeconds: 300 },
    { name: INGEST_QUEUE, fifo: false, visibilityTimeoutSeconds: 300, redrive: { deadLetterQueue: INGEST_DLQ, maxReceiveCount: INGEST_MAX_RECEIVES } },
    { name: BACKFILL_QUEUE, fifo: true, visibilityTimeoutSeconds: 900 },
  ];
}

/** What each observed queue is for, in the words a pipeline owner uses. */
export const PIPELINE_QUEUE_PURPOSE: Readonly<Record<string, string>> = {
  [INGEST_QUEUE]: 'Source files landed and waiting to be loaded',
  [INGEST_DLQ]: 'Files that failed three loads and need a person',
  [BACKFILL_QUEUE]: 'Backfills requested and waiting for a window',
};

/** The agent work queue: jobs waiting for a box and jobs a box is running, counted from the job rows (not a transport queue). */
export function agentWorkQueueRow(jobs: ReadonlyArray<{ status: string }>): PipelineQueueRow {
  const ready = jobs.filter(j => j.status === 'queued').length;
  const inFlight = jobs.filter(j => j.status === 'claimed' || j.status === 'running').length;
  return { name: 'agent-work', purpose: 'Agent jobs waiting for a box, and the ones a box is running', deadLetter: false, redriveTo: null, maxReceives: null,
    state: 'available', snapshot: { ready, inFlight, delayed: 0, visibilityTimeoutSeconds: 300, fifo: false }, reason: null };
}

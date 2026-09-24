// The in-process compaction queue's message store (lib/memory-queue.ts under
// `MOCK_QUEUE=true`). A registered fixture rather than a private array for one
// reason: `POST /api/__mock/reset` must take a queued or leased compaction
// back with everything else. A queue that survived a reset would redeliver a
// job the reset had just erased, and the consumer would run a pass against a
// corpus that no longer contains its job row.
//
// Every world starts with nothing queued — a seeded message would be a job
// the consumer runs at boot, mutating the corpus before anyone looked at it.

import { defineFixture } from './core/index.js';
import type { MemoryQueueRow } from '../lib/memory-queue.js';

export const distillationQueueMessages = defineFixture<MemoryQueueRow>({
  key: 'distillation-queue-messages',
  scenarios: {
    default: () => [],
    empty: () => [],
  },
});

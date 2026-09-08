// work_item_comments — the discussion on a work item, and the audit trail a
// dispatch leaves behind on it.
//
// `providers/work-items.ts`'s `addWorkItemComment` was a no-op in mock
// (`if (config.mock.aurora) return;`), so offline the write succeeded, wrote
// nothing, and the only surface that renders comments — the initiative
// activity feed, whose comment arm joins this table — stayed empty. The
// visible cost was the settle comment a simulated marketplace dispatch leaves
// on the item it ran ("Marketplace run completed without a captured
// change…"): the run appeared on the bots pages, the work item flipped back to
// open, and the sentence explaining WHY it flipped back existed nowhere.
//
// The rows below mirror schema/seed_program.sql's `work_item_comments` INSERTs
// — the same eight ids, the same work items, the same authors, the same prose.
// Ids matter here for the same reason they do everywhere else in this fixture
// tree: a comment on `wi-…` an Aurora seed never wrote is a row the real
// cluster can never produce.
//
// Ages come from the clock, so "2 days ago" is two days before the READ rather
// than two days before the process booted, and they mirror the seed's
// `NOW() - INTERVAL 'n days'` offsets exactly.

import { clock, defineFixture } from './core/index.js';

/** One row of `work_item_comments` (schema/orgiq_work_items_schema.sql).
 *  `isSystem` true is an audit event — a status change, or a marketplace run
 *  reporting how it finished — and the feed renders those differently from a
 *  human comment. */
export interface WorkItemCommentRow {
  id: string;
  workItemId: string;
  /** Null for a machine-written row: nobody authored the settle comment. */
  authorId: string | null;
  body: string;
  isSystem: boolean;
  createdAt: string;
}

export const workItemComments = defineFixture<WorkItemCommentRow>({
  key: 'work-item-comments',
  scenarios: {
    // schema/seed_program.sql:431-438, byte-for-byte.
    default: () => [
      { id: 'wic-prog-1', workItemId: 'wi-obs-e1-b5', authorId: 'p-008', isSystem: false,
        createdAt: clock.daysAgo(12),
        body: 'Repro: burst 40k spans/s for 90s and the gateway pod OOMs inside 4 minutes. Bounding the queue trades spans for survival — I think we take that trade.' },
      { id: 'wic-prog-2', workItemId: 'wi-obs-e1-b5', authorId: 'p-004', isSystem: false,
        createdAt: clock.daysAgo(2),
        body: 'Agreed. Cap the queue and let tail-sampling keep errors; dropped healthy spans are the cheapest loss we have.' },
      { id: 'wic-prog-3', workItemId: 'wi-obs-e2-s2', authorId: 'p-011', isSystem: false,
        createdAt: clock.daysAgo(6),
        body: 'Fast-burn window at 5m/1h and slow-burn at 6h/3d, thresholds from the SRE workbook. PR has the recording rules.' },
      { id: 'wic-prog-4', workItemId: 'wi-auth-e1-b4', authorId: 'p-051', isSystem: false,
        createdAt: clock.daysAgo(8),
        body: 'The loop is the client retrying refresh on a 403 that is actually a revocation. Server should return a terminal signal, not a retryable one.' },
      { id: 'wic-prog-5', workItemId: 'wi-auth-e1-s3', authorId: 'p-002', isSystem: false,
        createdAt: clock.daysAgo(9),
        body: 'Server-side max-age landed behind a flag; flipping it after the cutover window closes.' },
      { id: 'wic-prog-6', workItemId: 'wi-llm-e1-s2', authorId: 'p-013', isSystem: false,
        createdAt: clock.daysAgo(1),
        body: 'Rubric weights: grounding 0.4, completeness 0.3, tone 0.15, latency 0.15. Judge agreement with human labels at 0.82 on the pilot set.' },
      { id: 'wic-prog-7', workItemId: 'wi-llm-e2-s1', authorId: 'p-042', isSystem: false,
        createdAt: clock.daysAgo(1),
        body: 'Golden sets are versioned with the prompt now — an eval score means nothing if the set drifted under it.' },
      { id: 'wic-prog-8', workItemId: 'wi-cost-e2-s2', authorId: 'p-017', isSystem: false,
        createdAt: clock.daysAgo(3),
        body: 'Showback needs the bot baseline broken out separately from interactive runs — maintenance is a floor, not a choice.' },
    ],
    // Declared, so an auditor can see the feed's own empty state without
    // damaging the seed — see docs/mock-floor.md's fallback rule.
    empty: () => [],
  },
});

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
      // Planning notes on wi-obs-e1-s4, fixed ages rather than the random draw
      // above (schema/seeds/generate_program_seed.py's FIXED_AGE_COMMENTS).
      { id: 'wic-prog-9', workItemId: 'wi-obs-e1-s4', authorId: 'p-004', isSystem: false,
        createdAt: clock.daysAgo(2),
        body: 'Start with low-risk services after the collector rollout.' },
      { id: 'wic-prog-10', workItemId: 'wi-obs-e1-s4', authorId: 'p-011', isSystem: false,
        createdAt: clock.daysAgo(1),
        body: 'Keep the bridge available until dashboard parity is verified.' },
      // Ticket threads on the five engineering arcs, fixed ages
      // (schema/seeds/generate_program_seed.py's TICKET_COMMENTS).
      { id: 'wic-prog-11', workItemId: 'wi-auth-e1-b4', authorId: 'p-002', isSystem: false,
        createdAt: clock.daysAgo(7),
        body: 'Agreed with Simone. Answer 401 with error="invalid_token" and a session_revoked reason, and the client signs out once. Every other 401 stays retryable with backoff.' },
      { id: 'wic-prog-12', workItemId: 'wi-auth-e1-b4', authorId: 'p-004', isSystem: false,
        createdAt: clock.daysAgo(3),
        body: 'Repro is in the PR: revoke the grant, leave the tab open, count refresh calls. Before the fix 31 calls in the first minute, after it exactly one, then the sign-in page.' },
      { id: 'wic-prog-13', workItemId: 'wi-auth-e2-s2', authorId: 'p-051', isSystem: false,
        createdAt: clock.hoursAgo(0.9),
        body: 'Looking at the callback-list step now. One ask: make it fail closed. If describe-user-pool-client does not list the tenant origin under CallbackURLs, the flip does not start.' },
      { id: 'wic-prog-14', workItemId: 'wi-obs-e2-b4', authorId: 'p-011', isSystem: false,
        createdAt: clock.daysAgo(1),
        body: 'The dependency map is about 60 percent derivable from traces: 212 service-to-service edges seen in the last 7 days. The rest are batch jobs and queues that emit no spans, and their owners have to declare them before grouping can trust the map.' },
      { id: 'wic-prog-15', workItemId: 'wi-inf-e1-b3', authorId: 'p-013', isSystem: false,
        createdAt: clock.daysAgo(4),
        body: 'Profiled one cold start on the embedding model: 11 s pulling the image, 52 s loading weights from S3, 6 s warming the CUDA graphs. Baking the weights into the image removes most of the 52 s, but the image grows from 4 GB to 11 GB.' },
      { id: 'wic-prog-16', workItemId: 'wi-inf-e1-b3', authorId: 'p-049', isSystem: false,
        createdAt: clock.daysAgo(3),
        body: 'Even baked, a cold start is around 20 s against a 2.5 s p99. I have written the warm floor up as a decision so the standing cost is on record before anyone turns it on.' },
      { id: 'wic-prog-17', workItemId: 'wi-llm-e1-b3', authorId: 'p-042', isSystem: false,
        createdAt: clock.daysAgo(5),
        body: 'Seen it after every deploy: 43 replicas, 43 GetPrompt calls in the same second, 12 of them throttled. Jitter alone fixes the deploy case. Stale-while-revalidate covers the store being slow.' },
      { id: 'wic-prog-18', workItemId: 'wi-cost-e1-s2', authorId: 'p-011', isSystem: false,
        createdAt: clock.daysAgo(2),
        body: 'Checked the encryption keys: the three quiet collections each use their own KMS key, which is why they cannot share OCUs. Re-keying means a reindex, about 40 minutes per collection.' },
      { id: 'wic-prog-19', workItemId: 'wi-rta-e1-b3', authorId: 'p-019', isSystem: false,
        createdAt: clock.daysAgo(4),
        body: 'Raising allowed lateness to 5 minutes would hold window state ten times longer. A side output for late events plus an hourly correction job is cheaper and keeps the aggregates honest.' },
      { id: 'wic-prog-20', workItemId: 'wi-mob-e1-b3', authorId: 'p-035', isSystem: false,
        createdAt: clock.hoursAgo(3),
        body: '@Mia Singh do we keep the drawer swipe on Android, or open the drawer from the tab bar only? The back gesture and the swipe start from the same edge, and every fix that keeps both breaks one of them on some devices.' },
    ],
    // Declared, so an auditor can see the feed's own empty state without
    // damaging the seed — see docs/mock-floor.md's fallback rule.
    empty: () => [],
  },
});

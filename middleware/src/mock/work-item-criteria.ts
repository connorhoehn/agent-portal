// work_item_criteria — the acceptance-criteria checklist on a work item.
//
// Mirrors schema/seed_program.sql's `work_item_criteria` INSERTs (same ids,
// same work items, same text, same done/position), the same convention
// work-item-comments.ts follows for the same table family. Ages come from the
// clock (not MOCK_EPOCH reprojection — like the comments fixture, a checklist
// item's age is a real instant relative to the read, not an offset replayed
// against the seeded work item's own createdAt).

import { clock, defineFixture } from './core/index.js';

/** One row of `work_item_criteria` (schema/orgiq_work_items_schema.sql). */
export interface WorkItemCriterionRow {
  id: string;
  workItemId: string;
  text: string;
  done: boolean;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export const workItemCriteria = defineFixture<WorkItemCriterionRow>({
  key: 'work-item-criteria',
  scenarios: {
    // schema/seed_program.sql's "Acceptance-criteria checklists on the
    // in-flight items of the engineering arcs" block, byte-for-byte.
    default: () => [
      { id: 'wicr-obs-e1-s4-1', workItemId: 'wi-obs-e1-s4', text: 'Route metrics through the collector', done: false, position: 0, createdAt: clock.daysAgo(5), updatedAt: clock.daysAgo(5) },
      { id: 'wicr-obs-e1-s4-2', workItemId: 'wi-obs-e1-s4', text: 'Verify dashboard and alert parity', done: false, position: 1, createdAt: clock.daysAgo(5), updatedAt: clock.daysAgo(5) },
      { id: 'wicr-obs-e1-s4-3', workItemId: 'wi-obs-e1-s4', text: 'Keep a rollback path during migration', done: false, position: 2, createdAt: clock.daysAgo(5), updatedAt: clock.daysAgo(5) },

      { id: 'wicr-obs-e3-s1-1', workItemId: 'wi-obs-e3-s1', text: 'Every service has an active-series budget in the service catalog', done: true, position: 0, createdAt: clock.daysAgo(10), updatedAt: clock.daysAgo(3) },
      { id: 'wicr-obs-e3-s1-2', workItemId: 'wi-obs-e3-s1', text: 'CI fails a pull request that adds a label with unbounded values (user_id, request_id, raw path)', done: false, position: 1, createdAt: clock.daysAgo(10), updatedAt: clock.daysAgo(10) },
      { id: 'wicr-obs-e3-s1-3', workItemId: 'wi-obs-e3-s1', text: 'An exemption needs an owner, a reason and an expiry date', done: false, position: 2, createdAt: clock.daysAgo(10), updatedAt: clock.daysAgo(10) },

      { id: 'wicr-obs-e3-s2-1', workItemId: 'wi-obs-e3-s2', text: 'Log levels classified into debug, info and audit tiers', done: true, position: 0, createdAt: clock.daysAgo(12), updatedAt: clock.daysAgo(6) },
      { id: 'wicr-obs-e3-s2-2', workItemId: 'wi-obs-e3-s2', text: 'Debug tier sampled at 1 in 20 at the agent collector', done: true, position: 1, createdAt: clock.daysAgo(12), updatedAt: clock.daysAgo(4) },
      { id: 'wicr-obs-e3-s2-3', workItemId: 'wi-obs-e3-s2', text: 'Audit logs bypass sampling: a replay of 10,000 audit lines arrives with 10,000 lines', done: false, position: 2, createdAt: clock.daysAgo(12), updatedAt: clock.daysAgo(12) },

      { id: 'wicr-obs-e2-s3-1', workItemId: 'wi-obs-e2-s3', text: 'One panel per team showing budget remaining over the 30-day window', done: false, position: 0, createdAt: clock.daysAgo(4), updatedAt: clock.daysAgo(4) },
      { id: 'wicr-obs-e2-s3-2', workItemId: 'wi-obs-e2-s3', text: 'Each panel links to the burn-rate alert and the owning team', done: false, position: 1, createdAt: clock.daysAgo(4), updatedAt: clock.daysAgo(4) },

      { id: 'wicr-obs-e1-b5-1', workItemId: 'wi-obs-e1-b5', text: 'memory_limiter is the first processor in every gateway pipeline', done: true, position: 0, createdAt: clock.daysAgo(6), updatedAt: clock.daysAgo(2) },
      { id: 'wicr-obs-e1-b5-2', workItemId: 'wi-obs-e1-b5', text: 'Exporter sending_queue bounded at 5,000 batches', done: true, position: 1, createdAt: clock.daysAgo(6), updatedAt: clock.daysAgo(2) },
      { id: 'wicr-obs-e1-b5-3', workItemId: 'wi-obs-e1-b5', text: '40k spans/s burst replay for 90 s: zero OOM kills on the gateway pods', done: false, position: 2, createdAt: clock.daysAgo(6), updatedAt: clock.daysAgo(1) },
      { id: 'wicr-obs-e1-b5-4', workItemId: 'wi-obs-e1-b5', text: 'Error spans kept at 100 percent during the burst, measured by the tail-sampling decision counter', done: false, position: 3, createdAt: clock.daysAgo(6), updatedAt: clock.daysAgo(6) },

      { id: 'wicr-obs-e1-s3-1', workItemId: 'wi-obs-e1-s3', text: 'Route labels templated (/users/{id}), never raw paths', done: true, position: 0, createdAt: clock.daysAgo(9), updatedAt: clock.daysAgo(3) },
      { id: 'wicr-obs-e1-s3-2', workItemId: 'wi-obs-e1-s3', text: 'RED panels for checkout and search match the StatsD dashboards within 2 percent for a week', done: false, position: 1, createdAt: clock.daysAgo(9), updatedAt: clock.daysAgo(9) },
      { id: 'wicr-obs-e1-s3-3', workItemId: 'wi-obs-e1-s3', text: 'Active series from the connector stay under 50,000', done: false, position: 2, createdAt: clock.daysAgo(9), updatedAt: clock.daysAgo(9) },

      { id: 'wicr-obs-e2-s2-1', workItemId: 'wi-obs-e2-s2', text: 'Page at 14.4x burn over 1 hour, confirmed by a 5-minute window', done: true, position: 0, createdAt: clock.daysAgo(8), updatedAt: clock.daysAgo(4) },
      { id: 'wicr-obs-e2-s2-2', workItemId: 'wi-obs-e2-s2', text: 'Ticket at 6x burn over 6 hours, confirmed by a 30-minute window', done: true, position: 1, createdAt: clock.daysAgo(8), updatedAt: clock.daysAgo(4) },
      { id: 'wicr-obs-e2-s2-3', workItemId: 'wi-obs-e2-s2', text: 'Backtest over 30 days pages for both real incidents and nothing else', done: false, position: 2, createdAt: clock.daysAgo(8), updatedAt: clock.daysAgo(8) },

      { id: 'wicr-auth-e2-s2-1', workItemId: 'wi-auth-e2-s2', text: 'Rehearse the cutover on both internal tenants with zero forced logouts', done: false, position: 0, createdAt: clock.daysAgo(9), updatedAt: clock.daysAgo(1) },
      { id: 'wicr-auth-e2-s2-2', workItemId: 'wi-auth-e2-s2', text: 'Pre-flight: the tenant origin is in the Cognito app client CallbackURLs before the flip', done: false, position: 1, createdAt: clock.daysAgo(1), updatedAt: clock.daysAgo(1) },
      { id: 'wicr-auth-e2-s2-3', workItemId: 'wi-auth-e2-s2', text: 'Record the decided tenant order and the reason for it', done: false, position: 2, createdAt: clock.daysAgo(9), updatedAt: clock.daysAgo(9) },
      { id: 'wicr-auth-e2-s2-4', workItemId: 'wi-auth-e2-s2', text: 'Every tenant has a rollback that restores the shim route within two minutes', done: false, position: 3, createdAt: clock.daysAgo(9), updatedAt: clock.daysAgo(9) },

      { id: 'wicr-auth-e1-s3-1', workItemId: 'wi-auth-e1-s3', text: 'Re-mint the session cookie on every tenant and role switch', done: true, position: 0, createdAt: clock.daysAgo(20), updatedAt: clock.daysAgo(6) },
      { id: 'wicr-auth-e1-s3-2', workItemId: 'wi-auth-e1-s3', text: 'A copy of the pre-switch cookie is refused within 120 seconds', done: false, position: 1, createdAt: clock.daysAgo(20), updatedAt: clock.daysAgo(20) },
      { id: 'wicr-auth-e1-s3-3', workItemId: 'wi-auth-e1-s3', text: 'Masquerade sessions do not bump the epoch of the impersonated user', done: false, position: 2, createdAt: clock.daysAgo(20), updatedAt: clock.daysAgo(20) },

      { id: 'wicr-auth-e1-b4-1', workItemId: 'wi-auth-e1-b4', text: 'Refresh answers 401 with a session_revoked reason when a grant is revoked', done: true, position: 0, createdAt: clock.daysAgo(8), updatedAt: clock.daysAgo(3) },
      { id: 'wicr-auth-e1-b4-2', workItemId: 'wi-auth-e1-b4', text: 'Client signs out once on session_revoked and makes no further refresh calls', done: false, position: 1, createdAt: clock.daysAgo(8), updatedAt: clock.daysAgo(8) },
      { id: 'wicr-auth-e1-b4-3', workItemId: 'wi-auth-e1-b4', text: 'Regression test revokes a grant mid-session and asserts exactly one refresh call', done: false, position: 2, createdAt: clock.daysAgo(8), updatedAt: clock.daysAgo(8) },

      { id: 'wicr-auth-e2-b3-1', workItemId: 'wi-auth-e2-b3', text: 'Logout redirects through the shim single-logout endpoint while the shim exists', done: false, position: 0, createdAt: clock.daysAgo(6), updatedAt: clock.daysAgo(6) },
      { id: 'wicr-auth-e2-b3-2', workItemId: 'wi-auth-e2-b3', text: 'After logout, the next visit lands on the Cognito hosted UI', done: false, position: 1, createdAt: clock.daysAgo(6), updatedAt: clock.daysAgo(6) },

      { id: 'wicr-llm-e1-s2-1', workItemId: 'wi-llm-e1-s2', text: 'Rubric weights grounding 0.4, completeness 0.3, tone 0.15, latency 0.15 stored in config, not code', done: true, position: 0, createdAt: clock.daysAgo(14), updatedAt: clock.daysAgo(5) },
      { id: 'wicr-llm-e1-s2-2', workItemId: 'wi-llm-e1-s2', text: 'Judge agreement with human labels reported on the 120-question pilot set', done: true, position: 1, createdAt: clock.daysAgo(14), updatedAt: clock.daysAgo(3) },
      { id: 'wicr-llm-e1-s2-3', workItemId: 'wi-llm-e1-s2', text: 'Judge model chosen and recorded in the decision', done: false, position: 2, createdAt: clock.daysAgo(14), updatedAt: clock.daysAgo(14) },

      { id: 'wicr-llm-e1-b3-1', workItemId: 'wi-llm-e1-b3', text: 'Prompt cache TTL jittered by 0 to 15 seconds per replica', done: false, position: 0, createdAt: clock.daysAgo(5), updatedAt: clock.daysAgo(5) },
      { id: 'wicr-llm-e1-b3-2', workItemId: 'wi-llm-e1-b3', text: 'Stale prompt served while one refresh runs', done: false, position: 1, createdAt: clock.daysAgo(5), updatedAt: clock.daysAgo(5) },
      { id: 'wicr-llm-e1-b3-3', workItemId: 'wi-llm-e1-b3', text: '50 replicas restarted at once: zero throttled GetPrompt calls', done: false, position: 2, createdAt: clock.daysAgo(5), updatedAt: clock.daysAgo(5) },

      { id: 'wicr-llm-e2-s1-1', workItemId: 'wi-llm-e2-s1', text: 'Each agent has 30 to 60 golden questions with expected facts', done: true, position: 0, createdAt: clock.daysAgo(16), updatedAt: clock.daysAgo(4) },
      { id: 'wicr-llm-e2-s1-2', workItemId: 'wi-llm-e2-s1', text: 'Baseline file records the golden-set version it was scored against', done: false, position: 1, createdAt: clock.daysAgo(16), updatedAt: clock.daysAgo(2) },
      { id: 'wicr-llm-e2-s1-3', workItemId: 'wi-llm-e2-s1', text: 'A merge fails when any rubric dimension drops more than 0.03', done: false, position: 2, createdAt: clock.daysAgo(16), updatedAt: clock.daysAgo(16) },

      { id: 'wicr-cost-e1-s2-1', workItemId: 'wi-cost-e1-s2', text: 'Every OpenSearch Serverless collection listed with its KMS key and last-7-day query count', done: true, position: 0, createdAt: clock.daysAgo(9), updatedAt: clock.daysAgo(2) },
      { id: 'wicr-cost-e1-s2-2', workItemId: 'wi-cost-e1-s2', text: 'Collections under 100 queries a week moved onto the shared key group', done: false, position: 1, createdAt: clock.daysAgo(9), updatedAt: clock.daysAgo(9) },
      { id: 'wicr-cost-e1-s2-3', workItemId: 'wi-cost-e1-s2', text: 'Old collections deleted after 7 days of zero queries', done: false, position: 2, createdAt: clock.daysAgo(9), updatedAt: clock.daysAgo(9) },

      { id: 'wicr-cost-e2-s1-1', workItemId: 'wi-cost-e2-s1', text: 'CDK synthesis fails when a taggable resource lacks initiative and owner tags', done: true, position: 0, createdAt: clock.daysAgo(11), updatedAt: clock.daysAgo(3) },
      { id: 'wicr-cost-e2-s1-2', workItemId: 'wi-cost-e2-s1', text: 'Untagged resources created in the last day appear in the daily sweep', done: true, position: 1, createdAt: clock.daysAgo(11), updatedAt: clock.daysAgo(4) },
      { id: 'wicr-cost-e2-s1-3', workItemId: 'wi-cost-e2-s1', text: 'Every exemption names the resource type and why it cannot carry tags', done: false, position: 2, createdAt: clock.daysAgo(11), updatedAt: clock.daysAgo(11) },

      { id: 'wicr-inf-e1-s1-1', workItemId: 'wi-inf-e1-s1', text: 'Router publishes in-flight requests per model every 10 seconds', done: true, position: 0, createdAt: clock.daysAgo(10), updatedAt: clock.daysAgo(2) },
      { id: 'wicr-inf-e1-s1-2', workItemId: 'wi-inf-e1-s1', text: 'Scale out at 4 in-flight per replica sustained for 30 seconds, scale in after 10 minutes', done: false, position: 1, createdAt: clock.daysAgo(10), updatedAt: clock.daysAgo(10) },
      { id: 'wicr-inf-e1-s1-3', workItemId: 'wi-inf-e1-s1', text: 'Replay of the last traffic peak keeps p99 queue wait under 500 ms', done: false, position: 2, createdAt: clock.daysAgo(10), updatedAt: clock.daysAgo(10) },

      { id: 'wicr-inf-e1-b3-1', workItemId: 'wi-inf-e1-b3', text: 'Cold-start time broken down: image pull, weight load, warm-up', done: true, position: 0, createdAt: clock.daysAgo(7), updatedAt: clock.daysAgo(4) },
      { id: 'wicr-inf-e1-b3-2', workItemId: 'wi-inf-e1-b3', text: 'Warm-floor decision recorded with its monthly cost', done: false, position: 1, createdAt: clock.daysAgo(7), updatedAt: clock.daysAgo(7) },
      { id: 'wicr-inf-e1-b3-3', workItemId: 'wi-inf-e1-b3', text: 'p99 under 2.5 s for the first request after 30 minutes idle, measured by the canary', done: false, position: 2, createdAt: clock.daysAgo(7), updatedAt: clock.daysAgo(7) },

      { id: 'wicr-rta-e1-s1-1', workItemId: 'wi-rta-e1-s1', text: 'Incremental RocksDB checkpoints enabled', done: true, position: 0, createdAt: clock.daysAgo(12), updatedAt: clock.daysAgo(5) },
      { id: 'wicr-rta-e1-s1-2', workItemId: 'wi-rta-e1-s1', text: 'Checkpoint interval 30 seconds with under 10 seconds of alignment', done: false, position: 1, createdAt: clock.daysAgo(12), updatedAt: clock.daysAgo(12) },
      { id: 'wicr-rta-e1-s1-3', workItemId: 'wi-rta-e1-s1', text: 'Killing one task manager recovers in under 60 seconds with no duplicate output', done: false, position: 2, createdAt: clock.daysAgo(12), updatedAt: clock.daysAgo(12) },
    ],
    // Declared, so an auditor can see the checklist's own empty state without
    // damaging the seed — see middleware/src/mock/core/contract.ts's fallback rule.
    empty: () => [],
  },
});

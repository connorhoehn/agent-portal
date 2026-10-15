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
    // schema/seed_program.sql's "Acceptance-criteria checklists on select
    // Observability and Auth Migration items" block, byte-for-byte.
    default: () => [
      { id: 'wicr-obs-e1-s4-1', workItemId: 'wi-obs-e1-s4', text: 'Route metrics through the collector', done: false, position: 0, createdAt: clock.daysAgo(5), updatedAt: clock.daysAgo(5) },
      { id: 'wicr-obs-e1-s4-2', workItemId: 'wi-obs-e1-s4', text: 'Verify dashboard and alert parity', done: false, position: 1, createdAt: clock.daysAgo(5), updatedAt: clock.daysAgo(5) },
      { id: 'wicr-obs-e1-s4-3', workItemId: 'wi-obs-e1-s4', text: 'Keep a rollback path during migration', done: false, position: 2, createdAt: clock.daysAgo(5), updatedAt: clock.daysAgo(5) },

      { id: 'wicr-obs-e3-s1-1', workItemId: 'wi-obs-e3-s1', text: 'Define per-service label cardinality budgets', done: true, position: 0, createdAt: clock.daysAgo(10), updatedAt: clock.daysAgo(3) },
      { id: 'wicr-obs-e3-s1-2', workItemId: 'wi-obs-e3-s1', text: 'Add a CI check that fails a PR exceeding budget', done: false, position: 1, createdAt: clock.daysAgo(10), updatedAt: clock.daysAgo(10) },
      { id: 'wicr-obs-e3-s1-3', workItemId: 'wi-obs-e3-s1', text: 'Document the exemption process for legitimate spikes', done: false, position: 2, createdAt: clock.daysAgo(10), updatedAt: clock.daysAgo(10) },

      { id: 'wicr-obs-e3-s2-1', workItemId: 'wi-obs-e3-s2', text: 'Classify log levels into debug/info/audit tiers', done: true, position: 0, createdAt: clock.daysAgo(12), updatedAt: clock.daysAgo(6) },
      { id: 'wicr-obs-e3-s2-2', workItemId: 'wi-obs-e3-s2', text: 'Configure the sampling rate for the debug tier', done: true, position: 1, createdAt: clock.daysAgo(12), updatedAt: clock.daysAgo(4) },
      { id: 'wicr-obs-e3-s2-3', workItemId: 'wi-obs-e3-s2', text: 'Confirm audit logs bypass sampling entirely', done: false, position: 2, createdAt: clock.daysAgo(12), updatedAt: clock.daysAgo(12) },

      { id: 'wicr-obs-e2-s3-1', workItemId: 'wi-obs-e2-s3', text: 'Wire one dashboard panel per team', done: false, position: 0, createdAt: clock.daysAgo(4), updatedAt: clock.daysAgo(4) },
      { id: 'wicr-obs-e2-s3-2', workItemId: 'wi-obs-e2-s3', text: 'Add drill-down to the underlying SLO burn', done: false, position: 1, createdAt: clock.daysAgo(4), updatedAt: clock.daysAgo(4) },

      // Auth Migration's two in-flight stories (the Work demo story).
      { id: 'wicr-auth-e2-s2-1', workItemId: 'wi-auth-e2-s2', text: 'Rehearse the cutover on both internal tenants', done: false, position: 0, createdAt: clock.daysAgo(9), updatedAt: clock.daysAgo(1) },
      { id: 'wicr-auth-e2-s2-2', workItemId: 'wi-auth-e2-s2', text: 'Record the decided tenant order and the reason for it', done: false, position: 1, createdAt: clock.daysAgo(9), updatedAt: clock.daysAgo(9) },
      { id: 'wicr-auth-e2-s2-3', workItemId: 'wi-auth-e2-s2', text: 'Give every tenant a rollback that answers within two minutes', done: false, position: 2, createdAt: clock.daysAgo(9), updatedAt: clock.daysAgo(9) },

      { id: 'wicr-auth-e1-s3-1', workItemId: 'wi-auth-e1-s3', text: 'Re-mint the session cookie on every tenant and role switch', done: true, position: 0, createdAt: clock.daysAgo(20), updatedAt: clock.daysAgo(6) },
      { id: 'wicr-auth-e1-s3-2', workItemId: 'wi-auth-e1-s3', text: 'The pre-switch cookie stops working within the refresh window', done: false, position: 1, createdAt: clock.daysAgo(20), updatedAt: clock.daysAgo(20) },
    ],
    // Declared, so an auditor can see the checklist's own empty state without
    // damaging the seed — see docs/mock-floor.md's fallback rule.
    empty: () => [],
  },
});

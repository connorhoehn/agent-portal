// work_item_job_drafts — a dispatch prepared on a work item and saved for later
// (schema/work_item_job_drafts_schema.sql, 2026-10-28).
//
// Live: one row per work item, cleared when the item is dispatched. This
// registered fixture is its offline mirror under MOCK_AURORA: the seed carries
// no drafts (nothing in schema/seed_program.sql prepares a run and walks away),
// so `default` is empty and every row here is one a PUT in this process wrote —
// which `POST /api/__mock/reset` takes out again.
//
// Rows only, in the table's own columns. `savedByName` is resolved on read.

import { defineFixture } from './core/index.js';

/** One row of `work_item_job_drafts`. */
export interface WorkItemJobDraftRow {
  workItemId: string;
  model: string;
  budgetPerRunUsd: number | null;
  instruction: string | null;
  agentProjectId: string | null;
  savedBy: string;
  savedAt: string;
  updatedAt: string;
}

export const workItemJobDrafts = defineFixture<WorkItemJobDraftRow>({
  key: 'work-item-job-drafts',
  scenarios: {
    default: () => [],
    empty: () => [],
  },
});

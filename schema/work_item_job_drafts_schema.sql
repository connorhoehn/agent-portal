-- Work-item job drafts — a dispatch set up and saved for later (2026-10-28).
--
-- WHY THIS EXISTS. The dispatch drawer on an initiative lets an SME prepare a
-- run against a work item: pick the model, cap the spend, write the
-- instruction, choose the codebase. When the grant-scoped gate refuses them
-- ("no active sprint grant", lib/bot-runner.ts decideGrantScopedDispatch) the
-- approved response component offers two branches: request budget (an access
-- request, schema/access_schema.sql `sprint-envelope`) or SAVE FOR LATER. The
-- second needs somewhere to put the prepared setup that is not the browser —
-- the person who asked for the envelope is not always the one who comes back
-- to dispatch once it is granted, and a tab closed is a setup lost.
--
-- ONE DRAFT PER WORK ITEM, not per person: the draft is the item's prepared
-- run, the way its estimate (work_item_estimate_schema.sql) is the item's
-- estimate. `saved_by` records who prepared it; the next steward to open the
-- item sees it and may dispatch, change or discard it.
--
-- A DISPATCHED JOB CLEARS ITS DRAFT: POST /api/bots/dispatch-work deletes the
-- row once the run has started, so a draft always means "prepared, not yet
-- run". Nothing here gates anything; the dispatch gates are unchanged.
--
-- Additive, repeatable (every statement IF NOT EXISTS). Needs work_items
-- (orgiq_work_items_schema.sql) and agent_projects (agent_projects_schema.sql).

CREATE TABLE IF NOT EXISTS work_item_job_drafts (
  work_item_id        TEXT PRIMARY KEY REFERENCES work_items(id) ON DELETE CASCADE,
  -- The model the run would use. Required: a draft with no model is not a
  -- prepared run, and the estimate that justifies it is model-specific.
  model               TEXT NOT NULL,
  -- The caller's own per-run cap (dispatch-work's budgetPerRunUsd); NULL = none.
  budget_per_run_usd  NUMERIC CHECK (budget_per_run_usd IS NULL OR budget_per_run_usd >= 0),
  instruction         TEXT,
  -- The codebase the run targets; NULL lets the preflight pick. SET NULL on a
  -- deleted codebase: the rest of the draft is still worth keeping.
  agent_project_id    UUID REFERENCES agent_projects(id) ON DELETE SET NULL,
  -- The session subject that saved it (app_users sub, like bot_runs.dispatched_by).
  saved_by            TEXT NOT NULL,
  saved_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE work_item_job_drafts IS
  'A dispatch prepared on a work item and saved for later (model, per-run cap, '
  'instruction, codebase). One per item; cleared when the item is dispatched.';

-- Agent-run attribution — who authorized a run.
--
-- Why this exists: `budget_grants` hands a named SME a spend envelope for a
-- sprint, and until now nothing could enforce it, because `bot_runs` recorded
-- WHICH INITIATIVE a run spent against but never WHO dispatched it. The Budgets
-- page is deliberate about that gap: GrantRow.initiativeSpendInWindowUsd is the
-- initiative's spend inside the sprint window and is explicitly not presented as
-- the grantee's burn, since attributing initiative-wide spend to one person
-- would be a figure nobody can support.
--
-- This column does not fix that retroactively and must not be read as if it
-- did. It starts attribution GOING FORWARD:
--
--   * every run dispatched before this migration has dispatched_by NULL and is
--     attributed to nobody — that is correct, not missing data;
--   * cron and pr_watch firings stay NULL forever: nobody authorized them from
--     inside an envelope, and giving them an owner would re-invent the very
--     number this project refused to invent;
--   * only manual bot firings and marketplace dispatches carry a subject, and
--     only those count against a person's envelope.
--
-- So an envelope burn computed from this column is small and truthful rather
-- than large and fabricated. The middleware says so in every refusal it builds
-- from it ("counting only runs recorded as dispatched by you"), and degrades to
-- "burn unknown" — never to "burn zero" — on a cluster where this file has not
-- been applied.
--
-- Additive and idempotent: safe to re-run, and the middleware works either side
-- of it. Loads after agent_bots_schema.sql (which creates bot_runs).

ALTER TABLE bot_runs
  ADD COLUMN IF NOT EXISTS dispatched_by TEXT;

COMMENT ON COLUMN bot_runs.dispatched_by IS
  'The app_users subject (session sub) that authorized this run, for manual and '
  'marketplace dispatches. NULL for cron/pr_watch firings and for every run that '
  'predates this column: unattributed, deliberately, not unknown-by-accident. '
  'Summed per person inside a sprint window it is the burn against that person''s '
  'budget_grants envelope — and nothing wider than that.';

-- The envelope brake's read shape: one subject, a date window, newest first.
CREATE INDEX IF NOT EXISTS bot_runs_dispatched_by_idx
  ON bot_runs (dispatched_by, started_at DESC);

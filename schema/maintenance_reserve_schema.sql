-- The maintenance reserve (docs/deployment-enhancements/DE-55-maintenance-reserve.md,
-- folds DE-39).
--
-- Necessary bots (the cron maintenance floor) are funded FIRST: each
-- initiative's allocation carries a reserve for them, essential bots' scheduled
-- firings are judged against that reserve (spilling into the discretionary
-- remainder only while allow_floor_spill), and every human, job and box path is
-- judged against what is left:
--   discretionary remaining = allocated - max(reserve, floor spent)
--                             - discretionary spent - open discretionary holds
--
-- Loads after agent_bots_schema.sql, agent_budgets_schema.sql and
-- spend_holds_schema.sql (the three tables it alters). Additive and idempotent.

-- Null = auto: the last closed period's essential-bot spend x
-- MAINTENANCE_RESERVE_FACTOR (1.1), else the trailing 30-day essential spend x
-- the same factor on an initiative with no closed period behind it.
ALTER TABLE initiative_budgets ADD COLUMN IF NOT EXISTS maintenance_reserve_usd NUMERIC
  CHECK (maintenance_reserve_usd IS NULL OR maintenance_reserve_usd >= 0);
-- true (default): an essential firing past the reserve may spend the
-- discretionary remainder, so maintenance never stops while any money is left.
ALTER TABLE initiative_budgets ADD COLUMN IF NOT EXISTS allow_floor_spill BOOLEAN NOT NULL DEFAULT true;

-- Whether a bot is necessary (the floor). The spec's
-- `NOT NULL DEFAULT (trigger = 'cron')` is not expressible: PostgreSQL forbids
-- a column reference in a DEFAULT. So the column is nullable and NULL means
-- "by trigger": every reader uses COALESCE(essential, trigger = 'cron'). Only a
-- ManageBudgets holder sets it (PUT /api/bots/:id/essential).
ALTER TABLE bots ADD COLUMN IF NOT EXISTS essential BOOLEAN;

-- A hold written for an essential firing is floor money, counted against the
-- reserve rather than the discretionary remainder.
ALTER TABLE spend_holds ADD COLUMN IF NOT EXISTS essential BOOLEAN NOT NULL DEFAULT false;

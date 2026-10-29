-- Hard caps beside the soft brakes (docs/deployment-enhancements/DE-36-hard-caps.md).
--
-- A cap is a column, enforced inside the spend hold (lib/spend-holds.ts
-- reserveSpend) before the soft brakes and ignoring every confirm flag. Null
-- means the deployment default: allocated_usd x BUDGET_HARD_CAP_FACTOR (1.25).
-- user_budgets carries its own hard_cap_usd (user_budgets_schema.sql).
--
-- Loads after agent_budgets_schema.sql and program_schema.sql (the two tables
-- it alters). Additive and idempotent.

ALTER TABLE initiative_budgets ADD COLUMN IF NOT EXISTS hard_cap_usd NUMERIC
  CHECK (hard_cap_usd IS NULL OR hard_cap_usd >= allocated_usd);
ALTER TABLE budget_grants ADD COLUMN IF NOT EXISTS hard_cap_usd NUMERIC
  CHECK (hard_cap_usd IS NULL OR hard_cap_usd >= allocated_usd);

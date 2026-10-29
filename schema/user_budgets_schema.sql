-- User budgets (docs/deployment-enhancements/DE-54-user-budgets.md).
--
-- Budgets are real Bedrock money and apply to USERS as well as initiatives:
-- one row per app user, a monthly allocation (a soft brake, confirmable like
-- the initiative allocation) and an optional hard cap (never confirmable,
-- DE-36). Spend is never stored here: the burn is derived at read time from
-- spend_entries.actor_id inside the period, plus the user's open spend_holds,
-- so the row and the actuals cannot drift.
--
-- A user with no row is unbraked (shown as a blind spot, the same posture as
-- an initiative with no allocation). Cron spend never charges a user: cron
-- firings carry no actor, and the burn excludes trigger = 'cron' besides.
--
-- Loads after identity_schema.sql (FK on app_users) and spend_holds_schema.sql
-- (the ALTER below). Additive and idempotent.

CREATE TABLE IF NOT EXISTS user_budgets (
  user_id        TEXT PRIMARY KEY REFERENCES app_users (id) ON DELETE CASCADE,
  -- Monthly only, like initiative_budgets; the CHECK keeps the shape open.
  period         TEXT        NOT NULL DEFAULT 'monthly' CHECK (period IN ('monthly')),
  allocated_usd  NUMERIC     NOT NULL CHECK (allocated_usd >= 0),
  -- Null = the deployment default (allocated x BUDGET_HARD_CAP_FACTOR).
  hard_cap_usd   NUMERIC     CHECK (hard_cap_usd IS NULL OR hard_cap_usd >= allocated_usd),
  note           TEXT,
  -- The ManageBudgets holder who set it. Never the user themselves: the write
  -- route refuses a row whose user_id is the caller (or the masquerading actor).
  set_by         TEXT,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Unattributed spend (a box with no initiative) can now be held against the
-- spender's user budget, so a hold no longer always names an initiative.
-- Relaxing NOT NULL is additive: every existing row still satisfies it.
ALTER TABLE spend_holds ALTER COLUMN initiative_id DROP NOT NULL;

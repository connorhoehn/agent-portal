-- Budget periods beyond monthly (docs/deployment-enhancements/DE-38-budget-periods.md).
--
-- An allocation names its window: monthly (the default, and every existing
-- row), quarterly, sprint-aligned or rolling. The window itself is computed at
-- read time (middleware/src/lib/budget-periods.ts and its SQL twin, the
-- `budget_windows` CTE); only the policy and the period closes are stored.
--
-- Carry-over is a CLOSE ROW, not a running balance: when a read needs the
-- current period and the previous keyed period has no close row, it writes one
-- (INSERT ... ON CONFLICT DO NOTHING, so replicas and retries agree).
--
-- Loads after agent_budgets_schema.sql and program_schema.sql (it alters
-- initiative_budgets and indexes sprints). Additive and idempotent: applying it
-- twice is a no-op.

-- Widen the period CHECK by replacing the named constraint. Every existing row
-- is 'monthly', so the new constraint validates immediately. 'weekly' (or any
-- other word) still fails.
ALTER TABLE initiative_budgets DROP CONSTRAINT IF EXISTS initiative_budgets_period_check;
ALTER TABLE initiative_budgets ADD CONSTRAINT initiative_budgets_period_check
  CHECK (period IN ('monthly', 'quarterly', 'sprint', 'rolling'));

ALTER TABLE initiative_budgets
  ADD COLUMN IF NOT EXISTS rolling_days INTEGER CHECK (rolling_days BETWEEN 1 AND 366),
  -- Default 'none' (decision taken by default): nothing carries until a
  -- release manager opts in, so no existing figure moves.
  ADD COLUMN IF NOT EXISTS carry_over TEXT NOT NULL DEFAULT 'none'
    CHECK (carry_over IN ('none', 'unspent', 'overspend', 'both')),
  ADD COLUMN IF NOT EXISTS carry_over_cap_usd NUMERIC CHECK (carry_over_cap_usd >= 0),
  -- When the current policy took effect; periods ending at or before it carry nothing.
  ADD COLUMN IF NOT EXISTS carry_over_since TIMESTAMPTZ;

-- A rolling window needs its length and never carries (it never ends, so
-- nothing is left over). Added NOT VALID then validated, so a live table is not
-- scanned under the ADD's lock; the DO block makes the pair repeatable.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'initiative_budgets_period_shape'
                    AND conrelid = 'initiative_budgets'::regclass) THEN
    ALTER TABLE initiative_budgets ADD CONSTRAINT initiative_budgets_period_shape CHECK (
      (period = 'rolling') = (rolling_days IS NOT NULL)
      AND (period <> 'rolling' OR carry_over = 'none')) NOT VALID;
  END IF;
END $$;
ALTER TABLE initiative_budgets VALIDATE CONSTRAINT initiative_budgets_period_shape;

CREATE TABLE IF NOT EXISTS budget_period_closes (
  org_project_id       TEXT        NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  period_key           TEXT        NOT NULL,          -- '2026-10' | '2026-Q4' | sprints.id
  period_start         TIMESTAMPTZ NOT NULL,
  period_end           TIMESTAMPTZ NOT NULL,
  allocated_usd        NUMERIC     NOT NULL,          -- the allocation in force at close
  carry_in_usd         NUMERIC     NOT NULL DEFAULT 0,
  spent_usd            NUMERIC     NOT NULL,          -- known cost only
  unknown_cost_entries INTEGER     NOT NULL DEFAULT 0, -- counted, never blocking (DE-33)
  carry_out_usd        NUMERIC     NOT NULL,          -- signed: + unspent, - overspend
  reason               TEXT        NOT NULL DEFAULT 'boundary' CHECK (reason IN ('boundary', 'reconfigured')),
  closed_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (org_project_id, period_key),
  CHECK (period_end > period_start)
);

-- "The latest close before this period" is the carry-in lookup.
CREATE INDEX IF NOT EXISTS budget_period_closes_start_idx
  ON budget_period_closes (org_project_id, period_start DESC);

-- At most one ACTIVE sprint per initiative (decision taken by default): a
-- sprint-period allocation and every envelope resolve to one window. Created
-- only when the data already satisfies it, so a cluster that carries two active
-- sprints on one initiative still loads this file (and says so) instead of
-- failing the whole schema run; resolve the duplicates and re-run.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_indexes
              WHERE schemaname = current_schema() AND indexname = 'sprints_one_active_per_initiative') THEN
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM sprints WHERE status = 'active' GROUP BY org_project_id HAVING COUNT(*) > 1) THEN
    RAISE NOTICE 'sprints_one_active_per_initiative not created: an initiative has more than one active sprint';
    RETURN;
  END IF;
  CREATE UNIQUE INDEX sprints_one_active_per_initiative ON sprints (org_project_id) WHERE status = 'active';
END $$;

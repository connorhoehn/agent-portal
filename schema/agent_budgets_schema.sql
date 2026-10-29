-- Initiative budgets — the program-manager's allocation ledger.
--
-- One row per initiative: how much agent spend this initiative is allowed per
-- period. Spend itself is never stored here — it is derived at read time from
-- bot_runs.cost_usd using the same three-way attribution the Projects rollup
-- uses (a run belongs to an initiative via its work item, a bot targeting the
-- initiative, or a bot targeting a codebase that delivers it), so allocation
-- and actuals can never drift apart in storage.
--
-- Loads after agent_bots_schema.sql: spend reads join bot_runs, and the FK
-- references projects (orgiq_schema.sql). The allocation cascades with its
-- initiative — a deleted initiative has nothing left to budget.

CREATE TABLE IF NOT EXISTS initiative_budgets (
  org_project_id  TEXT PRIMARY KEY REFERENCES projects (id) ON DELETE CASCADE,

  allocated_usd   NUMERIC     NOT NULL CHECK (allocated_usd >= 0),
  -- v1 shipped monthly only; budget_periods_schema.sql (DE-38) replaces this
  -- CHECK by name to allow quarterly, sprint and rolling.
  period          TEXT        NOT NULL DEFAULT 'monthly' CHECK (period IN ('monthly')),

  updated_by      TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

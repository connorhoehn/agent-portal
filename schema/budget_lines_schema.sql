-- The learning loop's budget pieces (docs/learning-loop-design.md "Budgets").
--
-- Loads after spend_ledger_schema.sql (spend_entries) and run_controls_schema.sql.
-- Additive and idempotent: every statement is CREATE/ADD ... IF NOT EXISTS.

-- ── Threshold marks ─────────────────────────────────────────────────────────
-- One row per (budget, threshold, period) announced (lib/budget-thresholds.ts).
-- The primary key IS the idempotency: the INSERT ... ON CONFLICT DO NOTHING that
-- returns a row announces; every other replica, retry or restart finds the row
-- and stays quiet. subject_id is projects.id, app_users.id or budget_grants.id.
CREATE TABLE IF NOT EXISTS budget_threshold_marks (
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('initiative', 'user', 'grant')),
  subject_id   TEXT NOT NULL,
  threshold    INTEGER NOT NULL CHECK (threshold > 0),
  period_key   TEXT NOT NULL,          -- 'YYYY-MM' | 'YYYY-Qn' | a sprint id
  crossed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (subject_kind, subject_id, threshold, period_key)
);

-- ── The learning line ───────────────────────────────────────────────────────
-- The organisation's monthly cap for server-side distillation, once an org
-- leader sets one (PUT /api/budgets/learning). No row: LEARNING_BUDGET_USD.
CREATE TABLE IF NOT EXISTS learning_budget (
  id               TEXT PRIMARY KEY CHECK (id = 'org'),
  monthly_cap_usd  NUMERIC(10,4) NOT NULL CHECK (monthly_cap_usd >= 0),
  updated_by       TEXT,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Local compute: reported, not billed ─────────────────────────────────────
-- What a local worker said its run cost, beside the $0 recorded in cost_usd
-- (lib/run-cost.ts). Nothing sums it as spend; the Budgets page shows it.
ALTER TABLE spend_entries ADD COLUMN IF NOT EXISTS reported_usd NUMERIC(10,4);

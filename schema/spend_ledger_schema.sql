-- One spend ledger for every run path (docs/deployment-enhancements/DE-30-spend-ledger.md).
--
-- Budget spend used to be derived only from bot_runs.cost_usd, so ad-hoc box
-- tasks (POST /api/devbox/:sid/task), platform-api's agent loop
-- (POST /internal/devbox/:sid/task) and queued work jobs spent real Bedrock
-- money that no budget saw. Every path now appends one row per finished task
-- attempt here, and the budget readers move onto it behind SPEND_LEDGER.
--
-- The unit is one task attempt, never a box: a bot run executes on a box too,
-- so box totals would count the same dollar twice. An unknown cost is NULL
-- with cost_basis 'unknown', never 0.
--
-- Loads after program_schema.sql (FK on budget_grants) and orgiq_schema.sql
-- (FK on projects). Additive; nothing reads it until SPEND_LEDGER is set.

CREATE TABLE IF NOT EXISTS spend_entries (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source         TEXT NOT NULL CHECK (source IN ('bot_run', 'job', 'box_task', 'agent_loop')),
  -- bot_runs.id | agent_jobs.id:<attempt> | <boxId>:<task id>
  source_id      TEXT NOT NULL,
  -- Null = unattributed: spent, but on no initiative.
  initiative_id  TEXT REFERENCES projects (id) ON DELETE SET NULL,
  grant_id       TEXT REFERENCES budget_grants (id) ON DELETE SET NULL,
  box_id         TEXT,
  -- Who caused the spend: the session subject, or principal.requestedBy.
  actor_id       TEXT,
  -- Bot runs only: how the run was triggered (cron = the maintenance floor).
  trigger        TEXT,
  model          TEXT,
  cost_usd       NUMERIC(10,4),
  cost_basis     TEXT NOT NULL CHECK (cost_basis IN ('reported', 'estimated', 'unknown')),
  input_tokens   BIGINT,
  output_tokens  BIGINT,
  occurred_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- A retried write is a no-op, not a second charge.
  UNIQUE (source, source_id),
  CHECK ((cost_usd IS NULL) = (cost_basis = 'unknown'))
);

CREATE INDEX IF NOT EXISTS spend_entries_initiative_idx ON spend_entries (initiative_id, occurred_at);
CREATE INDEX IF NOT EXISTS spend_entries_grant_idx ON spend_entries (grant_id, occurred_at);
CREATE INDEX IF NOT EXISTS spend_entries_actor_idx ON spend_entries (actor_id, occurred_at);

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
  source         TEXT NOT NULL,
  -- bot_runs.id | agent_jobs.id:<attempt> | <boxId>:<task id> | agent_project_runs.id
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

-- DE-32: the price table's figure beside the recorded one, so a gap between
-- Claude Code's own price list ('reported') and the configured Bedrock rate
-- can be selected. Null when the table could not price the run. Additive.
ALTER TABLE spend_entries ADD COLUMN IF NOT EXISTS estimated_cost_usd NUMERIC(10,4);

-- Project runs can settle before a bot polls their result. Keep provenance
-- durably on the run so that poll and ledger backfills retain the estimate.
-- NULL identifies legacy rows, whose non-null figures were executor-reported.
ALTER TABLE agent_project_runs ADD COLUMN IF NOT EXISTS cost_basis TEXT
  CHECK (cost_basis IN ('reported', 'estimated', 'unknown'));
ALTER TABLE agent_project_runs ADD COLUMN IF NOT EXISTS estimated_cost_usd NUMERIC(10,4);

-- The source list as a named constraint, so adding a path is a re-apply of
-- this file rather than a hand migration (agent_project_run: direct
-- POST /api/agent-projects/:id/runs, which writes no bot_runs row;
-- agent_invoke: a chat invoke or a /summarize run, work item 16; microvm: one
-- microVM runner attempt, docs/microvm-runner-design.md §6; voice_session: one
-- voice navigator session, docs/voice-navigator-spec.md §7; meeting_assistant: one
-- call's Nova listening, docs/meeting-assistant-design.md decision 10; learning: one
-- server-side distillation of a finished run, docs/learning-loop-design.md).
ALTER TABLE spend_entries DROP CONSTRAINT IF EXISTS spend_entries_source_check;
ALTER TABLE spend_entries ADD CONSTRAINT spend_entries_source_check
  CHECK (source IN ('bot_run', 'job', 'box_task', 'agent_loop', 'agent_project_run', 'bff_call', 'agent_invoke', 'microvm', 'voice_session', 'meeting_assistant', 'learning'));

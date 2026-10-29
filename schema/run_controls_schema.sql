-- Run controls: the mid-run cutoff's record, run limits and kill switches
-- (docs/deployment-enhancements/DE-35-mid-run-cutoff.md, DE-37-run-limits.md,
-- DE-50-kill-switches-and-alerts.md).
--
-- Loads after agent_projects_schema.sql (agent_project_runs),
-- agentic_work_schema.sql (agent_jobs), agent_budgets_schema.sql
-- (initiative_budgets) and spend_holds_schema.sql (run_slots names a hold).
-- Additive and idempotent: every statement is CREATE/ADD ... IF NOT EXISTS, and
-- the backfill only fills NULLs.

-- ── DE-35: why a governed run's spend ceiling stopped it ────────────────────
-- {reason: 'budget', ceilingUsd, meteredUsd, holdIds, at}. NULL = not cut.
-- The reconcile copies it onto bot_runs.outcome.cutoff and comments on the
-- work item. Jobs carry the same block in agent_jobs.result->'cutoff'.
ALTER TABLE agent_project_runs ADD COLUMN IF NOT EXISTS cutoff JSONB;

-- ── DE-37: run limits per scope ─────────────────────────────────────────────
-- Absent row = no limit beyond the global bot-run ceiling (BOT_MAX_CONCURRENT).
-- max_concurrent 0 = paused for new runs at that scope.
CREATE TABLE IF NOT EXISTS run_limits (
  scope_kind       TEXT NOT NULL CHECK (scope_kind IN ('global', 'tenant', 'initiative')),
  scope_id         TEXT NOT NULL,          -- '*' | tenant id | projects.id
  max_concurrent   INTEGER CHECK (max_concurrent >= 0),
  max_runs_per_day INTEGER CHECK (max_runs_per_day >= 0),
  max_usd_per_hour NUMERIC CHECK (max_usd_per_hour >= 0),
  updated_by       TEXT,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (scope_kind, scope_id)
);

-- A concurrency slot is a lease, not a count. The holder is the run's spend
-- hold id (lib/spend-holds.ts reserveSpend writes both in one transaction), so
-- a slot is free again when the run releases it, when its hold closes, or when
-- it expires — whichever comes first. The primary key is what refuses a second
-- writer of the same slot number.
CREATE TABLE IF NOT EXISTS run_slots (
  scope_key   TEXT NOT NULL,               -- 'global:*' | 'tenant:orgiq' | 'initiative:p-…'
  slot_no     INTEGER NOT NULL,
  holder      TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (scope_key, slot_no)
);
CREATE INDEX IF NOT EXISTS run_slots_holder_idx ON run_slots (holder);

-- The job queue's initiative, as a column the claim can filter cheaply, so a
-- saturated initiative cannot hold the queue head. Stamped at enqueue from the
-- payload; backfilled here.
ALTER TABLE agent_jobs ADD COLUMN IF NOT EXISTS initiative_id TEXT;
UPDATE agent_jobs SET initiative_id = payload->>'initiativeId'
 WHERE initiative_id IS NULL AND payload->>'initiativeId' IS NOT NULL AND payload->>'initiativeId' <> '';
CREATE INDEX IF NOT EXISTS agent_jobs_initiative_queued_idx ON agent_jobs (initiative_id) WHERE status = 'queued';

-- ── DE-50: kill switches ────────────────────────────────────────────────────
-- scope 'fleet' or 'initiative:<projects.id>'. A paused scope refuses every new
-- spend at lib/spend-holds.ts reserveSpend (423), and the job dispatcher claims
-- nothing for it. Rows are kept when lifted (paused = false) as the last flip.
CREATE TABLE IF NOT EXISTS fleet_switches (
  scope   TEXT PRIMARY KEY CHECK (scope = 'fleet' OR scope LIKE 'initiative:%'),
  paused  BOOLEAN NOT NULL DEFAULT false,
  reason  TEXT,
  set_by  TEXT,
  set_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The budget-threshold sweep's memory: the highest threshold (50/80/100)
-- already announced for the period named, so each crossing is said once.
ALTER TABLE initiative_budgets ADD COLUMN IF NOT EXISTS last_threshold_notified INTEGER;
ALTER TABLE initiative_budgets ADD COLUMN IF NOT EXISTS last_threshold_period TEXT;

-- Every flip of a switch, append-only: who paused or resumed what, when, why.
CREATE TABLE IF NOT EXISTS fleet_switch_log (
  id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope   TEXT NOT NULL,
  paused  BOOLEAN NOT NULL,
  reason  TEXT,
  set_by  TEXT,
  set_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS fleet_switch_log_scope_idx ON fleet_switch_log (scope, set_at DESC);

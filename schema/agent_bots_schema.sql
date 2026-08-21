-- Bots — durable, mission-configured agents, and every time one fired.
--
-- A bot is the front half of the agentic loop the SDLC tables already govern:
-- what to work on, when, and under which guardrails. The back half is
-- unchanged — every repo-target run a bot dispatches flows through
-- dispatchGovernedRun (capture → review → gates → human decision → PR), so a
-- bot never gives an agent more authority than a hand-driven run has.
--
-- Loads after agentic_work_schema.sql (bot_runs references agent_jobs),
-- agent_projects_schema.sql (bots references agent_projects,
-- agent_project_runs) and orgiq_schema.sql (bots references projects).

CREATE TABLE IF NOT EXISTS bots (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  name                TEXT        NOT NULL,
  -- The whole catalog, deliberately: the template shapes the outcome contract,
  -- the written mission (prompt_template) says what to do.
  template            TEXT        NOT NULL CHECK (template IN ('epic','story','bug')),
  prompt_template     TEXT        NOT NULL,

  -- The target: a linked codebase, an initiative, or neither. A repo target
  -- dispatches governed runs; an initiative target enqueues queue jobs. The
  -- repo FK cascades (a bot on an unlinked repo has nothing left to do); the
  -- initiative FK detaches, because the bot's mission may outlive the row.
  agent_project_id    UUID REFERENCES agent_projects (id) ON DELETE CASCADE,
  org_project_id      TEXT REFERENCES projects (id) ON DELETE SET NULL,

  model               TEXT        NOT NULL,
  trigger             TEXT        NOT NULL CHECK (trigger IN ('manual','cron','pr_watch')),
  cron_expr           TEXT,       -- validated by validateCronExpr before it is stored
  enabled             BOOLEAN     NOT NULL DEFAULT TRUE,

  -- Guardrails. Per-run is a soft cap — a fresh estimate's p75 over it makes
  -- the run route demand an explicit confirmOverBudget (409 otherwise), and
  -- reconciliation flags the finished run's outcome with overRunBudget when
  -- the actual cost exceeded it. Per-day is a hard cap —
  -- the bot pauses itself via paused_reason when today's summed bot_runs cost
  -- reaches it. max_runs_per_day backstops runaway triggers independently of
  -- cost, so a mispriced model cannot defeat the brake.
  budget_per_run_usd  NUMERIC,
  budget_per_day_usd  NUMERIC,
  max_runs_per_day    INTEGER     NOT NULL DEFAULT 4,
  requires_review     BOOLEAN     NOT NULL DEFAULT TRUE,

  -- Last PR number seen, for pr_watch bots (the poller is a later phase; the
  -- column exists now so stored bots survive that phase landing).
  pr_watermark        TEXT,

  created_by          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_run_at         TIMESTAMPTZ,
  paused_reason       TEXT        -- 'daily budget reached', 'paused by operator'
);

-- One row per firing, whichever trigger caused it. The run/job it dispatched
-- is linked, not embedded — reconciliation reads the linked row's terminal
-- status and cost back onto this one, so the bot page can answer "what did
-- this cost today" without joining the whole pipeline.
CREATE TABLE IF NOT EXISTS bot_runs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Nullable on purpose: a marketplace run (trigger = 'marketplace') is a
  -- firing with no bot behind it — the work item is the mission.
  bot_id        UUID        REFERENCES bots (id) ON DELETE CASCADE,
  trigger       TEXT        NOT NULL,               -- manual | cron | pr_watch | marketplace

  -- Exactly one of these is set for a dispatched run: a governed run against a
  -- repo target, or a queue job for an initiative target. Both null for a run
  -- that never dispatched (skipped, or failed before dispatch).
  run_id        UUID REFERENCES agent_project_runs (id) ON DELETE SET NULL,
  job_id        TEXT REFERENCES agent_jobs (id) ON DELETE SET NULL,
  work_item_id  TEXT,

  status        TEXT        NOT NULL DEFAULT 'running'
                CHECK (status IN ('running','done','failed','skipped')),
  cost_usd      NUMERIC,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at   TIMESTAMPTZ,
  outcome       JSONB       NOT NULL DEFAULT '{}'   -- {changeId, prUrl, filesChanged, reason, ...}
);

CREATE INDEX IF NOT EXISTS idx_bot_runs_bot ON bot_runs (bot_id, started_at DESC);
-- Marketplace lookups go work_item → runs, with no bot to key on.
CREATE INDEX IF NOT EXISTS idx_bot_runs_work_item ON bot_runs (work_item_id, started_at DESC);

-- Migration for databases that created bot_runs when bot_id was NOT NULL.
-- Idempotent: DROP NOT NULL on an already-nullable column is a no-op.
ALTER TABLE bot_runs ALTER COLUMN bot_id DROP NOT NULL;

-- Close the work-item linkage gap (Phase 2 reads these; adding them now means
-- every run recorded from here on can be attributed). Idempotent — these
-- tables predate this file, so CREATE TABLE IF NOT EXISTS cannot add them.
ALTER TABLE agent_project_runs    ADD COLUMN IF NOT EXISTS work_item_id TEXT;
ALTER TABLE agent_change_requests ADD COLUMN IF NOT EXISTS work_item_id TEXT;
ALTER TABLE agent_jobs            ADD COLUMN IF NOT EXISTS bot_id UUID;

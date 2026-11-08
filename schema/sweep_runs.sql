-- One row per org-sweep run (docs/voice-navigator-spec.md §4 `bot_sweep_status`, package P5).
--
-- `agent_findings` keeps what a sweep found; this keeps that the sweep RAN, so
-- "has a sweep failed since yesterday" is answerable. Written by
-- providers/org-sweeps.ts runSweep: 'running' at start, 'ok' or 'failed' at the
-- end. `error` is the exception's message only, never a stack or content.
-- `bot_id` is NULL for the scheduled org sweeps; it is there for a sweep a bot
-- drives. No FK into any other table, so it can load anywhere.
--
-- Additive and idempotent. The tenant column makes this a tenant table:
-- schema/row_level_security.sql lists it.

CREATE TABLE IF NOT EXISTS sweep_runs (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant       TEXT        NOT NULL,
  sweep        TEXT        NOT NULL,
  bot_id       TEXT,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at  TIMESTAMPTZ,
  status       TEXT        NOT NULL DEFAULT 'running'
               CHECK (status IN ('running', 'ok', 'failed', 'cancelled')),
  error        TEXT,
  findings     INTEGER     CHECK (findings IS NULL OR findings >= 0),
  duration_ms  INTEGER     CHECK (duration_ms IS NULL OR duration_ms >= 0)
);

CREATE INDEX IF NOT EXISTS sweep_runs_tenant_started_idx ON sweep_runs (tenant, started_at DESC);
CREATE INDEX IF NOT EXISTS sweep_runs_failed_idx ON sweep_runs (tenant, started_at DESC) WHERE status = 'failed';

-- Durable, tenant-agnostic agentic flow runs (docs/agentic-flows-migration.md,
-- slice 4a). Additive. One row per run of a flow `kind` (e.g.
-- 'social.summarize'); middleware/src/lib/flow-runs/ owns every statement.
--   * requested_by is the only principal that may read a run (the provider
--     filters on it; another user's id answers like an unknown one).
--   * lease_owner / lease_expires_at: a dispatcher claims a queued run with one
--     UPDATE ... FOR UPDATE SKIP LOCKED, so exactly one node executes it. A
--     running run whose lease lapsed is re-queued (attempts < max_attempts) or
--     failed visibly. Every progress/finish write is fenced on lease_owner.
--   * input may hold private source text; it is cleared when a run finishes
--     and rows are pruned after a retention window.
-- Not applied to Aurora yet; tests assert the SQL shape and run the same
-- contract against the registered mock fixture.
CREATE TABLE IF NOT EXISTS flow_runs (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  kind TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'waiting-approval', 'completed', 'failed')),
  progress JSONB NOT NULL DEFAULT '[]'::jsonb,
  input JSONB,
  result JSONB,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 1,
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS flow_runs_claim_idx ON flow_runs(status, kind, created_at);
CREATE INDEX IF NOT EXISTS flow_runs_requester_idx ON flow_runs(tenant, requested_by, kind, created_at DESC);

-- 'waiting-approval' (docs/agentic-flows-migration.md slice 10, approval step): an /agent loop paused at a
-- human-approval step. No lease is held; input keeps the requester's identity. For a cluster created before
-- the status existed (additive, safe to re-run):
ALTER TABLE flow_runs DROP CONSTRAINT IF EXISTS flow_runs_status_check;
ALTER TABLE flow_runs ADD CONSTRAINT flow_runs_status_check
  CHECK (status IN ('queued', 'running', 'waiting-approval', 'completed', 'failed'));

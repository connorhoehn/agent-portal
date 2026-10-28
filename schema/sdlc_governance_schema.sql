-- SDLC governance: separation of duties (DE-43) and versioned, per-initiative
-- policy sets (DE-46). Additive and idempotent. Loads AFTER
-- agent_projects_schema.sql and agent_sdlc_schema.sql (it alters their
-- tables). The middleware bootstraps ('org', 1) from sdlc_policies on first
-- use (providers/sdlc-policy-sets.ts ensureOrgPolicySet), so the order is:
-- apply this file, deploy the BFF.

-- Who caused each change (DE-43). A run records its dispatcher; a change
-- records who it answers to (the dispatcher, else a cron bot's author).
ALTER TABLE agent_project_runs    ADD COLUMN IF NOT EXISTS dispatched_by TEXT;
ALTER TABLE agent_change_requests ADD COLUMN IF NOT EXISTS requested_by  TEXT;

-- The policy set version a change is judged under (DE-46 pin), and which
-- evaluation its current gates belong to.
ALTER TABLE agent_change_requests ADD COLUMN IF NOT EXISTS policy_scope   TEXT;
ALTER TABLE agent_change_requests ADD COLUMN IF NOT EXISTS policy_version INTEGER;
ALTER TABLE agent_change_requests ADD COLUMN IF NOT EXISTS evaluation_seq INTEGER NOT NULL DEFAULT 1;
-- Existing changes were evaluated once (their gates take the gates column's
-- default, 1); a change inserted from now on has not been evaluated yet.
ALTER TABLE agent_change_requests ALTER COLUMN evaluation_seq SET DEFAULT 0;

-- Gates are appended per evaluation instead of replaced, so a re-review keeps
-- the earlier judgment and the rule version that made it.
ALTER TABLE agent_change_gates ADD COLUMN IF NOT EXISTS policy_scope   TEXT;
ALTER TABLE agent_change_gates ADD COLUMN IF NOT EXISTS policy_version INTEGER;
ALTER TABLE agent_change_gates ADD COLUMN IF NOT EXISTS evaluation_seq INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_agent_change_gates_eval
  ON agent_change_gates (change_request_id, evaluation_seq, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_change_requests_requested_by
  ON agent_change_requests (requested_by);

-- Versioned policy sets, append-only. A version is the whole set; the audit
-- trail is a diff of two snapshots and a revert is a new version.
CREATE TABLE IF NOT EXISTS sdlc_policy_versions (
  scope        TEXT        NOT NULL,          -- 'org' | initiative id (projects.id)
  version      INTEGER     NOT NULL CHECK (version >= 1),
  policies     JSONB       NOT NULL,          -- [{id (stable key), name, enabled, kind, config, action}]
  based_on     INTEGER,                       -- the version this edit started from
  changed_by   TEXT        NOT NULL,          -- session sub, or 'migration'
  reason       TEXT        NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (scope, version)
);

-- Loosening edits waiting for a second person (DE-43 §4). Approval writes the
-- next version from base_version; a set that moved on supersedes it.
CREATE TABLE IF NOT EXISTS sdlc_policy_proposals (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  scope            TEXT        NOT NULL,
  base_version     INTEGER     NOT NULL,
  policies         JSONB       NOT NULL,
  loosening        JSONB       NOT NULL DEFAULT '[]',
  proposed_by      TEXT        NOT NULL,
  reason           TEXT        NOT NULL,
  status           TEXT        NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','approved','rejected','superseded')),
  decided_by       TEXT,
  decided_at       TIMESTAMPTZ,
  decision_note    TEXT,
  applied_version  INTEGER,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sdlc_policy_proposals_scope_status
  ON sdlc_policy_proposals (scope, status, created_at DESC);

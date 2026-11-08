-- Credential issues (DE-45): one row per repository token the BFF minted for
-- a run — which run, which repo, which permissions, until when, for whom.
-- NEVER the token. The question this answers is "which runs could push to
-- repo X yesterday", which a vault alone cannot.
--
-- Additive, standalone (no FKs: `run_ref` is a free-form reference such as
-- `run:<uuid>`, `bot-run:<id>` or `clone:<session>`, and the repo is a plain
-- owner/name). Loads anywhere.

CREATE TABLE IF NOT EXISTS credential_issues (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  run_ref       TEXT        NOT NULL,
  repo          TEXT        NOT NULL,                 -- owner/name
  -- The provider that minted it: 'github-app' (per-run installation token),
  -- 'pat' (a stored connection credential, legacy) or 'local' (dev:mock).
  provider      TEXT        NOT NULL CHECK (provider IN ('github-app', 'pat', 'local')),
  permissions   JSONB       NOT NULL,                 -- {"contents":"read"} / {"contents":"write","pull_requests":"write"}
  expires_at    TIMESTAMPTZ,                          -- null for a PAT, which does not expire per run
  caller_sub    TEXT,                                 -- who caused the run; null for a cron bot
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_credential_issues_repo_time ON credential_issues (repo, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_credential_issues_run ON credential_issues (run_ref);

-- The microVM runner (docs/microvm-runner-design.md §13): every credential a
-- run is handed, not only repository tokens. `kind` says which —
--   repo-install  a GitHub App installation token (read for boot, write for push)
--   repo-user     the actor's own GitHub user token, read for the PR step (BFF only)
--   run-token     the lab run token (x-lab-run-token) the box's broker holds
--   presign       a presigned S3 URL for the run's transcript (PUT, or GET to resume)
-- — and `session_id` which runtime session it went to. Null on rows from
-- before the runner, and on fleet mints. The provider list widens for the
-- three non-App kinds.
ALTER TABLE credential_issues ADD COLUMN IF NOT EXISTS session_id TEXT;
ALTER TABLE credential_issues ADD COLUMN IF NOT EXISTS kind TEXT;
ALTER TABLE credential_issues DROP CONSTRAINT IF EXISTS credential_issues_kind_check;
ALTER TABLE credential_issues ADD CONSTRAINT credential_issues_kind_check
  CHECK (kind IS NULL OR kind IN ('repo-install', 'repo-user', 'run-token', 'presign'));
ALTER TABLE credential_issues DROP CONSTRAINT IF EXISTS credential_issues_provider_check;
ALTER TABLE credential_issues ADD CONSTRAINT credential_issues_provider_check
  CHECK (provider IN ('github-app', 'pat', 'local', 'github-user', 'lab', 's3'));
CREATE INDEX IF NOT EXISTS idx_credential_issues_session ON credential_issues (session_id) WHERE session_id IS NOT NULL;

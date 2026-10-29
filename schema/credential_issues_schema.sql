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

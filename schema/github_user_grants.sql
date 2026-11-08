-- GitHub identities people granted OrgIQ (docs/microvm-runner-design.md §8, §10 item 5, §13).
--
-- A microVM run's pull request is opened as the person who queued it, with
-- their own GitHub user-to-server token, so the PR author is the person, not a
-- shared connection. This row says the grant exists and where the token is;
-- the token itself is ONLY in Secrets Manager (`orgiq/github-user/<sub>`,
-- `secret_arn`), read by the BFF at the PR step and never sent to a microVM.
-- A job whose actor has no live row (revoked_at IS NULL) is held back with
-- reason `no-github-identity` rather than half-delivered.
--
-- Written by the GitHub OAuth link flow (a later lane; nothing in this
-- repository inserts yet). Standalone: `user_sub` is an app_users id, kept
-- without an FK so a grant can be recorded for an IdP subject before the
-- directory row is reconciled. The tenant column makes this a tenant table:
-- schema/row_level_security.sql lists it.

CREATE TABLE IF NOT EXISTS github_user_grants (
  user_sub        TEXT        PRIMARY KEY,
  tenant          TEXT        NOT NULL,
  github_login    TEXT        NOT NULL,
  github_user_id  BIGINT      NOT NULL,
  -- `<id>+<login>@users.noreply.github.com`: the commit author email, so a
  -- person's real address never lands in a repository's history.
  noreply_email   TEXT        NOT NULL,
  secret_arn      TEXT        NOT NULL,
  scopes          TEXT[],
  granted_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  refreshed_at    TIMESTAMPTZ,
  revoked_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS github_user_grants_live_idx ON github_user_grants (user_sub) WHERE revoked_at IS NULL;

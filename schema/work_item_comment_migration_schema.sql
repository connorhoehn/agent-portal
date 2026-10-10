-- One store for a work item's conversation (docs/audit/2026-10-07-audit-plan.md D2).
--
-- A work item's discussion is the gateway chat thread `orgiq:work:<id>`. The
-- human rows of work_item_comments are that thread's history, projected into
-- the chat store once by middleware/src/lib/migrate-work-comments.ts; after it
-- runs, the table is read-only audit history for human rows (status changes and
-- run settlements, is_system = TRUE, are still written here by the PATCH route
-- and lib/bot-runner.ts).
--
-- This ledger is the migration's idempotency key and its race guard:
--   * comment_id is the PRIMARY KEY, so two migrators racing over the same rows
--     claim each comment exactly once (INSERT ... ON CONFLICT DO UPDATE ... WHERE
--     the earlier claim is stale and unwritten — a fresh claim is never stolen);
--   * written_at is set only after the chat store accepted the message, so a
--     migrator that died between claim and write leaves a stale claim that the
--     next run takes over (the message id is derived from comment_id, so a
--     retried write lands on the same key and cannot duplicate).
--
-- Additive and idempotent: CREATE ... IF NOT EXISTS only.

CREATE TABLE IF NOT EXISTS work_item_comment_migrations (
  comment_id   TEXT PRIMARY KEY REFERENCES work_item_comments(id) ON DELETE CASCADE,
  work_item_id TEXT NOT NULL,
  channel      TEXT,
  message_id   TEXT,
  migrator     TEXT NOT NULL,
  claimed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  written_at   TIMESTAMPTZ
);

COMMENT ON TABLE work_item_comment_migrations IS
  'Ledger of work_item_comments rows projected into the gateway chat thread '
  'orgiq:work:<work_item_id> (middleware/src/lib/migrate-work-comments.ts). '
  'written_at NULL = claimed, not yet confirmed written.';

CREATE INDEX IF NOT EXISTS wicm_unwritten_idx
  ON work_item_comment_migrations (claimed_at) WHERE written_at IS NULL;

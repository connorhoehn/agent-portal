-- schema_migrations — the migration ledger (DE-20,
-- docs/deployment-enhancements/DE-20-schema-migrations.md).
--
-- One row per schema/manifest.json entry that `python -m schema.migrate` has
-- planned or applied. It records what ran, from which file version
-- (checksum), when, and by whom (the caller's `sts get-caller-identity` ARN,
-- never a flag). A `data` entry also carries its dry-run report and that
-- report's sha, which `approve` must quote back.
--
-- Additive and idempotent: first in the manifest, re-run by every apply.
-- Not the page-thread job's per-row claim ledger
-- (work_item_comment_migrations); this one tracks whole migrations.

CREATE TABLE IF NOT EXISTS schema_migrations (
  id             TEXT PRIMARY KEY,
  kind           TEXT NOT NULL CHECK (kind IN ('repeatable', 'versioned', 'data', 'seed')),
  checksum       TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('planned', 'approved', 'applied', 'failed')),
  dry_run_report JSONB,
  dry_run_sha    TEXT,
  planned_by     TEXT,
  planned_at     TIMESTAMPTZ,
  approved_by    TEXT,
  approved_at    TIMESTAMPTZ,
  applied_by     TEXT,
  applied_at     TIMESTAMPTZ,
  duration_ms    BIGINT,
  last_error     TEXT,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS schema_migrations_status_idx ON schema_migrations (status);

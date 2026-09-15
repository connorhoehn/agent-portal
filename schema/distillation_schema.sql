-- ---------------------------------------------------------------------------
-- Distillation — L1 clusters and L2 artifacts distilled from lab_experiences
-- (L0). Additive: no ALTER of lab_experiences itself, and every FK from here
-- points AT it, never the reverse.
--
-- The middleware runs entirely off middleware/src/mock/distillation.ts today
-- (see providers/distillation.ts's Aurora-path note) — these tables exist so
-- the schema is ready when that mock path is replaced, and so the shape in
-- docs/distillation-goal.md has one canonical DDL definition rather than
-- living only in a TypeScript interface.
--
-- Loads after lab_loop_schema.sql (distillation_cluster_members FKs
-- lab_experiences) and after agent_bots_schema.sql / program_schema.sql in
-- load_schema.py's ordering, though it has no FK into either — placed here
-- purely to keep every "fleet memory" table grouped together.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS distillation_clusters (
  id                      TEXT PRIMARY KEY DEFAULT ('cl-' || gen_random_uuid()::TEXT),
  title                   TEXT NOT NULL,
  summary                 TEXT NOT NULL DEFAULT '',
  kind                    TEXT NOT NULL DEFAULT 'gotcha'
                          CHECK (kind IN ('worked','failed','gotcha','decision','convention')),
  repo                    TEXT,
  initiative_id           TEXT,
  tags                    TEXT[] NOT NULL DEFAULT '{}',
  confidence              REAL NOT NULL DEFAULT 0
                          CHECK (confidence >= 0 AND confidence <= 1),
  -- The compaction job (an in-app id, not a DB row here — the job ledger
  -- lives in the mock/eventual providers/distillation.ts store) that merged
  -- this cluster's members. Free-text: same "sessions are wiped, memory
  -- isn't" reasoning lab_experiences already applies to session_id/box_id.
  created_by_compaction_id TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS distillation_clusters_repo_idx ON distillation_clusters (repo, created_at DESC);
CREATE INDEX IF NOT EXISTS distillation_clusters_init_idx ON distillation_clusters (initiative_id, created_at DESC);

-- Many-to-many: which L0 observations were merged into a cluster. FKs the
-- REAL lab_experiences table — this is the one link in this file that
-- points at existing fleet memory rather than at another new table.
CREATE TABLE IF NOT EXISTS distillation_cluster_members (
  cluster_id      TEXT NOT NULL REFERENCES distillation_clusters (id) ON DELETE CASCADE,
  observation_id  TEXT NOT NULL REFERENCES lab_experiences (id) ON DELETE CASCADE,
  PRIMARY KEY (cluster_id, observation_id)
);

CREATE INDEX IF NOT EXISTS distillation_cluster_members_obs_idx ON distillation_cluster_members (observation_id);

CREATE TABLE IF NOT EXISTS distillation_artifacts (
  id                      TEXT PRIMARY KEY DEFAULT ('art-' || gen_random_uuid()::TEXT),
  type                    TEXT NOT NULL
                          CHECK (type IN ('runbook','insight','convention','decision','procedure')),
  title                   TEXT NOT NULL,
  summary                 TEXT NOT NULL DEFAULT '',
  body_markdown           TEXT NOT NULL DEFAULT '',
  -- The Library asset (observability.prompt_version_meta / Bedrock Prompt
  -- Management) this artifact was published as, if any — free-text, not an
  -- FK: the Library's catalog of record lives partly in Bedrock, which this
  -- schema cannot reference.
  library_item_id         TEXT,
  status                  TEXT NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft','published','retired')),
  reviewed_by             TEXT,
  reviewed_at             TIMESTAMPTZ,
  created_by_compaction_id TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS distillation_artifacts_status_idx ON distillation_artifacts (status, updated_at DESC);
CREATE INDEX IF NOT EXISTS distillation_artifacts_library_idx ON distillation_artifacts (library_item_id) WHERE library_item_id IS NOT NULL;

-- Many-to-many: which clusters were distilled into an artifact.
CREATE TABLE IF NOT EXISTS distillation_artifact_clusters (
  artifact_id  TEXT NOT NULL REFERENCES distillation_artifacts (id) ON DELETE CASCADE,
  cluster_id   TEXT NOT NULL REFERENCES distillation_clusters (id) ON DELETE CASCADE,
  PRIMARY KEY (artifact_id, cluster_id)
);

CREATE INDEX IF NOT EXISTS distillation_artifact_clusters_cluster_idx ON distillation_artifact_clusters (cluster_id);

CREATE TABLE IF NOT EXISTS distillation_facts (
  id                        TEXT PRIMARY KEY DEFAULT ('fact-' || gen_random_uuid()::TEXT),
  artifact_id               TEXT NOT NULL REFERENCES distillation_artifacts (id) ON DELETE CASCADE,
  statement                 TEXT NOT NULL,
  subject                   TEXT NOT NULL DEFAULT '',
  predicate                 TEXT NOT NULL DEFAULT '',
  object                    TEXT NOT NULL DEFAULT '',
  -- Evidence: the L0 observations that support this fact. Kept as an array
  -- column (mirrors lab_experiences.tags's own array-column precedent)
  -- rather than a join table, since a fact's evidence list is read as a
  -- whole and never queried the other direction ("which facts cite
  -- observation X" is a rare enough path to do with `= ANY`).
  evidence_observation_ids  TEXT[] NOT NULL DEFAULT '{}',
  confidence                REAL NOT NULL DEFAULT 0
                            CHECK (confidence >= 0 AND confidence <= 1),
  -- 1-based position when this fact is a STEP of a `procedure` artifact;
  -- NULL for a plain claim. A procedure's steps are its ordered facts, not a
  -- list beside them, so a step has one row and one evidence trail.
  ordinal                   SMALLINT CHECK (ordinal IS NULL OR ordinal >= 1)
);

CREATE INDEX IF NOT EXISTS distillation_facts_artifact_idx ON distillation_facts (artifact_id);

-- Additive migration for a cluster that built distillation_facts before
-- `ordinal` existed, and the CHECK swap that admits `procedure` on a cluster
-- whose distillation_artifacts predates it. Same idempotent DROP/ADD pair
-- orgiq_work_items_schema.sql uses for work_items_type_check.
ALTER TABLE distillation_facts ADD COLUMN IF NOT EXISTS ordinal SMALLINT CHECK (ordinal IS NULL OR ordinal >= 1);
ALTER TABLE distillation_artifacts DROP CONSTRAINT IF EXISTS distillation_artifacts_type_check;
ALTER TABLE distillation_artifacts ADD CONSTRAINT distillation_artifacts_type_check
  CHECK (type IN ('runbook','insight','convention','decision','procedure'));

-- Two steps of one procedure cannot share a position; plain claims (NULL)
-- are unconstrained, which is what the partial index says.
CREATE UNIQUE INDEX IF NOT EXISTS distillation_facts_step_idx
  ON distillation_facts (artifact_id, ordinal) WHERE ordinal IS NOT NULL;

CREATE TABLE IF NOT EXISTS distillation_review_samples (
  id            TEXT PRIMARY KEY DEFAULT ('rev-' || gen_random_uuid()::TEXT),
  target_kind   TEXT NOT NULL CHECK (target_kind IN ('cluster','artifact')),
  -- Free-text, not an FK: target_kind decides which table target_id names,
  -- and a sampled row must survive even if the underlying cluster/artifact
  -- is later deleted (the review history is the audit trail).
  target_id     TEXT NOT NULL,
  sampled_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewer      TEXT,
  verdict       TEXT NOT NULL DEFAULT 'pending'
                CHECK (verdict IN ('pending','agree','disagree')),
  note          TEXT
);

CREATE INDEX IF NOT EXISTS distillation_review_samples_verdict_idx
  ON distillation_review_samples (verdict, sampled_at DESC);

-- One row per session that ran a procedure. Nothing aggregated lives here:
-- a procedure's run count, its success share, when it was last proven and
-- whether it has drifted since are all counted from these rows at read time
-- (providers/distillation.ts procedureHealth), so there is no `runs` or
-- `health` column to disagree with them.
CREATE TABLE IF NOT EXISTS distillation_procedure_applications (
  id                 TEXT PRIMARY KEY DEFAULT ('papp-' || gen_random_uuid()::TEXT),
  procedure_id       TEXT NOT NULL REFERENCES distillation_artifacts (id) ON DELETE CASCADE,
  -- Free-text, same "sessions are wiped, memory isn't" reasoning as
  -- lab_experiences.session_id / box_id.
  session_id         TEXT,
  box_id             TEXT,
  repo               TEXT,
  applied_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  outcome            TEXT NOT NULL CHECK (outcome IN ('succeeded','failed','abandoned')),
  -- The step the run stopped on: a fact of that procedure with a non-null
  -- ordinal. SET NULL rather than CASCADE so a re-distilled step does not
  -- erase the record that a run once failed.
  failed_at_step_id  TEXT REFERENCES distillation_facts (id) ON DELETE SET NULL,
  note               TEXT
);

CREATE INDEX IF NOT EXISTS distillation_procedure_applications_proc_idx
  ON distillation_procedure_applications (procedure_id, applied_at DESC);

-- ---------------------------------------------------------------------------
-- Distillation — operational rows: compaction job records and the L0
-- write-stream's writers. Additive; no FK into distillation_schema.sql's
-- tables, because a job record must outlive the clusters/artifacts it names
-- (the ids are an audit trail, like distillation_review_samples.target_id).
--
-- Written by middleware/src/providers/distillation-store.ts as a durable
-- mirror of what the queue consumer did (fire-and-forget upserts, one per job
-- transition). With Aurora configured (MOCK_AURORA off) the compaction list,
-- a single job, /ingest and /levels' L0 writer count are READ back from these
-- tables by the same module; the corpus (observations, clusters, artifacts,
-- facts, reviews) is still mock-first. See docs/distillation.md.
--
-- Loads right after distillation_schema.sql (load_schema.py).
-- ---------------------------------------------------------------------------

-- One row per compaction pass. The shape is the wire job's
-- (GET /api/distillation/compactions): input_ids/output_ids are the batch
-- the pass claimed and the rows it wrote, log is its run log as it happened.
-- duration_ms and cost_usd are the values at the moment the pass finished —
-- a record of that run, not a rollup another table could contradict.
CREATE TABLE IF NOT EXISTS distillation_compactions (
  id            TEXT PRIMARY KEY,
  -- The level the pass merged INTO. Nothing compacts into L0.
  level         TEXT NOT NULL CHECK (level IN ('L1','L2')),
  -- The repo the pass was scoped to (also its FIFO message group); NULL = the
  -- whole store.
  repo          TEXT,
  status        TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed')),
  phase         TEXT CHECK (phase IN ('queued','claim','read','merge','write','done','failed','retrying')),
  percent       SMALLINT CHECK (percent IS NULL OR (percent BETWEEN 0 AND 100)),
  requested_by  TEXT,
  queued_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ,
  input_ids     TEXT[] NOT NULL DEFAULT '{}',
  output_ids    TEXT[] NOT NULL DEFAULT '{}',
  log           JSONB NOT NULL DEFAULT '[]'::jsonb,
  what_changed  TEXT,
  duration_ms   INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  cost_usd      NUMERIC(10,4) CHECK (cost_usd IS NULL OR cost_usd >= 0),
  error         TEXT,
  -- Queue deliveries so far; the dead-letter threshold is MAX_RECEIVES in
  -- middleware/src/lib/distillation-queue.ts.
  attempts      SMALLINT NOT NULL DEFAULT 0,
  -- The running pass's current step sentence; NULL once it is done or queued.
  step_label    TEXT,
  -- Bytes the pass reclaimed, as counted when it finished. NULL = not recorded
  -- (a row written before the column existed) — unknown, never zero.
  bytes_reclaimed BIGINT CHECK (bytes_reclaimed IS NULL OR bytes_reclaimed >= 0)
);

-- Clusters that created the table before these two columns existed.
ALTER TABLE distillation_compactions ADD COLUMN IF NOT EXISTS step_label TEXT;
ALTER TABLE distillation_compactions ADD COLUMN IF NOT EXISTS bytes_reclaimed BIGINT
  CHECK (bytes_reclaimed IS NULL OR bytes_reclaimed >= 0);

CREATE INDEX IF NOT EXISTS distillation_compactions_level_idx
  ON distillation_compactions (level, queued_at DESC);
CREATE INDEX IF NOT EXISTS distillation_compactions_open_idx
  ON distillation_compactions (status) WHERE status IN ('queued','running');

-- The sessions writing L0. One row per writer; the fleet's write rate is the
-- SUM over rows, never a stored total. last_write_at is when this writer last
-- landed an observation — "writers in the last hour" is counted from it.
CREATE TABLE IF NOT EXISTS distillation_ingest_writers (
  id                     TEXT PRIMARY KEY,
  -- Free-text, same "sessions are wiped, memory isn't" reasoning as
  -- lab_experiences.session_id / box_id.
  session_id             TEXT NOT NULL,
  box_id                 TEXT,
  repo                   TEXT NOT NULL,
  initiative_id          TEXT,
  observations_per_hour  NUMERIC(8,2) NOT NULL DEFAULT 0 CHECK (observations_per_hour >= 0),
  last_write_at          TIMESTAMPTZ,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS distillation_ingest_writers_recent_idx
  ON distillation_ingest_writers (last_write_at DESC);

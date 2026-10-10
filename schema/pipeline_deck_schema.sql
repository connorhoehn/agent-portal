-- Pipeline run report decks (docs/agentic-flows-migration.md, slice 3).
-- Additive; no FK to the run (a run is a projection over several source
-- tables, so its id is namespaced text, e.g. job:<id>). Same shape and CAS
-- rule as assessment_deck_schema.sql: head_revision_id is the compare-and-set
-- anchor and providers/pipeline-decks.ts appends with one statement.
CREATE TABLE IF NOT EXISTS pipeline_run_decks (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  title TEXT NOT NULL,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  head_revision_id TEXT
);
CREATE INDEX IF NOT EXISTS pipeline_run_decks_run_idx ON pipeline_run_decks(run_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS pipeline_run_deck_revisions (
  id TEXT PRIMARY KEY,
  deck_id TEXT NOT NULL REFERENCES pipeline_run_decks(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  base_revision_id TEXT,
  label TEXT NOT NULL,
  spec JSONB NOT NULL,
  locked_slide_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- 'generated' for the facts deck, 'person:<sub>' for a person's edit.
  produced_by TEXT NOT NULL,
  created_by TEXT,
  summary TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (deck_id, seq)
);
COMMENT ON TABLE pipeline_run_deck_revisions IS
  'Append-only run report deck revisions. Numbers on slides are read from the run projection, never from the model.';

-- Orgiq initiative status decks (docs/agentic-flows-migration.md, slice 6).
-- Additive. project_id names projects.id (no FK: the deck is a point-in-time
-- artifact and must outlive a project's removal from the graph). Same shape and
-- CAS rule as pipeline_deck_schema.sql: head_revision_id is the compare-and-set
-- anchor and providers/initiative-decks.ts appends with one statement.
-- includes_budget marks a deck that carries allocation, spend, envelope or
-- maintenance-floor figures; only a budget-tier reader may open it.
CREATE TABLE IF NOT EXISTS initiative_decks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  includes_budget BOOLEAN NOT NULL DEFAULT FALSE,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  head_revision_id TEXT
);
CREATE INDEX IF NOT EXISTS initiative_decks_project_idx ON initiative_decks(project_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS initiative_deck_revisions (
  id TEXT PRIMARY KEY,
  deck_id TEXT NOT NULL REFERENCES initiative_decks(id) ON DELETE CASCADE,
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
COMMENT ON TABLE initiative_deck_revisions IS
  'Append-only initiative status deck revisions. Numbers on slides are read from the initiative''s rows, never from the model.';

-- Assessment review decks (docs/assessment-deck-goal.md, "Storage").
-- Additive; apply after assessment_schema.sql (FK on assessment_teams).
-- Revisions are append-only: a save names its base, and the deck's
-- head_revision_id is the compare-and-set anchor (providers/assessment-decks.ts
-- appends with one UPDATE ... RETURNING / INSERT ... SELECT statement, so a
-- stale base inserts nothing and the BFF answers 409).
CREATE TABLE IF NOT EXISTS assessment_decks (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES assessment_teams(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  audience TEXT,
  dimension_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  head_revision_id TEXT,
  -- The latest generation/revise run (assessment_runs.id); not a FK so a
  -- pruned run ledger never blocks a deck.
  last_run_id TEXT
);
CREATE INDEX IF NOT EXISTS assessment_decks_team_idx ON assessment_decks(team_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS assessment_deck_revisions (
  id TEXT PRIMARY KEY,
  deck_id TEXT NOT NULL REFERENCES assessment_decks(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  base_revision_id TEXT,
  label TEXT NOT NULL,
  -- The vendored DeckSpec (middleware/src/lib/deck/DeckSpec.ts), validated before insert.
  spec JSONB NOT NULL,
  locked_slide_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- assessment_runs.id for an agent revision, 'person:<sub>' for a person's edit.
  produced_by TEXT NOT NULL,
  created_by TEXT,
  summary TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (deck_id, seq)
);
COMMENT ON TABLE assessment_deck_revisions IS
  'Append-only review deck revisions. Numbers on slides are filled from the assessment record, never by the model.';

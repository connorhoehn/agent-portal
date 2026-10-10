-- Social /deck decks (docs/agentic-flows-migration.md, slice 5). Additive. Same
-- shape and CAS rule as pipeline_deck_schema.sql: head_revision_id is the
-- compare-and-set anchor and lib/flow-artifacts appends with one statement.
-- `channel` is the conversation the deck was built from (social:ch:/dm:/team:);
-- its CURRENT members may read the deck, as may the owner (created_by). The id
-- is derived from the run id, so saving one run twice is the same deck.
CREATE TABLE IF NOT EXISTS social_decks (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  run_id TEXT,
  title TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  head_revision_id TEXT
);
CREATE INDEX IF NOT EXISTS social_decks_owner_idx ON social_decks(created_by, updated_at DESC);
CREATE INDEX IF NOT EXISTS social_decks_channel_idx ON social_decks(channel, updated_at DESC);

CREATE TABLE IF NOT EXISTS social_deck_revisions (
  id TEXT PRIMARY KEY,
  deck_id TEXT NOT NULL REFERENCES social_decks(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  base_revision_id TEXT,
  label TEXT NOT NULL,
  spec JSONB NOT NULL,
  locked_slide_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- 'generated' for the conversation deck, 'person:<sub>' for a person's edit.
  produced_by TEXT NOT NULL,
  created_by TEXT,
  summary TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (deck_id, seq)
);
COMMENT ON TABLE social_deck_revisions IS
  'Append-only Social deck revisions. Slide facts are counted from the conversation lines the requester could read, never by the model.';

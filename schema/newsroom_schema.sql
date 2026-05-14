-- newsroom_schema.sql
-- Additive DDL for the newsroom feature layer on top of the OrgIQ org-graph schema.
-- Fully idempotent: uses CREATE TABLE IF NOT EXISTS and ALTER TABLE ... ADD COLUMN IF NOT EXISTS.
-- No DROP, no NOT NULL on existing columns, no destructive changes.

-- ---------------------------------------------------------------------------
-- Extend documents with article-level columns
-- ---------------------------------------------------------------------------
ALTER TABLE documents ADD COLUMN IF NOT EXISTS headline       TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS subheadline    TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS published_at   TIMESTAMPTZ;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS section        TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS byline_person_id TEXT REFERENCES people(id);
ALTER TABLE documents ADD COLUMN IF NOT EXISTS word_count     INTEGER;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS status         TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS doc_type       TEXT;

-- Extend people with newsroom role
ALTER TABLE people ADD COLUMN IF NOT EXISTS role TEXT;

-- ---------------------------------------------------------------------------
-- Named entities (people, orgs, places, topics, etc.)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS entities (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  aliases     TEXT[],
  metadata    JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(entity_type);
CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(LOWER(name));

-- ---------------------------------------------------------------------------
-- Article ↔ entity join (with salience score and role)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS article_entities (
  article_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  entity_id  TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  salience   NUMERIC NOT NULL DEFAULT 1.0,
  role       TEXT,
  PRIMARY KEY (article_id, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_article_entities_entity ON article_entities(entity_id);

-- ---------------------------------------------------------------------------
-- Sources cited in articles
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sources (
  id            TEXT PRIMARY KEY,
  article_id    TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  entity_id     TEXT REFERENCES entities(id) ON DELETE SET NULL,
  source_type   TEXT NOT NULL,
  attribution   TEXT,
  quote_snippet TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sources_article ON sources(article_id);
CREATE INDEX IF NOT EXISTS idx_sources_entity ON sources(entity_id);

-- ---------------------------------------------------------------------------
-- Story clusters — groups of related articles on the same running story
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS story_clusters (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  description   TEXT,
  primary_beat  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_updated  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cluster_articles (
  cluster_id TEXT NOT NULL REFERENCES story_clusters(id) ON DELETE CASCADE,
  article_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  added_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (cluster_id, article_id)
);
CREATE INDEX IF NOT EXISTS idx_cluster_articles_article ON cluster_articles(article_id);

-- ---------------------------------------------------------------------------
-- Pitches — story ideas proposed by reporters
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pitches (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  body        TEXT,
  beat        TEXT,
  status      TEXT NOT NULL DEFAULT 'open',
  proposed_by TEXT REFERENCES people(id),
  assigned_to TEXT REFERENCES people(id),
  cluster_id  TEXT REFERENCES story_clusters(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pitches_status ON pitches(status);
CREATE INDEX IF NOT EXISTS idx_pitches_assigned ON pitches(assigned_to);

-- ---------------------------------------------------------------------------
-- Additional indexes on documents for newsroom query patterns
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_documents_published ON documents(published_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_documents_section ON documents(section);
CREATE INDEX IF NOT EXISTS idx_documents_doc_type ON documents(doc_type);
CREATE INDEX IF NOT EXISTS idx_documents_byline ON documents(byline_person_id);

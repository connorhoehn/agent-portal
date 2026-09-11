-- OrgIQ relational schema for Aurora PostgreSQL 16.
-- Aurora does not support Apache AGE, so the org-graph is modeled as plain tables
-- with edge tables for each relationship type. pgvector lives alongside in
-- node_embeddings for semantic similarity.
--
-- Apply via RDS Data API:
--   aws rds-data execute-statement \
--     --resource-arn $AURORA_CLUSTER_ARN \
--     --secret-arn $AURORA_SECRET_ARN \
--     --database orgiq \
--     --sql "$(cat schema/orgiq_schema.sql)"

CREATE EXTENSION IF NOT EXISTS vector;

-- ---------------------------------------------------------------------------
-- Nodes
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS people (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  email              TEXT,
  title              TEXT,
  team               TEXT,
  expertise_score    NUMERIC,
  pagerank_score     NUMERIC,
  composite_score    NUMERIC,
  scored_at          TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS skills (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  domain      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS teams (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  parent_id   TEXT REFERENCES teams(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS projects (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  status             TEXT,
  summary            TEXT,
  sponsor_person_id  TEXT REFERENCES people(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Idempotent for databases created before summary/sponsor existed.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS summary            TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS sponsor_person_id  TEXT REFERENCES people(id) ON DELETE SET NULL;

-- A call the org has made, or still has to make. ONE concept with a lifecycle,
-- not two things sharing a table:
--
--   status       open -> escalated -> resolved | rejected
--   decided_at   set exactly when the call has been made; NULL while it is open
--   project_id   the initiative it was raised against, or NULL for an org-wide
--                standard that no single initiative owns (d-aurora, d-k8s)
--   work_item_id the work this decision blocks, when it blocks work
--
-- `status`, `project_id`, `required_role`, `resolution`, `escalated_at`,
-- `resolved_at` and `work_item_id` are ALTERed in by
-- schema/orgiq_work_items_schema.sql, which is why they are not listed here —
-- they need `projects` and `work_items` to exist first. They are part of this
-- table's definition all the same, and BOTH seeds fill the whole set: a seed
-- that fills half of it is how `GET /api/graph/decisions` and an initiative's
-- Decisions tab came to describe two different worlds out of one table.
--
-- Who was in the room lives in `decision_participants` below — for every
-- decision, not just the ADR-shaped ones.
CREATE TABLE IF NOT EXISTS decisions (
  id          TEXT PRIMARY KEY,
  topic       TEXT NOT NULL,
  summary     TEXT,
  decided_at  DATE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS documents (
  id            TEXT PRIMARY KEY,
  source        TEXT,
  source_uri    TEXT,
  title         TEXT,
  ingested_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Corpus metadata, written by `schema/synth/load.py::upsert_document` for every
-- doc type: `doc_type` classifies the doc (adr | postmortem | perf_review |
-- slack_thread | all_hands), and `headline`/`published_at`/`section` carry the
-- per-type metadata `schema/synth/generate.py` derives (an ADR's title and
-- decision date under section 'decisions', an incident's title and date under
-- 'incidents', and so on).
--
-- These are ADD COLUMN rather than part of the CREATE above because a retired
-- tenant's schema file originally added them, and deleting that file took the
-- only definition with it — so a cluster loaded from this file alone had none
-- of them and the corpus load failed on `column "doc_type" does not exist`,
-- while a cluster loaded before the removal still had all four. Defining them
-- here converges both. IF NOT EXISTS keeps that idempotent.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS doc_type     TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS headline     TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS section      TEXT;

CREATE INDEX IF NOT EXISTS documents_doc_type_idx ON documents (doc_type);

-- ---------------------------------------------------------------------------
-- Edges — one table per relationship type (mirrors the former Cypher labels).
-- Each row has an optional `weight` so PageRank-style scoring can use it.
-- ---------------------------------------------------------------------------

-- HAS_SKILL: Person → Skill
CREATE TABLE IF NOT EXISTS person_skills (
  person_id  TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  skill_id   TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  weight     NUMERIC NOT NULL DEFAULT 1.0,
  source     TEXT,
  PRIMARY KEY (person_id, skill_id)
);

-- MEMBER_OF: Person → Team
CREATE TABLE IF NOT EXISTS team_memberships (
  person_id  TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  team_id    TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  role       TEXT,
  weight     NUMERIC NOT NULL DEFAULT 1.0,
  PRIMARY KEY (person_id, team_id)
);

-- WORKED_WITH: Person ↔ Person (undirected; stored with canonical id ordering)
CREATE TABLE IF NOT EXISTS collaborations (
  person_a_id  TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  person_b_id  TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  weight       NUMERIC NOT NULL DEFAULT 1.0,
  last_seen    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (person_a_id, person_b_id),
  CHECK (person_a_id < person_b_id)
);

-- WORKED_ON: Person → Project
CREATE TABLE IF NOT EXISTS project_contributions (
  person_id   TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  role        TEXT,
  weight      NUMERIC NOT NULL DEFAULT 1.0,
  PRIMARY KEY (person_id, project_id)
);

-- MADE / PARTICIPATED_IN: Person → Decision
CREATE TABLE IF NOT EXISTS decision_participants (
  person_id    TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  decision_id  TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  role         TEXT,
  weight       NUMERIC NOT NULL DEFAULT 1.0,
  PRIMARY KEY (person_id, decision_id)
);

-- MENTIONS: Document → any node (entity_type points to the source table)
CREATE TABLE IF NOT EXISTS mentions (
  document_id  TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  entity_type  TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  count        INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (document_id, entity_type, entity_id)
);

-- ---------------------------------------------------------------------------
-- Vector embeddings for graph nodes (Titan V2, 1024d)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS node_embeddings (
  node_id    TEXT PRIMARY KEY,
  node_type  TEXT NOT NULL,
  content    TEXT,
  embedding  vector(1024) NOT NULL
);

-- ---------------------------------------------------------------------------
-- Indexes — graph traversals are dominated by edge-table joins.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_person_skills_skill   ON person_skills(skill_id);
CREATE INDEX IF NOT EXISTS idx_team_memberships_team ON team_memberships(team_id);
CREATE INDEX IF NOT EXISTS idx_mentions_entity       ON mentions(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_people_composite     ON people(composite_score DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_people_expertise     ON people(expertise_score DESC NULLS LAST);

-- Approximate-nearest-neighbour index for embeddings (cosine distance).
-- Skipped if the cluster doesn't have ivfflat — pgvector recent versions ship it by default.
CREATE INDEX IF NOT EXISTS idx_node_embeddings_cos
  ON node_embeddings USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

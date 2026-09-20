-- assessment_schema.sql
-- The third tenant's durable store: engineering-maturity assessments ported
-- from agentic-assessment-accelerator (docs/assessment-tenant.md). Mirrors the
-- middleware mock's domain model (middleware/src/mock/assessment.ts) table for
-- interface, so the Aurora path of providers/assessment.ts can replace
-- `notMocked` without the wire shape moving. Standalone: no FK into the org
-- graph — tenants share a BFF, not a schema. Fully idempotent.
--
-- Ids are the mock's: TEAM-0NN, EV-xxxx, PROV-xxxx, Q-xxxx,
-- sub-<stamp>-form<Id>-<submitter>[-rN], run-<stamp>-<command>-<hex>.

-- ---------------------------------------------------------------------------
-- Rubric (17 dimensions × 6 levels). Static reference data, seeded from
-- RUBRIC_DIMENSIONS; versioned so a scored assessment can name the rubric it
-- was scored against.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS assessment_rubric_dimensions (
  rubric_version  TEXT NOT NULL,
  id              TEXT NOT NULL,                    -- '1'..'17'
  title           TEXT NOT NULL,
  definition      TEXT NOT NULL,
  na_description  TEXT NOT NULL,
  levels          JSONB NOT NULL,                   -- RubricLevel[] (0..5)
  PRIMARY KEY (rubric_version, id)
);

-- ---------------------------------------------------------------------------
-- Teams. `contacts`, `repos` and `contributors` are small arrays owned by the
-- team row (the mock keeps them inline); exceptions get their own table
-- because they carry an approval workflow.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS assessment_teams (
  id               TEXT PRIMARY KEY,                -- TEAM-0NN
  name             TEXT NOT NULL,
  cohort           TEXT NOT NULL CHECK (cohort IN ('white_glove', 'self_service', 'general')),
  status           TEXT NOT NULL DEFAULT 'active',
  workflow_step    INTEGER NOT NULL DEFAULT 1 CHECK (workflow_step BETWEEN 1 AND 6),
  assessment_lead  TEXT NOT NULL DEFAULT '',
  contacts         TEXT[] NOT NULL DEFAULT '{}',
  repos            JSONB NOT NULL DEFAULT '[]',     -- RepoRef[] {name, gitlab_url}
  contributors     JSONB NOT NULL DEFAULT '[]',     -- {initials, name}[]
  archetype        TEXT,                            -- ARCHETYPES.key or NULL
  rubric_version   TEXT NOT NULL DEFAULT 'v1',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_assessment_teams_cohort ON assessment_teams(cohort);

-- N/A is never self-granting: a requested exception sits here until a
-- lead-assessor approves or denies it (ApproveException). One row per
-- (team, dimension) — a re-request overwrites the denied row.
-- `requested_by` (nullable — a re-request overwrite keeps whoever most
-- recently proposed it) backs the "never the assessor who proposed it" rule:
-- patchException refuses an approve/deny where approved_by === requested_by
-- unless the caller is admin AND explicitly passes { override: true }.
CREATE TABLE IF NOT EXISTS assessment_team_exceptions (
  team_id       TEXT NOT NULL REFERENCES assessment_teams(id) ON DELETE CASCADE,
  dimension_id  TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('requested', 'approved', 'denied')),
  source        TEXT NOT NULL CHECK (source IN ('archetype', 'known_exception', 'submission', 'manual')),
  reason        TEXT NOT NULL DEFAULT '',
  requested_by  TEXT,
  approved_by   TEXT NOT NULL DEFAULT '',
  approved_at   TIMESTAMPTZ,
  PRIMARY KEY (team_id, dimension_id)
);

-- ---------------------------------------------------------------------------
-- Scores. One row per (team, dimension) is the current state; history and
-- evidence hang off it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS assessment_dimension_scores (
  team_id             TEXT NOT NULL REFERENCES assessment_teams(id) ON DELETE CASCADE,
  dimension_id        TEXT NOT NULL,
  current_level       INTEGER CHECK (current_level BETWEEN 0 AND 5),
  is_na               BOOLEAN NOT NULL DEFAULT FALSE,
  confidence          TEXT NOT NULL DEFAULT 'low' CHECK (confidence IN ('low', 'moderate', 'high')),
  self_claimed_level  INTEGER CHECK (self_claimed_level BETWEEN 0 AND 5),
  evidence_class      TEXT CHECK (evidence_class IN ('attested', 'documented', 'observed')),
  cap_applied         BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (team_id, dimension_id)
);

-- Where a piece of evidence came from. Shared by scored evidence and the
-- intake log; the provenance ledger on the Evidence tab reads this.
CREATE TABLE IF NOT EXISTS assessment_provenance (
  provenance_id  TEXT PRIMARY KEY,                  -- PROV-xxxx
  team_id        TEXT NOT NULL REFERENCES assessment_teams(id) ON DELETE CASCADE,
  source_uri     TEXT NOT NULL,
  captured_by    TEXT NOT NULL,
  captured_at    TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assessment_provenance_team ON assessment_provenance(team_id);

-- Evidence excerpts are VERBATIM: the app never paraphrases what a person
-- said or a document shows. `scored` = it was used by a scoring pass;
-- unscored rows are the intake log (EvidenceLogItem) waiting for one.
-- `dimension_id` is NULL for intake that has not been attributed yet.
CREATE TABLE IF NOT EXISTS assessment_evidence (
  evidence_id     TEXT PRIMARY KEY,                 -- EV-xxxx
  team_id         TEXT NOT NULL REFERENCES assessment_teams(id) ON DELETE CASCADE,
  dimension_id    TEXT,
  source_type     TEXT NOT NULL CHECK (source_type IN ('survey', 'transcript', 'document', 'artifact', 'touchpoint')),
  excerpt         TEXT NOT NULL,
  supports_level  INTEGER CHECK (supports_level BETWEEN 0 AND 5),
  captured_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source_ref      TEXT NOT NULL DEFAULT '',         -- provenance_id or free text
  scored          BOOLEAN NOT NULL DEFAULT FALSE,
  -- Uppercase, and constrained. Every writer supplies this column explicitly
  -- ('PENDING' at intake, 'SCORED' after scoring, 'CLASSIFIED' from the
  -- classifier), so the lowercase 'pending' default was unreachable — and an
  -- unreachable default that disagrees with the values in the table is worse
  -- than none: it is the spelling the next person copies. The CHECK makes the
  -- vocabulary the column's own, rather than a convention held only in TS.
  status          TEXT NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('PENDING', 'CLASSIFIED', 'SCORED')),
  title           TEXT,                             -- intake metadata (optional)
  captured_by     TEXT
);
CREATE INDEX IF NOT EXISTS idx_assessment_evidence_team_dim ON assessment_evidence(team_id, dimension_id);
CREATE INDEX IF NOT EXISTS idx_assessment_evidence_unscored ON assessment_evidence(team_id) WHERE scored = FALSE;

CREATE TABLE IF NOT EXISTS assessment_follow_up_questions (
  question_id      TEXT PRIMARY KEY,                -- Q-xxxx
  team_id          TEXT NOT NULL REFERENCES assessment_teams(id) ON DELETE CASCADE,
  dimension_id     TEXT NOT NULL,
  text             TEXT NOT NULL,
  target_audience  TEXT NOT NULL DEFAULT '',
  status           TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'ANSWERED', 'DROPPED')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_assessment_followups_open ON assessment_follow_up_questions(team_id) WHERE status = 'OPEN';

-- Append-only. `na_claimed` records a claim independent of `is_na`, which
-- only flips once an exception is approved.
CREATE TABLE IF NOT EXISTS assessment_dimension_history (
  id              BIGSERIAL PRIMARY KEY,
  team_id         TEXT NOT NULL REFERENCES assessment_teams(id) ON DELETE CASCADE,
  dimension_id    TEXT NOT NULL,
  from_level      INTEGER,
  to_level        INTEGER,
  is_na           BOOLEAN NOT NULL DEFAULT FALSE,
  na_claimed      BOOLEAN NOT NULL DEFAULT FALSE,
  rationale       TEXT NOT NULL DEFAULT '',
  evidence_ids    TEXT[] NOT NULL DEFAULT '{}',
  source_meeting  TEXT NOT NULL DEFAULT '',
  changed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  changed_by      TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_assessment_history_team_dim ON assessment_dimension_history(team_id, dimension_id, changed_at DESC);

-- ---------------------------------------------------------------------------
-- Submissions (Forms envelopes). The envelope is stored whole — dimension
-- hints are read as a unit and never queried by field — with the columns the
-- list and the commit path filter on lifted out.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS assessment_submissions (
  envelope_id         TEXT PRIMARY KEY,                -- sub-<stamp>-form<Id>-<submitter>[-rN]
  team_id             TEXT NOT NULL REFERENCES assessment_teams(id) ON DELETE CASCADE,
  status              TEXT NOT NULL DEFAULT 'staged' CHECK (status IN ('staged', 'committed', 'superseded')),
  revision            INTEGER NOT NULL DEFAULT 1,
  supersedes          TEXT REFERENCES assessment_submissions(envelope_id), -- envelope_id this one replaces
  form_submission_id  TEXT,                            -- lifted from envelope.source.form_submission_id
  submitted_at        TIMESTAMPTZ NOT NULL,
  ingested_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  assessment_date     DATE,
  self_certified      BOOLEAN NOT NULL DEFAULT FALSE,
  submitter           JSONB NOT NULL,                  -- {name, email, is_primary_contact}
  envelope            JSONB NOT NULL                   -- the full SubmissionEnvelope
);
CREATE INDEX IF NOT EXISTS idx_assessment_submissions_team ON assessment_submissions(team_id, status);
-- At most one COMMITTED envelope per (team, form) — the invariant
-- commitSubmissions' atomic supersede+insert (providers/assessment.ts) is
-- meant to hold. NULLs (legacy/manual envelopes with no form_submission_id)
-- are not constrained by a partial unique index in Postgres, matching how
-- those envelopes were never form-deduplicated before this column existed.
CREATE UNIQUE INDEX IF NOT EXISTS uq_assessment_submissions_committed_form
  ON assessment_submissions(team_id, form_submission_id) WHERE status = 'committed';

-- ---------------------------------------------------------------------------
-- Agent runs (the Activity ledger). `source` is who launched it — the Runs
-- page, a submission commit, the fleet dispatcher.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS assessment_runs (
  id             TEXT PRIMARY KEY,                  -- run-<stamp>-<command>-<hex>
  command        TEXT NOT NULL,
  team_id        TEXT REFERENCES assessment_teams(id) ON DELETE SET NULL,
  args           JSONB NOT NULL DEFAULT '{}',
  status         TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  source         TEXT NOT NULL DEFAULT 'ui',
  started_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at    TIMESTAMPTZ,
  summary        TEXT NOT NULL DEFAULT '',
  error          TEXT,
  files_written  TEXT[] NOT NULL DEFAULT '{}',
  launched_by    TEXT                               -- session sub, never the body
);
CREATE INDEX IF NOT EXISTS idx_assessment_runs_started ON assessment_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_assessment_runs_team ON assessment_runs(team_id, started_at DESC);

-- What a scoring pass concluded per dimension, kept whole so "How it was
-- assessed" can replay it. One log per (team, stamp).
CREATE TABLE IF NOT EXISTS assessment_scoring_logs (
  team_id      TEXT NOT NULL REFERENCES assessment_teams(id) ON DELETE CASCADE,
  stamp        TEXT NOT NULL,
  envelope_id  TEXT,
  source       TEXT NOT NULL DEFAULT '',
  run_id       TEXT REFERENCES assessment_runs(id) ON DELETE SET NULL,
  scores       JSONB NOT NULL,                      -- ScoringLogEntry[]
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (team_id, stamp)
);

-- ---------------------------------------------------------------------------
-- Feedback queue (HITL). Stored tasks only — the provider still synthesizes
-- a virtual task per OPEN follow-up question at read time, and resolving a
-- virtual task answers the question rather than inserting here.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS assessment_feedback_tasks (
  task_id       TEXT PRIMARY KEY,
  team_id       TEXT REFERENCES assessment_teams(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'RESOLVED', 'DISMISSED')),
  dimension_id  TEXT,
  question      TEXT NOT NULL,
  response      TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at   TIMESTAMPTZ,
  resolved_by   TEXT
);
CREATE INDEX IF NOT EXISTS idx_assessment_feedback_open ON assessment_feedback_tasks(status, team_id);

-- ---------------------------------------------------------------------------
-- Knowledge (Workspace / Enterprise / Rules / Prompts). A section is either
-- `local` (documents live here) or `synced` (a Confluence-style mirror whose
-- pages carry `page_id`); nodes form a tree; docs keep a version history that
-- is snapshotted before every save.
-- ---------------------------------------------------------------------------
-- Stable source-to-canvas identity. Source URLs remain unchanged while the
-- realtime channel is an opaque UUID that fits the gateway channel contract.
CREATE TABLE IF NOT EXISTS assessment_document_mappings (
  tenant_id text NOT NULL CHECK (tenant_id = 'assessment'),
  source_namespace text NOT NULL,
  source_id text NOT NULL,
  document_id uuid NOT NULL UNIQUE,
  source_revision text NOT NULL,
  schema_version integer NOT NULL DEFAULT 2 CHECK (schema_version >= 2),
  migration_state text NOT NULL DEFAULT 'pending' CHECK (migration_state IN ('pending', 'ready')),
  owner_sub text,
  published_revision text,
  PRIMARY KEY (tenant_id, source_namespace, source_id)
);

CREATE TABLE IF NOT EXISTS assessment_knowledge_sections (
  key       TEXT PRIMARY KEY,
  title     TEXT NOT NULL,
  kind      TEXT NOT NULL CHECK (kind IN ('local', 'synced')),
  provider  TEXT,
  position  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS assessment_knowledge_nodes (
  id              TEXT PRIMARY KEY,
  section_key     TEXT NOT NULL REFERENCES assessment_knowledge_sections(key) ON DELETE CASCADE,
  parent_id       TEXT REFERENCES assessment_knowledge_nodes(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  is_dir          BOOLEAN NOT NULL DEFAULT FALSE,
  classification  TEXT,
  editable        BOOLEAN,
  viewable        BOOLEAN,
  page_id         TEXT,                             -- synced provider's page id
  position        INTEGER NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_assessment_knowledge_nodes_parent ON assessment_knowledge_nodes(section_key, parent_id, position);

CREATE TABLE IF NOT EXISTS assessment_knowledge_docs (
  id              TEXT PRIMARY KEY,                 -- node id
  title           TEXT NOT NULL,
  classification  TEXT NOT NULL DEFAULT 'internal',
  path            TEXT NOT NULL,
  markdown        TEXT NOT NULL DEFAULT '',
  editable        BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Local drafts retain their intended source parent without publishing on create.
ALTER TABLE assessment_knowledge_docs ADD COLUMN IF NOT EXISTS source_parent_id TEXT;
ALTER TABLE assessment_knowledge_docs ADD COLUMN IF NOT EXISTS published_page_id TEXT;

CREATE TABLE IF NOT EXISTS assessment_knowledge_doc_versions (
  doc_id    TEXT NOT NULL REFERENCES assessment_knowledge_docs(id) ON DELETE CASCADE,
  stamp     TEXT NOT NULL,
  label     TEXT,
  size      INTEGER NOT NULL,
  saved_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  saved_by  TEXT,
  markdown  TEXT NOT NULL,
  PRIMARY KEY (doc_id, stamp)
);

-- Added for the Aurora path of publishKnowledgeDoc (providers/assessment.ts):
-- a re-publish of the same local doc increments this in place, mirroring the
-- mock provider's in-memory `publishedVersions` counter but durably.
ALTER TABLE assessment_knowledge_nodes ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;

-- Added: the mock provider's createKnowledgeComment only ever publishes a
-- broker event (the thread of record lives in the realtime gateway's chat
-- store) — no table existed for it. The Aurora path additionally persists
-- the comment here so a viewer who reconnects (or a fresh gateway session)
-- can still see prior comments instead of relying entirely on the
-- broker's in-memory event history.
CREATE TABLE IF NOT EXISTS assessment_knowledge_comments (
  id          TEXT PRIMARY KEY,
  doc_id      TEXT NOT NULL REFERENCES assessment_knowledge_nodes(id) ON DELETE CASCADE,
  body        TEXT NOT NULL,
  author      TEXT NOT NULL DEFAULT 'unknown',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Comments attach to local docs and synced pages, both represented by nodes.
-- One statement is atomic through the Data API loader. If a legacy comment
-- has no matching node, validation fails and the previous FK stays intact.
-- Reconcile the missing node explicitly; never delete comments to force this.
DO $COMMENT_TARGET$
BEGIN
  ALTER TABLE assessment_knowledge_comments DROP CONSTRAINT IF EXISTS assessment_knowledge_comments_doc_id_fkey;
  ALTER TABLE assessment_knowledge_comments ADD CONSTRAINT assessment_knowledge_comments_doc_id_fkey
    FOREIGN KEY (doc_id) REFERENCES assessment_knowledge_nodes(id) ON DELETE CASCADE;
END
$COMMENT_TARGET$;
CREATE INDEX IF NOT EXISTS idx_assessment_knowledge_comments_doc ON assessment_knowledge_comments(doc_id, created_at);

-- Edit and soft-delete, added when the comment thread grew them. Both are
-- timestamps rather than flags because the UI renders WHEN: the library's
-- ChatMessage takes `editedAt` (shown as "(edited)") and `deletedAt` (the row
-- keeps its place and says it was removed). A hard DELETE would take the
-- tombstone with it and leave a gap in a conversation people are reading.
ALTER TABLE assessment_knowledge_comments ADD COLUMN IF NOT EXISTS edited_at  TIMESTAMPTZ;
ALTER TABLE assessment_knowledge_comments ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- Reactions on a document OR on one of its comments. `target_id` is whichever
-- of the two, un-foreign-keyed on purpose: it points into two tables, and a
-- reaction outliving a hard-deleted parent is harmless (nothing reads it) while
-- a constraint that cannot express "one of two" would force either a second
-- table or a nullable pair of keys for no gain.
--
-- One row per (target, emoji, actor): the primary key IS the toggle. Reacting
-- twice with the same emoji is an insert then a delete, never a count of two,
-- which is the rule the UI's `mine` flag depends on.
CREATE TABLE IF NOT EXISTS assessment_knowledge_reactions (
  target_id   TEXT NOT NULL,
  emoji       TEXT NOT NULL,
  actor       TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (target_id, emoji, actor)
);
CREATE INDEX IF NOT EXISTS idx_assessment_knowledge_reactions_target
  ON assessment_knowledge_reactions(target_id);

-- ---------------------------------------------------------------------------
-- Programme configuration: the certification target and the three motions.
-- A single row keyed 'default' — PUT /configuration replaces it wholesale.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS assessment_configuration (
  key           TEXT PRIMARY KEY DEFAULT 'default',
  target_level  INTEGER NOT NULL DEFAULT 3 CHECK (target_level BETWEEN 0 AND 5),
  motions       JSONB NOT NULL DEFAULT '[]',        -- MotionConfig[]
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Story drafts (one per recommendation acted on). Jira push is deliberately
-- withheld in both apps; `jira_key` stays NULL until a person pushes.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS assessment_stories (
  filename      TEXT PRIMARY KEY,
  team_id       TEXT NOT NULL REFERENCES assessment_teams(id) ON DELETE CASCADE,
  dimension_id  TEXT NOT NULL,
  title         TEXT NOT NULL,
  markdown      TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('pushed', 'blocked', 'ready')),
  jira_key      TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_assessment_stories_team ON assessment_stories(team_id);

-- ---------------------------------------------------------------------------
-- Certification rollup, the dashboard's per-team and per-cohort numbers.
-- Scored = dimensions with a level or an approved N/A; verified at L means
-- every scored, applicable dimension is >= L.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_assessment_team_rollup AS
SELECT
  t.id                                                        AS team_id,
  t.name,
  t.cohort,
  COUNT(s.dimension_id) FILTER (WHERE s.current_level IS NOT NULL OR s.is_na) AS assessed_dimensions,
  COUNT(s.dimension_id) FILTER (WHERE s.is_na)                AS na_dimensions,
  MIN(s.current_level) FILTER (WHERE NOT s.is_na)             AS floor_level,
  COUNT(q.question_id)                                        AS open_follow_ups,
  t.updated_at
FROM assessment_teams t
LEFT JOIN assessment_dimension_scores s ON s.team_id = t.id
LEFT JOIN assessment_follow_up_questions q ON q.team_id = t.id AND q.status = 'OPEN'
GROUP BY t.id, t.name, t.cohort, t.updated_at;

-- Durable assessment dispatch: admission and payload persist in one transaction.
-- Claims prevent two middleware replicas invoking the same run. Interrupted
-- claims expire as failed, never silently retry non-idempotent score application.
ALTER TABLE assessment_runs ADD COLUMN IF NOT EXISTS dispatch_payload JSONB;
ALTER TABLE assessment_runs ADD COLUMN IF NOT EXISTS dispatch_claimed_at TIMESTAMPTZ;

-- Quote replies retain their parent when it becomes a soft-delete tombstone.
-- Existing comments remain top-level. NO ACTION never cascades parent deletion
-- into deleting replies; whole-document cascades still delete the entire thread.
ALTER TABLE assessment_knowledge_comments ADD COLUMN IF NOT EXISTS parent_id TEXT
  REFERENCES assessment_knowledge_comments(id) ON DELETE NO ACTION;

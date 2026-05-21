-- OrgIQ observability — Sprint 6: Prompt history & experiment log.
--
-- Adds persistence for:
--   1. canary_experiments  — one row per completed A/B run (outcome + scores)
--   2. prompt_version_meta — description + lifecycle status per Bedrock version
--      (Bedrock only stores ARN + timestamps; we add author, "what changed", and
--       the lifecycle status set by the canary controller)
--
-- The existing canary_decisions table (Sprint 5) already captures per-tick
-- decisions. These new tables summarise at the experiment level and decorate
-- per-version metadata so the /iq/history page can render the version timeline
-- + experiment outcome cards.
--
-- Apply via:
--   cd schema && psql ... -f observability_sprint6_prompt_history_schema.sql
-- Or via apply-schema.sh (adds to the ordered migration list).
--
-- Idempotent (IF NOT EXISTS on tables + indexes, ADD COLUMN IF NOT EXISTS on
-- the backfill). Safe to re-run.

CREATE SCHEMA IF NOT EXISTS observability;

-- ---------------------------------------------------------------------------
-- canary_experiments
--   One row per completed canary run. Written by the middleware at experiment
--   end (PROMOTE / ROLLBACK / HALT). The decisions FK lets the history page
--   fetch the full decision timeline via JOIN on canary_decisions.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS observability.canary_experiments (
  experiment_id       text PRIMARY KEY,
  canary_name         text NOT NULL DEFAULT 'orgiq-expert-explainer',
  prompt_id           text NOT NULL,             -- Bedrock prompt id (no arn suffix)
  prompt_version_a    text NOT NULL,             -- e.g. '3'
  prompt_version_b    text NOT NULL,             -- e.g. '4'
  prompt_arn_a        text,
  prompt_arn_b        text,
  started_at          timestamptz NOT NULL,
  finished_at         timestamptz,
  final_action        text CHECK (final_action IN (
                        'PROMOTE', 'ROLLBACK', 'HALTED', 'IN_PROGRESS'
                      )) DEFAULT 'IN_PROGRESS',
  final_weight_b      smallint,
  final_score_a       numeric(5,4),
  final_score_b       numeric(5,4),
  score_delta         numeric(5,4),              -- final_score_b - final_score_a
  decision_count      int DEFAULT 0,
  halt_reason         text,
  created_at          timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS canary_experiments_prompt_idx
  ON observability.canary_experiments (prompt_id, started_at DESC);

CREATE INDEX IF NOT EXISTS canary_experiments_ts_idx
  ON observability.canary_experiments (started_at DESC);

COMMENT ON TABLE observability.canary_experiments IS
  'One row per completed (or in-progress) A/B canary experiment. Written by '
  'the middleware at PROMOTE/ROLLBACK/HALT. Joins to canary_decisions on '
  '(prompt_version_a_arn, prompt_version_b_arn) for the full decision log.';

-- ---------------------------------------------------------------------------
-- prompt_version_meta
--   Supplements Bedrock Prompt Library metadata that the SDK does not expose
--   natively: free-text description ("what changed?"), author email, and the
--   lifecycle status set by the canary controller.
--
--   lifecycle_status values:
--     published    — version exists in Bedrock, not yet deployed in a canary
--     deployed     — used as subject B in at least one active experiment
--     promoted     — experiment ended PROMOTE, this version became production A
--     rolled_back  — experiment ended ROLLBACK for this B version
--     superseded   — a newer version was promoted after this one
--     draft        — DRAFT slot (not a numbered version)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS observability.prompt_version_meta (
  prompt_id          text NOT NULL,
  version            text NOT NULL,           -- '1', '2', … or 'DRAFT'
  description        text,                    -- "What changed?" field from EditPanel
  author_email       text,
  published_at       timestamptz,
  deployed_at        timestamptz,
  superseded_at      timestamptz,
  lifecycle_status   text NOT NULL DEFAULT 'published' CHECK (lifecycle_status IN (
                       'draft', 'published', 'deployed', 'promoted',
                       'rolled_back', 'superseded'
                     )),
  PRIMARY KEY (prompt_id, version)
);

CREATE INDEX IF NOT EXISTS prompt_version_meta_prompt_idx
  ON observability.prompt_version_meta (prompt_id, published_at DESC NULLS LAST);

COMMENT ON TABLE observability.prompt_version_meta IS
  'Portal-side metadata for Bedrock Prompt Library versions: description, '
  'author, and lifecycle status (published → deployed → promoted/rolled_back → superseded). '
  'prompt_id is the Bedrock prompt id (no ARN prefix).';

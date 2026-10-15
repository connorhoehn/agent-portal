-- The pipelines tenant's own tables (docs/social-tenant-design.md §5.2,
-- docs/social-tenant-and-pipelines-research-2026-09-29.md §D.3, lane P2).
--
-- WHAT LIVES HERE, AND WHAT DOES NOT. The run projection
-- (middleware/src/lib/pipeline-runs.ts) stays the read path for the
-- run-shaped tables that already exist — agent_jobs, bot_runs,
-- agent_project_runs, assessment_runs and
-- observability.invocation_traces. Nothing is copied from them into these
-- tables. These tables hold only what ORIGINATES in the pipelines tenant:
--
--   pipeline_definitions  a definition's recorded version — its owner, its
--                         version number and the roles that approve its steps.
--                         The definitions themselves are DERIVED from what
--                         exists (every bot, assessment command, runbook
--                         candidate and agent — lib/pipeline-definitions.ts);
--                         a row here is the version an author recorded over
--                         the derived one, merged by id.
--   pipeline_runs         runs this tenant started — today the runbook
--                         dry-run (POST /api/pipelines/definitions/:id/dry-run),
--                         executed by the EXISTING queue (agent_jobs, kind
--                         `runbook:dry-run`) and marked completed by the
--                         existing job completion path. `id` is the run id the
--                         projection gives that job (`job:<uuid>`), so a run
--                         has one id everywhere.
--   pipeline_steps        steps recorded by a run that originates here (the
--                         projection derives steps for everything else).
--   pipeline_artifacts    artifacts recorded by such a run.
--   pipeline_config       the tenant's configuration (default approver role).
--
-- The status vocabulary is pipeline-runtime's nine; the definition kinds and
-- artifact kinds are research §D.3's. Idempotent: every statement is
-- IF NOT EXISTS / ON CONFLICT DO NOTHING, so schema/load_schema.py can re-run it.

CREATE TABLE IF NOT EXISTS pipeline_definitions (
  id              TEXT        PRIMARY KEY,               -- 'bot:<uuid>', 'assessment:<command>', 'runbook:<candidate>', 'agent:<id>'
  tenant          TEXT        NOT NULL DEFAULT 'pipelines',
  context_tenant  TEXT        NOT NULL CHECK (context_tenant IN ('orgiq', 'assessment')),
  kind            TEXT        NOT NULL CHECK (kind IN ('runbook', 'agent', 'bot', 'assessment-command', 'compaction')),
  title           TEXT        NOT NULL,
  owner           TEXT,
  version         INTEGER     NOT NULL DEFAULT 1 CHECK (version >= 1),
  -- Who approves this definition's steps. Empty = the tenant default
  -- (pipeline_config 'default_approver_role', 'operator' unless changed).
  approver_roles  JSONB       NOT NULL DEFAULT '[]'::jsonb,
  source_table    TEXT,
  source_id       TEXT,
  updated_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pipeline_definitions_kind_idx ON pipeline_definitions (kind);

CREATE TABLE IF NOT EXISTS pipeline_runs (
  id              TEXT        PRIMARY KEY,               -- the projection's run id ('job:<uuid>')
  definition_id   TEXT        NOT NULL,
  tenant          TEXT        NOT NULL DEFAULT 'pipelines',
  -- Whose data the run acted for — what the embedded Runs sections filter on.
  context_tenant  TEXT        NOT NULL CHECK (context_tenant IN ('orgiq', 'assessment')),
  run_kind        TEXT        NOT NULL DEFAULT 'runbook:dry-run',
  status          TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN (
                    'pending', 'running', 'awaiting_approval', 'paused_at_breakpoint',
                    'completed', 'rejected', 'failed', 'cancelled', 'stuck')),
  job_id          TEXT,                                  -- agent_jobs.id — the queue row that executes it
  triggered_by    TEXT,
  trigger_type    TEXT        NOT NULL DEFAULT 'manual' CHECK (trigger_type IN ('manual', 'schedule', 'webhook', 'document-event')),
  model           TEXT,
  estimate_usd    NUMERIC(10, 4),
  cost_usd        NUMERIC(10, 4),
  error           TEXT,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS pipeline_runs_definition_idx ON pipeline_runs (definition_id, started_at DESC);
CREATE INDEX IF NOT EXISTS pipeline_runs_job_idx ON pipeline_runs (job_id);
CREATE INDEX IF NOT EXISTS pipeline_runs_context_idx ON pipeline_runs (context_tenant, started_at DESC);

CREATE TABLE IF NOT EXISTS pipeline_steps (
  run_id          TEXT        NOT NULL REFERENCES pipeline_runs (id) ON DELETE CASCADE,
  step_id         TEXT        NOT NULL,
  label           TEXT        NOT NULL,
  status          TEXT        NOT NULL CHECK (status IN ('pending', 'running', 'awaiting_approval', 'completed', 'failed', 'skipped')),
  attempts        JSONB       NOT NULL DEFAULT '[]'::jsonb,
  started_at      TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ,
  PRIMARY KEY (run_id, step_id)
);

CREATE TABLE IF NOT EXISTS pipeline_artifacts (
  id              TEXT        PRIMARY KEY,
  run_id          TEXT        REFERENCES pipeline_runs (id) ON DELETE CASCADE,
  step_id         TEXT,
  kind            TEXT        NOT NULL CHECK (kind IN ('change', 'document', 'scores', 'trace', 'transcript', 'image')),
  uri             TEXT        NOT NULL,
  title           TEXT        NOT NULL,
  meta            JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pipeline_config (
  key             TEXT        PRIMARY KEY,
  value           JSONB       NOT NULL,
  updated_by      TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Design §8: a definition that names no approver is approved by an operator.
INSERT INTO pipeline_config (key, value, updated_by) VALUES ('default_approver_role', '"operator"'::jsonb, 'u-dara')
ON CONFLICT (key) DO NOTHING;

-- The nine assessment commands (and the three ladder runbooks), version 1, recorded by Ines Moreau — the commands the assessment
-- worker runs (providers/assessment.ts AGENT_COMMANDS, mirrored from the
-- accelerator's .claude/commands as prompt documents). Seeded so a cluster
-- carries each command's recorded version; the parity entity
-- 'pipeline_definitions' (middleware/src/mock/core/parity/entities.ts) pins
-- these rows against the derived registry, so a command added on one side
-- and not the other fails the harness.
INSERT INTO pipeline_definitions (id, context_tenant, kind, title, owner, version, approver_roles, source_table, source_id, updated_by) VALUES
  ('assessment:classify-transcript', 'assessment', 'assessment-command', 'Classify transcript', 'u-ines', 1, '["operator"]'::jsonb, 'assessment_commands', 'classify-transcript', 'u-ines'),
  ('assessment:score-dimensions', 'assessment', 'assessment-command', 'Score dimensions', 'u-ines', 1, '["operator"]'::jsonb, 'assessment_commands', 'score-dimensions', 'u-ines'),
  ('assessment:process-self-assessment', 'assessment', 'assessment-command', 'Process self-assessment', 'u-ines', 1, '["operator"]'::jsonb, 'assessment_commands', 'process-self-assessment', 'u-ines'),
  ('assessment:develop-jira-story', 'assessment', 'assessment-command', 'Develop Jira story', 'u-ines', 1, '["operator"]'::jsonb, 'assessment_commands', 'develop-jira-story', 'u-ines'),
  ('assessment:extract-enterprise-context', 'assessment', 'assessment-command', 'Extract enterprise context', 'u-ines', 1, '["operator"]'::jsonb, 'assessment_commands', 'extract-enterprise-context', 'u-ines'),
  ('assessment:validate-outputs', 'assessment', 'assessment-command', 'Validate outputs', 'u-ines', 1, '["operator"]'::jsonb, 'assessment_commands', 'validate-outputs', 'u-ines'),
  ('assessment:draft-confluence-page', 'assessment', 'assessment-command', 'Draft Confluence page', 'u-ines', 1, '["operator"]'::jsonb, 'assessment_commands', 'draft-confluence-page', 'u-ines'),
  ('assessment:suggest-confluence-content', 'assessment', 'assessment-command', 'Suggest Confluence content', 'u-ines', 1, '["operator"]'::jsonb, 'assessment_commands', 'suggest-confluence-content', 'u-ines'),
  ('assessment:draw-diagram', 'assessment', 'assessment-command', 'Draw diagram', 'u-ines', 1, '["operator"]'::jsonb, 'assessment_commands', 'draw-diagram', 'u-ines'),
  ('runbook:promo-aurora-cold-start', 'orgiq', 'runbook', 'Resume a nightly ingest from its last checkpoint', 'u-ines', 1, '["operator"]'::jsonb, 'promotion_candidates', 'promo-aurora-cold-start', 'u-ines'),
  ('runbook:promo-arm64-fargate', 'orgiq', 'runbook', 'Quarantine a malformed batch instead of failing the whole load', 'u-ines', 1, '["operator"]'::jsonb, 'promotion_candidates', 'promo-arm64-fargate', 'u-ines'),
  ('runbook:promo-custodian-sg-drift', 'orgiq', 'runbook', 'Backfill a month of events without duplicating rows', 'u-ines', 1, '["operator"]'::jsonb, 'promotion_candidates', 'promo-custodian-sg-drift', 'u-ines')
ON CONFLICT (id) DO NOTHING;

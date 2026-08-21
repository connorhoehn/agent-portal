-- AI SDLC governance — code changes an agent proposes, and the gates they pass.
--
-- The org graph already had a governed loop: a sweep notices something, a
-- worker acts, and a `graph_proposals` row waits for a human before any graph
-- write lands. Code had no such thing. An agent ran against a repository, left
-- a diff in the workspace, and that was the end of it — nothing reviewed it,
-- nothing approved it, nothing delivered it, and the workspace was eventually
-- reaped taking the change with it.
--
-- These tables are the code-side mirror of `graph_proposals`: a run's diff
-- becomes a change request, an independent agent reviews it, policy gates
-- decide whether a human is needed, and only an approved change is delivered
-- as a branch and a pull request. Namespaced `agent_change_*` and `sdlc_*`
-- deliberately — reusing an existing table name once already cost the graph
-- its data.

-- A candidate code change, captured from an agent run so it survives the
-- workspace that produced it.
CREATE TABLE IF NOT EXISTS agent_change_requests (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  run_id        UUID        REFERENCES agent_project_runs (id) ON DELETE SET NULL,
  project_id    UUID        NOT NULL REFERENCES agent_projects (id) ON DELETE CASCADE,

  title         TEXT        NOT NULL,

  -- The captured unified diff, bounded. A change too large to store is a
  -- change too large to review by eye anyway; the row keeps the stat summary
  -- and truncates the body rather than refusing the change.
  diff          TEXT,
  diff_truncated BOOLEAN    NOT NULL DEFAULT FALSE,
  files         JSONB       NOT NULL DEFAULT '[]',   -- repo-relative paths touched
  files_changed INTEGER     NOT NULL DEFAULT 0,

  -- The model that authored the run behind this change, stored here so a
  -- model_allowlist policy can gate on who wrote it even after the run row is
  -- gone. createChangeRequest writes it; rowToChange reads it.
  model         TEXT,

  -- The lifecycle, enforced. Mirrors the discipline of agent_jobs: a change
  -- can only be in a state the pipeline put it in.
  --   captured           diff taken, not yet evaluated
  --   in_review          an independent reviewer is running
  --   changes_requested  the reviewer wants revisions (recoverable — a new run supersedes)
  --   blocked            a hard policy gate refused it
  --   needs_approval     cleared review, a policy gate needs a human
  --   approved           cleared every gate; ready to deliver
  --   delivering         branch/commit/push/PR in flight
  --   delivered          a pull request exists
  --   rejected           a human declined it
  --   failed             the pipeline errored
  status        TEXT        NOT NULL DEFAULT 'captured'
                CHECK (status IN ('captured','in_review','changes_requested','blocked',
                                  'needs_approval','approved','delivering','delivered',
                                  'rejected','failed')),

  -- The commit this change was captured as. With commit-per-capture the run's
  -- work is committed on the workspace's work branch at capture time, so the
  -- next run's diff is clean and delivery pushes exactly this commit rather than
  -- the whole (possibly cumulative) working tree. NULL = legacy change captured
  -- before this model; delivery falls back to shipping the working tree.
  commit_sha    TEXT,

  -- Delivery outcome.
  branch_name   TEXT,
  pr_url        TEXT,

  -- Who decided, when a human did.
  decided_by    TEXT,
  decided_at    TIMESTAMPTZ,
  decision_note TEXT,

  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Backfill for databases whose agent_change_requests predates the `model`
-- column: CREATE TABLE IF NOT EXISTS above will not alter an existing table, so
-- without this a reload leaves the table missing a column createChangeRequest
-- inserts, and every governed-change capture fails. Idempotent.
ALTER TABLE agent_change_requests ADD COLUMN IF NOT EXISTS model TEXT;
ALTER TABLE agent_change_requests ADD COLUMN IF NOT EXISTS commit_sha TEXT;

CREATE INDEX IF NOT EXISTS idx_agent_change_requests_project
  ON agent_change_requests (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_change_requests_open
  ON agent_change_requests (status)
  WHERE status IN ('needs_approval','changes_requested','in_review');

-- One reviewer's verdict on a change. Kept separately from the change row so a
-- re-review appends rather than overwrites — the history of what each reviewer
-- said is the audit trail, and the change row only holds the latest verdict it
-- acted on.
CREATE TABLE IF NOT EXISTS agent_change_reviews (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  change_request_id UUID        NOT NULL REFERENCES agent_change_requests (id) ON DELETE CASCADE,

  reviewer          TEXT        NOT NULL DEFAULT 'agent',   -- 'agent' | a person's id
  model             TEXT,
  verdict           TEXT        NOT NULL
                    CHECK (verdict IN ('approve','request_changes','reject')),
  summary           TEXT,
  -- [{severity, file, line, note}] — the concrete objections, so a request for
  -- changes is actionable rather than a bare thumbs-down.
  findings          JSONB       NOT NULL DEFAULT '[]',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_change_reviews_change
  ON agent_change_reviews (change_request_id, created_at DESC);

-- The evaluated gates for a change, recorded so the decision is explainable
-- after the fact — "why did this need a human" has an answer that is not
-- "re-run the engine and hope it decides the same way".
CREATE TABLE IF NOT EXISTS agent_change_gates (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  change_request_id UUID        NOT NULL REFERENCES agent_change_requests (id) ON DELETE CASCADE,
  policy_id         TEXT,
  policy_name       TEXT        NOT NULL,
  kind              TEXT        NOT NULL,
  outcome           TEXT        NOT NULL CHECK (outcome IN ('pass','requires_approval','block')),
  detail            TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_change_gates_change
  ON agent_change_gates (change_request_id, created_at);

-- Governance policies. Editable by an operator; these are the rules the gate
-- engine (middleware/src/lib/sdlc-policy.ts) evaluates every change against.
CREATE TABLE IF NOT EXISTS sdlc_policies (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT        NOT NULL,
  enabled     BOOLEAN     NOT NULL DEFAULT TRUE,
  kind        TEXT        NOT NULL
              CHECK (kind IN ('require_review','protected_paths','max_files','model_allowlist','max_cost')),
  config      JSONB       NOT NULL DEFAULT '{}',
  action      TEXT        NOT NULL DEFAULT 'require_approval'
              CHECK (action IN ('require_approval','block')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Backfill for databases whose sdlc_policies predates the max_cost kind:
-- CREATE TABLE IF NOT EXISTS above will not alter an existing table's CHECK,
-- and a constraint cannot be modified in place — so drop and recreate it under
-- its default name. Idempotent: on a fresh database this drops the inline
-- constraint just created and re-adds the identical one.
ALTER TABLE sdlc_policies DROP CONSTRAINT IF EXISTS sdlc_policies_kind_check;
ALTER TABLE sdlc_policies ADD CONSTRAINT sdlc_policies_kind_check
  CHECK (kind IN ('require_review','protected_paths','max_files','model_allowlist','max_cost'));

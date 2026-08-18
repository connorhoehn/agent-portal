-- Agentic work loop — the spine that turns this system from request/response
-- Q&A into agents that produce durable outcomes.
--
-- Three tables, one cycle:
--
--   agent_findings   sweeps notice something (bus-factor risk, stale doc)
--        ↓ promote
--   agent_jobs       a devbox worker claims it and does the work
--        ↓ propose
--   graph_proposals  the result is reviewed by a human, then written back
--                    into the org graph, which the next sweep reads
--
-- Applied by schema/apply_agentic_work.py.

-- ---------------------------------------------------------------------------
-- Jobs — the queue devbox workers pull from
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS agent_jobs (
  id            TEXT PRIMARY KEY DEFAULT ('job-' || gen_random_uuid()::TEXT),
  -- 'devbox:task' runs a Claude Code prompt in a microVM; 'sweep:<name>'
  -- runs an in-process org sweep. New kinds slot in without a migration.
  kind          TEXT NOT NULL,
  title         TEXT NOT NULL,
  -- Kind-specific input: {prompt, repo, boxId?} for devbox:task, {} for sweeps.
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- queued → claimed → running → (awaiting_review | done | failed | cancelled)
  -- awaiting_review is the human-in-the-loop stop: the worker produced
  -- something (a PR, a proposal) that a person must accept before it counts.
  status        TEXT NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued','claimed','running','awaiting_review','done','failed','cancelled')),
  priority      INTEGER NOT NULL DEFAULT 100,   -- lower runs first

  -- Which devbox box is executing it, and the runtime session that carries
  -- the workspace. Null until claimed.
  box_id        TEXT,
  session_id    TEXT,

  attempts      INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 2,

  result        JSONB,                          -- {summary, artifacts[], costUsd, turns}
  error         TEXT,

  created_by    TEXT,                           -- portal user / 'scheduler'
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at    TIMESTAMPTZ,
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE agent_jobs IS
  'Work queue for agent workers. Claimed atomically with FOR UPDATE SKIP LOCKED '
  'so multiple dispatchers never hand the same job to two boxes.';

-- The claim query filters on status and orders by (priority, created_at).
CREATE INDEX IF NOT EXISTS agent_jobs_claim_idx
  ON agent_jobs (status, priority, created_at)
  WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS agent_jobs_box_idx     ON agent_jobs (box_id);
CREATE INDEX IF NOT EXISTS agent_jobs_created_idx ON agent_jobs (created_at DESC);

-- ---------------------------------------------------------------------------
-- Findings — what scheduled sweeps notice
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS agent_findings (
  id            TEXT PRIMARY KEY DEFAULT ('find-' || gen_random_uuid()::TEXT),
  sweep         TEXT NOT NULL,                  -- 'bus_factor' | 'stale_docs' | 'orphan_decisions'
  severity      TEXT NOT NULL DEFAULT 'info'
                CHECK (severity IN ('critical','warning','info')),
  title         TEXT NOT NULL,
  detail        TEXT,
  -- What the finding is about, so the UI can deep-link into Explore.
  entity_type   TEXT,                           -- 'person' | 'skill' | 'document' | 'decision'
  entity_id     TEXT,
  evidence      JSONB NOT NULL DEFAULT '{}'::jsonb,

  status        TEXT NOT NULL DEFAULT 'open'
                CHECK (status IN ('open','promoted','dismissed','resolved')),
  -- Set when a finding is promoted into the work queue.
  job_id        TEXT REFERENCES agent_jobs(id) ON DELETE SET NULL,

  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Stable identity across sweep runs: re-running a sweep must update the
  -- existing row rather than pile up duplicates every night.
  fingerprint   TEXT NOT NULL,
  UNIQUE (sweep, fingerprint)
);

CREATE INDEX IF NOT EXISTS agent_findings_status_idx ON agent_findings (status, severity, last_seen_at DESC);

-- ---------------------------------------------------------------------------
-- Graph proposals — agent write-back, gated on human approval
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS graph_proposals (
  id            TEXT PRIMARY KEY DEFAULT ('prop-' || gen_random_uuid()::TEXT),
  -- What produced it, so a bad source can be traced and switched off.
  source        TEXT NOT NULL,                  -- 'sweep:<name>' | 'job:<id>' | 'agent:<id>'
  job_id        TEXT REFERENCES agent_jobs(id) ON DELETE SET NULL,
  finding_id    TEXT REFERENCES agent_findings(id) ON DELETE SET NULL,

  -- The mutation, kept declarative so the applier is a small switch and every
  -- proposal is reviewable as data rather than as opaque SQL.
  kind          TEXT NOT NULL
                CHECK (kind IN ('add_person_skill','update_person_title','add_collaboration',
                                'add_skill','link_document_mention')),
  target_type   TEXT NOT NULL,
  target_id     TEXT NOT NULL,
  payload       JSONB NOT NULL,
  rationale     TEXT,
  evidence      JSONB NOT NULL DEFAULT '{}'::jsonb,
  confidence    NUMERIC(3,2) CHECK (confidence BETWEEN 0 AND 1),

  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','approved','rejected','applied','failed')),
  reviewer      TEXT,
  review_note   TEXT,
  apply_error   TEXT,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at    TIMESTAMPTZ,
  applied_at    TIMESTAMPTZ
);

COMMENT ON TABLE graph_proposals IS
  'Agent-proposed org-graph mutations. Nothing here touches the graph until a '
  'human approves it; the applier then executes the declarative payload.';

CREATE INDEX IF NOT EXISTS graph_proposals_status_idx ON graph_proposals (status, created_at DESC);


-- ---------------------------------------------------------------------------
-- Migration: link_document_mention
--
-- The stale-docs sweep finds documents nothing references, but there was no
-- proposal kind that could actually link one — so 44 findings had no route to
-- resolution beyond a worker writing a plan about them. This adds the kind
-- that closes that loop. Idempotent: safe to re-run against a live database.
-- ---------------------------------------------------------------------------

ALTER TABLE graph_proposals DROP CONSTRAINT IF EXISTS graph_proposals_kind_check;
ALTER TABLE graph_proposals ADD CONSTRAINT graph_proposals_kind_check
  CHECK (kind IN ('add_person_skill','update_person_title','add_collaboration',
                  'add_skill','link_document_mention'));


-- ---------------------------------------------------------------------------
-- Migration: no duplicate live proposals for the same mutation
--
-- Re-analysing a document (a second click, a bulk pass, a retry) proposed the
-- same links again, so a reviewer would face N copies of one change and could
-- apply the same mutation repeatedly. Dedupe on the mutation itself — kind +
-- target + payload — but only while the proposal is live. A rejected or failed
-- proposal must remain re-proposable: rejecting says "not now", not "never
-- ask again", and a failed apply should be retryable once its cause is fixed.
--
-- md5(payload::text) rather than the jsonb itself because jsonb has no default
-- btree opclass for a unique index.
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS graph_proposals_live_dedupe
  ON graph_proposals (kind, target_id, md5(payload::text))
  WHERE status IN ('pending', 'approved', 'applied');

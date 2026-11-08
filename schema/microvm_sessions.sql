-- The microVM runner's sessions (docs/microvm-runner-design.md §13).
--
-- One row per runtime session: one (actor, agent project, job attempt) on the
-- `orgiq_microvm` runtime. The session id is derived, never chosen
-- (lib/microvm-ids.ts): `mvm1-<sha256(tenant:sub)[:16]>-<agent_project_id[:12]>-<job_id[:12]>-<attempt>`,
-- so two actors can never share one. The dispatcher (lib/microvm-dispatcher.ts)
-- writes the row at every status; the reaper's overrun sweep reads it.
--
-- The column additions the runner needs on existing tables are here too, so
-- this one file loads after every table it touches: agent_jobs
-- (agentic_work_schema.sql), spend_entries (spend_ledger_schema.sql),
-- spend_holds (spend_holds_schema.sql), agent_projects / agent_project_runs
-- (agent_projects_schema.sql) and projects (orgiq_schema.sql). The new
-- `spend_holds.source` / `spend_entries.source` value 'microvm' and the
-- `credential_issues` columns live in their own files' named constraints.
--
-- Additive and idempotent. The tenant column makes this a tenant table:
-- schema/row_level_security.sql lists it.

-- ── agent_jobs: who runs it, for whom, and what it resumes ─────────────────
-- `runner` is set at enqueue from the initiative's devbox profile
-- (network_class 'egress-allowlist' → 'microvm'); the fleet claim never takes a
-- 'microvm' row and the microVM claim takes nothing else. `actor_sub` is the
-- session subject at enqueue (never the request body) and is the authority;
-- `created_by` stays the display attribution. `resume_of_job_id` is §9's
-- explicit, actor-checked resume.
ALTER TABLE agent_jobs ADD COLUMN IF NOT EXISTS runner TEXT NOT NULL DEFAULT 'fleet';
ALTER TABLE agent_jobs DROP CONSTRAINT IF EXISTS agent_jobs_runner_check;
ALTER TABLE agent_jobs ADD CONSTRAINT agent_jobs_runner_check CHECK (runner IN ('fleet', 'microvm', 'local'));
ALTER TABLE agent_jobs ADD COLUMN IF NOT EXISTS actor_sub TEXT;
ALTER TABLE agent_jobs ADD COLUMN IF NOT EXISTS resume_of_job_id TEXT REFERENCES agent_jobs (id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS agent_jobs_microvm_queued_idx ON agent_jobs (priority, created_at) WHERE status = 'queued' AND runner = 'microvm';

-- ── spend_entries: the compute half of a microVM run (§6) ──────────────────
-- `compute_seconds` = stopped − booted, `compute_usd` = that × the
-- MICROVM_COMPUTE_USD_PER_SECOND rate, `session_id` the runtime session.
ALTER TABLE spend_entries ADD COLUMN IF NOT EXISTS compute_seconds INTEGER;
ALTER TABLE spend_entries ADD COLUMN IF NOT EXISTS compute_usd NUMERIC(10,4);
ALTER TABLE spend_entries ADD COLUMN IF NOT EXISTS session_id TEXT;

-- ── agent_project_runs: which runner a run used ────────────────────────────
ALTER TABLE agent_project_runs ADD COLUMN IF NOT EXISTS runner TEXT;

-- ── microvm_sessions ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS microvm_sessions (
  session_id         TEXT        PRIMARY KEY CHECK (length(session_id) >= 33),
  job_id             TEXT        NOT NULL REFERENCES agent_jobs (id) ON DELETE CASCADE,
  attempt            INTEGER     NOT NULL CHECK (attempt >= 1),
  actor_sub          TEXT        NOT NULL,
  tenant             TEXT        NOT NULL,
  agent_project_id   UUID        REFERENCES agent_projects (id) ON DELETE SET NULL,
  initiative_id      TEXT        REFERENCES projects (id) ON DELETE SET NULL,
  runtime_arn        TEXT,
  profile_id         TEXT,
  profile_version    INTEGER,
  network_class      TEXT,
  status             TEXT        NOT NULL DEFAULT 'booting'
                     CHECK (status IN ('booting', 'cloning', 'ready', 'running', 'pushing', 'reporting', 'stopped', 'failed')),
  hold_id            UUID        REFERENCES spend_holds (id) ON DELETE SET NULL,
  brief_sha          TEXT,
  library_sha        TEXT,
  claude_session_id  TEXT,
  base_sha           TEXT,
  head_sha           TEXT,
  branch             TEXT,
  pr_url             TEXT,
  transcript_s3_key  TEXT,
  exit_code          INTEGER,
  fresh_tokens       BIGINT,
  cost_usd           NUMERIC(10,4),
  cost_basis         TEXT        CHECK (cost_basis IS NULL OR cost_basis IN ('reported', 'estimated', 'unknown')),
  compute_seconds    INTEGER,
  compute_usd        NUMERIC(10,4),
  stop_reason        TEXT,
  -- The profile's per-task ceiling at dispatch: what the reaper's overrun
  -- sweep bounds a live session by (task_timeout_s + grace, §7).
  task_timeout_s     INTEGER,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  booted_at          TIMESTAMPTZ,
  started_at         TIMESTAMPTZ,
  ended_at           TIMESTAMPTZ,
  stopped_at         TIMESTAMPTZ,
  UNIQUE (job_id, attempt)
);

CREATE INDEX IF NOT EXISTS microvm_sessions_actor_live_idx ON microvm_sessions (actor_sub)
  WHERE status NOT IN ('stopped', 'failed');
CREATE INDEX IF NOT EXISTS microvm_sessions_live_idx ON microvm_sessions (created_at)
  WHERE status NOT IN ('stopped', 'failed');
CREATE INDEX IF NOT EXISTS microvm_sessions_project_idx ON microvm_sessions (agent_project_id, created_at DESC);

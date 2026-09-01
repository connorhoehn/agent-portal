-- ---------------------------------------------------------------------------
-- The lab loop — computer-lab agents reaching OUTSIDE their sessions.
--
-- A lab session is ephemeral by design (session storage is a cache; the
-- microVM is wiped on redeploy). Three things deserve to outlive it:
--
--   * issues it noticed        → agent_findings (agentic_work_schema) with
--                                sweep='lab-signal' — no table here; signals
--                                ride the existing findings pipeline so the
--                                Work page, counts and promote→job flow all
--                                apply unchanged.
--   * what it learned          → lab_experiences (this file) — the fleet's
--                                memory. New sessions recall these by repo /
--                                initiative before starting work.
--   * questions for a human    → lab_consults (this file) — a blocking ask:
--                                the agent polls until a person answers from
--                                the Work page, or the consult expires.
--
-- Loads after agent_sdlc_schema (references nothing beyond gen_random_uuid,
-- but belongs with the agentic family).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lab_experiences (
  id            TEXT PRIMARY KEY DEFAULT ('exp-' || gen_random_uuid()::TEXT),
  -- Where the learning came from. Free-text ids: the session/box namespace
  -- is the middleware's, not a foreign key — sessions are wiped, memory isn't.
  session_id    TEXT,
  box_id        TEXT,
  -- What the learning is ABOUT — how future sessions recall it.
  repo          TEXT,
  initiative_id TEXT,
  kind          TEXT NOT NULL DEFAULT 'gotcha'
                CHECK (kind IN ('worked','failed','gotcha','decision','convention')),
  title         TEXT NOT NULL,
  body          TEXT,
  tags          TEXT[] NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS lab_experiences_repo_idx ON lab_experiences (repo, created_at DESC);
CREATE INDEX IF NOT EXISTS lab_experiences_init_idx ON lab_experiences (initiative_id, created_at DESC);

CREATE TABLE IF NOT EXISTS lab_consults (
  id            TEXT PRIMARY KEY DEFAULT ('con-' || gen_random_uuid()::TEXT),
  session_id    TEXT,
  box_id        TEXT,
  repo          TEXT,
  initiative_id TEXT,
  question      TEXT NOT NULL,
  -- What the agent was doing when it asked — the human answers better with it.
  context       TEXT,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','answered','expired','withdrawn')),
  answer        TEXT,
  -- The session sub of whoever answered — attribution, same rule as
  -- bot_runs.dispatched_by: from the cookie, never the body.
  answered_by   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  answered_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS lab_consults_pending_idx
  ON lab_consults (created_at DESC) WHERE status = 'pending';
